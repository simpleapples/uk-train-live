// Today's train schedules from Network Rail's SCHEDULE feed (the daily full
// extract, JSON lines). TRUST movement reports carry no origin, destination
// or calling points; live mode looks each train up here instead.
//
// Only schedules that run today are kept, plus last night's that are still
// running after midnight, with each schedule's stops packed into an
// Int32Array (the full extract has ~700k schedules, ~37k run on a day).

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { titleCase } from '../engine/locations.ts';
import type { PlannedStop } from '../feeds/feed.ts';

/** What the train store needs to know about a train's schedule. */
export interface ScheduleInfo {
  uid: string;
  /** Date the train starts, YYYY-MM-DD (London). */
  date: string;
  /** Two-letter operator code; ZZ for freight and engineering trains. */
  atoc: string;
  origin: string;
  destination: string;
  service?: ServiceCodes;
}

/** The schedule's CIF codes for the train itself; see service.ts. */
export interface ServiceCodes {
  power?: string;
  timingLoad?: string;
  speed?: string;
  seating?: string;
  sleepers?: string;
  reservations?: string;
  catering?: string;
}

interface Schedule {
  uid: string;
  date: string;
  headcode: string;
  atoc: string;
  /** STP_RANK of the schedule kept, so a VSTP overlay can tell whether it wins. */
  rank: number;
  service?: ServiceCodes;
  /** Per location, STRIDE ints: key index, arrival, departure, pass (half-minutes after the date's midnight, -1 if none), calls (1/0). */
  stops: Int32Array;
}

const STRIDE = 5;
const NONE = -1;
// Overlays and new short-term schedules replace the permanent one for a day;
// a cancellation removes it.
const STP_RANK: Record<string, number> = { P: 1, N: 2, O: 2, C: 3 };
// A report this close to a scheduled time (either way) identifies the train.
const MATCH_TOLERANCE_MS = 2 * 60_000;

interface CifLocation {
  record_identity?: string;
  location_type?: string;
  tiploc_code?: string;
  arrival?: string | null;
  departure?: string | null;
  pass?: string | null;
  public_arrival?: string | null;
  public_departure?: string | null;
}

interface CifSchedule {
  CIF_train_uid: string;
  CIF_stp_indicator: string;
  schedule_start_date: string;
  schedule_end_date: string;
  schedule_days_runs?: string;
  atoc_code?: string | null;
  schedule_segment?: {
    signalling_id?: string | null;
    CIF_power_type?: string | null;
    CIF_timing_load?: string | null;
    CIF_speed?: string | null;
    CIF_train_class?: string | null;
    CIF_sleepers?: string | null;
    CIF_reservations?: string | null;
    CIF_catering_code?: string | null;
    schedule_location?: CifLocation[];
  };
}

/** A schedule from the VSTP feed: like the extract's, but times are HHMMSS and places nest deeper. */
export interface VstpSchedule {
  transaction_type?: string;
  CIF_train_uid: string;
  CIF_stp_indicator: string;
  schedule_start_date: string;
  schedule_end_date: string;
  schedule_days_runs?: string;
  schedule_segment?: Array<{
    signalling_id?: string | null;
    atoc_code?: string | null;
    CIF_power_type?: string | null;
    CIF_timing_load?: string | null;
    CIF_speed?: string | null;
    CIF_train_class?: string | null;
    CIF_sleepers?: string | null;
    CIF_reservations?: string | null;
    CIF_catering_code?: string | null;
    schedule_location?: Array<{
      scheduled_arrival_time?: string | null;
      scheduled_departure_time?: string | null;
      scheduled_pass_time?: string | null;
      public_arrival_time?: string | null;
      public_departure_time?: string | null;
      location?: { tiploc?: { tiploc_id?: string } };
    }>;
  }>;
}

export interface TimetableOptions {
  /** A better name for a location key than the timetable's own (station names). */
  name?: (key: string) => string | undefined;
}

export class Timetable implements ScheduleLookup {
  readonly dates: readonly string[];
  #keys: string[] = [];
  #keyIndex = new Map<string, number>();
  #names = new Map<string, string>();
  #byUid = new Map<string, Schedule>();
  #byHeadcode = new Map<string, Schedule[]>();
  // TIPLOC -> STANOX: live reports name places by STANOX.
  #stanoxOf = new Map<string, string>();
  #name: (key: string) => string | undefined;

