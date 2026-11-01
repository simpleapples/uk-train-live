// Ordnance Survey National Grid (OSGB36) easting/northing -> WGS84 longitude
// and latitude: inverse Transverse Mercator on the Airy 1830 ellipsoid, then
// a Helmert transform. Good to a few metres, from OS's "A Guide to
// Coordinate Systems in Great Britain".

const AIRY = { a: 6377563.396, b: 6356256.909 };
const WGS84 = { a: 6378137, b: 6356752.3142 };
const F0 = 0.9996012717;
const LAT0 = (49 * Math.PI) / 180;
const LON0 = (-2 * Math.PI) / 180;
const E0 = 400000;
const N0 = -100000;
const ARCSEC = Math.PI / (180 * 3600);
// OSGB36 -> WGS84 (the published WGS84 -> OSGB36 parameters, negated).
const HELMERT = { tx: 446.448, ty: -125.157, tz: 542.06, s: -20.4894e-6, rx: 0.1502 * ARCSEC, ry: 0.247 * ARCSEC, rz: 0.8421 * ARCSEC };

/** Latitude and longitude on the OSGB36 datum, radians. */
export function gridToOsgb36(e: number, n: number): [lat: number, lon: number] {
  const { a, b } = AIRY;
  const e2 = 1 - (b * b) / (a * a);
  const nn = (a - b) / (a + b);
  const meridional = (lat: number) => b * F0 * (
    (1 + nn + (5 / 4) * nn ** 2 + (5 / 4) * nn ** 3) * (lat - LAT0)
    - (3 * nn + 3 * nn ** 2 + (21 / 8) * nn ** 3) * Math.sin(lat - LAT0) * Math.cos(lat + LAT0)
    + ((15 / 8) * nn ** 2 + (15 / 8) * nn ** 3) * Math.sin(2 * (lat - LAT0)) * Math.cos(2 * (lat + LAT0))
    - (35 / 24) * nn ** 3 * Math.sin(3 * (lat - LAT0)) * Math.cos(3 * (lat + LAT0)));
  let lat = LAT0;
  let m = 0;
  do {
    lat += (n - N0 - m) / (a * F0);
    m = meridional(lat);
  } while (Math.abs(n - N0 - m) >= 0.00001);
  const sin = Math.sin(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / (1 - e2 * sin * sin) ** 1.5;
  const eta2 = nu / rho - 1;
  const tan = Math.tan(lat);
  const sec = 1 / Math.cos(lat);
  const de = e - E0;
  const vii = tan / (2 * rho * nu);
  const viii = (tan / (24 * rho * nu ** 3)) * (5 + 3 * tan ** 2 + eta2 - 9 * tan ** 2 * eta2);
  const ix = (tan / (720 * rho * nu ** 5)) * (61 + 90 * tan ** 2 + 45 * tan ** 4);
  const x = sec / nu;
  const xi = (sec / (6 * nu ** 3)) * (nu / rho + 2 * tan ** 2);
  const xii = (sec / (120 * nu ** 5)) * (5 + 28 * tan ** 2 + 24 * tan ** 4);
  const xiia = (sec / (5040 * nu ** 7)) * (61 + 662 * tan ** 2 + 1320 * tan ** 4 + 720 * tan ** 6);
  return [
    lat - vii * de ** 2 + viii * de ** 4 - ix * de ** 6,
    LON0 + x * de - xi * de ** 3 + xii * de ** 5 - xiia * de ** 7,
  ];
}

/** WGS84 [lon, lat] in degrees for a National Grid easting and northing in metres. */
export function gridToWgs84(e: number, n: number): [lon: number, lat: number] {
  const [phi, lambda] = gridToOsgb36(e, n);
  // To Cartesian on Airy, Helmert to WGS84, back to latitude and longitude.
  const ea2 = 1 - AIRY.b ** 2 / AIRY.a ** 2;
  const nu = AIRY.a / Math.sqrt(1 - ea2 * Math.sin(phi) ** 2);
  const x1 = nu * Math.cos(phi) * Math.cos(lambda);
  const y1 = nu * Math.cos(phi) * Math.sin(lambda);
  const z1 = (1 - ea2) * nu * Math.sin(phi);
  const { tx, ty, tz, s, rx, ry, rz } = HELMERT;
  const x2 = tx + (1 + s) * x1 - rz * y1 + ry * z1;
  const y2 = ty + rz * x1 + (1 + s) * y1 - rx * z1;
  const z2 = tz - ry * x1 + rx * y1 + (1 + s) * z1;
  const ew2 = 1 - WGS84.b ** 2 / WGS84.a ** 2;
  const p = Math.hypot(x2, y2);
  let lat = Math.atan2(z2, p * (1 - ew2));
  for (let i = 0; i < 10; i++) {
    const v = WGS84.a / Math.sqrt(1 - ew2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z2 + ew2 * v * Math.sin(lat), p);
  }
  return [(Math.atan2(y2, x2) * 180) / Math.PI, (lat * 180) / Math.PI];
}
