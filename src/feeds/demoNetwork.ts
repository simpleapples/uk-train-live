// Simulated services for demo mode. Lines are ordered TIPLOCs (resolved to
// coordinates through data/stations.json); patterns say which of them a
// service calls at, how often it runs and how fast it goes.

export const LINES: Record<string, string[]> = {
  ecml: ['KNGX', 'STEVNGE', 'HITCHIN', 'PBRO', 'GTHM', 'NEWANG', 'RTFD', 'DONC', 'YORK', 'THIRSK', 'NLRTN', 'DLTN', 'DRHM', 'NWCSTLE', 'ALNMOTH', 'BRWCKUT', 'EDINBUR'],
  ecmlLeeds: ['KNGX', 'STEVNGE', 'HITCHIN', 'PBRO', 'GTHM', 'NEWANG', 'RTFD', 'DONC', 'WKFLDWG', 'LEEDS'],
  kingsLynn: ['KNGX', 'STEVNGE', 'HITCHIN', 'CAMBDGE', 'ELYY', 'KLYNN'],
  wcml: ['EUSTON', 'WATFDJ', 'MKNSCEN', 'RUGBY', 'NNTN', 'TMWTHLL', 'LCHTTVL', 'STAFFRD', 'CREWE', 'WRGTNBQ', 'WIGANNW', 'PRST', 'LANCSTR', 'OXENHLM', 'PNTH', 'CARLILE', 'LCKRBIE', 'MOTHRWL', 'GLGC'],
  wcmlBirmingham: ['EUSTON', 'WATFDJ', 'MKNSCEN', 'RUGBY', 'COVNTRY', 'BHAMINT', 'BHAMNWS', 'WVRMPTN'],
  wcmlManchester: ['EUSTON', 'WATFDJ', 'MKNSCEN', 'RUGBY', 'NNTN', 'TMWTHLL', 'LCHTTVL', 'STOKEOT', 'MACLSFD', 'STKP', 'MNCRPIC'],
  gwml: ['PADTON', 'SLOUGH', 'RDNGSTN', 'DIDCOTP', 'SDON', 'CHIPNHM', 'BATHSPA', 'BRSTLTM'],
  southWales: ['PADTON', 'SLOUGH', 'RDNGSTN', 'DIDCOTP', 'SDON', 'BRSTPWY', 'SEVTNLJ', 'NWPTRTG', 'CRDFCEN', 'BRGEND', 'PTALBOT', 'NEATH', 'SWANSEA'],
  westOfEngland: ['PADTON', 'SLOUGH', 'RDNGSTN', 'NEWBURY', 'WSTBRYW', 'CCARY', 'TAUNTON', 'TIVIPW', 'EXETRSD', 'NABT', 'PLYMTH'],
  mml: ['STPX', 'LUTOAPY', 'BEDFDM', 'WLNGBRO', 'KETR', 'MRKTHRB', 'LESTER', 'LOGHBRO', 'EMPKWAY', 'DRBY', 'CHFD', 'SHEFFLD'],
  hs1: ['STPX', 'STFODOM', 'ASHFKY', 'FLKSTNC', 'DOVERP'],
  geml: ['LIVST', 'STFD', 'SHENFLD', 'CHLMSFD', 'CLCHSTR', 'MANNGTR', 'IPSWICH', 'STWMRKT', 'DISS', 'NRCH'],
  brighton: ['VICTRIC', 'CLPHMJC', 'ECROYDN', 'GTWK', 'HYWRDSH', 'BRGHTN'],
  swml: ['WATRLMN', 'CLPHMJC', 'WOKING', 'BSNGSTK', 'WNCHSTR', 'SOTON', 'BOMO'],
  portsmouth: ['WATRLMN', 'CLPHMJC', 'WOKING', 'GUILDFD', 'HAVANT', 'PHBR'],
  transpennine: ['LVRPLSH', 'NWTNLW', 'MNCROXR', 'MNCRPIC', 'SBYD', 'HDRSFLD', 'DWBY', 'LEEDS', 'YORK', 'THIRSK', 'NLRTN', 'DLTN', 'DRHM', 'NWCSTLE'],
  xcSouthWest: ['BHAMNWS', 'CHLTNHM', 'BRSTPWY', 'BRSTLTM', 'TAUNTON', 'TIVIPW', 'EXETRSD', 'NABT', 'PLYMTH'],
  xcNorthEast: ['BHAMNWS', 'DRBY', 'CHFD', 'SHEFFLD', 'WKFLDWG', 'LEEDS', 'YORK'],
  marches: ['CRDFCEN', 'NWPTRTG', 'HEREFRD', 'SHRWBY', 'CREWE', 'STKP', 'MNCRPIC'],
  northWales: ['CREWE', 'CHST', 'LANDUDJ', 'BANGOR', 'HLYH'],
  edinburghGlasgow: ['EDINBUR', 'HAYMRKT', 'LNLTHGW', 'FALKRKH', 'CROY', 'GLGQHL'],
  edinburghAberdeen: ['EDINBUR', 'HAYMRKT', 'KCLD', 'LEUCHRS', 'DUNDETB', 'ARBROTH', 'MONTRSE', 'SHVN', 'ABRDEEN'],
  highland: ['GLGQHL', 'STIRLNG', 'PERTH', 'PTLCHRY', 'AVIEMRE', 'IVRNESS'],
};

