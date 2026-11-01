import { describe, expect, it } from 'vitest';
import { LocationIndex } from '../src/engine/locations.ts';
import { PathService } from '../src/engine/paths.ts';
import { type TflData, type TflPrediction, TflTracker } from '../src/tfl/tflTracker.ts';

// Four-station lines, A-B-C-D, roughly 1 km apart (no track data, so
// straight-line distances).
const data: TflData = {
  lines: {
    central: { name: 'Central', mode: 'tube', color: '#E32017', routes: [['A', 'B', 'C', 'D']] },
    dlr: { name: 'DLR', mode: 'dlr', color: '#00A4A7', routes: [['A', 'B', 'C', 'D']] },
  },
  stations: {
    A: { name: 'Alpha', lat: 51.5, lon: -0.2 },
    B: { name: 'Bravo', lat: 51.5, lon: -0.186 },
    C: { name: 'Charlie', lat: 51.5, lon: -0.172 },
    D: { name: 'Delta', lat: 51.5, lon: -0.158 },
  },
};
const locations = LocationIndex.byKey(data.stations);
const NOW = Date.UTC(2026, 10, 1, 9, 0, 0);

function tracker() {
  const paths = new PathService(locations, null);
  return new TflTracker(data, locations, () => paths);
}

function pred(naptanId: string, tts: number, extra: Partial<TflPrediction> = {}): TflPrediction {
  return { lineId: 'central', vehicleId: '261', naptanId, timeToStation: tts, destinationNaptanId: 'D', destinationName: 'Delta Underground Station', ...extra };
}

describe('TflTracker: trains with numbers', () => {
  it('places a train between its previous and next station', () => {
    const t = tracker();
    t.update([pred('C', 60), pred('D', 180)], NOW);
    const [v] = t.snapshot();
    expect(v).toMatchObject({ id: 'TFL-central-261', mode: 'tube', state: 'moving', color: '#E32017', destination: 'Delta', operator: 'Central line' });
    expect(v.from.name).toBe('Bravo');
    expect(v.to?.name).toBe('Charlie');
    const progress = (NOW - v.departedAt) / v.runMs;
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(1);
  });

  it('takes running speed from TfL predictions for the next sections', () => {
    const t = tracker();
    // C to D (about 970 m) predicted at 120 s, less 30 s dwell and 20 s
    // start/stop: 70 s running, about 50 km/h.
    t.update([pred('C', 60), pred('D', 180)], NOW);
    const [v] = t.snapshot();
    expect(v.speedKmh).toBeGreaterThan(30);
    expect(v.speedKmh).toBeLessThan(45);
    // The section runs at that speed plus start/stop time.
    expect(v.runMs / 1000).toBeGreaterThan(80);
    expect(v.runMs / 1000).toBeLessThan(100);
  });

  it('works out the direction from later predictions', () => {
    const t = tracker();
    t.update([pred('B', 60, { destinationNaptanId: 'A' }), pred('A', 180, { destinationNaptanId: 'A' })], NOW);
    const [v] = t.snapshot();
    expect(v.from.name).toBe('Charlie');
    expect(v.to?.name).toBe('Bravo');
  });

  it('shows a train about to arrive as standing at the station', () => {
    const t = tracker();
    t.update([pred('C', 10), pred('D', 130)], NOW);
    // `toward` says which way it faces.
    expect(t.snapshot()[0]).toMatchObject({ state: 'stopped', to: null, speedKmh: 0, toward: 'D' });
    expect(t.snapshot()[0].from.name).toBe('Charlie');
  });

  it('describes the whole route with predicted arrivals', () => {
    const t = tracker();
    t.update([pred('C', 60), pred('D', 180)], NOW);
    const d = t.describe('TFL-central-261')!;
    expect(d.stops.map((s) => [s.name, s.status])).toEqual([
      ['Alpha', 'passed'],
      ['Bravo', 'passed'],
      ['Charlie', 'upcoming'],
      ['Delta', 'upcoming'],
    ]);
    expect(d.stops[2].expectedArr).toBe(NOW + 60_000);
    expect(d.previous?.name).toBe('Bravo');
    expect(d.next?.name).toBe('Charlie');
    expect(d.pathBehind.length).toBeGreaterThan(1);
    expect(d.pathAhead.length).toBeGreaterThan(1);
    // The line's trains.
    expect(d.service).toMatchObject({ stock: '1992 Stock', kind: 'tube' });
  });

  it('treats "Check Front of Train" as an unknown destination', () => {
    const t = tracker();
    t.update([pred('C', 60, { destinationNaptanId: undefined, destinationName: undefined, towards: 'Check Front of Train' }), pred('D', 180, { destinationNaptanId: undefined, destinationName: undefined })], NOW);
    expect(t.snapshot()[0].destination).toBeUndefined();
  });

  it('ignores Underground predictions without a usable train number', () => {
    const t = tracker();
    t.update([pred('C', 60, { vehicleId: '000' }), pred('C', 60, { vehicleId: '' })], NOW);
    expect(t.snapshot()).toHaveLength(0);
  });

  // Overground and Elizabeth line ids are trips; TfL lists later ones too.
  it('ignores trips that have not started yet', () => {
    const t = tracker();
    t.update([pred('C', 3600), pred('D', 3720)], NOW);
    expect(t.snapshot()).toHaveLength(0);
  });

  it('ignores a stray "due now" at the first station of a later trip', () => {
    const t = tracker();
    t.update([pred('A', 10), pred('B', 2000), pred('C', 2120)], NOW);
    expect(t.snapshot()).toHaveLength(0);
  });

  it('drops a train only after it is missing from two polls', () => {
    const t = tracker();
    t.update([pred('C', 60)], NOW);
    t.drainChanges();
    t.update([], NOW + 30_000);
    expect(t.snapshot()).toHaveLength(1);
    t.update([], NOW + 60_000);
    expect(t.snapshot()).toHaveLength(0);
    expect(t.drainChanges().removals).toEqual(['TFL-central-261']);
  });
});

