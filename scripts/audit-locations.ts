// Checks where trains would be drawn against the timetable and the track, to
// find places in the wrong spot or with no spot. Read-only; run it after
// rebuilding data/timing-points.json or data/track.json.gz:
//   npm run data:audit [-- --date YYYY-MM-DD] [--top N]
// It needs the timetable extract and CORPUS that live mode downloads to state/.
import { existsSync, readFileSync } from 'node:fs';
import { LocationIndex, type StanoxTable, type StationTable, type TimingPointTable } from '../src/engine/locations.ts';
import { PathService } from '../src/engine/paths.ts';
import { distanceM, lineLengthM, type LonLat, TrackNetwork } from '../src/engine/track.ts';
import { londonDate, Timetable } from '../src/schedule/timetable.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const TOP = Number(arg('top') ?? 25);
const date = arg('date') ?? londonDate(Date.now());
// Faster than this between two places, in a straight line, means one is misplaced: the
// fastest train on that leg with a margin, and at most this (HS1 runs at 300 km/h).
const MAX_KMH = 320;
const SPEED_MARGIN = 1.3;
const MIN_LEG_MS = 2 * 60_000;
const DETOUR = 3;
const DETOUR_MIN_M = 5000;
const OFF_TRACK_M = 400;
const TFL_RUN = new Set(['LO', 'XR', 'LT']);

