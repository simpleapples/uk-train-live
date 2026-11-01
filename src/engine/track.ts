// Rail network graph (built by scripts/build-track.ts) used to move trains
// along real track: snaps points onto the nearest running line and finds the
// shortest track path between two of them.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export type LonLat = [number, number];

/** On-disk form: vertex coords and delta-encoded edge polylines, 1e-5 degree ints. */
export interface TrackJson {
  v: number[];
  e: [number, number, number[]][];
}

interface Edge {
  a: number;
  b: number;
  coords: LonLat[];
  /** Metres from the edge start to each coordinate. */
  cum: number[];
  len: number;
}

export interface Snap {
  edge: number;
  /** Metres along the edge from its `a` end. */
  offset: number;
  /** Metres from the query point to the track. */
  dist: number;
  point: LonLat;
}

const KY = 110_574;
const kx = (lat: number) => Math.cos((lat * Math.PI) / 180) * 111_320;
const CELL = 0.01; // grid cell size in degrees
// Being off the track costs more than running along it, so a path prefers
// the line nearest each station.
const DEFAULT_OFF_TRACK_WEIGHT = 2;

export function distanceM(a: LonLat, b: LonLat): number {
  const k = kx((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * KY);
}

export function lineLengthM(line: LonLat[]): number {
  let len = 0;
  for (let i = 1; i < line.length; i++) len += distanceM(line[i - 1], line[i]);
  return len;
}

const cellKey = (latCell: number, lonCell: number) => (latCell + 20_000) * 100_000 + (lonCell + 50_000);

class MinHeap {
  #items: [number, number][] = [];

  get size(): number {
    return this.#items.length;
  }

  push(priority: number, value: number): void {
    const items = this.#items;
    items.push([priority, value]);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): [number, number] | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length && last) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < items.length && items[l][0] < items[m][0]) m = l;
        if (r < items.length && items[r][0] < items[m][0]) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}

type Prev = { edge: number; from: number } | { start: Snap };

export class TrackNetwork {
  #vertices: LonLat[] = [];
  #edges: Edge[] = [];
  #adj: number[][] = [];
  // cell -> flattened [edge, segment, edge, segment, ...]
  #grid = new Map<number, number[]>();