export interface Pattern {
  line: string;
  /** First and last TIPLOC served, in line order; defaults to the whole line. */
  from?: string;
  to?: string;
  /** TIPLOCs the train stops at; everywhere else it passes. */
  calls: 'all' | string[];
  headwayMin: number;
  /** Average running speed between stops, km/h. */
  speedKmh: number;
  /** Headcode class digit and route letter, e.g. '1' + 'S' -> 1Sxx. */
  cls: string;
  letter: string;
  toc: string;
}

export const OPERATORS: Record<string, string> = {
  LN: 'LNER',
  GN: 'Great Northern',
  AW: 'Avanti West Coast',
  GW: 'GWR',
  EM: 'East Midlands Railway',
  SE: 'Southeastern',
  GA: 'Greater Anglia',
  SN: 'Southern',
  SW: 'South Western Railway',
  TP: 'TransPennine Express',
  NT: 'Northern',
  XC: 'CrossCountry',
  TW: 'Transport for Wales',
  SR: 'ScotRail',
  FL: 'Freightliner',
  DB: 'DB Cargo',
};

export const PATTERNS: Pattern[] = [
  { line: 'ecml', calls: ['KNGX', 'PBRO', 'YORK', 'NWCSTLE', 'EDINBUR'], headwayMin: 30, speedKmh: 165, cls: '1', letter: 'S', toc: 'LN' },
  { line: 'ecmlLeeds', calls: ['KNGX', 'STEVNGE', 'PBRO', 'GTHM', 'NEWANG', 'DONC', 'WKFLDWG', 'LEEDS'], headwayMin: 60, speedKmh: 150, cls: '1', letter: 'D', toc: 'LN' },
  { line: 'ecml', to: 'PBRO', calls: 'all', headwayMin: 30, speedKmh: 110, cls: '2', letter: 'P', toc: 'GN' },
  { line: 'kingsLynn', calls: 'all', headwayMin: 30, speedKmh: 105, cls: '1', letter: 'K', toc: 'GN' },
  { line: 'wcml', calls: ['EUSTON', 'MKNSCEN', 'WRGTNBQ', 'PRST', 'LANCSTR', 'OXENHLM', 'CARLILE', 'GLGC'], headwayMin: 60, speedKmh: 160, cls: '1', letter: 'S', toc: 'AW' },
  { line: 'wcmlBirmingham', calls: ['EUSTON', 'MKNSCEN', 'RUGBY', 'COVNTRY', 'BHAMINT', 'BHAMNWS', 'WVRMPTN'], headwayMin: 20, speedKmh: 145, cls: '1', letter: 'G', toc: 'AW' },
  { line: 'wcmlManchester', calls: ['EUSTON', 'STOKEOT', 'MACLSFD', 'STKP', 'MNCRPIC'], headwayMin: 20, speedKmh: 155, cls: '1', letter: 'H', toc: 'AW' },
  { line: 'gwml', calls: 'all', headwayMin: 30, speedKmh: 135, cls: '1', letter: 'C', toc: 'GW' },
  { line: 'southWales', calls: ['PADTON', 'RDNGSTN', 'DIDCOTP', 'SDON', 'BRSTPWY', 'NWPTRTG', 'CRDFCEN', 'BRGEND', 'PTALBOT', 'NEATH', 'SWANSEA'], headwayMin: 30, speedKmh: 140, cls: '1', letter: 'B', toc: 'GW' },
  { line: 'westOfEngland', calls: ['PADTON', 'RDNGSTN', 'TAUNTON', 'TIVIPW', 'EXETRSD', 'NABT', 'PLYMTH'], headwayMin: 60, speedKmh: 135, cls: '1', letter: 'A', toc: 'GW' },
  { line: 'mml', calls: 'all', headwayMin: 30, speedKmh: 135, cls: '1', letter: 'F', toc: 'EM' },
  { line: 'hs1', calls: 'all', headwayMin: 60, speedKmh: 150, cls: '1', letter: 'J', toc: 'SE' },
  { line: 'geml', calls: ['LIVST', 'STFD', 'CHLMSFD', 'CLCHSTR', 'MANNGTR', 'IPSWICH', 'STWMRKT', 'DISS', 'NRCH'], headwayMin: 30, speedKmh: 130, cls: '1', letter: 'P', toc: 'GA' },
  { line: 'brighton', calls: 'all', headwayMin: 15, speedKmh: 100, cls: '1', letter: 'B', toc: 'SN' },
  { line: 'swml', calls: 'all', headwayMin: 30, speedKmh: 115, cls: '1', letter: 'W', toc: 'SW' },
  { line: 'portsmouth', calls: 'all', headwayMin: 30, speedKmh: 105, cls: '1', letter: 'P', toc: 'SW' },
  { line: 'transpennine', calls: 'all', headwayMin: 60, speedKmh: 110, cls: '1', letter: 'N', toc: 'TP' },
  { line: 'transpennine', from: 'MNCRPIC', to: 'LEEDS', calls: 'all', headwayMin: 30, speedKmh: 75, cls: '2', letter: 'E', toc: 'NT' },
  { line: 'xcSouthWest', calls: 'all', headwayMin: 60, speedKmh: 130, cls: '1', letter: 'V', toc: 'XC' },
  { line: 'xcNorthEast', calls: 'all', headwayMin: 60, speedKmh: 130, cls: '1', letter: 'E', toc: 'XC' },
  { line: 'marches', calls: 'all', headwayMin: 60, speedKmh: 105, cls: '1', letter: 'W', toc: 'TW' },
  { line: 'northWales', calls: 'all', headwayMin: 60, speedKmh: 100, cls: '1', letter: 'D', toc: 'TW' },
  { line: 'edinburghGlasgow', calls: 'all', headwayMin: 15, speedKmh: 115, cls: '1', letter: 'R', toc: 'SR' },
  { line: 'edinburghAberdeen', calls: 'all', headwayMin: 60, speedKmh: 105, cls: '1', letter: 'A', toc: 'SR' },
  { line: 'highland', calls: 'all', headwayMin: 120, speedKmh: 95, cls: '1', letter: 'H', toc: 'SR' },
  { line: 'wcml', from: 'RUGBY', to: 'MOTHRWL', calls: ['RUGBY', 'MOTHRWL'], headwayMin: 90, speedKmh: 85, cls: '4', letter: 'S', toc: 'FL' },
  { line: 'ecml', from: 'DONC', to: 'NWCSTLE', calls: ['DONC', 'NWCSTLE'], headwayMin: 120, speedKmh: 75, cls: '6', letter: 'N', toc: 'DB' },
  { line: 'southWales', from: 'DIDCOTP', to: 'PTALBOT', calls: ['DIDCOTP', 'PTALBOT'], headwayMin: 120, speedKmh: 70, cls: '6', letter: 'B', toc: 'DB' },
];
