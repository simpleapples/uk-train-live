// Builds data/timing-points.json: positions and proper names for Network Rail
// timing points that are not stations (junctions, yards, sidings, signals,
// level crossings), so trains reporting there, freight above all, can be drawn.
//
// Source: BPLAN geography (Network Rail's planning data), the last copy on the
// Open Rail Data wiki. Its LOC records give a National Grid reference for
// about half the timing points, and many of those are placeholders or wrong;
// its NWK records give the links between timing points and their lengths.
//
// So nothing is taken on trust but NaPTAN's stations. Working out from them:
//  - a grid reference is accepted if it agrees with the accepted points it
//    links to (some have easting and northing swapped, which is put right);
//  - one with nothing to check against must lie on the track;
//  - a point with no usable reference, or one well off the track, is placed on
//    the track between accepted points either side of it, by link length;
//  - the timetable (state/schedule-full.json.gz, if live mode has downloaded
//    it) then checks the lot: a point that would need trains to run faster
//    than any can is dropped, and points the links could not place are placed
//    by when trains pass them.
//  - a dead end (depot, yard) is placed at a place of that name in OpenStreetMap
//    near its neighbour, and metro stops at the stop of that name.
// Anything else stays unknown: better no position than a wrong one.
// `npm run data:audit` reports what is left.
//
// The download is cached in data/cache/.
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip, gunzipSync } from 'node:zlib';
import { distanceM, lineLengthM, type LonLat, TrackNetwork } from '../src/engine/track.ts';
import { gridToWgs84 } from './lib/osgb.ts';

const URL_GEOGRAPHY = 'https://web.archive.org/web/2025if_/https://wiki.openraildata.com/images/d/dd/Geography_20240602_to_20241214_from_20240524.txt.gz';
const CACHE = new URL('../data/cache/bplan-geography.txt.gz', import.meta.url);
const OUT = new URL('../data/timing-points.json', import.meta.url);
// How far to search the network for accepted points either side of an unknown one.
const SEARCH_M = 25_000;
const ON_TRACK_M = 200;
const OFF_TRACK_M = 400;
// A reference this far off still names the line nearby, if nothing better turns up.
const ROUGH_SNAP_M = 1500;
// Faster than this between two timing points, in a straight line, cannot be right (HS1 runs at 300 km/h).
const MAX_KMH = 320;
const SPEED_MARGIN = 1.3;
const MIN_LEG_MINUTES = 2;
const TIMETABLE = new URL('../state/schedule-full.json.gz', import.meta.url);
const OSM_CACHE = new URL('../data/cache/osm-places/', import.meta.url);
const GB = '49.8,-8.7,61,1.9';
// One tag at a time: a query for them all at once times out.
const OSM_QUERIES: Record<string, string> = {
  '1.json': `nwr["landuse"="railway"]["name"](${GB})`,
  '2.json': `nwr["railway"="yard"]["name"](${GB})`,
  '4.json': `nwr["railway"="service_station"]["name"](${GB})`,
  // Tyne & Wear Metro and Sheffield Supertram stops, which NaPTAN's rail list leaves out.
  'metro-tyne.json': 'nwr["railway"~"^(station|halt|tram_stop)$"]["name"](54.85,-1.8,55.1,-1.3)',
  'metro-sheffield.json': 'nwr["railway"~"^(station|halt|tram_stop)$"]["name"](53.3,-1.55,53.48,-1.28)',
};
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const METRO_OPERATORS = new Set(['TW', 'SJ']);
// Words that say what a place is, not which one.
const GENERIC = new Set(`sidings siding sdgs sdg depot yard carriage cs chs csd reception recp holding emu dmu hst tmd lmd emd iep up down dn north south
  east west nth sth the and of signal sig stop board junction jn jcn gbrf ews dbs dbc fl flt fhh flhh drs colas freightliner new old line loop goods
  gds traction maintenance light works centre terminal railway rail station train care service servicing international`.split(/\s+/));