  constructor(json: TrackJson) {
    for (let i = 0; i < json.v.length; i += 2) {
      this.#vertices.push([json.v[i] / 1e5, json.v[i + 1] / 1e5]);
      this.#adj.push([]);
    }
    for (const [a, b, enc] of json.e) {
      const coords: LonLat[] = [];
      let x = 0, y = 0;
      for (let i = 0; i < enc.length; i += 2) {
        x += enc[i];
        y += enc[i + 1];
        coords.push([x / 1e5, y / 1e5]);
      }
      const cum = [0];
      for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distanceM(coords[i - 1], coords[i]));
      const id = this.#edges.length;
      this.#edges.push({ a, b, coords, cum, len: cum.at(-1)! });
      this.#adj[a].push(id);
      if (b !== a) this.#adj[b].push(id);
      for (let s = 1; s < coords.length; s++) this.#index(id, s - 1, coords[s - 1], coords[s]);
    }
  }

  static load(file: string | URL): TrackNetwork {
    return new TrackNetwork(JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as TrackJson);
  }

  get edgeCount(): number {
    return this.#edges.length;
  }

  /** Nearest point on each nearby line, closest first. */
  snap(p: LonLat, radiusM = 400, max = 6): Snap[] {
    const dLat = radiusM / KY;
    const dLon = radiusM / kx(p[1]);
    const best = new Map<number, Snap>();
    const k = kx(p[1]);
    for (let la = Math.floor((p[1] - dLat) / CELL); la <= Math.floor((p[1] + dLat) / CELL); la++) {
      for (let lo = Math.floor((p[0] - dLon) / CELL); lo <= Math.floor((p[0] + dLon) / CELL); lo++) {
        const cell = this.#grid.get(cellKey(la, lo));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i += 2) {
          const edge = this.#edges[cell[i]];
          const s = cell[i + 1];
          const a = edge.coords[s], b = edge.coords[s + 1];
          const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * KY;
          const bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * KY;
          const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
          const t = len2 ? Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / len2)) : 0;
          const dist = Math.hypot(ax + t * (bx - ax), ay + t * (by - ay));
          if (dist > radiusM) continue;
          const prev = best.get(cell[i]);
          if (prev && prev.dist <= dist) continue;
          best.set(cell[i], {
            edge: cell[i],
            offset: edge.cum[s] + t * (edge.cum[s + 1] - edge.cum[s]),
            dist,
            point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
          });
        }
      }
    }
    return [...best.values()].sort((x, y) => x.dist - y.dist).slice(0, max);
  }

  snapPoint(p: LonLat, radiusM = 400): LonLat | null {
    return this.snap(p, radiusM, 1)[0]?.point ?? null;
  }

  /**
   * Shortest track path between two points, or null if either is off the
   * network or they are not connected. `maxSnaps` lines near each end are
   * tried; big interchanges need more, or the right line may not be among them.
   * `offTrackWeight` is what each metre between a station and the track costs
   * relative to a metre of track; raise it where a line has two tracks near a
   * station and must keep to the nearer one.
   */
  route(from: LonLat, to: LonLat, radiusM = 400, maxSnaps = 6, offTrackWeight = DEFAULT_OFF_TRACK_WEIGHT): LonLat[] | null {
    const OFF_TRACK_WEIGHT = offTrackWeight;
    const starts = this.snap(from, radiusM, maxSnaps);
    const ends = this.snap(to, radiusM, maxSnaps);
    if (!starts.length || !ends.length) return null;
    const maxCost = distanceM(from, to) * 3 + 20_000;

    let best = Infinity;
    let plan: { kind: 'same'; s: Snap; t: Snap } | { kind: 'graph'; end: number; t: Snap } | null = null;
    for (const s of starts) {
      for (const t of ends) {
        if (s.edge !== t.edge) continue;
        const cost = Math.abs(s.offset - t.offset) + (s.dist + t.dist) * OFF_TRACK_WEIGHT;
        if (cost < best) {
          best = cost;
          plan = { kind: 'same', s, t };
        }
      }
    }

    const targets = new Map<number, { t: Snap; extra: number }[]>();
    const addTarget = (v: number, t: Snap, extra: number) => {
      const list = targets.get(v) ?? [];
      list.push({ t, extra });
      targets.set(v, list);
    };
    for (const t of ends) {
      const e = this.#edges[t.edge];
      addTarget(e.a, t, t.offset + t.dist * OFF_TRACK_WEIGHT);
      addTarget(e.b, t, e.len - t.offset + t.dist * OFF_TRACK_WEIGHT);
    }

    const g = new Map<number, number>();
    const prev = new Map<number, Prev>();
    const heap = new MinHeap();
    const h = (v: number) => distanceM(this.#vertices[v], to);
    const relax = (v: number, cost: number, p: Prev) => {
      if (cost >= (g.get(v) ?? Infinity)) return;
      g.set(v, cost);
      prev.set(v, p);
      heap.push(cost + h(v), v);
    };
    for (const s of starts) {
      const e = this.#edges[s.edge];
      relax(e.a, s.offset + s.dist * OFF_TRACK_WEIGHT, { start: s });
      relax(e.b, e.len - s.offset + s.dist * OFF_TRACK_WEIGHT, { start: s });
    }

    while (heap.size) {
      const [f, v] = heap.pop()!;
      if (f >= best) break;
      const gv = g.get(v)!;
      if (f > gv + h(v) + 1e-6) continue; // stale heap entry
      for (const { t, extra } of targets.get(v) ?? []) {
        if (gv + extra < best) {
          best = gv + extra;
          plan = { kind: 'graph', end: v, t };
        }
      }
      if (gv > maxCost) continue;
      for (const id of this.#adj[v]) {
        const e = this.#edges[id];
        const w = e.a === v ? e.b : e.a;
        relax(w, gv + e.len, { edge: id, from: v });
      }
    }

    if (!plan) return null;
    if (plan.kind === 'same') return dedupe(this.#slice(plan.s.edge, plan.s.offset, plan.t.offset));

    const steps: { edge: number; from: number }[] = [];
    let v = plan.end;
    let start: Snap;
    for (;;) {
      const p = prev.get(v)!;
      if ('start' in p) {
        start = p.start;
        break;
      }
      steps.push(p);
      v = p.from;
    }
    steps.reverse();

    const startEdge = this.#edges[start.edge];
    const out = this.#slice(start.edge, start.offset, v === startEdge.a ? 0 : startEdge.len);
    for (const step of steps) {
      const e = this.#edges[step.edge];
      out.push(...(step.from === e.a ? e.coords : [...e.coords].reverse()));
    }
    const endEdge = this.#edges[plan.t.edge];
    out.push(...this.#slice(plan.t.edge, plan.end === endEdge.a ? 0 : endEdge.len, plan.t.offset));
    return dedupe(out);
  }

  #index(edge: number, seg: number, a: LonLat, b: LonLat): void {
    const la0 = Math.floor(Math.min(a[1], b[1]) / CELL), la1 = Math.floor(Math.max(a[1], b[1]) / CELL);
    const lo0 = Math.floor(Math.min(a[0], b[0]) / CELL), lo1 = Math.floor(Math.max(a[0], b[0]) / CELL);
    for (let la = la0; la <= la1; la++) {
      for (let lo = lo0; lo <= lo1; lo++) {
        const key = cellKey(la, lo);
        const cell = this.#grid.get(key);
        if (cell) cell.push(edge, seg);
        else this.#grid.set(key, [edge, seg]);
      }
    }
  }

  #pointAt(e: Edge, offset: number): LonLat {
    let i = 1;
    while (i < e.cum.length - 1 && e.cum[i] < offset) i++;
    const span = e.cum[i] - e.cum[i - 1];
    const t = span ? Math.max(0, Math.min(1, (offset - e.cum[i - 1]) / span)) : 0;
    const a = e.coords[i - 1], b = e.coords[i];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }

  /** Points along an edge between two offsets, in travel order. */
  #slice(id: number, from: number, to: number): LonLat[] {
    const e = this.#edges[id];
    const out: LonLat[] = [this.#pointAt(e, from)];
    if (from <= to) {
      for (let i = 0; i < e.coords.length; i++) if (e.cum[i] > from && e.cum[i] < to) out.push(e.coords[i]);
    } else {
      for (let i = e.coords.length - 1; i >= 0; i--) if (e.cum[i] < from && e.cum[i] > to) out.push(e.coords[i]);
    }
    out.push(this.#pointAt(e, to));
    return out;
  }
}

function dedupe(line: LonLat[]): LonLat[] {
  return line.filter((p, i) => i === 0 || p[0] !== line[i - 1][0] || p[1] !== line[i - 1][1]);
}
