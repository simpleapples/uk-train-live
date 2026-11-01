// Generates TRUST-shaped movement messages for simulated services, so the
// whole pipeline (store -> SSE -> map) runs without a Network Rail account.
// Location codes in these messages are TIPLOCs, not STANOX codes.

import type { StationTable } from '../engine/locations.ts';
import { MSG_MOVEMENT, type TrustMessage } from '../trust/types.ts';
import type { EmitMessages, Feed, FeedStatus, PlannedStop } from './feed.ts';
import { LINES, PATTERNS, type Pattern } from './demoNetwork.ts';

const MINUTE = 60_000;
const DWELL_MS = MINUTE;
// Track is never straight; inflate crow-fly distance to approximate it.
const CURVATURE = 1.15;

interface TimetableStop {
  tiploc: string;
  arr: number; // ms after origin departure
  dep: number;
  call: boolean;
}

interface Service {
  patternIndex: number;
  pattern: Pattern;
  up: boolean;
  stops: TimetableStop[];
  durationMs: number;
  offsetMs: number;
}

interface DemoEvent {
  at: number;
  message: TrustMessage;
}

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function buildTimetable(pattern: Pattern, stations: StationTable, up: boolean): TimetableStop[] {
  const line = LINES[pattern.line];
  if (!line) throw new Error(`Unknown demo line ${pattern.line}`);
  const first = pattern.from ? line.indexOf(pattern.from) : 0;
  const last = pattern.to ? line.indexOf(pattern.to) : line.length - 1;
  if (first < 0 || last < 0 || first >= last) throw new Error(`Bad from/to on demo line ${pattern.line}`);
  let route = line.slice(first, last + 1);
  if (up) route = route.reverse();

  const calls = pattern.calls === 'all' ? null : new Set(pattern.calls);
  const stops: TimetableStop[] = [];
  let t = 0;
  route.forEach((tiploc, i) => {
    const here = stations[tiploc];
    if (!here) throw new Error(`Demo TIPLOC ${tiploc} has no coordinates`);
    const terminal = i === 0 || i === route.length - 1;
    const call = terminal || !calls || calls.has(tiploc);
    if (i > 0) {
      const km = haversineKm(stations[route[i - 1]], here) * CURVATURE;
      t += Math.max(1, Math.round((km / pattern.speedKmh) * 60)) * MINUTE;
    }
    const arr = t;
    if (call && !terminal) t += DWELL_MS;
    stops.push({ tiploc, arr, dep: t, call });
  });
  return stops;
}

