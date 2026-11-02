// Closes gaps in data/track.json.gz. The vector tiles it is built from cut and
// simplify lines, so a branch can end just short of the line it joins (the
// Caterham branch at Purley). A line end close to other track, with no short
// way round by rail, is joined to it. Run after `npm run data:track`.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { distanceM, lineLengthM, type LonLat, type Snap, TrackNetwork, type TrackJson } from '../src/engine/track.ts';

const FILE = new URL('../data/track.json.gz', import.meta.url);
const JOIN_WITHIN_M = 100;
// Connected within this by rail already: a siding beside the main line, not a gap.
const LONG_WAY_ROUND_M = 1500;

const json = JSON.parse(gunzipSync(readFileSync(FILE)).toString('utf8')) as TrackJson;
const track = new TrackNetwork(json);
const vertex = (v: number): LonLat => [json.v[2 * v] / 1e5, json.v[2 * v + 1] / 1e5];

const degree = new Int32Array(json.v.length / 2);
const edgeOf = new Int32Array(json.v.length / 2);
json.e.forEach(([a, b], i) => {
  degree[a]++;
  degree[b]++;
  edgeOf[a] = i;
  edgeOf[b] = i;
});

const decode = (enc: number[]) => {
  const out: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < enc.length; i += 2) {
    x += enc[i];
    y += enc[i + 1];
    out.push([x, y]);
  }
  return out;
};
const encode = (pts: [number, number][]) => {
  const out: number[] = [];
  let [x, y] = [0, 0];
  for (const [px, py] of pts) {
    out.push(px - x, py - y);
    [x, y] = [px, py];
  }
  return out;
};

const joins: { v: number; snap: Snap }[] = [];
for (let v = 0; v < degree.length; v++) {
  if (degree[v] !== 1) continue;
  const p = vertex(v);
  const near = track.snap(p, JOIN_WITHIN_M, 8).filter((s) => s.edge !== edgeOf[v]).sort((a, b) => a.dist - b.dist)[0];
  if (!near) continue;
  const line = track.route(p, near.point, 2, 2);
  if (line && lineLengthM(line) < Math.max(LONG_WAY_ROUND_M, near.dist * 5)) continue;
  joins.push({ v, snap: near });
}

// Split each edge at the points joined to it, then add the joins.
const byEdge = new Map<number, { v: number; snap: Snap }[]>();
for (const j of joins) byEdge.set(j.snap.edge, [...(byEdge.get(j.snap.edge) ?? []), j]);
const vertices = [...json.v];
const edges: TrackJson['e'] = [];
const extra: TrackJson['e'] = [];
json.e.forEach((edge, i) => {
  const onThis = byEdge.get(i);
  if (!onThis) {
    edges.push(edge);
    return;
  }
  const pts = decode(edge[2]);
  // Metres along the edge to each point, as Snap.offset measures them.
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + distanceM([pts[k - 1][0] / 1e5, pts[k - 1][1] / 1e5], [pts[k][0] / 1e5, pts[k][1] / 1e5]));
  let from = edge[0];
  let rest = pts;
  let restCum = cum;
  for (const j of [...onThis].sort((a, b) => a.snap.offset - b.snap.offset)) {
    const at: [number, number] = [Math.round(j.snap.point[0] * 1e5), Math.round(j.snap.point[1] * 1e5)];
    const k = restCum.findIndex((c) => c >= j.snap.offset);
    if (k <= 0) continue;
    const id = vertices.length / 2;
    vertices.push(at[0], at[1]);
    edges.push([from, id, encode([...rest.slice(0, k), at])]);
    extra.push([j.v, id, encode([[json.v[2 * j.v], json.v[2 * j.v + 1]], at])]);
    from = id;
    rest = [at, ...rest.slice(k)];
    restCum = [j.snap.offset, ...restCum.slice(k)];
  }
  edges.push([from, edge[1], encode(rest)]);
});

writeFileSync(FILE, gzipSync(JSON.stringify({ v: vertices, e: [...edges, ...extra] })));
console.log(`joined ${extra.length} line ends to track within ${JOIN_WITHIN_M} m`);
for (const j of joins.slice(0, 40)) console.log(`  ${vertex(j.v)[1].toFixed(4)},${vertex(j.v)[0].toFixed(4)}  ${Math.round(j.snap.dist)} m`);
