import { describe, expect, it } from 'vitest';
import { describeService } from '../src/schedule/service.ts';
import type { ScheduleInfo, ServiceCodes } from '../src/schedule/timetable.ts';

const info = (atoc: string, service?: ServiceCodes): ScheduleInfo => ({ uid: 'C10001', date: '2026-11-01', atoc, origin: 'A', destination: 'B', service });

describe('describeService', () => {
  it('names the unit class from the timing load, with top speed and facilities', () => {
    expect(describeService(info('VT', { power: 'EMU', timingLoad: '390', speed: '125', seating: 'B', catering: 'T', reservations: 'S' }))).toEqual({
      stock: 'Class 390 Pendolino',
      maxMph: 125,
      tonnes: undefined,
      features: ['First class', 'Trolley'],
    });
  });

  it("uses an operator's own name for its Hitachi trains", () => {
    expect(describeService(info('GR', { power: 'EMU', timingLoad: '800' }))?.stock).toBe('Class 800 Azuma');
    expect(describeService(info('GW', { power: 'DMU', timingLoad: '800' }))?.stock).toBe('Class 800 Intercity Express Train');
    expect(describeService(info('LD', { power: 'EMU', timingLoad: '803' }))?.stock).toBe('Class 803 AT300');
  });

  it('reads the letter codes that stand for classes', () => {
    expect(describeService(info('NT', { power: 'DMU', timingLoad: 'S' }))?.stock).toBe('Class 150/153/155/156 Sprinter');
    expect(describeService(info('EM', { power: 'DMU', timingLoad: 'E' }))?.stock).toBe('Class 158/168/170/175');
    expect(describeService(info('SN', { power: 'EMU', timingLoad: '0' }))?.stock).toBe('Class 380 Desiro');
    // Accelerated timings, not a class.
    expect(describeService(info('SW', { power: 'EMU', timingLoad: 'AT' }))?.stock).toBe('Electric multiple unit');
  });

  it('gives the planned load of a hauled train, never a class', () => {
    expect(describeService(info('ZZ', { power: 'D', timingLoad: '1600', speed: '060' }))).toEqual({
      stock: 'Diesel locomotive',
      maxMph: 60,
      tonnes: 1600,
      features: [],
    });
  });

  it('lists sleepers, catering and compulsory reservations', () => {
    expect(describeService(info('CS', { power: 'E', seating: 'B', sleepers: 'B', catering: 'CF', reservations: 'A' }))?.features).toEqual([
      'First class',
      'Sleeper',
      'Buffet',
      'First class restaurant',
      'Reservations required',
    ]);
  });

  it('says nothing without codes', () => {
    expect(describeService(info('GR'))).toBeUndefined();
    expect(describeService(undefined)).toBeUndefined();
  });
});
