// How full a TfL train typically is between two stations at this time of
// day, from TfL's NUMBAT model (data/tfl-loads.json.gz, built by
// scripts/build-tfl-loads.ts). TfL publishes no live train loading, so this
// is the typical figure, not a count of the train on screen.

import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export interface LoadsJson {
  source: string;
  days: string[];
  /** Minutes after midnight of the first quarter hour; a NUMBAT day runs from 05:00. */
  startMinute: number;
  /** Per line, people on its busiest trains (98th percentile, weekdays). */
  busiest: Record<string, number>;
  /** line -> "from>to" -> per day type, people per train each quarter hour. */
  links: Record<string, Record<string, (number | null)[][]>>;
}

export interface TrainLoad {
  people: number;
  /** 0 quiet, 1 moderate, 2 busy, 3 very busy, for that line. */
  level: number;
  label: string;
  /** Where the figure comes from, for a tooltip. */
  basis: string;
}

const LEVELS: [number, string][] = [[0.3, 'Quiet'], [0.6, 'Moderate'], [0.85, 'Busy'], [Infinity, 'Very busy']];
// London weekday (Monday = 0) -> NUMBAT day type, and how to say it.
const DAY_TYPES = ['MON', 'TWT', 'TWT', 'TWT', 'FRI', 'SAT', 'SUN'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const londonParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export class TflLoads {
  #data: LoadsJson;

  constructor(data: LoadsJson) {
    this.#data = data;
  }

  static load(file: URL): TflLoads | null {
    return existsSync(file) ? new TflLoads(JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as LoadsJson) : null;
  }

  /** The typical load between two adjacent stations at `at`, if NUMBAT has that section. */
  estimate(line: string, from: string, to: string, at: number): TrainLoad | undefined {
    const days = this.#data.links[line]?.[`${from}>${to}`];
    const busiest = this.#data.busiest[line];
    if (!days || !busiest) return undefined;
    const parts = Object.fromEntries(londonParts.formatToParts(at).map((p) => [p.type, p.value]));
    let weekday = WEEKDAY[parts.weekday];
    let minute = Number(parts.hour) * 60 + Number(parts.minute) - this.#data.startMinute;
    // Before 05:00 belongs to the previous NUMBAT day.
    if (minute < 0) {
      minute += 24 * 60;
      weekday = (weekday + 6) % 7;
    }
    const people = days[this.#data.days.indexOf(DAY_TYPES[weekday])]?.[Math.floor(minute / 15)];
    if (people === null || people === undefined) return undefined;
    const level = LEVELS.findIndex(([upTo]) => people / busiest < upTo);
    return { people, level, label: LEVELS[level][1], basis: `Typical for this time on a ${DAY_NAMES[weekday]}, from ${this.#data.source}` };
  }
}
