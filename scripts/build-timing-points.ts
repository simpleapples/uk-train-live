// Builds data/timing-points.json: coordinates for Network Rail timing points
// that are not stations (junctions, yards, sidings, signals, level
// crossings), so trains reporting there, freight above all, can be drawn.
//
// Source: BPLAN geography (Network Rail's planning data), the last copy on the
// Open Rail Data wiki. Its LOC records give a National Grid reference for
// about half the timing points, a few of them wrong; its NWK records give the
// links between timing points and their lengths. Stations' NaPTAN positions
// are trusted over BPLAN's, and help check it; a point with no usable
// reference is placed along the line between known points on either side.
//
// The download is cached in data/cache/.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { gridToWgs84 } from './lib/osgb.ts';

const URL_GEOGRAPHY = 'https://web.archive.org/web/2025if_/https://wiki.openraildata.com/images/d/dd/Geography_20240602_to_20241214_from_20240524.txt.gz';
const CACHE = new URL('../data/cache/bplan-geography.txt.gz', import.meta.url);
const STATIONS = new URL('../data/stations.json', import.meta.url);
const OUT = new URL('../data/timing-points.json', import.meta.url);
// How far to search the network for known points either side of an unknown one.
const SEARCH_M = 25_000;

type LonLat = [lon: number, lat: number];

async function geography(): Promise<string> {
  if (!existsSync(CACHE)) {
    await mkdir(new URL('.', CACHE), { recursive: true });
    console.log(`downloading ${URL_GEOGRAPHY}`);
    const res = await fetch(URL_GEOGRAPHY);
    if (!res.ok) throw new Error(`BPLAN geography: HTTP ${res.status}`);
    await writeFile(CACHE, Buffer.from(await res.arrayBuffer()));
  }
  return gunzipSync(await readFile(CACHE)).toString('latin1');
}

const known = new Map<string, LonLat>();
const grids = new Map<string, [number, number]>();
const tiplocs = new Set<string>();
const links = new Map<string, Map<string, number>>();
for (const line of (await geography()).split('\n')) {
  const f = line.split('\t');
  if (f[0] === 'LOC' && f[1] === 'A') {
    tiplocs.add(f[2]);
    const [e, n] = [Number(f[6]), Number(f[7])];
    // 999999 and 0 mean "not known"; Great Britain is within 0-700 km east, 0-1300 km north.
    if (e > 0 && n > 0 && e < 700_000 && n < 1_300_000) {
      grids.set(f[2], [e, n]);
      known.set(f[2], gridToWgs84(e, n));
    }
  } else if (f[0] === 'NWK' && f[1] === 'A') {
    // Origin, destination, line code and name, dates, directions, then length in metres.
    const m = Number(f[10]);
    if (!(m > 0) || f[2] === f[3]) continue;
    for (const [a, b] of [[f[2], f[3]], [f[3], f[2]]]) {
      const next = links.get(a) ?? new Map<string, number>();
      next.set(b, Math.min(next.get(b) ?? Infinity, m));
      links.set(a, next);
    }
  }
}
console.log(`${tiplocs.size} timing points, ${known.size} with a grid reference, ${links.size} with network links`);

const stations = JSON.parse(await readFile(STATIONS, 'utf8')) as Record<string, { lat: number; lon: number }>;
for (const [tiploc, s] of Object.entries(stations)) known.set(tiploc, [s.lon, s.lat]);

/** Metres between two nearby points. */
const dist = (a: LonLat, b: LonLat) => {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111_320;
};

// A reference far further from most of its known neighbours than the track
// is long is wrong; some have easting and northing the wrong way round. Two
// wrong neighbours can vouch for each other, so go round until it settles.
const fits = (p: LonLat, tiploc: string) => {
  const near = [...(links.get(tiploc) ?? [])].filter(([t]) => known.has(t));
  const ok = near.filter(([t, m]) => dist(p, known.get(t)!) <= Math.max(2.5 * m, m + 2000)).length;
  return !near.length || ok * 2 >= near.length;
};
let swapped = 0;
let dropped = 0;
for (let changed = true, round = 0; changed && round < 5; round++) {
  changed = false;
  for (const [tiploc, [e, n]] of grids) {
    if (stations[tiploc] || !known.has(tiploc) || fits(known.get(tiploc)!, tiploc)) continue;
    changed = true;
    if (fits(gridToWgs84(n, e), tiploc)) {
      known.set(tiploc, gridToWgs84(n, e));
      grids.set(tiploc, [n, e]);
      swapped++;
    } else {
      known.delete(tiploc);
      dropped++;
    }
  }
}
console.log(`grid references: ${swapped} swapped back, ${dropped} dropped as inconsistent`);

// Unknown points: walk the network to the nearest known points; take the
// closest pair reached through different neighbours whose straight-line
// distance agrees with going through this point, and place it between them.
const placed = new Map<string, LonLat>();
for (const tiploc of tiplocs) {
  if (known.has(tiploc) || !links.has(tiploc)) continue;
  const best = new Map<string, number>([[tiploc, 0]]);
  const via = new Map<string, string>();
  const queue: [string, number][] = [[tiploc, 0]];
  const reached: { t: string; d: number; via: string }[] = [];
  while (queue.length) {
    queue.sort((a, b) => a[1] - b[1]);
    const [t, d] = queue.shift()!;
    if (d > (best.get(t) ?? Infinity) || d > SEARCH_M) continue;
    if (t !== tiploc && known.has(t)) {
      reached.push({ t, d, via: via.get(t)! });
      continue;
    }
    for (const [next, m] of links.get(t) ?? []) {
      const nd = d + m;
      if (nd < (best.get(next) ?? Infinity)) {
        best.set(next, nd);
        via.set(next, t === tiploc ? next : via.get(t)!);
        queue.push([next, nd]);
      }
    }
  }
  let pick: { a: (typeof reached)[0]; b: (typeof reached)[0] } | undefined;
  for (const a of reached) {
    for (const b of reached) {
      if (a.via === b.via || a.t >= b.t) continue;
      const along = a.d + b.d;
      const straight = dist(known.get(a.t)!, known.get(b.t)!);
      if (straight > along * 1.2 + 500 || straight < along * 0.5) continue;
      if (!pick || along < pick.a.d + pick.b.d) pick = { a, b };
    }
  }
  if (!pick) continue;
  const [pa, pb] = [known.get(pick.a.t)!, known.get(pick.b.t)!];
  const f = pick.a.d / (pick.a.d + pick.b.d);
  placed.set(tiploc, [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f]);
}
console.log(`${placed.size} more placed between known neighbours`);

// Stations already have NaPTAN coordinates; keep the rest.
const out: Record<string, LonLat> = {};
for (const [tiploc, [lon, lat]] of [...known, ...placed].sort(([a], [b]) => a.localeCompare(b))) {
  if (!stations[tiploc]) out[tiploc] = [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
}
await writeFile(OUT, `${JSON.stringify(out)}\n`);
console.log(`wrote ${Object.keys(out).length} timing points (not stations) to data/timing-points.json`);
