// TfL rail lines (Underground, DLR, Overground, Elizabeth line) from TfL's
// open arrivals API.
//
// TfL publishes predictions, not positions: for each train, its upcoming
// stations and the seconds until it reaches each. The nearest prediction
// gives the next station; the line's station sequence gives the one before
// it; the time left, against the section's running time, says how far along
// the train is. Running speed comes from TfL's own predictions for the
// following sections when there are enough of them.
//
// DLR predictions carry no train numbers, so DLR trains are inferred: a
// station whose soonest arrival (towards a given destination) is sooner than
// one section's running time has a train on the section before it. Inferred
// trains are matched to the previous poll's by position to keep their ids.

import type { FeedStatus } from '../feeds/feed.ts';
import type { LocationIndex, StationTable } from '../engine/locations.ts';
import type { PathService } from '../engine/paths.ts';
import type { TrainSource } from '../engine/source.ts';
import { distanceM, lineLengthM, type LonLat } from '../engine/track.ts';
import type { StopDetail, TrainDetails } from '../engine/trainDetails.ts';
import type { TrainChanges, TrainView } from '../engine/trainStore.ts';
import type { TflLoads } from './loads.ts';
import { tflStock } from './stock.ts';

export type TflMode = 'tube' | 'dlr' | 'overground' | 'elizabeth-line';

export interface TflData {
  lines: Record<string, { name: string; mode: TflMode; color: string; routes: string[][] }>;
  stations: StationTable;
}

/** The fields of a TfL /Line/{ids}/Arrivals prediction this uses. */
export interface TflPrediction {
  lineId: string;
  vehicleId?: string;
  naptanId: string;
  timeToStation: number; // seconds
  towards?: string;
  destinationNaptanId?: string;
  destinationName?: string;
  platformName?: string;
  timestamp?: string;
}

/** A line's disruption from TfL's status feed (closures, delays). */
export interface TflLineStatus {
  summary: string;
  reason?: string;
  /** No trains at all (closed or suspended), not just part of the line. */
  closed: boolean;
}

export interface TflOptions {
  pollMs?: number;
  statusPollMs?: number;
  appKey?: string;
  fetch?: typeof fetch;
  /** Typical train loads, for how busy a train usually is. */
  loads?: TflLoads | null;
}

interface TflTrain {
  view: TrainView;
  /** Station keys in travel order, from the route's start to the destination. */
  route: string[];
  /** Index in `route` of the last station passed (or being stopped at). */
  here: number;
  expected: Map<string, number>;
  missed: number;
  /** For matching inferred (DLR) trains between polls. */
  match?: { group: string; prev?: string; next: string };
}

/** The fields of a TfL /Line/{ids}/Status entry this uses. */
export interface TflLineStatusResponse {
  id: string;
  lineStatuses?: { statusSeverity: number; statusSeverityDescription: string; reason?: string }[];
}

/** A train's upcoming stops in travel order, with seconds until each. */
type Chain = { key: string; tts: number }[];

const API = 'https://api.tfl.gov.uk';
const USER_AGENT = 'train-live-prototype/0.1 (rail map prototype)';
// Fallback running speed (excluding stops) and station dwell per network.
const MODE_DEFAULTS: Record<TflMode, { speedKmh: number; dwellS: number }> = {
  tube: { speedKmh: 40, dwellS: 30 },
  dlr: { speedKmh: 35, dwellS: 25 },
  overground: { speedKmh: 50, dwellS: 40 },
  'elizabeth-line': { speedKmh: 60, dwellS: 45 },
};
// Time lost accelerating and braking on each section.
const START_STOP_S = 20;
const AT_STATION_S = 20;
// Trains missing from this many polls in a row are dropped (they have
// usually gone out of service).
const MAX_MISSED = 2;
// Longest a train is shown waiting at the station its trip starts from.
const MAX_WAIT_AT_START_S = 300;
// TfL status severities: good service and notices that are not disruptions
// (no issues, information, exit only, no step-free access).
const NOT_DISRUPTED = new Set([10, 18, 19, 12, 13]);
// Closed, suspended, planned closure, not running, service closed.
const WHOLE_LINE_CLOSED = new Set([1, 2, 4, 16, 20]);

