// Builds the data for TfL's rail networks (Underground, DLR, Overground,
// Elizabeth line):
//   data/tfl.json          lines (network, colour, station sequences) and
//                          stations, from TfL
//   data/tfl-track.json.gz one track graph per line, from the ways in that
//                          line's OSM route relations (Overpass), so each
//                          train is routed only on its own line's track
// The OSM download is cached in data/cache/tfl-osm-rels.json; pass --refresh
// to fetch it again.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { buildGraph, type LonLat } from './lib/graph.ts';

try { process.loadEnvFile(); } catch { /* no .env file */ }

const USER_AGENT = 'train-live-prototype/0.1 (rail map prototype)';
const TFL = 'https://api.tfl.gov.uk';
const KEY = process.env.TFL_APP_KEY ? `app_key=${process.env.TFL_APP_KEY}` : '';
const MODES = ['tube', 'dlr', 'overground', 'elizabeth-line'];
const OVERPASS_URL = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
// Route relations include the main-line track these lines share (District to
// Richmond, Elizabeth line to Reading, most of the Overground). Underground
// relations carry a network tag; the others are found by their name prefix.
// Relations come with their member lists, to tell which ways are whose.
const OSM_QUERY = `[out:json][timeout:240];
(
  rel["route"="subway"]["network"="London Underground"](51.2,-1.1,51.9,0.5);
  rel["type"="route"]["route"~"^(train|light_rail)$"]["name"~"^(DLR|Elizabeth line|Liberty Line|Lioness Line|Mildmay Line|Suffragette Line|Weaver Line|Windrush Line):"](51.2,-1.1,51.9,0.5);
)->.r;
.r out body;
way(r.r)["railway"~"^(subway|rail|light_rail)$"];
out skel qt;
node(w);
out skel qt;`;
const OSM_CACHE = new URL('../data/cache/tfl-osm-rels.json', import.meta.url);

// TfL's line colours.
const COLOURS: Record<string, string> = {
  bakerloo: '#B36305',
  central: '#E32017',
  circle: '#FFD300',
  district: '#00782A',
  'hammersmith-city': '#F3A9BB',
  jubilee: '#A0A5A9',
  metropolitan: '#9B0056',
  northern: '#000000',
  piccadilly: '#003688',
  victoria: '#0098D4',
  'waterloo-city': '#95CDBA',
  dlr: '#00A4A7',
  elizabeth: '#6950A1',
  liberty: '#61686B',
  lioness: '#FAA61A',
  mildmay: '#006FE6',
  suffragette: '#18A95D',
  weaver: '#893B67',
  windrush: '#DC241F',
};