  private constructor(dates: readonly string[], opts: TimetableOptions) {
    this.dates = dates;
    this.#name = opts.name ?? (() => undefined);
  }

  /** Reads a gzipped full extract, keeping what runs on `dates` (yesterday, today). */
  static async load(file: string, dates: readonly string[], opts: TimetableOptions = {}): Promise<Timetable> {
    const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
    return Timetable.fromLines(lines, dates, opts);
  }

  static async fromLines(lines: Iterable<string> | AsyncIterable<string>, dates: readonly string[], opts: TimetableOptions = {}): Promise<Timetable> {
    const t = new Timetable(dates, opts);
    const best = new Map<string, { rank: number; s: CifSchedule }>();
    for await (const line of lines) {
      if (line.startsWith('{"TiplocV1"')) {
        const tl = JSON.parse(line).TiplocV1;
        const key = tl.stanox || tl.tiploc_code;
        t.#stanoxOf.set(tl.tiploc_code, key);
        if (tl.tps_description && !t.#names.has(key)) t.#names.set(key, titleCase(tl.tps_description));
      } else if (line.startsWith('{"JsonScheduleV1"')) {
        const s = JSON.parse(line).JsonScheduleV1 as CifSchedule;
        for (const date of dates) {
          if (!runsOn(s, date)) continue;
          const id = `${s.CIF_train_uid}|${date}`;
          const rank = STP_RANK[s.CIF_stp_indicator] ?? 0;
          if (rank >= (best.get(id)?.rank ?? 0)) best.set(id, { rank, s });
        }
      }
    }
    for (const [id, { s, rank }] of best) {
      if (s.CIF_stp_indicator !== 'C') t.#add(s, id.slice(id.indexOf('|') + 1), rank);
    }
    return t;
  }

  /**
   * A very short term plan from the VSTP feed: a schedule made within two
   * days of running (engineering trains, extra freight), so not in the
   * extract. Returns how many of the timetable's dates it changed.
   */
  addVstp(v: VstpSchedule): number {
    const s = fromVstp(v);
    const rank = STP_RANK[s.CIF_stp_indicator] ?? 0;
    const remove = v.transaction_type === 'Delete' || s.CIF_stp_indicator === 'C';
    let changed = 0;
    for (const date of this.dates) {
      if (!runsOn(s, date)) continue;
      const id = `${s.CIF_train_uid}|${date}`;
      if (remove) {
        if (this.#remove(id)) changed++;
      } else if (rank >= (this.#byUid.get(id)?.rank ?? 0) && this.#add(s, date, rank)) {
        changed++;
      }
    }
    return changed;
  }

  /** Keeps a schedule for one date, replacing any it had; false if it is not worth keeping. */
  #add(s: CifSchedule, date: string, rank: number): boolean {
    const stops = this.#pack(s.schedule_segment?.schedule_location ?? []);
    if (stops.length < 2 * STRIDE) return false;
    // Earlier days only matter for trains still running after midnight.
    if (date !== this.dates[this.dates.length - 1] && lastTime(stops) < 2880) return false;
    const schedule: Schedule = {
      uid: s.CIF_train_uid,
      date,
      headcode: s.schedule_segment?.signalling_id?.trim() ?? '',
      atoc: s.atoc_code || 'ZZ',
      rank,
      service: serviceCodes(s),
      stops,
    };
    const id = `${schedule.uid}|${date}`;
    this.#remove(id);
    this.#byUid.set(id, schedule);
    if (schedule.headcode) {
      const list = this.#byHeadcode.get(schedule.headcode);
      if (list) list.push(schedule);
      else this.#byHeadcode.set(schedule.headcode, [schedule]);
    }
    return true;
  }

  #remove(id: string): boolean {
    const old = this.#byUid.get(id);
    if (!old) return false;
    this.#byUid.delete(id);
    const list = this.#byHeadcode.get(old.headcode);
    if (list) {
      list.splice(list.indexOf(old), 1);
      if (!list.length) this.#byHeadcode.delete(old.headcode);
    }
    return true;
  }

  get size(): number {
    return this.#byUid.size;
  }

  /** Every schedule kept, as [uid, date]. */
  schedules(): [uid: string, date: string][] {
    return [...this.#byUid.values()].map((s) => [s.uid, s.date]);
  }

  /** The schedule a TRUST activation names (train_uid, and the date it starts). */
  byUid(uid: string, date: string): ScheduleInfo | undefined {
    const s = this.#byUid.get(`${uid}|${date}`);
    return s && this.#info(s);
  }

  /**
   * For a train first seen mid-journey (no activation message): the schedule
   * with this headcode that passes this location at the planned time.
   */
  match(headcode: string, key: string, plannedMs: number): ScheduleInfo | undefined {
    const k = this.#keyIndex.get(key);
    if (k === undefined) return undefined;
    let best: Schedule | undefined;
    let bestDiff = MATCH_TOLERANCE_MS;
    for (const s of this.#byHeadcode.get(headcode) ?? []) {
      for (let i = 0; i < s.stops.length; i += STRIDE) {
        if (s.stops[i] !== k) continue;
        for (let j = 1; j <= 3; j++) {
          const t = s.stops[i + j];
          if (t === NONE) continue;
          const diff = Math.abs(londonTime(s.date, t) - plannedMs);
          if (diff <= bestDiff) {
            bestDiff = diff;
            best = s;
          }
        }
      }
    }
    return best && this.#info(best);
  }

  /** Every location the train is timed at, in order; passing points have `call: false`. */
  plannedStops(uid: string, date: string): PlannedStop[] | undefined {
    const s = this.#byUid.get(`${uid}|${date}`);
    if (!s) return undefined;
    const out: PlannedStop[] = [];
    for (let i = 0; i < s.stops.length; i += STRIDE) {
      const key = this.#keys[s.stops[i]];
      const [arr, dep, pass] = [s.stops[i + 1], s.stops[i + 2], s.stops[i + 3]];
      out.push({
        key,
        name: this.#nameOf(key),
        call: s.stops[i + 4] === 1,
        arr: arr === NONE ? undefined : londonTime(s.date, arr),
        dep: dep !== NONE ? londonTime(s.date, dep) : pass !== NONE ? londonTime(s.date, pass) : undefined,
      });
    }
    return out;
  }

  #info(s: Schedule): ScheduleInfo {
    // First and last calls: a train may be timed on to a siding or signal
    // beyond the station it terminates at.
    let first = 0;
    let last = s.stops.length - STRIDE;
    while (first < last && s.stops[first + 4] !== 1) first += STRIDE;
    while (last > first && s.stops[last + 4] !== 1) last -= STRIDE;
    if (s.stops[first + 4] !== 1) [first, last] = [0, s.stops.length - STRIDE];
    return {
      uid: s.uid,
      date: s.date,
      atoc: s.atoc,
      origin: this.#nameOf(this.#keys[s.stops[first]]),
      destination: this.#nameOf(this.#keys[s.stops[last]]),
      ...(s.service && { service: s.service }),
    };
  }

  #nameOf(key: string): string {
    return this.#name(key) ?? this.#names.get(key) ?? key;
  }

