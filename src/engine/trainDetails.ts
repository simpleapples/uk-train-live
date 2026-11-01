// Everything the detail panel needs for one train: its stops (the timetable
// when the feed knows it, otherwise the places it has reported at), where it
// is among them, and the track to highlight.

import type { PlannedStop } from '../feeds/feed.ts';
import { describeService, type ServiceDetails } from '../schedule/service.ts';
import type { LocationIndex } from './locations.ts';
import type { PathService } from './paths.ts';
import type { LonLat } from './track.ts';
import type { HistoryEntry, TrainStore, TrainView } from './trainStore.ts';

export type StopStatus = 'passed' | 'current' | 'upcoming';

export interface StopDetail {
  key: string;
  name: string;
  /** False for timing points the train runs through without stopping. */
  call: boolean;
  status: StopStatus;
  lat?: number;
  lon?: number;
  plannedArr?: number;
  plannedDep?: number;
  actualArr?: number;
  actualDep?: number;
  /** Predicted arrival (Tube trains, from TfL). */
  expectedArr?: number;
}

export interface TrainDetails {
  train: TrainView;
  /** True when `stops` is a timetable; false when it only lists reported locations. */
  timetabled: boolean;
  stops: StopDetail[];
  previous?: StopDetail;
  current?: StopDetail;
  next?: StopDetail;
  /** Track already covered, and still ahead, split at the last reported location. */
  pathBehind: LonLat[];
  pathAhead: LonLat[];
  /** Train type and facilities, from its schedule. */
  service?: ServiceDetails;
}

export function describeTrain(
  id: string,
  store: TrainStore,
  locations: LocationIndex,
  paths: PathService,
  plannedStops?: (trainId: string) => PlannedStop[] | undefined,
): TrainDetails | undefined {
  const rec = store.train(id);
  if (!rec) return undefined;
  const { view, history } = rec;
  const planned = plannedStops?.(id);
  const timetabled = Boolean(planned?.length);
  const stops = timetabled ? fromTimetable(planned!, history, view, locations) : fromHistory(history, view);
  for (const s of stops) {
    const p = locations.get(s.key);
    if (p) {
      s.lat = p.lat;
      s.lon = p.lon;
    }
  }

  const here = stops.findLastIndex((s) => s.status !== 'upcoming');
  const previous = stops.slice(0, here + 1).findLast((s) => s.call && s.status === 'passed');
  const current = stops.find((s) => s.status === 'current');
  const next = stops.find((s) => s.call && s.status === 'upcoming');

  const pathBehind: LonLat[] = [];
  const pathAhead: LonLat[] = [];
  const placed = stops.flatMap((s, i) => (s.lat !== undefined ? [{ i, key: s.key }] : []));
  for (let n = 1; n < placed.length; n++) {
    const seg = paths.between(placed[n - 1].key, placed[n].key);
    if (seg) append(placed[n].i <= here ? pathBehind : pathAhead, seg);
  }

  return { train: view, timetabled, stops, previous, current, next, pathBehind, pathAhead, service: describeService(store.scheduleOf(id)) };
}

function fromTimetable(
  planned: PlannedStop[],
  history: readonly HistoryEntry[],
  view: TrainView,
  locations: LocationIndex,
): StopDetail[] {
  const stops: StopDetail[] = planned.map((p) => ({
    key: p.key,
    name: p.name ?? locations.name(p.key) ?? p.key,
    call: p.call,
    status: 'upcoming',
    plannedArr: p.arr,
    plannedDep: p.dep,
  }));

  // Match reports to timetable rows in order.
  let from = 0;
  let lastMatched = -1;
  for (const h of history) {
    const i = stops.findIndex((s, idx) => idx >= from && s.key === h.key);
    if (i < 0) continue;
    stops[i].actualArr = h.arr;
    stops[i].actualDep = h.dep;
    lastMatched = i;
    from = i + 1;
  }
  // A train first seen mid-journey has little history; its current
  // location still says where it is.
  const atFrom = stops.findIndex((s, idx) => idx >= Math.max(0, lastMatched) && s.key === view.from.key);
  const here = atFrom >= 0 ? atFrom : lastMatched;

  stops.forEach((s, i) => {
    if (i < here) s.status = 'passed';
    else if (i === here) s.status = view.state === 'moving' ? 'passed' : 'current';
  });
  return stops;
}

function fromHistory(history: readonly HistoryEntry[], view: TrainView): StopDetail[] {
  const stops: StopDetail[] = history.map((h) => ({
    key: h.key,
    name: h.name,
    call: !h.pass,
    status: 'passed',
    actualArr: h.arr,
    actualDep: h.dep,
  }));
  const last = stops.at(-1);
  if (last && view.state !== 'moving' && last.key === view.from.key) last.status = 'current';
  if (view.state === 'moving' && view.to) {
    stops.push({ key: view.to.key, name: view.to.name, call: true, status: 'upcoming' });
  }
  return stops;
}

function append(line: LonLat[], seg: LonLat[]): void {
  const last = line.at(-1);
  const first = seg[0];
  line.push(...(last && first && last[0] === first[0] && last[1] === first[1] ? seg.slice(1) : seg));
}