const read = async <T>(path: string) => JSON.parse(await readFile(new URL(`../data/${path}`, import.meta.url), 'utf8')) as T;
const inGreatBritain = ([lon, lat]: LonLat) => lat > 49.8 && lat < 61 && lon > -8.7 && lon < 1.9;

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

// ---- Read BPLAN ----

const names = new Map<string, string>();
const references = new Map<string, [e: number, n: number]>();
const links = new Map<string, Map<string, number>>();
for (const line of (await geography()).split('\n')) {
  const f = line.split('\t');
  if (f[0] === 'LOC' && f[1] === 'A') {
    if (f[3]?.trim()) names.set(f[2], f[3].trim());
    const [e, n] = [Number(f[6]), Number(f[7])];
    if (e > 0 && n > 0) references.set(f[2], [e, n]);
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
console.log(`${names.size} timing points, ${references.size} with a grid reference, ${links.size} with network links`);

const stations = await read<Record<string, { name: string; lat: number; lon: number }>>('stations.json');
const track = TrackNetwork.load(new URL('../data/track.json.gz', import.meta.url));

// NaPTAN has no position for the Elizabeth line's own platforms; TfL does.
const tfl = await read<{ lines: Record<string, { routes: string[][] }>; stations: Record<string, { name: string; lat: number; lon: number }> }>('tfl.json');
const TFL_PLATFORMS: Record<string, [line: string, name: string]> = {
  PADTLL: ['elizabeth', 'Paddington'], BONDST: ['elizabeth', 'Bond Street'], TOTCTRD: ['elizabeth', 'Tottenham Court Road'],
  FRNDXR: ['elizabeth', 'Farringdon'], LIVSTLL: ['elizabeth', 'London Liverpool Street'], WCHAPXR: ['elizabeth', 'Whitechapel'],
  CANWHRF: ['elizabeth', 'Canary Wharf'], CUSTMHS: ['elizabeth', 'Custom House'], WOLWXR: ['elizabeth', 'Woolwich'],
  ABWDXR: ['elizabeth', 'Abbey Wood'], BARKRIV: ['suffragette', 'Barking Riverside'],
};
const platforms = new Map<string, LonLat>();
for (const [tiploc, [line, name]] of Object.entries(TFL_PLATFORMS)) {
  const id = tfl.lines[line]?.routes.flat().find((s) => tfl.stations[s]?.name === name);
  if (id) platforms.set(tiploc, [tfl.stations[id].lon, tfl.stations[id].lat]);
  else console.log(`no TfL position for ${tiploc} (${name})`);
}

// ---- Accept grid references, working out from the stations ----

const accepted = new Map<string, LonLat>(platforms);
for (const [tiploc, s] of Object.entries(stations)) if (inGreatBritain([s.lon, s.lat])) accepted.set(tiploc, [s.lon, s.lat]);
const anchors = accepted.size;

const position = (e: number, n: number): LonLat | null => {
  if (e >= 700_000 || n >= 1_300_000) return null;
  const p = gridToWgs84(e, n);
  return inGreatBritain(p) ? p : null;
};
/** How many accepted neighbours a position agrees with, of how many, given the track between them. */
const agreement = (p: LonLat, tiploc: string) => {
  const near = [...(links.get(tiploc) ?? [])].filter(([t]) => accepted.has(t));
  return { near: near.length, ok: near.filter(([t, m]) => distanceM(p, accepted.get(t)!) <= Math.max(2 * m, m + 1000)).length };
};
const agrees = (p: LonLat | null, tiploc: string) => {
  if (!p) return false;
  const { near, ok } = agreement(p, tiploc);
  return near > 0 && ok * 2 >= near;
};

let swapped = 0;
const pending = new Map([...references].filter(([t]) => !accepted.has(t)));
const rejected = new Set<string>();
for (let changed = true; changed;) {
  changed = false;
  for (const [tiploc, [e, n]] of pending) {
    if (agreement([0, 0], tiploc).near === 0) continue;
    const direct = position(e, n);
    const flipped = position(n, e);
    if (agrees(direct, tiploc)) {
      accepted.set(tiploc, direct!);
    } else if (agrees(flipped, tiploc)) {
      accepted.set(tiploc, flipped!);
      swapped++;
    } else {
      rejected.add(tiploc);
    }
    pending.delete(tiploc);
    changed = true;
  }
}
// Nothing accepted to check these against: they must at least lie on the track.
let onTrackOnly = 0;
for (const [tiploc, [e, n]] of pending) {
  const p = position(e, n);
  if (p && track.snapPoint(p, ON_TRACK_M)) {
    accepted.set(tiploc, p);
    onTrackOnly++;
  } else {
    rejected.add(tiploc);
  }
}
console.log(`grid references: ${accepted.size - anchors} accepted (${swapped} swapped back, ${onTrackOnly} on track with nothing to check against), ${rejected.size} rejected`);

// ---- Place the rest on the track between accepted neighbours ----

/** Accepted points reached along the network without passing another, and which neighbour led there. */
function reachable(from: string, usable: (t: string) => boolean): { t: string; d: number; via: string }[] {
  const best = new Map<string, number>([[from, 0]]);
  const via = new Map<string, string>();
  const queue: [string, number][] = [[from, 0]];
  const reached: { t: string; d: number; via: string }[] = [];
  while (queue.length) {
    queue.sort((a, b) => a[1] - b[1]);
    const [t, d] = queue.shift()!;
    if (d > (best.get(t) ?? Infinity) || d > SEARCH_M) continue;
    if (t !== from && usable(t)) {
      reached.push({ t, d, via: via.get(t)! });
      continue;
    }
    for (const [next, m] of links.get(t) ?? []) {
      const nd = d + m;
      if (nd < (best.get(next) ?? Infinity)) {
        best.set(next, nd);
        via.set(next, t === from ? next : via.get(t)!);
        queue.push([next, nd]);
      }
    }
  }
  return reached;
}

function pointAlong(line: LonLat[], f: number): LonLat {
  let left = lineLengthM(line) * f;
  for (let i = 1; i < line.length; i++) {
    const step = distanceM(line[i - 1], line[i]);
    if (step >= left) {
      const k = step ? left / step : 0;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * k, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * k];
    }
    left -= step;
  }
  return line[line.length - 1];
}

/** Between the closest pair of accepted points on different sides whose distance apart agrees with going through this one. */
function between(tiploc: string, usable: (t: string) => boolean): LonLat | null {
  const reached = reachable(tiploc, usable);
  let pick: { a: (typeof reached)[0]; b: (typeof reached)[0] } | undefined;
  for (const a of reached) {
    for (const b of reached) {
      if (a.via === b.via || a.t >= b.t) continue;
      const along = a.d + b.d;
      const apart = distanceM(accepted.get(a.t)!, accepted.get(b.t)!);
      if (apart > along * 1.2 + 500 || apart < along * 0.5) continue;
      if (!pick || along < pick.a.d + pick.b.d) pick = { a, b };
    }
  }
  if (!pick) return null;
  const [pa, pb] = [accepted.get(pick.a.t)!, accepted.get(pick.b.t)!];
  const along = pick.a.d + pick.b.d;
  const f = pick.a.d / along;
  const line = track.route(pa, pb, OFF_TRACK_M, 6);
  if (!line || line.length < 2) return null;
  const l = lineLengthM(line);
  return l > along * 0.6 && l < along * 1.6 ? pointAlong(line, f) : null;
}

// References well off the track are often rough: prefer the track where the neighbours allow it.
const isStation = (t: string) => Boolean(stations[t]) || platforms.has(t);
const rough = new Set([...accepted.keys()].filter((t) => !isStation(t) && !track.snapPoint(accepted.get(t)!, OFF_TRACK_M)));
const firm = (t: string) => accepted.has(t) && !rough.has(t);
const placed = new Map<string, LonLat>();
let moved = 0;
for (const tiploc of new Set([...links.keys(), ...names.keys()])) {
  if (firm(tiploc) || isStation(tiploc) || !links.has(tiploc)) continue;
  const got = between(tiploc, firm);
  if (!got) continue;
  placed.set(tiploc, got);
  if (rough.has(tiploc)) moved++;
}
for (const [t, p] of placed) accepted.set(t, p);
console.log(`placed on the track between neighbours: ${placed.size} (${moved} of them replacing a rough reference)`);

// Rough references the neighbours could not improve: the nearest track if there
// is one close by. If not, see below whether the timetable can place them.
const offTheMap = new Map<string, LonLat>();
let snapped = 0;
for (const t of rough) {
  const p = accepted.get(t);
  if (!p || placed.has(t)) continue;
  const s = track.snapPoint(p, ROUGH_SNAP_M);
  if (s) {
    accepted.set(t, s);
    snapped++;
  } else {
    offTheMap.set(t, p);
    accepted.delete(t);
  }
}
console.log(`${snapped} rough references moved to the nearest track, ${offTheMap.size} too far from any`);

// ---- Check against the timetable, and place what is left by passing times ----

interface Run {
  atoc: string;
  /** Above this, in km/h, a leg cannot be right: the train's top speed and a margin. */
  limit: number;
  stops: { t: string; at: number }[];
}

/** Each distinct order of places a train runs through, with a time in minutes at each. */
async function timetableRuns(): Promise<Run[]> {
  if (!existsSync(TIMETABLE)) {
    console.log('no timetable in state/: skipping its checks');
    return [];
  }
  const time = (v: unknown) => (typeof v === 'string' && v.length >= 4 ? Number(v.slice(0, 2)) * 60 + Number(v.slice(2, 4)) + (v[4] === 'H' ? 0.5 : 0) : null);
  const seen = new Set<string>();
  const runs: Run[] = [];
  for await (const line of createInterface({ input: createReadStream(TIMETABLE).pipe(createGunzip()), crlfDelay: Infinity })) {
    if (!line.startsWith('{"JsonScheduleV1"')) continue;
    const record = JSON.parse(line).JsonScheduleV1;
    const g = record.schedule_segment;
    if (!g?.CIF_power_type || !g.schedule_location?.length) continue;
    const key = g.schedule_location.map((l: { tiploc_code: string }) => l.tiploc_code).join();
    if (seen.has(key)) continue;
    seen.add(key);
    const run: { t: string; at: number }[] = [];
    let offset = 0;
    let last = -1;
    for (const l of g.schedule_location) {
      const at = time(l.departure) ?? time(l.pass) ?? time(l.arrival);
      if (at === null) continue;
      if (at < last) offset += 24 * 60;
      last = at;
      run.push({ t: l.tiploc_code.trim(), at: at + offset });
    }
    const mph = Number(g.CIF_speed);
    runs.push({ atoc: record.atoc_code ?? '', limit: mph > 0 ? Math.min(MAX_KMH, mph * 1.609 * SPEED_MARGIN) : MAX_KMH, stops: run });
  }
  return runs;
}

const runs = await timetableRuns();
console.log(`timetable: ${runs.length} distinct runs`);

/**
 * Legs too fast for most trains on them (one oddly timed train proves nothing),
 * and how much of the running through each point they are.
 */
function survey(): { bad: string[]; shares: Map<string, number> } {
  const legs = new Map<string, { n: number; bad: number }>();
  const count = (t: string, wrong: boolean) => {
    const c = legs.get(t) ?? { n: 0, bad: 0 };
    c.n++;
    if (wrong) c.bad++;
    legs.set(t, c);
  };
  for (const { limit, stops } of runs) {
    let prev: { t: string; at: number } | undefined;
    for (const stop of stops) {
      if (!accepted.has(stop.t)) continue;
      if (prev && prev.t !== stop.t && stop.at - prev.at >= MIN_LEG_MINUTES) {
        // Timetable times are rounded to the half minute.
        const kmh = distanceM(accepted.get(prev.t)!, accepted.get(stop.t)!) / 1000 / ((stop.at - prev.at + 0.5) / 60);
        const wrong = kmh > limit;
        count(prev.t, wrong);
        count(stop.t, wrong);
        count(`${prev.t}>${stop.t}`, wrong);
      }
      prev = stop;
    }
  }
  return {
    bad: [...legs].filter(([id, c]) => id.includes('>') && c.bad * 2 > c.n).map(([id]) => id),
    shares: new Map([...legs].map(([t, c]) => [t, c.bad / c.n])),
  };
}

/**
 * Drops points the timetable contradicts. Of the two ends of an impossible leg,
 * the one with more of its running contradicted is wrong (stations are right);
 * worst first, as a wrong point spoils its neighbours' legs too.
 */
function dropContradicted(): number {
  let dropped = 0;
  for (let round = 0; round < 40; round++) {
    const { bad, shares } = survey();
    const blamed = new Set<string>();
    for (const leg of bad) {
      const [a, b] = leg.split('>');
      const pick = isStation(a) ? b : isStation(b) ? a : (shares.get(a) ?? 0) >= (shares.get(b) ?? 0) ? a : b;
      if (!isStation(pick)) blamed.add(pick);
    }
    if (!blamed.size) break;
    const worst = [...blamed].sort((x, y) => (shares.get(y) ?? 0) - (shares.get(x) ?? 0));
    for (const t of worst.slice(0, Math.ceil(worst.length / 3))) {
      accepted.delete(t);
      dropped++;
    }
  }
  return dropped;
}

/** On the track between the accepted points trains most often pass it between, by the median share of the time. */
function placeByTimetable(): number {
  const samples = new Map<string, Map<string, number[]>>();
  for (const { stops } of runs) {
    let prev: { t: string; at: number } | undefined;
    let gap: { t: string; at: number }[] = [];
    for (const stop of stops) {
      if (!accepted.has(stop.t)) {
        if (prev) gap.push(stop);
        continue;
      }
      if (prev && gap.length && stop.at > prev.at) {
        for (const g of gap) {
          const pair = samples.get(g.t) ?? new Map<string, number[]>();
          const id = `${prev.t}>${stop.t}`;
          pair.set(id, [...(pair.get(id) ?? []), (g.at - prev.at) / (stop.at - prev.at)]);
          samples.set(g.t, pair);
        }
      }
      prev = stop;
      gap = [];
    }
  }
  const found = new Map<string, LonLat>();
  for (const [t, pairs] of samples) {
    const [id, shares] = [...pairs].sort((a, b) => b[1].length - a[1].length)[0];
    const [a, b] = id.split('>');
    const [pa, pb] = [accepted.get(a)!, accepted.get(b)!];
    const f = [...shares].sort((x, y) => x - y)[Math.floor(shares.length / 2)];
    const line = track.route(pa, pb, OFF_TRACK_M, 6);
    // No route (a line the map does not have): leave it out. The route between
    // its neighbours is still drawn, where a guess off the track would break it.
    if (line && line.length > 1 && lineLengthM(line) < distanceM(pa, pb) * 2.5 + 5000) found.set(t, pointAlong(line, f));
  }
  for (const [t, p] of found) accepted.set(t, p);
  return found.size;
}

if (runs.length) {
  for (let pass = 1; pass <= 3; pass++) {
    const dropped = dropContradicted();
    const byTimes = placeByTimetable();
    console.log(`timetable pass ${pass}: ${dropped} contradicted and dropped; ${byTimes} placed on the track by passing times`);
    if (!dropped && !byTimes) break;
  }
  console.log(`after the last placing: ${dropContradicted()} more dropped`);
}

// On lines the map does not have (the Tyne & Wear Metro, say) an accepted
// reference is still the best there is.
let kept = 0;
for (const [t, p] of offTheMap) {
  if (accepted.has(t)) continue;
  accepted.set(t, p);
  kept++;
}
console.log(`${kept} references kept off the map's track; ${dropContradicted()} contradicted and dropped`);

// ---- Dead ends and metro stops, from OpenStreetMap's names ----

interface OsmPlace {
  name: string;
  words: Set<string>;
  p: LonLat;
}

async function osmPlaces(file: string, query: string): Promise<OsmPlace[]> {
  const cached = new URL(file, OSM_CACHE);
  const usable = async () => existsSync(cached) && (await readFile(cached, 'utf8')).includes('"elements"');
  if (!(await usable())) {
    await mkdir(OSM_CACHE, { recursive: true });
    for (const server of OVERPASS) {
      try {
        const res = await fetch(server, { method: 'POST', body: new URLSearchParams({ data: `[out:json][timeout:120];${query};out center tags;` }), headers: { 'User-Agent': 'train-live-prototype/0.1 (rail map prototype)' }, signal: AbortSignal.timeout(150_000) });
        const text = await res.text();
        if (res.ok && text.includes('"elements"')) {
          await writeFile(cached, text);
          break;
        }
      } catch { /* the next server */ }
    }
  }
  if (!(await usable())) {
    console.log(`no OpenStreetMap data for ${file}`);
    return [];
  }
  const { elements } = JSON.parse(await readFile(cached, 'utf8')) as { elements: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags: { name: string } }[] };
  return elements.flatMap((e) => {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    return lat === undefined || lon === undefined ? [] : [{ name: e.tags.name, words: wordsOf(e.tags.name), p: [lon, lat] as LonLat }];
  });
}

