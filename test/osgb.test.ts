import { describe, expect, it } from 'vitest';
import { gridToOsgb36, gridToWgs84 } from '../scripts/lib/osgb.ts';

describe('National Grid conversion', () => {
  it("matches Ordnance Survey's worked example on the OSGB36 datum", () => {
    // Caister Water Tower: 52°39′27.2531″N 1°43′4.5177″E.
    const [lat, lon] = gridToOsgb36(651409.903, 313177.27);
    expect((lat * 180) / Math.PI).toBeCloseTo(52 + 39 / 60 + 27.2531 / 3600, 7);
    expect((lon * 180) / Math.PI).toBeCloseTo(1 + 43 / 60 + 4.5177 / 3600, 7);
  });

  it('lands a station on its NaPTAN position in WGS84', () => {
    // Roby, SJ 432 907 in BPLAN; NaPTAN has 53.41004, -2.85593.
    const [lon, lat] = gridToWgs84(343200, 390700);
    expect(lat).toBeCloseTo(53.41004, 4);
    expect(lon).toBeCloseTo(-2.85593, 4);
  });
});
