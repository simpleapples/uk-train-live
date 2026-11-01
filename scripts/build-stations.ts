// Builds data/stations.json (TIPLOC -> name + WGS84 coordinates) from NaPTAN.
// NaPTAN rail station ATCO codes are "9100" + TIPLOC, so no Network Rail
// account is needed for this step.
import { writeFile, mkdir } from 'node:fs/promises';

const NAPTAN_URL = 'https://naptan.api.dft.gov.uk/v1/access-nodes?atcoAreaCodes=910&dataFormat=csv';
const OUT = new URL('../data/stations.json', import.meta.url);

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

const res = await fetch(NAPTAN_URL);
if (!res.ok) throw new Error(`NaPTAN download failed: HTTP ${res.status}`);
const lines = (await res.text()).replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
const header = parseCsvLine(lines[0]);
const col = (name: string) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`NaPTAN CSV is missing column ${name}`);
  return i;
};
const iAtco = col('ATCOCode'), iName = col('CommonName'), iLat = col('Latitude'),
  iLon = col('Longitude'), iType = col('StopType'), iStatus = col('Status');

const stations: Record<string, { name: string; lat: number; lon: number }> = {};
for (const line of lines.slice(1)) {
  const f = parseCsvLine(line);
  if (f[iType] !== 'RLY' || f[iStatus] !== 'active' || !f[iAtco].startsWith('9100')) continue;
  const lat = Number(f[iLat]), lon = Number(f[iLon]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  stations[f[iAtco].slice(4)] = {
    name: f[iName].replace(/\s+Rail Station$/i, ''),
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
  };
}

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(stations));
console.log(`Wrote ${Object.keys(stations).length} stations to data/stations.json`);
