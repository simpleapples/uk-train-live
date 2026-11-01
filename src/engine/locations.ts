// Resolves the location key a TRUST message carries (a STANOX in live data)
// to a named point on the map.

export interface Station {
  name: string;
  lat: number;
  lon: number;
}

/** TIPLOC -> station, as written by scripts/build-stations.ts. */
export type StationTable = Record<string, Station>;

/** STANOX -> TIPLOCs and a fallback name, as written by scripts/fetch-corpus.ts. */
export type StanoxTable = Record<string, { tiplocs: string[]; name?: string }>;

export interface Place extends Station {
  key: string;
}

export class LocationIndex {
  #places = new Map<string, Place>();
  #names = new Map<string, string>();

  /**
   * Places keyed by the table's own keys: TIPLOCs for the demo feed (whose
   * messages carry TIPLOCs in place of STANOX codes), NaPTAN ids for the Tube.
   */
  static byKey(stations: StationTable): LocationIndex {
    const index = new LocationIndex();
    for (const [key, s] of Object.entries(stations)) index.add(key, s);
    return index;
  }

  /** Live feed: STANOX -> first TIPLOC that has station coordinates. */
  static byStanox(stations: StationTable, stanox: StanoxTable): LocationIndex {
    const index = new LocationIndex();
    for (const [code, entry] of Object.entries(stanox)) {
      const tiploc = entry.tiplocs.find((t) => stations[t]);
      if (tiploc) index.add(code, stations[tiploc]);
      // CORPUS names are upper case ("ROTHERHAM CENTRAL").
      else if (entry.name) index.#names.set(code, entry.name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()));
    }
    return index;
  }

  add(key: string, s: Station): void {
    this.#places.set(key, { key, name: s.name, lat: s.lat, lon: s.lon });
  }

  get(key: string | null | undefined): Place | undefined {
    return key ? this.#places.get(key) : undefined;
  }

  /** Name for a key even when it has no coordinates (junctions, sidings). */
  name(key: string | null | undefined): string | undefined {
    if (!key) return undefined;
    return this.#places.get(key)?.name ?? this.#names.get(key);
  }

  get size(): number {
    return this.#places.size;
  }

  /**
   * Moves each place onto the nearest track, so stopped trains sit on the
   * line rather than at the station entrance. Returns how many moved.
   */
  snapTo(snap: (lon: number, lat: number) => [number, number] | null): number {
    let moved = 0;
    for (const p of this.#places.values()) {
      const s = snap(p.lon, p.lat);
      if (!s) continue;
      p.lon = Math.round(s[0] * 1e5) / 1e5;
      p.lat = Math.round(s[1] * 1e5) / 1e5;
      moved++;
    }
    return moved;
  }
}