  #keyOf(key: string): number {
    let k = this.#keyIndex.get(key);
    if (k === undefined) {
      k = this.#keys.push(key) - 1;
      this.#keyIndex.set(key, k);
    }
    return k;
  }

  #pack(locations: CifLocation[]): Int32Array {
    // Passenger trains: calls are the stops with public times. Others
    // (empty stock, freight) have none; their calls are where they stop.
    const isPublic = (v: string | null | undefined) => Boolean(v) && v !== '0000';
    const hasPublic = locations.some((l) => isPublic(l.public_arrival) || isPublic(l.public_departure));
    const out = new Int32Array(locations.length * STRIDE);
    let offset = 0;
    let last = -Infinity;
    // Times only go forward; a smaller one has crossed midnight.
    const time = (v: string | null | undefined) => {
      const t = parseTime(v);
      if (t === NONE) return NONE;
      if (t + offset < last) offset += 2880;
      last = t + offset;
      return last;
    };
    locations.forEach((l, i) => {
      const tiploc = l.tiploc_code?.trim() ?? '';
      const arr = time(l.arrival);
      const pass = time(l.pass);
      const dep = time(l.departure);
      const calls = hasPublic
        ? isPublic(l.public_arrival) || isPublic(l.public_departure)
        : pass === NONE && (arr !== NONE || dep !== NONE);
      out.set([this.#keyOf(this.#stanoxOf.get(tiploc) ?? tiploc), arr, dep, pass, calls ? 1 : 0], i * STRIDE);
    });
    return out;
  }
}

