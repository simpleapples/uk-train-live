import { describe, expect, it } from 'vitest';
import { TflLoads } from '../src/tfl/loads.ts';

// One section of the Victoria line; quarter hours from 05:00.
const day = (values: Record<number, number>) => Array.from({ length: 96 }, (_, q) => values[q] ?? null);
const loads = new TflLoads({
  source: 'TfL NUMBAT 2023',
  days: ['MON', 'TWT', 'FRI', 'SAT', 'SUN'],
  startMinute: 300,
  busiest: { victoria: 400 },
  links: { victoria: { 'A>B': [day({ 12: 380, 84: 50 }), day({}), day({}), day({}), day({ 28: 200 })] } },
});

describe('TflLoads', () => {
  it('gives the typical load for the section, day type and quarter hour, as a level for that line', () => {
    // Monday 2 November 2026, 08:05 (GMT).
    expect(loads.estimate('victoria', 'A', 'B', Date.UTC(2026, 10, 2, 8, 5))).toEqual({
      people: 380,
      level: 3,
      label: 'Very busy',
      basis: 'Typical for this time on a Monday, from TfL NUMBAT 2023',
    });
    expect(loads.estimate('victoria', 'A', 'B', Date.UTC(2026, 10, 1, 12, 0))).toMatchObject({ people: 200, label: 'Moderate' });
  });

  it('counts the small hours as the day before, as NUMBAT does', () => {
    // Tuesday 02:00 is late on Monday.
    expect(loads.estimate('victoria', 'A', 'B', Date.UTC(2026, 10, 3, 2, 0))).toMatchObject({ people: 50, label: 'Quiet', basis: expect.stringContaining('Monday') });
  });

  it('says nothing for a section, direction or time it has no figure for', () => {
    expect(loads.estimate('victoria', 'B', 'A', Date.UTC(2026, 10, 2, 8, 5))).toBeUndefined();
    expect(loads.estimate('victoria', 'A', 'B', Date.UTC(2026, 10, 2, 13, 0))).toBeUndefined();
    expect(loads.estimate('central', 'A', 'B', Date.UTC(2026, 10, 2, 8, 5))).toBeUndefined();
  });
});
