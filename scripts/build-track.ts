// Builds data/track.json.gz: the GB rail network as a compact graph
// (junction vertices + simplified track polylines), so trains can be moved
// along real track instead of straight lines.
//
// Geometry comes from OpenFreeMap's OpenMapTiles vector tiles (OpenStreetMap
// data): reliable to fetch, unlike the public Overpass servers, but lines are
// merged, simplified and cut at tile edges, so junctions are rebuilt here by
// snapping line ends onto nearby track. Tiles are cached in data/cache/;
// pass --refresh to download them again. TRACK_ZOOM (default 10) trades
// precision for download size.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { buildGraph, type LonLat } from './lib/graph.ts';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const USER_AGENT = 'train-live-prototype/0.1 (rail map prototype)';
const ZOOM = Number(process.env.TRACK_ZOOM ?? 10);
const CACHE_DIR = new URL(`../data/cache/openfreemap-z${ZOOM}/`, import.meta.url);
const OUT = new URL('../data/track.json.gz', import.meta.url);
const CONCURRENCY = 6;
// A line end this close to other track is treated as joining it. Tiles
// simplify long lines more than short bridge/tunnel pieces, so the gap at a
// real join can be tens of metres.
const SNAP_M = Number(process.env.TRACK_SNAP_M ?? 25);
const TOLERANCE_M = 8;
const MIN_COMPONENT_M = 3000;

// Latitude bands with the longitudes GB (and Northern Ireland) rail spans,
// leaving out the Republic of Ireland and the Continent where possible.
const BANDS: [south: number, north: number, west: number, east: number][] = [
  [49.85, 51, -5.8, 1.8],
  [51, 52, -5.4, 1.8],
  [52, 53, -5.4, 1.8],
  [53, 54, -5.4, 0.5],
  [54, 55, -8.2, 0],
  [55, 56, -6.2, -1.5],
  [56, 57, -6, -2],
  [57, 58.8, -6, -1.7],
];

const lon2x = (lon: number) => ((lon + 180) / 360) * 2 ** ZOOM;
const lat2y = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** ZOOM;
};
const x2lon = (x: number) => (x / 2 ** ZOOM) * 360 - 180;
const y2lat = (y: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** ZOOM));

const tiles = new Map<string, [number, number]>();
for (const [s, n, w, e] of BANDS) {
  for (let x = Math.floor(lon2x(w)); x <= Math.floor(lon2x(e)); x++) {
    for (let y = Math.floor(lat2y(n)); y <= Math.floor(lat2y(s)); y++) tiles.set(`${x}_${y}`, [x, y]);
  }
}

// ---- Download ----

if (process.argv.includes('--refresh')) await rm(CACHE_DIR, { recursive: true, force: true });
await mkdir(CACHE_DIR, { recursive: true });
const tileJson = (await (await fetch(TILEJSON_URL, { headers: { 'User-Agent': USER_AGENT } })).json()) as { tiles: string[] };
const template = tileJson.tiles[0];