describe('TflTracker: line status', () => {
  it('reports disrupted lines with their worst status, and whether the whole line is closed', () => {
    const t = tracker();
    t.setLineStatus([
      { id: 'central', lineStatuses: [{ statusSeverity: 9, statusSeverityDescription: 'Minor Delays' }, { statusSeverity: 4, statusSeverityDescription: 'Planned Closure', reason: ' No service today. ' }] },
      { id: 'dlr', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] },
      { id: 'not-a-line', lineStatuses: [{ statusSeverity: 2, statusSeverityDescription: 'Suspended' }] },
    ]);
    expect(t.status().lines).toEqual({ central: { summary: 'Planned Closure', reason: 'No service today.', closed: true } });
  });
});

describe('TflTracker: DLR trains inferred from station predictions', () => {
  const dlr = (naptanId: string, tts: number): TflPrediction => ({
    lineId: 'dlr', vehicleId: '', naptanId, timeToStation: tts, destinationNaptanId: 'D', destinationName: 'Delta DLR Station',
  });

  it('finds a train on each section whose next station expects it soon', () => {
    const t = tracker();
    // One train approaching C (then D), another far away (A in 10 min).
    t.update([dlr('C', 40), dlr('D', 150), dlr('A', 600)], NOW);
    const trains = t.snapshot();
    expect(trains).toHaveLength(1);
    expect(trains[0]).toMatchObject({ mode: 'dlr', operator: 'DLR', state: 'moving', headcode: '' });
    expect(trains[0].from.name).toBe('Bravo');
    expect(trains[0].to?.name).toBe('Charlie');
    const d = t.describe(trains[0].id)!;
    expect(d.stops.find((s) => s.name === 'Delta')?.expectedArr).toBe(NOW + 150_000);
  });

  it('keeps the same id as the train moves on to the next section', () => {
    const t = tracker();
    t.update([dlr('C', 40), dlr('D', 150)], NOW);
    const before = t.snapshot()[0].id;
    // 70 s later it has left C and is approaching D.
    t.update([dlr('D', 60)], NOW + 70_000);
    const after = t.snapshot();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before);
    expect(after[0].to?.name).toBe('Delta');
  });
});
