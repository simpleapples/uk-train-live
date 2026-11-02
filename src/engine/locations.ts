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
  /** A junction, yard, signal or crossing rather than a station. */
  timingPoint?: boolean;
}

/** Positions and proper names of timing points that are not stations, as written by scripts/build-timing-points.ts. */
export interface TimingPointTable {
  /** TIPLOC -> [lon, lat]. */
  points: Record<string, [number, number]>;
  /** TIPLOC -> Network Rail's planning name ("Bedford South Jn."; CORPUS may just say "SOUTH JN"). */
  names: Record<string, string>;
}

// Operator abbreviations keep their capitals ("Tonbridge West Yard GBRf").
const ABBREVIATIONS: Record<string, string> = {
  GBRF: 'GBRf', DBC: 'DBC', DBS: 'DBS', EWS: 'EWS', DRS: 'DRS', FLT: 'FLT', FHH: 'FHH', FLHH: 'FLHH', LUL: 'LUL', DLR: 'DLR', EMD: 'EMD', ISU: 'ISU', MOD: 'MoD',
  AHB: 'AHB', AOCL: 'AOCL', ABCL: 'ABCL', MCB: 'MCB', BSC: 'BSC', EMU: 'EMU', DMU: 'DMU', IEP: 'IEP', HST: 'HST', TRSMD: 'TRSMD',
};
// Network Rail's short forms, spelt out where they can only mean one thing
// ("St" may be Saint or Street, "Eng" Engineers or Engine: left alone).
const EXPANSIONS: Record<string, string> = {
  jn: 'Junction', jcn: 'Junction', jct: 'Junction', sig: 'Signal', sdgs: 'Sidings', sdg: 'Siding', sth: 'South', nth: 'North',
  yd: 'Yard', rd: 'Road', dn: 'Down', gds: 'Goods', lp: 'Loop', recp: 'Reception', tml: 'Terminal', teml: 'Terminal', term: 'Terminal',
  stn: 'Station', dpt: 'Depot', maint: 'Maintenance', frt: 'Freight', aggs: 'Aggregates', lc: 'Level Crossing', gf: 'Ground Frame',
  sb: 'Signal Box', cs: 'Carriage Sidings', csd: 'Carriage Servicing Depot', chs: 'Carriage Holding Sidings', ps: 'Power Station',
  tmd: 'Traction Maintenance Depot', lmd: 'Light Maintenance Depot', ce: 'Engineers', fd: 'Freight Depot',
  upl: 'Up Passenger Loop', dpl: 'Down Passenger Loop', md: 'Maintenance Depot', ln: 'Lane', sq: 'Square',
};
// Only with a full stop, where the bare word could be a name ("Car Dyke").
const DOTTED: Record<string, string> = { car: 'carriage' };

/**
 * Upper-case CORPUS and timetable names ("ROTHERHAM CENTRAL", "HEATON STH
 * JN.") in title case, with short forms spelt out ("Heaton South Junction").
 */
export function titleCase(s: string): string {
  return s.trim().toLowerCase()
    .replace(/t\.&r\.s\.m\.d\.?/g, 'trsmd')
    // Pairs like "c&w" and "s&te" are codes.
    .replace(/(?<![a-z0-9])[a-z]{1,3}&[a-z]{1,3}(?![a-z0-9])/g, (m) => m.toUpperCase())
    // Dotted short forms: "l.c." -> "lc", "jn." -> "jn", "car." -> "carriage".
    .replace(/\b((?:[a-z]\.){2,})(?=\s|\)|$)/g, (m) => m.replaceAll('.', ''))
    .replace(/\b([a-z]+)\.(?=\s|\)|$)/g, (m, w: string) => DOTTED[w] ?? (EXPANSIONS[w] || w === 'st' ? w : m))
    // Words, but not the "s" of "King's".
    .replace(/(^|[^a-z0-9'’])([a-z][a-z0-9]*)/g, (_, before: string, w: string) => before + (
      ABBREVIATIONS[w.toUpperCase()] ?? EXPANSIONS[w]
      // Codes stay in capitals: with digits (signal "MS35") or without vowels ("MDHC").
      ?? (/\d/.test(w) || (w.length > 1 && w !== 'st' && !/[aeiouy]/.test(w)) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))));
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

  /**
   * Live feed: STANOX -> first TIPLOC that has station coordinates, else one
   * that is a known timing point (junction, yard).
   */
  static byStanox(stations: StationTable, stanox: StanoxTable, timingPoints: TimingPointTable = { points: {}, names: {} }): LocationIndex {
    const index = new LocationIndex();
    for (const [code, entry] of Object.entries(stanox)) {
      const station = entry.tiplocs.find((t) => stations[t]);
      const point = station ? undefined : entry.tiplocs.find((t) => timingPoints.points[t]);
      // Whichever says more: planning names say where ("Carnforth North Jn" against
      // CORPUS's "NORTH JUNCTION"), but CORPUS can be clearer ("ATTERCLIFFE", "ATTRCLI").
      const planned = (point && timingPoints.names[point]) || entry.tiplocs.map((t) => timingPoints.names[t]).find(Boolean);
      const name = [planned, entry.name].filter((n): n is string => Boolean(n)).map(titleCase).sort((a, b) => b.length - a.length)[0];
      if (station) {
        index.add(code, stations[station]);
      } else if (point) {
        const [lon, lat] = timingPoints.points[point];
        index.#places.set(code, { key: code, name: name ?? point, lat, lon, timingPoint: true });
      } else if (name) {
        index.#names.set(code, name);
      }
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