const pending = [...tiles.entries()].filter(([key]) => !existsSync(new URL(`${key}.pbf`, CACHE_DIR)));
console.log(`Rail lines at zoom ${ZOOM}: ${tiles.size} tiles, ${pending.length} to download`);
let done = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let item = pending.shift(); item; item = pending.shift()) {
    const [key, [x, y]] = item;
    const url = template.replace('{z}', String(ZOOM)).replace('{x}', String(x)).replace('{y}', String(y));
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
        if (res.status === 204 || res.status === 404) {
          await writeFile(new URL(`${key}.pbf`, CACHE_DIR), new Uint8Array());
          break;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await writeFile(new URL(`${key}.pbf`, CACHE_DIR), new Uint8Array(await res.arrayBuffer()));
        break;
      } catch (err) {
        if (attempt >= 4) throw new Error(`tile ${key}: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (++done % 100 === 0) console.log(`  ${done} tiles downloaded`);
  }
}));

// ---- Decode: running lines only, clipped to their own tile ----

type Pt = [number, number];

/** Liang–Barsky: the part of segment a–b inside [lo, hi]², with its parameter range. */
function clipSegment(a: Pt, b: Pt, lo: number, hi: number): [Pt, Pt, number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - lo], [dx, hi - a[0]], [-dy, a[1] - lo], [dy, hi - a[1]]]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy], t0, t1];
}

function clipLine(pts: Pt[], lo: number, hi: number): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] | null = null;
  for (let i = 1; i < pts.length; i++) {
    const seg = clipSegment(pts[i - 1], pts[i], lo, hi);
    if (!seg) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const [a, b, t0, t1] = seg;
    if (!cur || t0 > 0) {
      if (cur) out.push(cur);
      cur = [a];
    }
    cur.push(b);
    if (t1 < 1) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.filter((l) => l.length >= 2);
}

const lines: LonLat[][] = [];
for (const [key, [tx, ty]] of tiles) {
  const buf = await readFile(new URL(`${key}.pbf`, CACHE_DIR));
  if (!buf.length) continue;
  const layer = new VectorTile(new Pbf(buf)).layers.transportation;
  if (!layer) continue;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const { class: cls, subclass, service } = f.properties;
    if (cls !== 'rail' || subclass !== 'rail' || service) continue;
    for (const ring of f.loadGeometry()) {
      for (const piece of clipLine(ring.map((p) => [p.x, p.y] as Pt), 0, layer.extent)) {
        lines.push(piece.map(([px, py]) => [x2lon(tx + px / layer.extent), y2lat(ty + py / layer.extent)]));
      }
    }
  }
}
console.log(`Decoded ${lines.length} line pieces`);

// ---- Rebuild junctions: snap each line end onto the nearest other track ----

const KX = Math.cos((54.5 * Math.PI) / 180) * 111_320;
const KY = 110_574;
const CELL_M = 250;
const cellOf = (p: LonLat) => [Math.floor((p[0] * KX) / CELL_M), Math.floor((p[1] * KY) / CELL_M)];
const grid = new Map<string, [number, number][]>();
lines.forEach((line, l) => {
  for (let s = 1; s < line.length; s++) {
    const [ax, ay] = cellOf(line[s - 1]), [bx, by] = cellOf(line[s]);
    for (let cx = Math.min(ax, bx); cx <= Math.max(ax, bx); cx++) {
      for (let cy = Math.min(ay, by); cy <= Math.max(ay, by); cy++) {
        const k = `${cx}:${cy}`;
        const cell = grid.get(k);
        if (cell) cell.push([l, s - 1]);
        else grid.set(k, [[l, s - 1]]);
      }
    }
  }
});

// Merged double track often comes out as one string running out along one
// line and back along the other, so a real meeting point can sit mid-string.
// Every line end therefore joins every other line passing within SNAP_M, and
// all the points it joins become one node (union-find over point refs).
const refIds = new Map<string, number>();
const refPoint: LonLat[] = [];
const parentRef: number[] = [];
const ref = (key: string, p: LonLat) => {
  let id = refIds.get(key);
  if (id === undefined) {
    id = refPoint.length;
    refIds.set(key, id);
    refPoint.push(p);
    parentRef.push(id);
  }
  return id;
};
const rootRef = (x: number): number => {
  while (parentRef[x] !== x) x = parentRef[x] = parentRef[parentRef[x]];
  return x;
};
const unionRef = (a: number, b: number) => { parentRef[rootRef(b)] = rootRef(a); };

const inserts = new Map<number, { seg: number; t: number; ref: number }[]>();
let joins = 0;
lines.forEach((line, l) => {
  for (const end of [0, line.length - 1]) {
    const e = line[end];
    const [cx, cy] = cellOf(e);
    const nearest = new Map<number, { seg: number; t: number; dist: number }>();
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const [m, seg] of grid.get(`${gx}:${gy}`) ?? []) {
          if (m === l) continue;
          const a = lines[m][seg], b = lines[m][seg + 1];
          const ax = (a[0] - e[0]) * KX, ay = (a[1] - e[1]) * KY;
          const bx = (b[0] - e[0]) * KX, by = (b[1] - e[1]) * KY;
          const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
          const t = len2 ? Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / len2)) : 0;
          const dist = Math.hypot(ax + t * (bx - ax), ay + t * (by - ay));
          const prev = nearest.get(m);
          if (dist <= SNAP_M && (!prev || dist < prev.dist)) nearest.set(m, { seg, t, dist });
        }
      }
    }
    const here = ref(`v:${l}:${end}`, e);
    for (const [m, { seg, t }] of nearest) {
      joins++;
      const a = lines[m][seg], b = lines[m][seg + 1];
      const segLen = Math.hypot((b[0] - a[0]) * KX, (b[1] - a[1]) * KY);
      // Close to an existing vertex: join there; otherwise split the segment.
      if (t * segLen < 2) unionRef(here, ref(`v:${m}:${seg}`, a));
      else if ((1 - t) * segLen < 2) unionRef(here, ref(`v:${m}:${seg + 1}`, b));
      else {
        const p: LonLat = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        const list = inserts.get(m) ?? [];
        const id = ref(`i:${m}:${list.length}`, p);
        list.push({ seg, t, ref: id });
        inserts.set(m, list);
        unionRef(here, id);
      }
    }
  }
});
// Every point in a joined group takes the group's coordinate.
for (const [key, id] of refIds) {
  if (!key.startsWith('v:')) continue;
  const [, l, i] = key.split(':').map(Number);
  lines[l][i] = refPoint[rootRef(id)];
}
for (const [m, list] of inserts) {
  // Splice from the end so earlier indices stay valid.
  list.sort((x, y) => y.seg - x.seg || y.t - x.t);
  for (const { seg, ref: id } of list) lines[m].splice(seg + 1, 0, refPoint[rootRef(id)]);
}
console.log(`Made ${joins} joins between line ends and neighbouring track`);

// Identical coordinates are the same node.
const coord = new Map<number, LonLat>();
const nodeOf = new Map<string, number>();
const wayNodes = lines.map((line) => line.map((p) => {
  const key = `${p[0]},${p[1]}`;
  let id = nodeOf.get(key);
  if (id === undefined) {
    id = nodeOf.size;
    nodeOf.set(key, id);
    coord.set(id, p);
  }
  return id;
}));

const graph = buildGraph(wayNodes, coord, { toleranceM: TOLERANCE_M, minComponentM: MIN_COMPONENT_M });
await writeFile(OUT, gzipSync(JSON.stringify(graph.json)));
console.log(`Wrote ${graph.edges} track edges (${Math.round(graph.km)} km), ${graph.junctions} junctions, ${graph.pointsKept}/${graph.pointsIn} points kept to data/track.json.gz`);
