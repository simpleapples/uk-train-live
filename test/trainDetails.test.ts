import { describe, expect, it } from 'vitest';
import type { PlannedStop } from '../src/feeds/feed.ts';
import { LocationIndex } from '../src/engine/locations.ts';
import { PathService } from '../src/engine/paths.ts';
import { describeTrain } from '../src/engine/trainDetails.ts';
import { TrainStore } from '../src/engine/trainStore.ts';
import type { TrustMessage } from '../src/trust/types.ts';

const stations = {
  KNGX: { name: 'London Kings Cross', lat: 51.53, lon: -0.12 },
  STEVNGE: { name: 'Stevenage', lat: 51.9, lon: -0.21 },
  HITCHIN: { name: 'Hitchin', lat: 51.95, lon: -0.26 },
  PBRO: { name: 'Peterborough', lat: 52.57, lon: -0.25 },
};
const locations = LocationIndex.byKey(stations);
const paths = new PathService(locations, null);
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const ID = '001S12DM31';

const plan: PlannedStop[] = [
  { key: 'KNGX', call: true, dep: T0 },
  { key: 'STEVNGE', call: true, arr: T0 + 20 * 60_000, dep: T0 + 21 * 60_000 },
  { key: 'HITCHIN', call: false, arr: T0 + 25 * 60_000, dep: T0 + 25 * 60_000 },
  { key: 'PBRO', call: true, arr: T0 + 50 * 60_000 },
];

function move(body: Record<string, string | null>): TrustMessage {
  return {
    header: { msg_type: '0003' },
    body: {
      train_id: ID,
      event_type: 'DEPARTURE',
      variation_status: 'LATE',
      timetable_variation: '3',
      train_terminated: 'false',
      ...body,
    },
  };
}

describe('describeTrain', () => {
  it('places a moving train among its timetabled stops', () => {
    const store = new TrainStore(locations);
    store.apply(move({ loc_stanox: 'KNGX', next_report_stanox: 'STEVNGE', next_report_run_time: '20', actual_timestamp: String(T0 + 180_000) }), T0);
    store.apply(move({ event_type: 'ARRIVAL', loc_stanox: 'STEVNGE', actual_timestamp: String(T0 + 23 * 60_000) }), T0);
    store.apply(move({ loc_stanox: 'STEVNGE', next_report_stanox: 'HITCHIN', next_report_run_time: '4', actual_timestamp: String(T0 + 24 * 60_000) }), T0);

    const d = describeTrain(ID, store, locations, paths, (id) => (id === ID ? plan : undefined))!;
    expect(d.timetabled).toBe(true);
    expect(d.stops.map((s) => [s.key, s.status])).toEqual([
      ['KNGX', 'passed'],
      ['STEVNGE', 'passed'],
      ['HITCHIN', 'upcoming'],
      ['PBRO', 'upcoming'],
    ]);
    expect(d.stops[1]).toMatchObject({ actualArr: T0 + 23 * 60_000, actualDep: T0 + 24 * 60_000 });
    expect(d.previous?.name).toBe('Stevenage');
    // Hitchin is only passed, so the next stop is Peterborough.
    expect(d.next?.name).toBe('Peterborough');
    expect(d.pathBehind).toEqual([[-0.12, 51.53], [-0.21, 51.9]]);
    expect(d.pathAhead).toEqual([[-0.21, 51.9], [-0.26, 51.95], [-0.25, 52.57]]);
  });

  it('marks the stop a train is standing at as current', () => {
    const store = new TrainStore(locations);
    store.apply(move({ event_type: 'ARRIVAL', loc_stanox: 'STEVNGE', actual_timestamp: String(T0 + 20 * 60_000) }), T0);
    const d = describeTrain(ID, store, locations, paths, () => plan)!;
    expect(d.current?.name).toBe('Stevenage');
    expect(d.previous?.name).toBe('London Kings Cross');
    expect(d.stops[0].status).toBe('passed');
  });

  it('falls back to reported locations when there is no timetable', () => {
    const store = new TrainStore(locations);
    store.apply(move({ loc_stanox: 'KNGX', next_report_stanox: 'STEVNGE', next_report_run_time: '20', actual_timestamp: String(T0) }), T0);
    const d = describeTrain(ID, store, locations, paths)!;
    expect(d.timetabled).toBe(false);
    expect(d.stops.map((s) => [s.name, s.status])).toEqual([
      ['London Kings Cross', 'passed'],
      ['Stevenage', 'upcoming'],
    ]);
    expect(d.next?.name).toBe('Stevenage');
    expect(d.pathAhead).toHaveLength(2);
  });

  it('returns undefined for unknown trains', () => {
    expect(describeTrain('nope', new TrainStore(locations), locations, paths)).toBeUndefined();
  });
});