function wordsOf(name: string): Set<string> {
  return new Set(name.toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, '').split(/[^a-z0-9]+/).filter(Boolean));
}

const distinctive = (name: string) => [...wordsOf(name)].filter((w) => !GENERIC.has(w) && !/\d/.test(w));

// Where each place appears in the timetable.
const runsThrough = new Map<string, { run: Run; i: number }[]>();
for (const run of runs) {
  run.stops.forEach((s, i) => {
    const list = runsThrough.get(s.t);
    if (list) list.push({ run, i });
    else runsThrough.set(s.t, [{ run, i }]);
  });
}

/** Accepted points this one links to, or runs next to in the timetable, and how far away they can be. */
function nearbyAnchors(tiploc: string): { p: LonLat; within: number }[] {
  const found = reachable(tiploc, (t) => accepted.has(t)).map((r) => ({ p: accepted.get(r.t)!, within: r.d * 1.5 + 1500 }));
  if (found.length) return found;
  const seen = runsThrough.get(tiploc)?.[0];
  if (seen) {
    const { run: { stops }, i } = seen;
    for (const [from, step] of [[i - 1, -1], [i + 1, 1]] as const) {
      for (let k = from; stops[k]; k += step) {
        if (!accepted.has(stops[k].t)) continue;
        const minutes = Math.abs(stops[i].at - stops[k].at);
        if (minutes <= 15) found.push({ p: accepted.get(stops[k].t)!, within: (minutes / 60) * 100_000 + 1500 });
        break;
      }
    }
  }
  return found;
}

