import { describe, expect, it } from 'vitest';
import { titleCase } from '../src/engine/locations.ts';
import { londonDate, londonTime, Timetable } from '../src/schedule/timetable.ts';

// 2026-10-31 is a Saturday, in GMT (London = UTC).
const DAY = '2026-10-31';
const NOON = Date.UTC(2026, 9, 31, 12, 0, 0);
const MIN = 60_000;

const tiploc = (code: string, stanox: string | null, desc: string) =>
  JSON.stringify({ TiplocV1: { transaction_type: 'Create', tiploc_code: code, stanox, tps_description: desc } });

interface Loc { tiploc: string; arr?: string; dep?: string; pass?: string; pub?: boolean }
function schedule(o: { uid: string; stp?: string; atoc?: string; headcode?: string; start?: string; end?: string; days?: string; locs?: Loc[] }) {
  return JSON.stringify({
    JsonScheduleV1: {
      CIF_train_uid: o.uid,
      CIF_stp_indicator: o.stp ?? 'P',
      schedule_start_date: o.start ?? '2026-10-01',
      schedule_end_date: o.end ?? '2026-12-01',
      schedule_days_runs: o.days ?? '1111111',
      atoc_code: o.atoc ?? 'GR',
      schedule_segment: o.locs && {
        signalling_id: o.headcode ?? '1S12',
        schedule_location: o.locs.map((l) => ({
          tiploc_code: l.tiploc,
          arrival: l.arr ?? null,
          departure: l.dep ?? null,
          pass: l.pass ?? null,
          public_arrival: l.pub && l.arr ? l.arr.slice(0, 4) : null,
          public_departure: l.pub && l.dep ? l.dep.slice(0, 4) : null,
        })),
      },
    },
  });
}

const TIPLOCS = [
  tiploc('KNGX', '87701', 'LONDON KINGS CROSS'),
  tiploc('WYMONDJ', '86099', 'WYMONDLEY JN'),
  tiploc('STEVNGE', '86021', 'STEVENAGE'),
  tiploc('PBRO', '70011', 'PETERBOROUGH'),
  tiploc('PBROSDG', null, 'PETERBOROUGH SIDINGS'),
];
// Kings Cross 12:00 -> Peterborough 12:50, then on to sidings out of service.
const LNER_LOCS: Loc[] = [
  { tiploc: 'KNGX', dep: '1200', pub: true },
  { tiploc: 'WYMONDJ', pass: '1215H' },
  { tiploc: 'STEVNGE', arr: '1219', dep: '1220', pub: true },
  { tiploc: 'PBRO', arr: '1250', dep: '1252', pub: true },
  { tiploc: 'PBROSDG', arr: '1255' },
];

const load = (lines: string[], dates = [DAY]) => Timetable.fromLines([...TIPLOCS, ...lines], dates, {
  name: (key) => (key === '87701' ? 'London Kings Cross' : undefined),
});

