// Keeps live mode's timetable current: downloads Network Rail's full extract
// once it has been rebuilt each night, and re-reads it when the date changes.

import { stat } from 'node:fs/promises';
import { type Credentials, downloadTo, SCHEDULE_URL } from '../feeds/nrodFiles.ts';
import { londonDate, londonTime, Timetable, type TimetableOptions } from './timetable.ts';

const CHECK_EVERY_MS = 15 * 60_000;
// Network Rail rebuilds the full extract around 01:00; fetch it after 02:00.
const PUBLISHED_BY_HALF_MINUTES = 2 * 60 * 2;
const DAY_MS = 24 * 60 * 60_000;

export interface TimetableKeeperOptions extends TimetableOptions {
  creds: Credentials;
  /** Where the downloaded extract is kept between restarts. */
  file: string;
  onLoad: (timetable: Timetable) => void;
}

/** Starts the keeper; returns a function that stops it. */
export function keepTimetable(opts: TimetableKeeperOptions): () => void {
  let loadedFor = '';
  let busy = false;

  const refresh = async () => {
    const now = Date.now();
    const today = londonDate(now);
    let downloaded = false;
    if (await isStale(opts.file, now)) {
      const t0 = Date.now();
      await downloadTo(SCHEDULE_URL, opts.creds, opts.file);
      console.log(`[schedule] downloaded the timetable in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      downloaded = true;
    }
    if (!downloaded && loadedFor === today) return;
    const t0 = Date.now();
    // Yesterday too, for trains still running after midnight.
    const timetable = await Timetable.load(opts.file, [londonDate(now - DAY_MS), today], opts);
    loadedFor = today;
    opts.onLoad(timetable);
    console.log(`[schedule] ${timetable.size} schedules for ${today} (read in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  };

  const run = () => {
    if (busy) return;
    busy = true;
    // A failed download leaves the old timetable in use; try again later.
    refresh().catch((err) => console.warn(`[schedule] ${(err as Error).message}`)).finally(() => { busy = false; });
  };
  run();
  const timer = setInterval(run, CHECK_EVERY_MS);
  return () => clearInterval(timer);
}

/** Missing, or older than the latest nightly rebuild. */
async function isStale(file: string, now: number): Promise<boolean> {
  const mtime = await stat(file).then((s) => s.mtimeMs, () => 0);
  let published = londonTime(londonDate(now), PUBLISHED_BY_HALF_MINUTES);
  if (published > now) published -= DAY_MS;
  return mtime < published;
}
