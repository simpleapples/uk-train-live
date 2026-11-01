// Turns track polylines that share node ids into the compact graph format
// src/engine/track.ts loads: junction vertices plus simplified, delta-encoded
// edge polylines.

import type { TrackJson } from '../../src/engine/track.ts';

export type LonLat = [number, number];

export interface GraphOptions {
  /** Douglas–Peucker tolerance for edge polylines. */
  toleranceM?: number;
  /** Connected pieces with less track than this are dropped as fragments. */
  minComponentM?: number;
}

export interface GraphResult {
  json: TrackJson;
  edges: number;
  junctions: number;
  km: number;
  pointsIn: number;
  pointsKept: number;
}

export function meters(a: LonLat, b: LonLat): number {
  const kx = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180) * 111_320;
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110_574);
}

function simplify(points: LonLat[], toleranceM: number): LonLat[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const kx = Math.cos(points[s][1] * Math.PI / 180) * 111_320;
    const ax = points[s][0] * kx, ay = points[s][1] * 110_574;
    const bx = points[e][0] * kx, by = points[e][1] * 110_574;
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    let worst = -1, worstD = 0;
    for (let i = s + 1; i < e; i++) {
      const px = points[i][0] * kx, py = points[i][1] * 110_574;
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2)) : 0;
      const d = Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worstD > toleranceM) {
      keep[worst] = 1;
      stack.push([s, worst], [worst, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * @param ways node-id sequences; ways that share an id are connected there.
 * @param coord node id -> coordinate.
 */
export function buildGraph(ways: Iterable<number[]>, coord: Map<number, LonLat>, opts: GraphOptions = {}): GraphResult {
  const toleranceM = opts.toleranceM ?? 8;
  const minComponentM = opts.minComponentM ?? 3000;

  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    const la = adj.get(a) ?? [];
    if (!la.includes(b)) la.push(b);
    adj.set(a, la);
  };
  for (const nodes of ways) {
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1], b = nodes[i];
      if (a === b || !coord.has(a) || !coord.has(b)) continue;
      link(a, b);
      link(b, a);
    }
  }

  // Vertices are junctions and line ends; chains of degree-2 nodes between
  // them collapse into one edge.
  const isVertex = (id: number) => adj.get(id)!.length !== 2;
  const rawEdges: { a: number; b: number; nodes: number[] }[] = [];
  const walked = new Set<string>();
  for (const v of adj.keys()) {
    if (!isVertex(v)) continue;
    for (const n of adj.get(v)!) {
      if (walked.has(`${v}:${n}`)) continue;
      const nodes = [v, n];
      let prev = v, cur = n;
      while (!isVertex(cur)) {
        const [x, y] = adj.get(cur)!;
        const next = x === prev ? y : x;
        nodes.push(next);
        prev = cur;
        cur = next;
      }
      walked.add(`${v}:${n}`);
      walked.add(`${cur}:${prev}`);
      rawEdges.push({ a: v, b: cur, nodes });
    }
  }

  // Drop small disconnected fragments (isolated stubs, mapping errors).
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: number, b: number) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  const edgeLen = rawEdges.map((e) => {
    let len = 0;
    for (let i = 1; i < e.nodes.length; i++) len += meters(coord.get(e.nodes[i - 1])!, coord.get(e.nodes[i])!);
    union(e.a, e.b);
    return len;
  });
  const componentLen = new Map<number, number>();
  rawEdges.forEach((e, i) => componentLen.set(find(e.a), (componentLen.get(find(e.a)) ?? 0) + edgeLen[i]));

  const vertexIndex = new Map<number, number>();
  const vertices: number[] = [];
  const edges: [number, number, number[]][] = [];
  const q = (x: number) => Math.round(x * 1e5);
  const vid = (id: number) => {
    let i = vertexIndex.get(id);
    if (i === undefined) {
      i = vertexIndex.size;
      vertexIndex.set(id, i);
      const [lon, lat] = coord.get(id)!;
      vertices.push(q(lon), q(lat));
    }
    return i;
  };
  let pointsIn = 0, pointsKept = 0, km = 0;
  rawEdges.forEach((e, i) => {
    if ((componentLen.get(find(e.a)) ?? 0) < minComponentM) return;
    const line = simplify(e.nodes.map((id) => coord.get(id)!), toleranceM);
    // Delta-encoded 1e-5 degree integers: x0, y0, dx1, dy1, ...
    const enc: number[] = [];
    let px = 0, py = 0;
    for (const [lon, lat] of line) {
      const x = q(lon), y = q(lat);
      enc.push(x - px, y - py);
      px = x;
      py = y;
    }
    pointsIn += e.nodes.length;
    pointsKept += line.length;
    km += edgeLen[i] / 1000;
    edges.push([vid(e.a), vid(e.b), enc]);
  });

  return { json: { v: vertices, e: edges }, edges: edges.length, junctions: vertices.length / 2, km, pointsIn, pointsKept };
}