/** A train through this point would have to run faster than it can, to or from the nearest accepted points. */
function contradicted(tiploc: string): boolean {
  const p = accepted.get(tiploc)!;
  for (const { run: { stops, limit }, i } of runsThrough.get(tiploc) ?? []) {
    for (const step of [-1, 1]) {
      for (let k = i + step; stops[k]; k += step) {
        if (!accepted.has(stops[k].t) || stops[k].t === tiploc) continue;
        const minutes = Math.abs(stops[k].at - stops[i].at);
        if (minutes >= MIN_LEG_MINUTES && distanceM(p, accepted.get(stops[k].t)!) / 1000 / ((minutes + 0.5) / 60) > limit) return true;
        break;
      }
    }
  }
  return false;
}

// Only somewhere a name can stand for: a signal or junction near a yard of the same name is not that yard.
const NOT_A_PLACE = /\b(signal|sig|jn|jcn|junction|ground frame|gf|g\.f\.|crossing|lc|l\.c\.|stop board|loop|crossover|turnback)\b/i;
const depots = (await Promise.all(Object.entries(OSM_QUERIES).filter(([f]) => !f.startsWith('metro')).map(([f, q]) => osmPlaces(f, q)))).flat();
const depotsByWord = new Map<string, OsmPlace[]>();
for (const place of depots) for (const w of place.words) depotsByWord.set(w, [...(depotsByWord.get(w) ?? []), place]);
let namedPlaces = 0;
const fromOsm: string[] = [];
for (const [tiploc, name] of names) {
  if (accepted.has(tiploc) || NOT_A_PLACE.test(name)) continue;
  const wanted = distinctive(name);
  const candidates = new Set(wanted.flatMap((w) => depotsByWord.get(w) ?? []));
  if (!candidates.size) continue;
  const anchors = nearbyAnchors(tiploc);
  if (!anchors.length) continue;
  let best: { p: LonLat; score: number; d: number; from: LonLat; within: number } | undefined;
  for (const place of candidates) {
    const score = wanted.filter((w) => place.words.has(w)).length;
    for (const a of anchors) {
      const d = distanceM(place.p, a.p);
      if (d <= a.within && (!best || score > best.score || (score === best.score && d < best.d))) best = { p: place.p, score, d, from: a.p, within: a.within };
    }
  }
  if (!best) continue;
  // It must be on the track, and reachable from its neighbour along it.
  const on = track.snapPoint(best.p, OFF_TRACK_M);
  const line = on && track.route(best.from, on, OFF_TRACK_M, 6);
  if (!on || !line || lineLengthM(line) > best.within * 2) continue;
  accepted.set(tiploc, on);
  fromOsm.push(tiploc);
}
for (const t of fromOsm) {
  if (contradicted(t)) accepted.delete(t);
  else namedPlaces++;
}

