// What a train is and what it offers, from its schedule's CIF codes: unit
// class from the timing load, top speed, first class, catering, sleepers and
// reservations. Code meanings: Open Rail Data wiki, "CIF Codes" and
// "Schedule Records".

import type { ScheduleInfo, ServiceCodes } from './timetable.ts';

export interface ServiceDetails {
  /** "Class 390 Pendolino", or the kind of train when the class is unknown. */
  stock?: string;
  /** Timetabled maximum speed. */
  maxMph?: number;
  /** Planned trailing load of a locomotive-hauled train. */
  tonnes?: number;
  /** "First class", "Trolley", "Sleeper", ... */
  features: string[];
}

const POWER: Record<string, string> = {
  D: 'Diesel locomotive',
  E: 'Electric locomotive',
  ED: 'Electro-diesel locomotive',
  EML: 'Electric unit and locomotive',
  EMU: 'Electric multiple unit',
  DMU: 'Diesel multiple unit',
  DEM: 'Diesel multiple unit',
  HST: 'High Speed Train',
};

// Timing loads that stand for a class (or group of classes) rather than giving its number.
const DMU_LOADS: Record<string, string> = {
  '69': '172', A: '141–144', E: '158/168/170/175', N: '165', S: '150/153/155/156', T: '165/166', V: '220/221', X: '159',
};
const EMU_LOADS: Record<string, string> = { '0': '380', '506': '350', E: '458' };

const FAMILIES: Record<string, string> = {
  '150': 'Sprinter', '150/153/155/156': 'Sprinter', '153': 'Super Sprinter', '155': 'Super Sprinter', '156': 'Super Sprinter',
  '158': 'Express Sprinter', '165': 'Networker Turbo', '165/166': 'Networker Turbo', '166': 'Networker Turbo',
  '170': 'Turbostar', '171': 'Turbostar', '172': 'Turbostar', '175': 'Coradia', '180': 'Adelante', '185': 'Desiro',
  '195': 'Civity', '196': 'Civity', '197': 'Civity', '220': 'Voyager', '220/221': 'Voyager', '221': 'Super Voyager',
  '222': 'Meridian', '231': 'FLIRT', '331': 'Civity', '345': 'Aventra', '350': 'Desiro', '357': 'Electrostar',
  '360': 'Desiro', '375': 'Electrostar', '376': 'Electrostar', '377': 'Electrostar', '378': 'Capitalstar',
  '379': 'Electrostar', '380': 'Desiro', '385': 'AT200', '387': 'Electrostar', '390': 'Pendolino', '395': 'Javelin',
  '397': 'Civity', '398': 'Citylink', '399': 'Citylink', '444': 'Desiro', '450': 'Desiro', '458': 'Juniper',
  '465': 'Networker', '466': 'Networker', '700': 'Desiro City', '701': 'Arterio', '707': 'Desiro City', '710': 'Aventra',
  '717': 'Desiro City', '720': 'Aventra', '730': 'Aventra', '745': 'FLIRT', '755': 'FLIRT', '756': 'FLIRT',
  '800': 'AT300', '801': 'AT300', '802': 'AT300', '803': 'AT300', '805': 'AT300', '807': 'AT300', '810': 'AT300',
};
// Operators' own names for their Hitachi AT300s, by ATOC code and class.
const BRANDS: Record<string, string> = {
  'GR 800': 'Azuma', 'GR 801': 'Azuma', 'GW 800': 'Intercity Express Train', 'GW 802': 'Intercity Express Train',
  'TP 802': 'Nova 1', 'HT 802': 'Paragon', 'VT 805': 'Evero', 'VT 807': 'Evero', 'EM 810': 'Aurora',
};

const CATERING: Record<string, string> = {
  C: 'Buffet', F: 'First class restaurant', H: 'Hot food', M: 'First class meal', R: 'Restaurant', T: 'Trolley',
};
// Only the ones that stop you boarding; "recommended" and "possible" are noise.
const RESERVATIONS: Record<string, string> = { A: 'Reservations required', E: 'Bike reservations required' };

export function describeService(info: ScheduleInfo | undefined): ServiceDetails | undefined {
  const c = info?.service;
  if (!c) return undefined;
  const hauled = c.power === 'D' || c.power === 'E' || c.power === 'ED';
  const features = [
    c.seating === 'B' ? 'First class' : undefined,
    c.sleepers ? 'Sleeper' : undefined,
    ...[...(c.catering ?? '')].map((k) => CATERING[k]),
    RESERVATIONS[c.reservations ?? ''],
  ].filter((f): f is string => Boolean(f));
  const details: ServiceDetails = {
    stock: stockOf(c, info.atoc),
    maxMph: Number(c.speed) || undefined,
    tonnes: hauled ? Number(c.timingLoad) || undefined : undefined,
    features,
  };
  return details.stock || details.maxMph || features.length ? details : undefined;
}

function stockOf(c: ServiceCodes, atoc: string): string | undefined {
  const load = c.timingLoad ?? '';
  const cls =
    c.power === 'EMU' ? EMU_LOADS[load] ?? (/^\d{3}$/.test(load) ? load : undefined)
    : c.power === 'DMU' || c.power === 'DEM' ? DMU_LOADS[load] ?? (/^\d{3}$/.test(load) ? load : undefined)
    : undefined;
  if (!cls) return c.power && POWER[c.power];
  const name = BRANDS[`${atoc} ${cls}`] ?? FAMILIES[cls];
  return name ? `Class ${cls} ${name}` : `Class ${cls}`;
}
