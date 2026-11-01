// Reference files from Network Rail's open data portal, with the same account
// as the live feed: CORPUS (location codes) and the daily timetable.

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { gunzipSync } from 'node:zlib';
import type { StanoxTable } from '../engine/locations.ts';

const PORTAL = 'https://publicdatafeeds.networkrail.co.uk/ntrod';
/** Every operator's schedules, as JSON lines (gzip, ~140 MB); rebuilt each night around 01:00. */
export const SCHEDULE_URL = `${PORTAL}/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full`;
const CORPUS_URL = `${PORTAL}/SupportingFileAuthenticate?type=CORPUS`;

export interface Credentials {
  username: string;
  password: string;
}

// The portal redirects to a signed download URL; fetch drops the
// Authorization header on that cross-origin hop, which is what S3 expects.
async function get(url: string, creds: Credentials): Promise<Response> {
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}` },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok || !res.body) throw new Error(`${new URL(url).pathname}: HTTP ${res.status}`);
  return res;
}

/** Saves a portal file to `dest`, replacing the old one only once the download is complete. */
export async function downloadTo(url: string, creds: Credentials, dest: string): Promise<void> {
  const res = await get(url, creds);
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as ReadableStream), createWriteStream(part));
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}

/** CORPUS as STANOX -> TIPLOCs and a name: live mode needs it to place TRUST reports. */
export async function fetchCorpus(creds: Credentials): Promise<StanoxTable> {
  let raw = Buffer.from(await (await get(CORPUS_URL, creds)).arrayBuffer());
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);

  interface CorpusEntry { STANOX?: string; TIPLOC?: string; NLCDESC?: string }
  const { TIPLOCDATA } = JSON.parse(raw.toString('utf8')) as { TIPLOCDATA: CorpusEntry[] };
  const stanox: StanoxTable = {};
  for (const e of TIPLOCDATA) {
    const code = e.STANOX?.trim();
    const tiploc = e.TIPLOC?.trim();
    if (!code || !tiploc) continue;
    const entry = (stanox[code] ??= { tiplocs: [] });
    entry.tiplocs.push(tiploc);
    entry.name ??= e.NLCDESC?.trim() || undefined;
  }
  return stanox;
}
