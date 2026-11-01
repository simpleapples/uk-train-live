import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LocationIndex, type StationTable } from '../src/engine/locations.ts';
import { TrainStore } from '../src/engine/trainStore.ts';
import { buildTimetable, DemoFeed } from '../src/feeds/demoFeed.ts';
import { LINES, PATTERNS } from '../src/feeds/demoNetwork.ts';

const stations: StationTable = JSON.parse(readFileSync(new URL('../data/stations.json', import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 9, 31, 14, 7, 30);

describe('demo network', () => {
  it('only uses TIPLOCs that have coordinates', () => {
    const missing = Object.values(LINES).flat().filter((t) => !stations[t]);
    expect(missing).toEqual([]);
  });

  it('builds a timetable for every pattern in both directions', () => {
    for (const p of PATTERNS) {
      for (const up of [false, true]) {
        const stops = buildTimetable(p, stations, up);
        expect(stops.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < stops.length; i++) expect(stops[i].arr).toBeGreaterThan(stops[i - 1].dep);
      }
    }
  });

  it('gives an express a realistic London–Edinburgh running time', () => {
    const ecml = PATTERNS.find((p) => p.line === 'ecml' && p.cls === '1')!;
    const hours = buildTimetable(ecml, stations, false).at(-1)!.arr / 3_600_000;
    expect(hours).toBeGreaterThan(3.5);
    expect(hours).toBeLessThan(5.5);
  });
});

describe('DemoFeed', () => {
  it('fills the map on the first tick and keeps moving trains on later ticks', () => {
    const feed = new DemoFeed(stations);
    const store = new TrainStore(LocationIndex.byKey(stations));
    for (const m of feed.tick(NOW)) store.apply(m, NOW);
    const first = store.snapshot();
    expect(first.length).toBeGreaterThan(150);
    expect(first.filter((t) => t.state === 'moving').length).toBeGreaterThan(first.length / 2);

    store.drainChanges();
    let later = 0;
    for (let s = 1; s <= 300; s++) {
      const msgs = feed.tick(NOW + s * 1000);
      later += msgs.length;
      for (const m of msgs) store.apply(m, NOW + s * 1000);
    }
    expect(later).toBeGreaterThan(50);
    expect(store.drainChanges().upserts.length).toBeGreaterThan(30);
  });

  it('emits well-formed TRUST movement messages with unique train ids', () => {
    const msgs = new DemoFeed(stations).tick(NOW);
    const ids = msgs.map((m) => m.body.train_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of msgs) {
      expect(m.header.msg_type).toBe('0003');
      expect(m.body.train_id).toHaveLength(10);
      expect(['ARRIVAL', 'DEPARTURE']).toContain(m.body.event_type);
      expect(Number(m.body.actual_timestamp)).toBeLessThanOrEqual(NOW);
    }
  });

  it('is deterministic for a given clock', () => {
    const a = new DemoFeed(stations).tick(NOW);
    const b = new DemoFeed(stations).tick(NOW);
    expect(a).toEqual(b);
  });
});
