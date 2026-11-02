import { describe, expect, it } from 'vitest';
import { LocationIndex } from '../src/engine/locations.ts';

const stations = { ROBY: { name: 'Roby', lat: 53.41, lon: -2.856 } };
const stanox = {
  '36603': { tiplocs: ['ROBY'], name: 'ROBY STATION' },
  '62016': { tiplocs: ['BEDFDS'], name: 'SOUTH JN' },
  '25808': { tiplocs: ['ATTCLIF'], name: 'ATTERCLIFFE' },
  '52190': { tiplocs: ['TMREUKL'], name: 'TEMPLE MILLS RECP' },
};
const index = LocationIndex.byStanox(stations, stanox, {
  points: { BEDFDS: [-0.46, 52.1] },
  names: { BEDFDS: 'Bedford South Jn.', ATTCLIF: 'Attrcli', ROBY: 'Roby' },
});

describe('LocationIndex.byStanox', () => {
  it('prefers a station, with its own name', () => {
    expect(index.get('36603')).toMatchObject({ name: 'Roby', lat: 53.41 });
    expect(index.get('36603')?.timingPoint).toBeUndefined();
  });

  it('places a timing point, under whichever name says more', () => {
    expect(index.get('62016')).toMatchObject({ name: 'Bedford South Junction', lat: 52.1, lon: -0.46, timingPoint: true });
    expect(index.name('25808')).toBe('Attercliffe');
  });

  it('knows the name of a place with no position', () => {
    expect(index.get('52190')).toBeUndefined();
    expect(index.name('52190')).toBe('Temple Mills Reception');
  });
});