async function tfl<T>(path: string): Promise<T> {
  const url = `${TFL}${path}${path.includes('?') ? '&' : '?'}${KEY}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`TfL ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ---- TfL: lines, station sequences, stations ----

interface TflLine { id: string; name: string; modeName: string }
interface TflStop { id: string; name: string; lat: number; lon: number }
interface TflSequence {
  stations: TflStop[];
  stopPointSequences: { stopPoint: TflStop[] }[];
  orderedLineRoutes: { name: string; naptanIds: string[] }[];
}

const lines = await tfl<TflLine[]>(`/Line/Mode/${MODES.join(',')}`);
const data: {
  lines: Record<string, { name: string; mode: string; color: string; routes: string[][] }>;
  stations: Record<string, { name: string; lat: number; lon: number }>;
} = { lines: {}, stations: {} };

const stationName = (name: string) => name
  .replace(/ (Underground|DLR|Rail) Station$/, '')
  .replace(/ \(.*Line\)$/i, '')
  .trim();

for (const line of lines) {
  const seq = await tfl<TflSequence>(`/Line/${line.id}/Route/Sequence/all?serviceTypes=Regular`);
  // `stations` leaves out some interchanges; the stop point sequences have them all.
  for (const s of [...seq.stations, ...seq.stopPointSequences.flatMap((p) => p.stopPoint)]) {
    data.stations[s.id] = {
      name: stationName(s.name),
      lat: Math.round(s.lat * 1e5) / 1e5,
      lon: Math.round(s.lon * 1e5) / 1e5,
    };
  }
  // The same sequence can be listed once per direction; keep one copy.
  const seen = new Set<string>();
  const routes = seq.orderedLineRoutes.map((r) => r.naptanIds).filter((ids) => {
    const key = [ids.join(','), [...ids].reverse().join(',')].sort()[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  data.lines[line.id] = { name: line.name, mode: line.modeName, color: COLOURS[line.id] ?? '#666666', routes };
  const missing = routes.flat().filter((id) => !data.stations[id]);
  if (missing.length) throw new Error(`${line.name}: no coordinates for ${[...new Set(missing)].join(', ')}`);
  console.log(`  ${line.name} (${line.modeName}): ${routes.length} routes`);
}
await writeFile(new URL('../data/tfl.json', import.meta.url), JSON.stringify(data));
console.log(`Wrote data/tfl.json: ${lines.length} lines, ${Object.keys(data.stations).length} stations`);

// ---- OSM: track ----

if (!existsSync(OSM_CACHE) || process.argv.includes('--refresh')) {
  let body: string | null = null;
  for (let attempt = 1; attempt <= 6 && !body; attempt++) {
    console.log(`Downloading TfL rail track from Overpass (attempt ${attempt})…`);
    try {
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: `data=${encodeURIComponent(OSM_QUERY)}`,
        signal: AbortSignal.timeout(5 * 60_000),
      });
      const text = await res.text();
      if (res.ok && !(JSON.parse(text) as { remark?: string }).remark?.includes('error')) body = text;
      else console.warn(`  HTTP ${res.status}`);
    } catch (err) {
      console.warn(`  ${(err as Error).message}`);
    }
    // Public Overpass asks clients to back off when it is busy.
    if (!body) await new Promise((r) => setTimeout(r, attempt * 45_000));
  }
  if (!body) throw new Error('Overpass kept failing; try again later or set OVERPASS_URL.');
  await mkdir(new URL('../data/cache/', import.meta.url), { recursive: true });
  await writeFile(OSM_CACHE, body);
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
  members?: { type: string; ref: number; role: string }[];
}
const { elements } = JSON.parse(await readFile(OSM_CACHE, 'utf8')) as { elements: OsmElement[] };
const coord = new Map<number, LonLat>();
const wayNodes = new Map<number, number[]>();
for (const el of elements) {
  if (el.type === 'node') coord.set(el.id, [el.lon!, el.lat!]);
  else if (el.type === 'way' && el.nodes) wayNodes.set(el.id, el.nodes);
}

// Relation names start with the line's name ("Central line: Ealing Broadway
// → Epping", "Weaver Line: …"); "Central Line (sidings …)" is not a service.
const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/\s+line$/, '').trim();
const lineByName = new Map(Object.entries(data.lines).map(([id, l]) => [norm(l.name), id]));
const lineWays = new Map<string, Set<number>>();
for (const el of elements) {
  if (el.type !== 'relation') continue;
  const head = el.tags?.name?.split(':')[0] ?? '';
  const lineId = lineByName.get(norm(head));
  if (!lineId) continue;
  const set = lineWays.get(lineId) ?? new Set<number>();
  for (const m of el.members ?? []) if (m.type === 'way' && wayNodes.has(m.ref)) set.add(m.ref);
  lineWays.set(lineId, set);
}

// OSM ways share node ids at junctions, so no snapping is needed here.
const graphs: Record<string, ReturnType<typeof buildGraph>['json']> = {};
for (const lineId of Object.keys(data.lines)) {
  const ways = [...(lineWays.get(lineId) ?? [])].map((id) => wayNodes.get(id)!);
  if (!ways.length) {
    console.warn(`  ${data.lines[lineId].name}: no OSM route relation found; it will be drawn with straight lines`);
    continue;
  }
  const graph = buildGraph(ways, coord, { toleranceM: 4, minComponentM: 200 });
  graphs[lineId] = graph.json;
  console.log(`  ${data.lines[lineId].name}: ${graph.edges} edges, ${Math.round(graph.km)} km`);
}
await writeFile(new URL('../data/tfl-track.json.gz', import.meta.url), gzipSync(JSON.stringify({ lines: graphs })));
console.log(`Wrote data/tfl-track.json.gz: track for ${Object.keys(graphs).length} lines`);
