// Builds data/tfl-loads.json.gz: how many people a TfL train typically
// carries between two stations, per quarter hour and day type, from TfL's
// NUMBAT model (link loads divided by trains per quarter hour). TfL publishes
// no live train loading, so this is the typical figure for that time.
//
// The workbooks (~12 MB each) are cached in data/cache/numbat/.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { readSheets } from './lib/xlsx.ts';

const YEAR = '2023';
const BASE = `https://s3-eu-west-1.amazonaws.com/crowding.data.tfl.gov.uk/NUMBAT/NUMBAT%20${YEAR}`;
// NUMBAT day types; a NUMBAT day runs from 05:00 to 04:59.
const DAYS = ['MON', 'TWT', 'FRI', 'SAT', 'SUN'];
const CACHE = new URL('../data/cache/numbat/', import.meta.url);
const OUT = new URL('../data/tfl-loads.json.gz', import.meta.url);

// NUMBAT line -> our line ids (London Trams are not on the map).
const LINES: Record<string, string[]> = {
  Bakerloo: ['bakerloo'], Central: ['central'], District: ['district'], DLR: ['dlr'], 'Elizabeth Line': ['elizabeth'],
  'H&C and Circle': ['hammersmith-city', 'circle'], Jubilee: ['jubilee'], Metropolitan: ['metropolitan'], Northern: ['northern'],
  Piccadilly: ['piccadilly'], Victoria: ['victoria'], 'Waterloo & City': ['waterloo-city'],
  'LO East London': ['windrush'], 'LO North London': ['mildmay'], 'LO Gospel Oak-Barking': ['suffragette'],
  'LO Watford-Euston': ['lioness'], 'LO West Anglia': ['weaver'], 'LO Romford–Upminster': ['liberty'],
};

// NUMBAT names the map spells differently.
const ALIASES: Record<string, string> = {
  'heathrow terminals 123': 'heathrow terminals 2 and 3', 'new cross': 'new cross ell',
  euston: 'london euston', 'liverpool street': 'london liverpool street',
};

/** "King's Cross St. Pancras LU" and "King's Cross St Pancras" -> "kings cross st pancras". */
const norm = (s: string) => {
  const n = s.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/&/g, ' and ').replace(/['’.]/g, '')
    .replace(/\b(lu|nr|lo|dlr|el|tfl|underground|station)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return ALIASES[n] ?? n;
};

interface TflJson {
  lines: Record<string, { routes: string[][] }>;
  stations: Record<string, { name: string }>;
}

async function workbook(day: string): Promise<Buffer> {
  const file = new URL(`NBT${YEAR.slice(2)}${day}_outputs.xlsx`, CACHE);
  if (!existsSync(file)) {
    await mkdir(CACHE, { recursive: true });
    const url = `${BASE}/NBT${YEAR.slice(2)}${day}_outputs.xlsx`;
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return readFile(file);
}

const tfl = JSON.parse(await readFile(new URL('../data/tfl.json', import.meta.url), 'utf8')) as TflJson;
// Per line: normalised station name -> NaPTAN id, from the stations it serves.
const stationsOf = new Map<string, Map<string, string>>();
for (const [line, { routes }] of Object.entries(tfl.lines)) {
  const byName = new Map<string, string>();
  for (const id of new Set(routes.flat())) byName.set(norm(tfl.stations[id]?.name ?? ''), id);
  stationsOf.set(line, byName);
}
// "Bank and Monument" is one station complex in NUMBAT, two on the map.
const lookup = (line: string, name: string) =>
  stationsOf.get(line)?.get(norm(name)) ?? norm(name).split(' and ').map((n) => stationsOf.get(line)?.get(n)).find(Boolean);

// line -> "from>to" -> per day, people per train for each quarter hour from 05:00.
const links: Record<string, Record<string, (number | null)[][]>> = {};
const unmatched = new Set<string>();
for (const [d, day] of DAYS.entries()) {
  const sheets = readSheets(await workbook(day), ['Link_Loads', 'Link_Frequencies']);
  const header = (rows: string[][]) => rows.findIndex((r) => r[0] === 'Link');
  const loads = sheets.get('Link_Loads')!;
  const freqs = sheets.get('Link_Frequencies')!;
  const cols = loads[header(loads)];
  const first = cols.findIndex((c) => /^\d{4}-\d{4}$/.test(c));
  const trainsOn = new Map(freqs.slice(header(freqs) + 1).map((r) => [r[0], r]));
  for (const row of loads.slice(header(loads) + 1)) {
    const lineIds = LINES[row[1]];
    const trains = trainsOn.get(row[0]);
    if (!lineIds || !trains) continue;
    const perTrain = cols.slice(first).map((_, q) => {
      const n = Number(trains[first + q]);
      return n > 0 ? Math.round(Number(row[first + q]) / n) : null;
    });
    for (const line of lineIds) {
      const from = lookup(line, row[6]);
      const to = lookup(line, row[9]);
      if (!from || !to) {
        unmatched.add(`${row[1]}: ${!from ? row[6] : row[9]}`);
        continue;
      }
      ((links[line] ??= {})[`${from}>${to}`] ??= Array.from({ length: DAYS.length }, () => []))[d] = perTrain;
    }
  }
  console.log(`${day}: read`);
}

// A line's busiest trains (98th percentile on weekdays), to say how full a train is for that line.
const busiest: Record<string, number> = {};
for (const [line, byLink] of Object.entries(links)) {
  const all = Object.values(byLink).flatMap((days) => days.slice(0, 3).flat()).filter((v): v is number => v !== null).sort((a, b) => a - b);
  busiest[line] = all[Math.floor(all.length * 0.98)] ?? 0;
}

const out = { source: `TfL NUMBAT ${YEAR}`, days: DAYS, startMinute: 5 * 60, busiest, links };
await writeFile(OUT, gzipSync(JSON.stringify(out)));
const count = Object.values(links).reduce((n, l) => n + Object.keys(l).length, 0);
console.log(`wrote ${count} links on ${Object.keys(links).length} lines; busiest per train: ${JSON.stringify(busiest)}`);
if (unmatched.size) console.log(`unmatched stations (${unmatched.size}): ${[...unmatched].sort().join('; ')}`);