const metro = [...await osmPlaces('metro-tyne.json', OSM_QUERIES['metro-tyne.json']), ...await osmPlaces('metro-sheffield.json', OSM_QUERIES['metro-sheffield.json'])];
const onMetro = new Set(runs.filter((r) => METRO_OPERATORS.has(r.atoc)).flatMap((r) => r.stops.map((s) => s.t)));
let metroStops = 0;
for (const tiploc of onMetro) {
  const name = names.get(tiploc);
  if (accepted.has(tiploc) || !name) continue;
  const wanted = [...wordsOf(name.replace(/\(.*\)/, ''))].filter((w) => !['metro', 'station'].includes(w));
  const place = metro.find((m) => {
    const words = [...m.words].filter((w) => !['metro', 'station', 'tram', 'stop'].includes(w));
    return words.length === wanted.length && wanted.every((w) => m.words.has(w));
  });
  if (!place) continue;
  accepted.set(tiploc, place.p);
  if (contradicted(tiploc)) accepted.delete(tiploc);
  else metroStops++;
}
console.log(`from OpenStreetMap names: ${namedPlaces} depots and yards, ${metroStops} metro stops; ${dropContradicted()} contradicted and dropped`);

// Dead ends and islands with no position: left out on purpose.
const out = { points: {} as Record<string, LonLat>, names: Object.fromEntries([...names].sort(([a], [b]) => a.localeCompare(b))) };
for (const [tiploc, [lon, lat]] of [...accepted].sort(([a], [b]) => a.localeCompare(b))) {
  if (!stations[tiploc] || platforms.has(tiploc)) out.points[tiploc] = [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
}
await writeFile(OUT, `${JSON.stringify(out)}\n`);
console.log(`wrote ${Object.keys(out.points).length} positions and ${names.size} names to data/timing-points.json`);
