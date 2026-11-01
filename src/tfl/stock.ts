// What runs on each TfL line, for the train-type card. TfL's feed does not say
// which train is which, so a line that runs two fleets names both. Piccadilly
// line 2024 Stock and the DLR's B23s were still entering service in late 2026.

import type { Feature, ServiceDetails } from '../schedule/service.ts';

const AIR_CON: Feature = { id: 'air-con', label: 'Air-conditioned' };
const tube = (stock: string): ServiceDetails => ({ stock, kind: 'tube', traction: 'electric', features: [] });
const unit = (stock: string, features: Feature[] = [AIR_CON], thirdRail = false): ServiceDetails =>
  ({ stock, kind: 'unit', traction: 'electric', ...(thirdRail && { thirdRail }), features });
// The sub-surface lines and the DLR pick up from the track, not overhead wires.
const subSurface = (stock: string) => unit(stock, [AIR_CON], true);

const LINES: Record<string, ServiceDetails> = {
  bakerloo: tube('1972 Stock'),
  central: tube('1992 Stock'),
  jubilee: tube('1996 Stock'),
  northern: tube('1995 Stock'),
  piccadilly: tube('1973 Stock'),
  victoria: tube('2009 Stock'),
  'waterloo-city': tube('1992 Stock'),
  circle: subSurface('S7 Stock'),
  district: subSurface('S7 Stock'),
  'hammersmith-city': subSurface('S7 Stock'),
  metropolitan: subSurface('S8 Stock'),
  elizabeth: unit('Class 345 Aventra'),
  liberty: unit('Class 710 Aventra'),
  suffragette: unit('Class 710 Aventra'),
  weaver: unit('Class 710 Aventra'),
  windrush: unit('Class 378 Capitalstar'),
  lioness: unit('Class 378 Capitalstar or 710 Aventra'),
  mildmay: unit('Class 378 Capitalstar or 710 Aventra'),
  dlr: unit('B92, B2K, B07 or B23 stock', [], true),
};

export function tflStock(line: string): ServiceDetails | undefined {
  return LINES[line];
}
