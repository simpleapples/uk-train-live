// Track geometry between two timing points, cached. Falls back to a straight
// line when there is no track data or no sensible path.

import type { LocationIndex, Place } from './locations.ts';
import { distanceM, lineLengthM, type LonLat, type TrackNetwork } from './track.ts';

const MAX_CACHE = 50_000;

export interface PathOptions {
  /** How far from a station to look for track. */
  radiusM?: number;
  /** How many nearby lines to try at each end (more for big interchanges). */
  maxSnaps?: number;
  /** Cost of each metre between a station and the track (see TrackNetwork.route). */
  offTrackWeight?: number;
}

export class PathService {
  #locations: LocationIndex;
  #track: TrackNetwork | null;
  #radiusM: number;
  #maxSnaps: number;
  #offTrackWeight: number | undefined;
  #cache = new Map<string, LonLat[]>();
  #placed = new Map<string, Place>();

  constructor(locations: LocationIndex, track: TrackNetwork | null, opts: PathOptions = {}) {
    this.#locations = locations;
    this.#track = track;
    this.#radiusM = opts.radiusM ?? 400;
    this.#maxSnaps = opts.maxSnaps ?? 6;
    this.#offTrackWeight = opts.offTrackWeight;
  }

  /**
   * The place moved onto this service's track. A station shared by several
   * lines sits on a different track for each, so each line keeps its own.
   */
  place(key: string): Place | undefined {
    const p = this.#locations.get(key);
    if (!p || !this.#track) return p;
    let placed = this.#placed.get(key);
    if (!placed) {
      const s = this.#track.snapPoint([p.lon, p.lat], this.#radiusM);
      placed = s ? { ...p, lon: Math.round(s[0] * 1e5) / 1e5, lat: Math.round(s[1] * 1e5) / 1e5 } : p;
      this.#placed.set(key, placed);
    }
    return placed;
  }

  between(fromKey: string, toKey: string): LonLat[] | null {
    // Route from the stations themselves, not from their nearest track: where
    // a line has two tracks near a station (Elizabeth line tunnel and surface
    // at Liverpool Street), the router picks the pair of points that connect.
    const a = this.#locations.get(fromKey);
    const b = this.#locations.get(toKey);
    if (!a || !b) return null;
    const id = `${fromKey}>${toKey}`;
    const hit = this.#cache.get(id);
    if (hit) return hit;
    const reverse = this.#cache.get(`${toKey}>${fromKey}`);
    if (reverse) return this.#remember(id, [...reverse].reverse());

    const A: LonLat = [a.lon, a.lat];
    const B: LonLat = [b.lon, b.lat];
    let line = fromKey === toKey ? null : this.#track?.route(A, B, this.#radiusM, this.#maxSnaps, this.#offTrackWeight) ?? null;
    // A path far longer than the crow flies means a station snapped onto the
    // wrong line; a straight line is less misleading.
    if (!line || line.length < 2 || lineLengthM(line) > distanceM(A, B) * 2.5 + 5000) line = [A, B];
    return this.#remember(id, line);
  }

  #remember(id: string, line: LonLat[]): LonLat[] {
    if (this.#cache.size >= MAX_CACHE) this.#cache.clear();
    this.#cache.set(id, line);
    return line;
  }
}
