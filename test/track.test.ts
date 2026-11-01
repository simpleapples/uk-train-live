import { describe, expect, it } from 'vitest';
import { distanceM, lineLengthM, type LonLat, TrackNetwork, type TrackJson } from '../src/engine/track.ts';

// A bent line A–J, a straight line J–B, a branch J–N, and an island X–Y.
const A: LonLat = [0, 52], J: LonLat = [0.1, 52], B: LonLat = [0.2, 52], N: LonLat = [0.1, 52.1];
const BEND: LonLat = [0.05, 52.01];
const X: LonLat = [1, 52], Y: LonLat = [1.1, 52];

function encode(points: LonLat[]): number[] {
  const out: number[] = [];
  let px = 0, py = 0;
  for (const [lon, lat] of points) {
    const x = Math.round(lon * 1e5), y = Math.round(lat * 1e5);
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out;
}

const json: TrackJson = {
  v: [A, J, B, N, X, Y].flatMap(([lon, lat]) => [Math.round(lon * 1e5), Math.round(lat * 1e5)]),
  e: [
    [0, 1, encode([A, BEND, J])],
    [1, 2, encode([J, B])],
    [1, 3, encode([J, N])],
    [4, 5, encode([X, Y])],
  ],
};
const track = new TrackNetwork(json);
const near = (p: LonLat, q: LonLat, m = 5) => distanceM(p, q) < m;

describe('TrackNetwork', () => {
  it('snaps a point onto the nearest line', () => {
    const p = track.snapPoint([0.15, 52.001]);
    expect(p).not.toBeNull();
    expect(near(p!, [0.15, 52])).toBe(true);
  });

  it('does not snap points far from any track', () => {
    expect(track.snapPoint([0.15, 52.02])).toBeNull();
  });

  it('follows the track geometry instead of a straight line', () => {
    const line = track.route([0.0001, 52.0001], [0.1999, 52.0001])!;
    expect(line).not.toBeNull();
    expect(near(line[0], A, 20)).toBe(true);
    expect(near(line.at(-1)!, B, 20)).toBe(true);
    expect(line.some((p) => near(p, BEND))).toBe(true);
    expect(lineLengthM(line)).toBeGreaterThan(distanceM(A, B));
  });

  it('routes through a junction onto a branch', () => {
    const line = track.route(A, N)!;
    expect(line.some((p) => near(p, J))).toBe(true);
    expect(near(line.at(-1)!, N)).toBe(true);
  });

  it('handles both ends on the same edge, in either direction', () => {
    const fwd = track.route([0.12, 52], [0.18, 52])!;
    const back = track.route([0.18, 52], [0.12, 52])!;
    expect(fwd).toHaveLength(2);
    expect(near(fwd[0], [0.12, 52])).toBe(true);
    expect(near(back[0], [0.18, 52])).toBe(true);
  });

  it('returns null between disconnected lines', () => {
    expect(track.route(A, X)).toBeNull();
  });
});
