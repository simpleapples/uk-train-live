// Checks the generated track data: every section a demo train or a TfL train
// runs must follow track, not fall back to a straight line.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LocationIndex, type StationTable } from '../src/engine/locations.ts';
import { PathService } from '../src/engine/paths.ts';
import { gunzipSync } from 'node:zlib';
import { distanceM, lineLengthM, type LonLat, TrackNetwork, type TrackJson } from '../src/engine/track.ts';
import { LINES } from '../src/feeds/demoNetwork.ts';
import type { TflData } from '../src/tfl/tflTracker.ts';

const stations: StationTable = JSON.parse(readFileSync(new URL('../data/stations.json', import.meta.url), 'utf8'));
const track = TrackNetwork.load(new URL('../data/track.json.gz', import.meta.url));

describe('track data', () => {
  it('snaps almost every station onto track', () => {
    const all = Object.values(stations);
    const snapped = all.filter((s) => track.snapPoint([s.lon, s.lat], 400)).length;
    expect(snapped / all.length).toBeGreaterThan(0.97);
  });

  it('routes every demo segment along track without big detours', () => {
    const failures: string[] = [];
    for (const line of Object.values(LINES)) {
      for (let i = 1; i < line.length; i++) {
        const a = stations[line[i - 1]], b = stations[line[i]];
        const A = track.snapPoint([a.lon, a.lat]) ?? ([a.lon, a.lat] as LonLat);
        const B = track.snapPoint([b.lon, b.lat]) ?? ([b.lon, b.lat] as LonLat);
        const path = track.route(A, B);
        // Same tolerance PathService uses before falling back to a straight line.
        if (!path || lineLengthM(path) > distanceM(A, B) * 2.5 + 5000) failures.push(`${a.name} → ${b.name}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('TfL track data', () => {
  const tfl: TflData = JSON.parse(readFileSync(new URL('../data/tfl.json', import.meta.url), 'utf8'));
  const tracks = (JSON.parse(gunzipSync(readFileSync(new URL('../data/tfl-track.json.gz', import.meta.url))).toString('utf8')) as {
    lines: Record<string, TrackJson>;
  }).lines;

  it('has track for every line', () => {
    expect(Object.keys(tfl.lines).filter((id) => !tracks[id])).toEqual([]);
  });

  // The settings the server uses for TfL lines.
  const pathsFor = (lineId: string) => new PathService(locations, new TrackNetwork(tracks[lineId]), { radiusM: 500, maxSnaps: 24, offTrackWeight: 5 });
  const locations = LocationIndex.byKey(tfl.stations);

  it("routes every pair of consecutive stations along that line's own track", () => {
    const failures: string[] = [];
    for (const [lineId, line] of Object.entries(tfl.lines)) {
      const paths = pathsFor(lineId);
      for (const route of line.routes) {
        for (let i = 1; i < route.length; i++) {
          // When routing fails PathService draws a straight line between the
          // stations themselves; a routed path starts on the track instead.
          const path = paths.between(route[i - 1], route[i])!;
          const from = tfl.stations[route[i - 1]];
          const fellBack = path.length === 2 && path[0][0] === from.lon && path[0][1] === from.lat;
          if (fellBack) failures.push(`${lineId}: ${from.name} → ${tfl.stations[route[i]].name}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('joins consecutive sections at each station, so the route has no gaps', () => {
    const gaps: string[] = [];
    for (const [lineId, line] of Object.entries(tfl.lines)) {
      const paths = pathsFor(lineId);
      for (const route of line.routes) {
        for (let i = 2; i < route.length; i++) {
          const before = paths.between(route[i - 2], route[i - 1])!;
          const after = paths.between(route[i - 1], route[i])!;
          if (distanceM(before[before.length - 1], after[0]) > 50) gaps.push(`${lineId}: ${tfl.stations[route[i - 1]].name}`);
        }
      }
    }
    // The Circle line really has two Paddington stations, ~190 m apart.
    expect([...new Set(gaps)]).toEqual(['circle: Paddington']);
  });
});