const read = <T>(path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as T;
const stations = read<StationTable>('data/stations.json');
const stanox = read<StanoxTable>(existsSync(new URL('../data/stanox.json', import.meta.url)) ? 'data/stanox.json' : 'state/stanox.json');
const points = read<TimingPointTable>('data/timing-points.json');
const locations = LocationIndex.byStanox(stations, stanox, points);
const track = TrackNetwork.load(new URL('../data/track.json.gz', import.meta.url));

// Off the track, before anything is snapped onto it.
const placedKeys = Object.keys(stanox).filter((k) => locations.get(k));
const offTrack = new Set(placedKeys.filter((k) => {
  const p = locations.get(k)!;
  return !track.snapPoint([p.lon, p.lat], OFF_TRACK_M);
}));
locations.snapTo((lon, lat) => track.snapPoint([lon, lat], OFF_TRACK_M));
const paths = new PathService(locations, track);

const timetable = await Timetable.load(fileURLToPathSafe('../state/schedule-full.json.gz'), [date], { name: (k) => locations.name(k) });
function fileURLToPathSafe(rel: string) {
  return new URL(rel, import.meta.url).pathname;
}

interface Leg { from: string; to: string; trains: number; minMs: number; limit: number }
const legs = new Map<string, Leg>();
const trainsAt = new Map<string, number>();
const unplaced = new Map<string, { trains: number; calls: number; last: number }>();
let stopCount = 0;
let placedCount = 0;
let fullyPlaced = 0;
let counted = 0;
const schedules = timetable.schedules();
for (const [uid, d] of schedules) {
  const stops = timetable.plannedStops(uid, d) ?? [];
  // Buses and ships have no power type; TfL's own trains are drawn from TfL's feed.
  const info = timetable.byUid(uid, d);
  if (!info?.service?.power || TFL_RUN.has(info.atoc)) continue;
  counted++;
  let prev: { key: string; at: number } | undefined;
  let whole = true;
  stops.forEach((s, i) => {
    stopCount++;
    trainsAt.set(s.key, (trainsAt.get(s.key) ?? 0) + 1);
    if (!locations.get(s.key)) {
      whole = false;
      const u = unplaced.get(s.key) ?? { trains: 0, calls: 0, last: 0 };
      u.trains++;
      if (s.call) u.calls++;
      if (i === stops.length - 1) u.last++;
      unplaced.set(s.key, u);
      return;
    }
    placedCount++;
    const arr = s.arr ?? s.dep;
    if (prev && arr !== undefined && prev.key !== s.key) {
      const id = `${prev.key}>${s.key}`;
      const leg = legs.get(id) ?? { from: prev.key, to: s.key, trains: 0, minMs: Infinity, limit: 0 };
      leg.trains++;
      leg.minMs = Math.min(leg.minMs, arr - prev.at);
      const mph = Number(info.service?.speed);
      leg.limit = Math.max(leg.limit, mph > 0 ? Math.min(MAX_KMH, mph * 1.609 * SPEED_MARGIN) : MAX_KMH);
      legs.set(id, leg);
    }
    const dep = s.dep ?? s.arr;
    if (dep !== undefined) prev = { key: s.key, at: dep };
  });
  if (whole) fullyPlaced++;
}

const name = (k: string) => locations.name(k) ?? k;
const coord = (k: string): LonLat => {
  const p = locations.get(k)!;
  return [p.lon, p.lat];
};
const kmh = (m: number, ms: number) => Math.round((m / (ms / 1000)) * 3.6);
const tooFast: (Leg & { d: number; v: number })[] = [];
const noPath: (Leg & { d: number })[] = [];
const detours: (Leg & { d: number; l: number })[] = [];
const blame = new Map<string, number>();
const addBlame = (k: string, n: number) => blame.set(k, (blame.get(k) ?? 0) + n);
let checked = 0;
for (const leg of legs.values()) {
  const d = distanceM(coord(leg.from), coord(leg.to));
  // Timetable times are rounded to the half minute.
  if (leg.minMs >= MIN_LEG_MS && kmh(d, leg.minMs + 30_000) > leg.limit) {
    tooFast.push({ ...leg, d, v: kmh(d, leg.minMs + 30_000) });
    addBlame(leg.from, leg.trains);
    addBlame(leg.to, leg.trains);
  }
  // As PathService does: no route, or one so long it must be wrong, is drawn straight.
  const line = paths.between(leg.from, leg.to);
  const routed = track.route(coord(leg.from), coord(leg.to));
  if (d > 1000 && (!routed || routed.length < 2 || lineLengthM(routed) > d * 2.5 + 5000)) {
    noPath.push({ ...leg, d });
  } else if (line) {
    const l = lineLengthM(line);
    if (l > DETOUR * d && l > DETOUR_MIN_M) detours.push({ ...leg, d, l });
  }
  if (++checked % 5000 === 0) console.error(`${checked}/${legs.size} legs`);
}

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const byTrains = <T extends { trains: number }>(a: T, b: T) => b.trains - a.trains;
console.log(`${date}: ${counted} schedules (no buses or TfL-run trains), ${legs.size} distinct legs`);
console.log(`stops placed: ${placedCount}/${stopCount} (${((placedCount / stopCount) * 100).toFixed(1)}%); schedules with every stop placed: ${fullyPlaced} (${((fullyPlaced / counted) * 100).toFixed(1)}%)`);
const offUsed = [...offTrack].filter((k) => trainsAt.has(k)).sort((a, b) => trainsAt.get(b)! - trainsAt.get(a)!);
console.log(`\nMore than ${OFF_TRACK_M} m from any track: ${offTrack.size} places, ${offUsed.length} used today`);
for (const k of offUsed.slice(0, TOP)) console.log(`  ${String(trainsAt.get(k)).padStart(5)} trains  ${name(k)} (${k})  ${locations.get(k)!.timingPoint ? 'timing point' : 'station'}`);
console.log(`\nImpossible legs (too fast for the fastest train on them, in a straight line): ${tooFast.length}`);
for (const l of tooFast.sort(byTrains).slice(0, TOP)) console.log(`  ${String(l.trains).padStart(5)} trains  ${name(l.from)} -> ${name(l.to)}  ${km(l.d)} in ${Math.round(l.minMs / 60000)} min = ${l.v} km/h`);
console.log('\nPlaces most blamed for impossible legs:');
for (const [k, n] of [...blame].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`  ${String(n).padStart(5)} trains  ${name(k)} (${k})  ${locations.get(k)?.timingPoint ? 'timing point' : 'station'}`);
console.log(`\nLegs with no track route (over 1 km, drawn straight): ${noPath.length}`);
for (const l of noPath.sort(byTrains).slice(0, TOP)) console.log(`  ${String(l.trains).padStart(5)} trains  ${name(l.from)} -> ${name(l.to)}  ${km(l.d)}`);
console.log(`\nDetours (track route over ${DETOUR}x the straight line, over ${km(DETOUR_MIN_M)}): ${detours.length}`);
for (const l of detours.sort(byTrains).slice(0, TOP)) console.log(`  ${String(l.trains).padStart(5)} trains  ${name(l.from)} -> ${name(l.to)}  ${km(l.l)} for ${km(l.d)}`);
const missing = [...unplaced].map(([k, u]) => ({ k, ...u })).sort(byTrains);
console.log(`\nNo position: ${missing.length} places, ${missing.reduce((n, u) => n + u.trains, 0)} stops; ${missing.filter((u) => u.last).length} are where a train ends`);
for (const u of missing.slice(0, TOP)) console.log(`  ${String(u.trains).padStart(5)} trains  ${name(u.k)} (${u.k})  calls ${u.calls}, ends ${u.last}`);