export class TflTracker implements TrainSource {
  readonly name = 'tfl';
  #data: TflData;
  #locations: LocationIndex;
  /** Each line is routed only on its own track. */
  #paths: (lineId: string) => PathService;
  #opts: TflOptions;
  #trains = new Map<string, TflTrain>();
  #changed = new Set<string>();
  #removed = new Set<string>();
  #timer?: NodeJS.Timeout;
  #statusTimer?: NodeJS.Timeout;
  #status: FeedStatus = { connected: false, detail: 'not started' };
  #lineStatus: Record<string, TflLineStatus> = {};
  #nextInferredId = 1;

  constructor(data: TflData, locations: LocationIndex, paths: (lineId: string) => PathService, opts: TflOptions = {}) {
    this.#data = data;
    this.#locations = locations;
    this.#paths = paths;
    this.#opts = opts;
  }

  start(): void {
    void this.#poll();
    void this.#pollLineStatus();
    this.#timer = setInterval(() => void this.#poll(), this.#opts.pollMs ?? 30_000);
    this.#statusTimer = setInterval(() => void this.#pollLineStatus(), this.#opts.statusPollMs ?? 5 * 60_000);
  }

  stop(): void {
    clearInterval(this.#timer);
    clearInterval(this.#statusTimer);
  }

  /** Feed health, plus the lines that are disrupted (a line closed for the day has few or no trains). */
  status(): FeedStatus & { trains: number; lines: Record<string, TflLineStatus> } {
    return { ...this.#status, trains: this.#trains.size, lines: this.#lineStatus };
  }

  async #pollLineStatus(): Promise<void> {
    const lines = Object.keys(this.#data.lines).join(',');
    const key = this.#opts.appKey ? `?app_key=${encodeURIComponent(this.#opts.appKey)}` : '';
    try {
      const res = await (this.#opts.fetch ?? fetch)(`${API}/Line/${lines}/Status${key}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return;
      this.setLineStatus((await res.json()) as TflLineStatusResponse[]);
    } catch {
      // Keep the last known status; arrivals carry on without it.
    }
  }

  /** Takes TfL's /Line/{ids}/Status response; each line keeps its worst current status. */
  setLineStatus(response: TflLineStatusResponse[]): void {
    const out: Record<string, TflLineStatus> = {};
    for (const line of response) {
      if (!line || !this.#data.lines[line.id]) continue;
      const worst = (line.lineStatuses ?? [])
        .filter((s) => !NOT_DISRUPTED.has(s.statusSeverity))
        .sort((a, b) => a.statusSeverity - b.statusSeverity)[0];
      if (!worst) continue;
      out[line.id] = {
        summary: worst.statusSeverityDescription,
        reason: worst.reason?.trim() || undefined,
        closed: WHOLE_LINE_CLOSED.has(worst.statusSeverity),
      };
    }
    this.#lineStatus = out;
  }

  snapshot(): TrainView[] {
    return [...this.#trains.values()].map((t) => t.view);
  }

  drainChanges(): TrainChanges {
    const upserts = [...this.#changed].flatMap((id) => this.#trains.get(id)?.view ?? []);
    const removals = [...this.#removed];
    this.#changed.clear();
    this.#removed.clear();
    return { upserts, removals };
  }

  async #poll(): Promise<void> {
    const lines = Object.keys(this.#data.lines).join(',');
    const key = this.#opts.appKey ? `?app_key=${encodeURIComponent(this.#opts.appKey)}` : '';
    try {
      const res = await (this.#opts.fetch ?? fetch)(`${API}/Line/${lines}/Arrivals${key}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const predictions = (await res.json()) as TflPrediction[];
      this.update(predictions, Date.now());
      this.#status = { connected: true, detail: `${this.#trains.size} trains from TfL` };
    } catch (err) {
      this.#status = { connected: false, detail: `TfL arrivals: ${(err as Error).message}` };
    }
  }

  /** Replaces the train list with one built from a full set of predictions. */
  update(predictions: TflPrediction[], now: number): void {
    const byVehicle = new Map<string, TflPrediction[]>();
    const anonymous = new Map<string, TflPrediction[]>();
    for (const p of predictions) {
      if (!p || !this.#data.lines[p.lineId] || !this.#locations.get(p.naptanId)) continue;
      const vehicle = p.vehicleId?.trim();
      if (vehicle && !/^0+$/.test(vehicle)) push(byVehicle, `TFL-${p.lineId}-${vehicle}`, p);
      else if (this.#data.lines[p.lineId].mode === 'dlr') push(anonymous, p.lineId, p);
      // Other predictions without a train number cannot be tied to a train.
    }

    const fresh = new Map<string, TflTrain>();
    for (const [id, list] of byVehicle) {
      const train = this.#fromVehicle(id, list, now);
      if (train) fresh.set(id, train);
    }
    for (const [lineId, list] of anonymous) {
      for (const [id, train] of this.#inferTrains(lineId, list, now)) fresh.set(id, train);
    }

    for (const [id, train] of fresh) {
      this.#trains.set(id, train);
      this.#changed.add(id);
      this.#removed.delete(id);
    }
    for (const [id, train] of this.#trains) {
      if (fresh.has(id)) continue;
      // Inferred trains have no identity to wait for; drop them at once.
      if (!train.match && ++train.missed < MAX_MISSED) continue;
      this.#trains.delete(id);
      this.#changed.delete(id);
      this.#removed.add(id);
    }
  }

  describe(trainId: string): TrainDetails | undefined {
    const train = this.#trains.get(trainId);
    if (!train) return undefined;
    const { view, route, here } = train;
    const paths = this.#paths(view.line!);
    const stops: StopDetail[] = route.map((key, i) => {
      const place = paths.place(key);
      let status: StopDetail['status'] = i <= here ? 'passed' : 'upcoming';
      if (i === here && view.state !== 'moving') status = 'current';
      return {
        key,
        name: place?.name ?? key,
        call: true,
        status,
        lat: place?.lat,
        lon: place?.lon,
        expectedArr: train.expected.get(key),
      };
    });
    const pathBehind: LonLat[] = [];
    const pathAhead: LonLat[] = [];
    for (let i = 1; i < route.length; i++) {
      const seg = paths.between(route[i - 1], route[i]);
      if (!seg) continue;
      const target = i <= here ? pathBehind : pathAhead;
      const last = target.at(-1);
      target.push(...(last && last[0] === seg[0][0] && last[1] === seg[0][1] ? seg.slice(1) : seg));
    }
    return {
      train: view,
      timetabled: true,
      stops,
      previous: stops.slice(0, here + 1).findLast((s) => s.status === 'passed'),
      current: stops.find((s) => s.status === 'current'),
      next: stops.find((s) => s.status === 'upcoming'),
      pathBehind,
      pathAhead,
      service: tflStock(view.line!),
      // The section it is on, or about to leave.
      load: this.#opts.loads?.estimate(view.line!, view.from.key, view.to?.key ?? route[here + 1] ?? '', Date.now()),
    };
  }

  // ---- Trains with train numbers ----

  #fromVehicle(id: string, list: TflPrediction[], now: number): TflTrain | null {
    const lineId = list[0].lineId;
    const line = this.#data.lines[lineId];
    // One prediction per station, soonest first.
    const upcoming: TflPrediction[] = [];
    const seen = new Set<string>();
    for (const p of [...list].sort((a, b) => a.timeToStation - b.timeToStation)) {
      if (seen.has(p.naptanId)) continue;
      seen.add(p.naptanId);
      upcoming.push(p);
    }
    const next = upcoming[0];
    if (!next) return null;

    // The route (branch) and direction that best fit the predicted stops.
    let best: { ordered: string[]; at: number; score: number } | null = null;
    for (const r of line.routes) {
      if (!r.includes(next.naptanId)) continue;
      for (const ordered of [r, [...r].reverse()]) {
        const at = ordered.indexOf(next.naptanId);
        let score = 0;
        let pos = at;
        for (const p of upcoming.slice(1)) {
          const j = ordered.indexOf(p.naptanId, pos + 1);
          if (j < 0) continue;
          score++;
          pos = j;
        }
        if (next.destinationNaptanId && ordered.indexOf(next.destinationNaptanId, at) >= 0) score += 2;
        // A previous station must exist to place the train between two stops.
        if (at > 0) score += 0.5;
        if (!best || score > best.score) best = { ordered, at, score };
      }
    }
    const ordered = best?.ordered ?? [next.naptanId];
    let at = best?.at ?? 0;

    // Predictions in route order from the next station on.
    let chain: Chain = [];
    const ttsAt = new Map(upcoming.map((p) => [p.naptanId, p.timeToStation]));
    for (let k = at; k < ordered.length; k++) {
      const tts = ttsAt.get(ordered[k]);
      if (tts !== undefined && (!chain.length || tts > chain[chain.length - 1].tts)) chain.push({ key: ordered[k], tts });
    }

    // Overground and Elizabeth line ids are trips, and TfL lists trips that
    // start up to two hours from now, often with a stray "due now" at the
    // first station. A gap no train could take between two stops means the
    // stops before it are not real; start from the stop after it.
    const { speedKmh, dwellS } = MODE_DEFAULTS[line.mode];
    const runS = (a: string, b: string) => this.#lengthM(lineId, a, b) / (speedKmh / 3.6) + START_STOP_S;
    for (let k = chain.length - 1; k > 0; k--) {
      if (chain[k].tts - chain[k - 1].tts > 2 * runS(chain[k - 1].key, chain[k].key) + dwellS + 300) {
        chain = chain.slice(k);
        at = ordered.indexOf(chain[0].key, at);
        break;
      }
    }
    // A train that cannot reach its next stop that soon is not running yet
    // (a later trip, or one laying over at the terminus).
    const soonest = chain[0]?.tts ?? next.timeToStation;
    const limitS = at > 0 ? 1.5 * runS(ordered[at - 1], ordered[at]) + dwellS + 180 : MAX_WAIT_AT_START_S;
    if (soonest > limitS) return null;
    return this.#makeTrain(id, lineId, ordered, at, chain, next, now);
  }

  // ---- DLR: trains inferred from per-station predictions ----

  #inferTrains(lineId: string, list: TflPrediction[], now: number): Map<string, TflTrain> {
    const line = this.#data.lines[lineId];
    const defaults = MODE_DEFAULTS[line.mode];
    // station -> destination -> seconds until each arrival, soonest first
    const arrivals = new Map<string, Map<string, TflPrediction[]>>();
    for (const p of list) {
      const dest = p.destinationNaptanId ?? '';
      const byDest = arrivals.get(p.naptanId) ?? new Map<string, TflPrediction[]>();
      push(byDest, dest, p);
      arrivals.set(p.naptanId, byDest);
    }
    for (const byDest of arrivals.values()) for (const ps of byDest.values()) ps.sort((a, b) => a.timeToStation - b.timeToStation);

    const found: { group: string; ordered: string[]; at: number; chain: Chain; meta: TflPrediction }[] = [];
    const seenSections = new Set<string>();
    for (const r of line.routes) {
      for (const ordered of [r, [...r].reverse()]) {
        for (let i = 1; i < ordered.length; i++) {
          const prev = ordered[i - 1], station = ordered[i];
          for (const [dest, ps] of arrivals.get(station) ?? []) {
            const destIdx = ordered.indexOf(dest, i);
            if (destIdx < 0) continue;
            const first = ps[0];
            const runS = this.#lengthM(lineId, prev, station) / (defaults.speedKmh / 3.6) + START_STOP_S;
            if (first.timeToStation > runS + AT_STATION_S) continue;
            const section = `${prev}>${station}|${dest}`;
            if (seenSections.has(section)) continue;
            seenSections.add(section);
            // Follow the same train down the line: at each later station, the
            // first arrival after it reached the one before.
            const chain: Chain = [{ key: station, tts: first.timeToStation }];
            for (let k = i + 1; k <= destIdx; k++) {
              const later = arrivals.get(ordered[k])?.get(dest)?.find((p) => p.timeToStation > chain[chain.length - 1].tts + 10);
              if (!later) break;
              chain.push({ key: ordered[k], tts: later.timeToStation });
            }
            found.push({ group: `${lineId}|${dest}`, ordered, at: i, chain, meta: first });
          }
        }
      }
    }

    // Keep ids stable: a train seen before now has the same next station, or
    // the next station has become its previous one.
    const previous = [...this.#trains.entries()].filter(([, t]) => t.match?.group.startsWith(`${lineId}|`));
    const taken = new Set<string>();
    const out = new Map<string, TflTrain>();
    for (const f of found) {
      const next = f.ordered[f.at];
      const prev = f.ordered[f.at - 1];
      const same = previous.find(([id, t]) => !taken.has(id) && t.match!.group === f.group && t.match!.next === next)
        ?? previous.find(([id, t]) => !taken.has(id) && t.match!.group === f.group && t.match!.next === prev);
      const id = same?.[0] ?? `TFL-${lineId}-inferred-${this.#nextInferredId++}`;
      taken.add(id);
      const train = this.#makeTrain(id, lineId, f.ordered, f.at, f.chain, f.meta, now);
      train.match = { group: f.group, prev, next };
      out.set(id, train);
    }
    return out;
  }

  // ---- Shared ----

  #lengthM(lineId: string, a: string, b: string): number {
    const path = this.#paths(lineId).between(a, b);
    if (path) return lineLengthM(path);
    const pa = this.#locations.get(a), pb = this.#locations.get(b);
    return pa && pb ? distanceM([pa.lon, pa.lat], [pb.lon, pb.lat]) : 0;
  }

  /**
   * Running speed (m/s, excluding stops) implied by TfL's predicted times
   * between the next few stations, or null if there are too few.
   */
  #predictedSpeed(lineId: string, chain: Chain, dwellS: number): number | null {
    let dist = 0, time = 0;
    for (let i = 1; i < chain.length && i <= 4; i++) {
      const running = chain[i].tts - chain[i - 1].tts - dwellS - START_STOP_S;
      if (running < 15) continue;
      dist += this.#lengthM(lineId, chain[i - 1].key, chain[i].key);
      time += running;
    }
    if (time < 45) return null;
    // Keep within what these railways can do (15–160 km/h).
    return Math.min(44, Math.max(4, dist / time));
  }

  #makeTrain(id: string, lineId: string, ordered: string[], at: number, chain: Chain, meta: TflPrediction, now: number): TflTrain {
    const line = this.#data.lines[lineId];
    const defaults = MODE_DEFAULTS[line.mode];
    const speed = this.#predictedSpeed(lineId, chain, defaults.dwellS) ?? defaults.speedKmh / 3.6;
    let route = ordered;
    const destIdx = meta.destinationNaptanId ? route.indexOf(meta.destinationNaptanId, at) : -1;
    if (destIdx >= 0) route = route.slice(0, destIdx + 1);

    const paths = this.#paths(lineId);
    const nextPlace = paths.place(route[at])!;
    const prevKey = at > 0 ? route[at - 1] : undefined;
    const prevPlace = prevKey ? paths.place(prevKey) : undefined;
    const tts = Math.max(0, chain[0]?.tts ?? 0);
    // Only Underground train numbers are short and meaningful; Overground and
    // Elizabeth line ids are long trip references, and DLR ones are made up.
    const vehicle = line.mode === 'tube' ? id.slice(`TFL-${lineId}-`.length) : '';
    const base = {
      id,
      headcode: vehicle,
      toc: 'TfL',
      operator: lineLabel(line.name, line.mode),
      freight: false,
      delayMin: 0,
      platform: meta.platformName?.trim() || undefined,
      reportedAt: Date.parse(meta.timestamp ?? '') || now,
      mode: line.mode,
      line: lineId,
      color: line.color,
      destination: stationName(meta.destinationName ?? meta.towards),
    };

    let view: TrainView;
    let here: number;
    if (tts <= AT_STATION_S || !prevPlace) {
      view = { ...base, state: 'stopped', from: nextPlace, to: null, departedAt: now, runMs: 0, speedKmh: 0, toward: route[at + 1] };
      here = at;
    } else {
      const lengthM = this.#lengthM(lineId, prevKey!, route[at]);
      const runS = lengthM / speed + START_STOP_S;
      if (tts > runS + AT_STATION_S) {
        // Still standing at (or held outside) the previous station.
        view = { ...base, state: 'stopped', from: prevPlace, to: null, departedAt: now, runMs: 0, speedKmh: 0, toward: route[at] };
      } else {
        const elapsedS = Math.max(0, runS - tts);
        view = {
          ...base,
          state: 'moving',
          from: prevPlace,
          to: nextPlace,
          departedAt: now - elapsedS * 1000,
          runMs: runS * 1000,
          // Average over the section, including speeding up and slowing down.
          speedKmh: Math.round((lengthM / runS) * 3.6),
        };
      }
      here = at - 1;
    }

    const expected = new Map(chain.map((c) => [c.key, now + c.tts * 1000]));
    return { view, route, here, expected, missed: 0 };
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function lineLabel(name: string, mode: TflMode): string {
  if (mode === 'dlr' || /line$/i.test(name)) return name;
  return `${name} line`;
}

function stationName(name: string | undefined): string | undefined {
  // TfL's placeholders when a train's destination is not known.
  if (!name || /^(check front of train|unknown)$/i.test(name.trim())) return undefined;
  return name.replace(/ (Underground|DLR|Rail) Station$/, '').replace(/ \(.*Line\)$/i, '').trim() || undefined;
}
