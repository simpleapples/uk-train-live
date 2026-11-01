// Entry point. FEED=demo (default) runs simulated services; FEED=nrod
// connects to Network Rail's live TRUST feed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createApp } from './app.ts';
import { LocationIndex, type StanoxTable, type StationTable, type TimingPointTable } from './engine/locations.ts';
import { PathService } from './engine/paths.ts';
import type { TrainSource } from './engine/source.ts';
import { lineLengthM, TrackNetwork, type TrackJson } from './engine/track.ts';
import { describeTrain } from './engine/trainDetails.ts';
import { type OperatorNameFn, type StoreState, TrainStore } from './engine/trainStore.ts';
import { DemoFeed } from './feeds/demoFeed.ts';
import { OPERATORS } from './feeds/demoNetwork.ts';
import type { Feed, PlannedStop } from './feeds/feed.ts';
import { NrodFeed } from './feeds/nrodFeed.ts';
import { VstpFeed } from './feeds/vstpFeed.ts';
import { type Credentials, fetchCorpus } from './feeds/nrodFiles.ts';
import { operatorName as liveOperatorName, TFL_RUN_TOCS } from './feeds/tocCodes.ts';
import { keepTimetable } from './schedule/keeper.ts';
import type { Timetable, VstpSchedule } from './schedule/timetable.ts';
import { TflLoads } from './tfl/loads.ts';
import { type TflData, TflTracker } from './tfl/tflTracker.ts';

try { process.loadEnvFile(); } catch { /* no .env file */ }

const env = process.env;
const port = Number(env.PORT ?? 3000);
const feedKind = env.FEED ?? 'demo';
// Live mode keeps the downloaded timetable, CORPUS and its trains here, so a
// restart (or a new container on the same volume) carries on where it was.
const stateDir = resolve(env.STATE_DIR ?? fileURLToPath(new URL('../state', import.meta.url)));
const SAVE_EVERY_MS = 30_000;

function loadJson<T>(rel: string, hint: string): T {
  try {
    return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as T;
  } catch {
    console.error(`Missing ${rel.replace('../', '')}. ${hint}`);
    process.exit(1);
  }
}

/** STANOX codes: from `npm run data:corpus`, a previous download, or Network Rail now. */
async function loadStanox(creds: Credentials): Promise<StanoxTable> {
  const saved = [fileURLToPath(new URL('../data/stanox.json', import.meta.url)), join(stateDir, 'stanox.json')].find((f) => existsSync(f));
  if (saved) return JSON.parse(readFileSync(saved, 'utf8')) as StanoxTable;
  console.log('Downloading CORPUS location codes…');
  const stanox = await fetchCorpus(creds);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'stanox.json'), JSON.stringify(stanox));
  return stanox;
}

const stations = loadJson<StationTable>('../data/stations.json', 'Run `npm run data:stations` first.');

let feed: Feed;
let locations: LocationIndex;
let operatorName: OperatorNameFn = () => undefined;
let creds: Credentials | null = null;

if (feedKind === 'demo') {
  locations = LocationIndex.byKey(stations);
  feed = new DemoFeed(stations);
  operatorName = (toc) => OPERATORS[toc];
} else if (feedKind === 'nrod') {
  if (!env.NROD_USERNAME || !env.NROD_PASSWORD) {
    console.error('FEED=nrod needs NROD_USERNAME and NROD_PASSWORD (see .env.example).');
    process.exit(1);
  }
  creds = { username: env.NROD_USERNAME, password: env.NROD_PASSWORD };
  // Junctions, yards and signals too, so freight trains can be drawn where they are.
  const timingPointsFile = new URL('../data/timing-points.json', import.meta.url);
  const timingPoints = existsSync(timingPointsFile) ? (JSON.parse(readFileSync(timingPointsFile, 'utf8')) as TimingPointTable) : {};
  locations = LocationIndex.byStanox(stations, await loadStanox(creds), timingPoints);
  operatorName = liveOperatorName;
  feed = new NrodFeed({
    username: env.NROD_USERNAME,
    password: env.NROD_PASSWORD,
    host: env.NROD_HOST,
    port: env.NROD_PORT ? Number(env.NROD_PORT) : undefined,
    tls: env.NROD_TLS === 'true',
    topic: env.NROD_TOPIC,
  });
} else {
  console.error(`Unknown FEED "${feedKind}"; use demo or nrod.`);
  process.exit(1);
}

const trackFile = new URL('../data/track.json.gz', import.meta.url);
let track: TrackNetwork | null = null;
if (existsSync(trackFile)) {
  track = TrackNetwork.load(trackFile);
  const moved = locations.snapTo((lon, lat) => track!.snapPoint([lon, lat], 400));
  console.log(`Track network: ${track.edgeCount} edges; ${moved}/${locations.size} locations snapped onto track`);
} else {
  console.warn('No data/track.json.gz — trains will move in straight lines. Run `npm run data:track`.');
}