/** What the train store asks of a timetable (so tests can stub it). */
export interface ScheduleLookup {
  byUid(uid: string, date: string): ScheduleInfo | undefined;
  match(headcode: string, key: string, plannedMs: number): ScheduleInfo | undefined;
  plannedStops?(uid: string, date: string): PlannedStop[] | undefined;
}

/** "HHMM" or "HHMMH" (half past the minute) -> half-minutes after midnight. */
function parseTime(v: string | null | undefined): number {
  if (!v || v.length < 4) return NONE;
  const h = Number(v.slice(0, 2));
  const m = Number(v.slice(2, 4));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NONE;
  return (h * 60 + m) * 2 + (v[4] === 'H' ? 1 : 0);
}

function lastTime(stops: Int32Array): number {
  let t = NONE;
  for (let i = 0; i < stops.length; i += STRIDE) t = Math.max(t, stops[i + 1], stops[i + 2], stops[i + 3]);
  return t;
}

function serviceCodes(s: CifSchedule): ServiceCodes | undefined {
  const g = s.schedule_segment;
  const codes: ServiceCodes = {};
  const fields = {
    power: g?.CIF_power_type,
    timingLoad: g?.CIF_timing_load,
    speed: g?.CIF_speed,
    seating: g?.CIF_train_class,
    sleepers: g?.CIF_sleepers,
    reservations: g?.CIF_reservations,
    catering: g?.CIF_catering_code,
  };
  for (const [k, v] of Object.entries(fields)) if (v?.trim()) codes[k as keyof ServiceCodes] = v.trim();
  return Object.keys(codes).length ? codes : undefined;
}

function runsOn(s: CifSchedule, date: string): boolean {
  return s.schedule_start_date <= date && date <= s.schedule_end_date && s.schedule_days_runs?.[weekdayIndex(date)] === '1';
}

function fromVstp(v: VstpSchedule): CifSchedule {
  const seg = v.schedule_segment?.[0];
  return {
    CIF_train_uid: v.CIF_train_uid.trim(),
    CIF_stp_indicator: v.CIF_stp_indicator,
    schedule_start_date: v.schedule_start_date,
    schedule_end_date: v.schedule_end_date,
    schedule_days_runs: v.schedule_days_runs,
    atoc_code: seg?.atoc_code?.trim() || null,
    schedule_segment: seg && {
      signalling_id: seg.signalling_id,
      CIF_power_type: seg.CIF_power_type,
      CIF_timing_load: seg.CIF_timing_load,
      CIF_speed: seg.CIF_speed,
      CIF_train_class: seg.CIF_train_class,
      CIF_sleepers: seg.CIF_sleepers,
      CIF_reservations: seg.CIF_reservations,
      CIF_catering_code: seg.CIF_catering_code,
      schedule_location: seg.schedule_location?.map((l) => ({
        tiploc_code: l.location?.tiploc?.tiploc_id,
        arrival: vstpTime(l.scheduled_arrival_time),
        departure: vstpTime(l.scheduled_departure_time),
        pass: vstpTime(l.scheduled_pass_time),
        public_arrival: vstpTime(l.public_arrival_time),
        public_departure: vstpTime(l.public_departure_time),
      })),
    },
  };
}

/** VSTP's "HHMMSS" as the extract's "HHMM", plus "H" from 30 seconds. */
function vstpTime(v: string | null | undefined): string | null {
  const t = v?.trim();
  if (!t || t.length < 4) return null;
  return `${t.slice(0, 4)}${Number(t.slice(4, 6)) >= 30 ? 'H' : ''}`;
}

/** Monday = 0, as in schedule_days_runs. */
const weekdays = new Map<string, number>();
function weekdayIndex(date: string): number {
  let day = weekdays.get(date);
  if (day === undefined) {
    day = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
    weekdays.set(date, day);
  }
  return day;
}

// ---- London time ----

const londonParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** How far London's clock is ahead of UTC at an instant (0 or one hour). */
function londonOffsetMs(utcMs: number): number {
  const p = Object.fromEntries(londonParts.formatToParts(utcMs).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return asUtc - Math.floor(utcMs / 60_000) * 60_000;
}

/** A timetable time (half-minutes after midnight on `date`, London) as ms since the epoch. */
export function londonTime(date: string, halfMinutes: number): number {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d) + halfMinutes * 30_000;
  return wall - londonOffsetMs(wall - londonOffsetMs(wall));
}

/** The London calendar date of an instant, YYYY-MM-DD. */
export function londonDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(ms);
}
