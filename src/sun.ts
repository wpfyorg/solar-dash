// Sunrise/sunset via the NOAA solar-position approximation.
//
// Fallbacks only — set LAT/LON in wrangler.jsonc to your own plant's
// coordinates. These defaults point at New Delhi and only apply if that's
// missing or unparseable.
export const DEFAULT_LAT = 28.6139;
export const DEFAULT_LON = 77.209;
export const TZ_OFFSET_HOURS = 5.5;

export function sunTimes(
  lat: number,
  lon: number,
  year: number,
  month: number,
  day: number
): { sunrise: string; sunset: string } {
  const doy = dayOfYear(year, month, day);
  const gamma = ((2 * Math.PI) / 365) * (doy - 1);

  const eqtime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  const latR = (lat * Math.PI) / 180;
  const zenith = (90.833 * Math.PI) / 180;
  let cosHa = Math.cos(zenith) / (Math.cos(latR) * Math.cos(decl)) - Math.tan(latR) * Math.tan(decl);
  cosHa = Math.max(-1, Math.min(1, cosHa));
  const ha = (Math.acos(cosHa) * 180) / Math.PI;

  const solarNoonUtcMin = 720 - 4 * lon - eqtime;
  const sunriseUtcMin = solarNoonUtcMin - ha * 4;
  const sunsetUtcMin = solarNoonUtcMin + ha * 4;

  return { sunrise: fmtLocal(sunriseUtcMin), sunset: fmtLocal(sunsetUtcMin) };
}

function rem_euclid(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? r + b : r;
}

function fmtLocal(utcMinutes: number): string {
  const local = rem_euclid(utcMinutes + TZ_OFFSET_HOURS * 60, 1440);
  const h = Math.floor(local / 60);
  const m = Math.floor(local % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function dayOfYear(year: number, month: number, day: number): number {
  const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const idx = Math.min(Math.max(month - 1, 0), 11);
  let doy = cum[idx]! + day;
  if (leap && month > 2) doy += 1;
  return doy;
}