const paths = new PathService(locations, track);
const trackDistance = (from: string, to: string) => {
  const line = paths.between(from, to);
  return line ? lineLengthM(line) : null;
};
// TfL rail (Underground, DLR, Overground, Elizabeth line): live from TfL in
// both modes (TFL=off to disable).
const tflFile = new URL('../data/tfl.json', import.meta.url);
const tflOn = env.TFL !== 'off' && existsSync(tflFile);
// Overground, Elizabeth line and some Tube trains also report to TRUST; show
// each train once, from TfL.
const store = new TrainStore(locations, operatorName, trackDistance, tflOn ? TFL_RUN_TOCS : new Set());

const sources: TrainSource[] = [];
// One path service per TfL line, each on that line's own track.
const tflPaths = new Map<string, PathService>();
const TFL_PATH_OPTIONS = { radiusM: 500, maxSnaps: 24, offTrackWeight: 5 };
if (tflOn) {
  const tflData = JSON.parse(readFileSync(tflFile, 'utf8')) as TflData;
  const tflLocations = LocationIndex.byKey(tflData.stations);
  const tflTrackFile = new URL('../data/tfl-track.json.gz', import.meta.url);
  const tracks = existsSync(tflTrackFile)
    ? (JSON.parse(gunzipSync(readFileSync(tflTrackFile)).toString('utf8')) as { lines: Record<string, TrackJson> }).lines
    : {};
  for (const lineId of Object.keys(tflData.lines)) {
    const track = tracks[lineId] ? new TrackNetwork(tracks[lineId]) : null;
    // Interchanges stack several tracks near one station, so try many; and a
    // line with tunnel and surface tracks side by side must keep to the one
    // at the station (Elizabeth line at Whitechapel).
    tflPaths.set(lineId, new PathService(tflLocations, track, TFL_PATH_OPTIONS));
  }
  const missing = Object.keys(tflData.lines).filter((id) => !tracks[id]);
  const loads = TflLoads.load(new URL('../data/tfl-loads.json.gz', import.meta.url));
  sources.push(new TflTracker(tflData, tflLocations, (lineId) => tflPaths.get(lineId)!, { appKey: env.TFL_APP_KEY, loads }));
  console.log(`TfL: ${Object.keys(tflData.lines).length} lines${missing.length ? ` (straight lines for ${missing.join(', ')})` : ''}`);
}

// Live mode: each train's schedule (origin, destination, calling points,
// operator) from the daily timetable, and its trains kept across restarts.
let timetable: Timetable | null = null;
let plannedStops: ((id: string) => PlannedStop[] | undefined) | undefined = feed.plannedStops?.bind(feed);
const stateFile = join(stateDir, 'trains.json');
// Short-notice schedules (VSTP): applied to each day's timetable as it loads,
// and kept across restarts until they have run.
const vstpFile = join(stateDir, 'vstp.json');
let vstp: VstpSchedule[] = [];
let vstpChanged = false;
const writeState = (file: string, data: unknown) => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(`${file}.part`, JSON.stringify(data));
  renameSync(`${file}.part`, file);
};
const saveState = () => {
  writeState(stateFile, store.exportState(Date.now()));
  if (vstpChanged) {
    writeState(vstpFile, vstp);
    vstpChanged = false;
  }
};
if (creds) {
  if (existsSync(stateFile)) {
    try {
      const restored = store.importState(JSON.parse(readFileSync(stateFile, 'utf8')) as StoreState, Date.now());
      console.log(`Restored ${restored} trains from the last run`);
    } catch (err) {
      console.warn(`Could not restore trains: ${(err as Error).message}`);
    }
  }
  setInterval(() => {
    try { saveState(); } catch (err) { console.warn(`Could not save trains: ${(err as Error).message}`); }
  }, SAVE_EVERY_MS);
  if (existsSync(vstpFile)) {
    try { vstp = JSON.parse(readFileSync(vstpFile, 'utf8')) as VstpSchedule[]; } catch { /* start afresh */ }
  }
  keepTimetable({
    creds,
    file: join(stateDir, 'schedule-full.json.gz'),
    name: (key) => locations.name(key),
    onLoad: (t) => {
      const kept = vstp.filter((v) => v.schedule_end_date >= t.dates[0]);
      vstpChanged ||= kept.length !== vstp.length;
      vstp = kept;
      const added = vstp.reduce((n, v) => n + t.addVstp(v), 0);
      if (added) console.log(`[vstp] ${added} short-notice schedules added to the timetable`);
      timetable = t;
      store.setTimetable(t);
    },
  });
  // Trains without a schedule pick one up at their next report.
  new VstpFeed(creds).start((v) => {
    vstp.push(v);
    vstpChanged = true;
    timetable?.addVstp(v);
  });
  plannedStops = (id) => {
    const s = store.scheduleOf(id);
    return s && timetable?.plannedStops(s.uid, s.date);
  };
}

const app = createApp({
  feed,
  store,
  sources,
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  describe: (id) => describeTrain(id, store, locations, paths, plannedStops),
  path: (from, to, line) => (line ? tflPaths.get(line) : paths)?.between(from, to) ?? null,
});

app.server.listen(port, () => {
  console.log(`train-live (${feedKind}) on http://localhost:${port} — ${locations.size} mapped locations`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (creds) {
      try { saveState(); } catch { /* best effort on the way out */ }
    }
    app.close();
    process.exit(0);
  });
}
