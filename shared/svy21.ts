// SVY21 (EPSG:3414) grid coordinates to WGS84 latitude/longitude.
// Transverse Mercator inverse on the WGS84 ellipsoid with SLA's published SVY21 parameters.

const a = 6378137;
const f = 1 / 298.257223563;
const oLat = 1.366666; // origin latitude, degrees
const oLon = 103.833333; // origin longitude, degrees
const oN = 38744.572; // false northing
const oE = 28001.642; // false easting
const k = 1; // central meridian scale factor

const rad = Math.PI / 180;
const b = a * (1 - f);
const e2 = 2 * f - f * f;
const e4 = e2 * e2;
const e6 = e4 * e2;
const A0 = 1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256;
const A2 = (3 / 8) * (e2 + e4 / 4 + (15 * e6) / 128);
const A4 = (15 / 256) * (e4 + (3 * e6) / 4);
const A6 = (35 * e6) / 3072;

const meridianArc = (lat: number) =>
  a * (A0 * lat - A2 * Math.sin(2 * lat) + A4 * Math.sin(4 * lat) - A6 * Math.sin(6 * lat));

export function svy21ToWgs84(northing: number, easting: number): { lat: number; lng: number } {
  const n = (a - b) / (a + b);
  const n2 = n * n;
  const n3 = n2 * n;
  const n4 = n2 * n2;
  const G = a * (1 - n) * (1 - n2) * (1 + (9 * n2) / 4 + (225 * n4) / 64) * rad;

  const Nprime = northing - oN;
  const Mo = meridianArc(oLat * rad);
  const Mprime = Mo + Nprime / k;
  const sigma = (Mprime / G) * rad;

  const latPrime =
    sigma +
    ((3 * n) / 2 - (27 * n3) / 32) * Math.sin(2 * sigma) +
    ((21 * n2) / 16 - (55 * n4) / 32) * Math.sin(4 * sigma) +
    ((151 * n3) / 96) * Math.sin(6 * sigma) +
    ((1097 * n4) / 512) * Math.sin(8 * sigma);

  const sinLat = Math.sin(latPrime);
  const rho = (a * (1 - e2)) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const v = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const psi = v / rho;
  const t = Math.tan(latPrime);
  const Eprime = easting - oE;
  const x = Eprime / (k * v);

  const latTerm1 = (t / (k * rho)) * ((x * Eprime) / 2);
  const latTerm2 =
    (t / (k * rho)) * ((x * x * x * Eprime) / 24) * (-4 * psi * psi + 9 * psi * (1 - t * t) + 12 * t * t);
  const latTerm3 =
    (t / (k * rho)) *
    ((Math.pow(x, 5) * Eprime) / 720) *
    (8 * Math.pow(psi, 4) * (11 - 24 * t * t) -
      12 * Math.pow(psi, 3) * (21 - 71 * t * t) +
      15 * psi * psi * (15 - 98 * t * t + 15 * Math.pow(t, 4)) +
      180 * psi * (5 * t * t - 3 * Math.pow(t, 4)) +
      360 * Math.pow(t, 4));
  const latTerm4 = (t / (k * rho)) * ((Math.pow(x, 7) * Eprime) / 40320) * (1385 - 3633 * t * t + 4095 * Math.pow(t, 4) + 1575 * Math.pow(t, 6));
  const lat = latPrime - latTerm1 + latTerm2 - latTerm3 + latTerm4;

  const secLat = 1 / Math.cos(lat);
  const lonTerm1 = x * secLat;
  const lonTerm2 = ((x * x * x * secLat) / 6) * (psi + 2 * t * t);
  const lonTerm3 =
    ((Math.pow(x, 5) * secLat) / 120) *
    (-4 * Math.pow(psi, 3) * (1 - 6 * t * t) + psi * psi * (9 - 68 * t * t) + 72 * psi * t * t + 24 * Math.pow(t, 4));
  const lonTerm4 = ((Math.pow(x, 7) * secLat) / 5040) * (61 + 662 * t * t + 1320 * Math.pow(t, 4) + 720 * Math.pow(t, 6));
  const lng = oLon * rad + lonTerm1 - lonTerm2 + lonTerm3 - lonTerm4;

  return { lat: lat / rad, lng: lng / rad };
}