// Small seeded PRNG so a given service instance always gets the same delays.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export class DemoFeed implements Feed {
  readonly kind = 'demo';
  #services: Service[];
  #instances = new Map<string, { trainId: string; events: DemoEvent[] }>();
  #plans = new Map<string, PlannedStop[]>();
  #timer?: NodeJS.Timeout;
  #lastTick: number | null = null;
  #now: () => number;

  constructor(stations: StationTable, now: () => number = Date.now) {
    this.#now = now;
    this.#services = PATTERNS.flatMap((pattern, patternIndex) =>
      [false, true].map((up) => {
        const stops = buildTimetable(pattern, stations, up);
        const headway = pattern.headwayMin * MINUTE;
        // Stagger patterns so services do not all leave on the hour.
        const offsetMs = ((patternIndex * 7 * MINUTE) + (up ? headway / 2 : 0)) % headway;
        return { patternIndex, pattern, up, stops, durationMs: stops.at(-1)!.arr, offsetMs };
      }),
    );
  }

  start(emit: EmitMessages): void {
    const tick = () => {
      const now = this.#now();
      const messages = this.tick(now);
      if (messages.length) emit(messages, now);
    };
    tick();
    this.#timer = setInterval(tick, 1000);
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  status(): FeedStatus {
    return { connected: true, detail: `${this.#services.length} simulated service patterns` };
  }

  plannedStops(trainId: string): PlannedStop[] | undefined {
    return this.#plans.get(trainId);
  }

  /**
   * Messages for events in (previous tick, now]. The first call instead
   * returns each running service's most recent event, so the map starts full.
   */
  tick(now: number): TrustMessage[] {
    const since = this.#lastTick;
    this.#lastTick = now;
    const out: TrustMessage[] = [];
    const live = new Set<string>();

    for (const svc of this.#services) {
      const period = svc.pattern.headwayMin * MINUTE;
      // Allow for the worst simulated delay when deciding who is still running.
      const horizon = svc.durationMs + 45 * MINUTE;
      const kMin = Math.ceil((now - horizon - svc.offsetMs) / period);
      const kMax = Math.floor((now - svc.offsetMs) / period);
      for (let k = kMin; k <= kMax; k++) {
        const key = `${svc.patternIndex}:${svc.up ? 'U' : 'D'}:${k}`;
        live.add(key);
        let instance = this.#instances.get(key);
        if (!instance) {
          instance = this.#instance(svc, k, key);
          this.#instances.set(key, instance);
        }
        const { events } = instance;
        if (since === null) {
          const latest = events.findLast((e) => e.at <= now);
          if (latest) out.push(latest.message);
        } else {
          for (const e of events) if (e.at > since && e.at <= now) out.push(e.message);
        }
      }
    }
    for (const [key, instance] of this.#instances) {
      if (live.has(key)) continue;
      this.#instances.delete(key);
      this.#plans.delete(instance.trainId);
    }
    return out;
  }

  #instance(svc: Service, k: number, key: string): { trainId: string; events: DemoEvent[] } {
    const { pattern, stops } = svc;
    const rand = mulberry32(hash(key));
    // Seconds of jitter so reports do not all land on the minute.
    const startsAt = k * pattern.headwayMin * MINUTE + svc.offsetMs + Math.floor(rand() * 60) * 1000;
    const headcode = `${pattern.cls}${pattern.letter}${pad2(((k % 100) + 100) % 100)}`;
    const trainId = `${pad2(svc.patternIndex)}${headcode}${svc.up ? 'U' : 'D'}M${pad2(new Date(startsAt).getUTCDate())}`;

    const r = rand();
    let delay = r < 0.6 ? 0 : r < 0.9 ? 1 + Math.floor(rand() * 4) : 5 + Math.floor(rand() * 11);
    const events: DemoEvent[] = [];
    let lastAt = -Infinity;

    const push = (i: number, eventType: 'ARRIVAL' | 'DEPARTURE', planned: string, scheduled: number) => {
      const at = Math.max(lastAt, startsAt + scheduled + delay * MINUTE);
      lastAt = at;
      const next = stops[i + 1];
      const terminated = i === stops.length - 1;
      events.push({
        at,
        message: {
          header: { msg_type: MSG_MOVEMENT, source_system_id: 'TRUST', original_data_source: 'DEMO' },
          body: {
            train_id: trainId,
            event_type: eventType,
            planned_event_type: planned,
            actual_timestamp: String(at),
            planned_timestamp: String(startsAt + scheduled),
            loc_stanox: stops[i].tiploc,
            next_report_stanox: next?.tiploc ?? null,
            next_report_run_time: next ? String(Math.round((next.arr - stops[i].dep) / MINUTE)) : null,
            timetable_variation: String(Math.abs(delay)),
            variation_status: delay > 0 ? 'LATE' : delay < 0 ? 'EARLY' : 'ON TIME',
            toc_id: pattern.toc,
            train_terminated: String(terminated),
            direction_ind: svc.up ? 'UP' : 'DOWN',
            event_source: 'AUTOMATIC',
          },
        },
      });
    };

    stops.forEach((stop, i) => {
      if (i > 0) {
        const roll = rand();
        if (roll < 0.03) delay += 3 + Math.floor(rand() * 4);
        else if (roll < 0.18) delay += 1;
        else if (roll < 0.3) delay = Math.max(-1, delay - 1);
      }
      if (i === 0) push(i, 'DEPARTURE', 'DEPARTURE', stop.dep);
      else if (i === stops.length - 1) push(i, 'ARRIVAL', 'DESTINATION', stop.arr);
      else if (stop.call) {
        push(i, 'ARRIVAL', 'ARRIVAL', stop.arr);
        push(i, 'DEPARTURE', 'DEPARTURE', stop.dep);
      } else push(i, 'DEPARTURE', 'PASS', stop.arr);
    });

    this.#plans.set(trainId, stops.map((s, i) => ({
      key: s.tiploc,
      call: s.call,
      arr: i > 0 ? startsAt + s.arr : undefined,
      dep: i < stops.length - 1 ? startsAt + s.dep : undefined,
    })));
    return { trainId, events };
  }
}