describe('Timetable', () => {
  it('describes a train by schedule id: operator, and its first and last passenger stops', async () => {
    const t = await load([schedule({ uid: 'C10001', locs: LNER_LOCS })]);
    // Station names from the map's own index where it has one, else the timetable's.
    expect(t.byUid('C10001', DAY)).toEqual({ uid: 'C10001', date: DAY, atoc: 'GR', origin: 'London Kings Cross', destination: 'Peterborough' });
    expect(t.byUid('C10001', '2026-11-01')).toBeUndefined();
  });

  it('finds a train first seen mid-journey by headcode, place and planned time', async () => {
    const t = await load([schedule({ uid: 'C10001', locs: LNER_LOCS }), schedule({ uid: 'C10002', headcode: '1S12', locs: LNER_LOCS.map((l) => ({ ...l, dep: l.dep?.replace('12', '14'), arr: l.arr?.replace('12', '14'), pass: l.pass?.replace('12', '14') })) })]);
    expect(t.match('1S12', '86021', NOON + 20 * MIN)?.uid).toBe('C10001');
    expect(t.match('1S12', '86021', NOON + 140 * MIN)?.uid).toBe('C10002');
    // Passing times count too (12:15½ at Wymondley).
    expect(t.match('1S12', '86099', NOON + 15 * MIN)?.uid).toBe('C10001');
    expect(t.match('1S12', '86021', NOON + 30 * MIN)).toBeUndefined();
    expect(t.match('2S12', '86021', NOON + 20 * MIN)).toBeUndefined();
  });

  it('lists every timed location with planned times, passing points as non-calls', async () => {
    const t = await load([schedule({ uid: 'C10001', locs: LNER_LOCS })]);
    const stops = t.plannedStops('C10001', DAY)!;
    expect(stops.map((s) => [s.key, s.name, s.call])).toEqual([
      ['87701', 'London Kings Cross', true],
      ['86099', 'Wymondley Jn', false],
      ['86021', 'Stevenage', true],
      ['70011', 'Peterborough', true],
      // No STANOX: keyed by TIPLOC.
      ['PBROSDG', 'Peterborough Sidings', false],
    ]);
    expect(stops[0].dep).toBe(NOON);
    expect(stops[1].dep).toBe(NOON + 15.5 * MIN);
    expect(stops[2]).toMatchObject({ arr: NOON + 19 * MIN, dep: NOON + 20 * MIN });
  });

  it('uses an overlay for the day it covers, and drops cancelled runs', async () => {
    const t = await load([
      schedule({ uid: 'C10001', locs: LNER_LOCS }),
      schedule({ uid: 'C10001', stp: 'O', start: DAY, end: DAY, locs: LNER_LOCS.slice(0, 3) }),
      schedule({ uid: 'C10003', headcode: '1S14', locs: LNER_LOCS }),
      schedule({ uid: 'C10003', stp: 'C', start: DAY, end: DAY }),
    ]);
    expect(t.byUid('C10001', DAY)?.destination).toBe('Stevenage');
    expect(t.byUid('C10003', DAY)).toBeUndefined();
    expect(t.size).toBe(1);
  });

  it("keeps yesterday's trains only while they are still running after midnight", async () => {
    const overnight: Loc[] = [{ tiploc: 'KNGX', dep: '2340', pub: true }, { tiploc: 'PBRO', arr: '0030', pub: true }];
    const t = await load(
      [schedule({ uid: 'C20001', locs: overnight }), schedule({ uid: 'C10001', locs: LNER_LOCS })],
      ['2026-10-30', DAY],
    );
    expect(t.byUid('C20001', '2026-10-30')).toBeDefined();
    expect(t.byUid('C10001', '2026-10-30')).toBeUndefined();
    expect(t.byUid('C10001', DAY)).toBeDefined();
    // Times run on past midnight.
    expect(t.plannedStops('C20001', '2026-10-30')!.at(-1)!.arr).toBe(Date.UTC(2026, 9, 31, 0, 30));
  });

  it('only keeps schedules that run on that day of the week', async () => {
    // Saturday is the sixth day in schedule_days_runs.
    const t = await load([schedule({ uid: 'C10001', days: '1111101', locs: LNER_LOCS })]);
    expect(t.size).toBe(0);
  });
});

describe('London time', () => {
  it('converts timetable times in summer time and in winter', () => {
    expect(londonTime('2026-07-01', 12 * 60 * 2)).toBe(Date.UTC(2026, 6, 1, 11, 0));
    expect(londonTime(DAY, 12 * 60 * 2)).toBe(NOON);
  });

  it('writes upper-case names in title case, keeping operator abbreviations', () => {
    expect(titleCase('TONBRIDGE WEST YARD GBRF')).toBe('Tonbridge West Yard GBRf');
    expect(titleCase('ST MARY CRAY JN')).toBe('St Mary Cray Jn');
    expect(titleCase('ABERDEEN WATERLOO (GBRF)')).toBe('Aberdeen Waterloo (GBRf)');
  });

  it('gives the London date of an instant', () => {
    // 23:30 UTC on 30 June is already 1 July in London.
    expect(londonDate(Date.UTC(2026, 5, 30, 23, 30))).toBe('2026-07-01');
  });
});
