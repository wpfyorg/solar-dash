// Weather-based production forecast. Two curves for the hero chart:
//
//   expected — Open-Meteo's forecast irradiance on the plane of your panels
//              (tilt/azimuth), turned into kW with your panel size and a
//              performance ratio calibrated from your own recent days.
//   clear    — the same, but for a cloudless sky, from a small clear-sky
//              model computed here (Open-Meteo has no tilted clear-sky
//              variable). This is the "if it were fully sunny" line.
//
// Both are capped at the inverter's AC limit, since that's what clips a
// bright midday when the panels (DC) are bigger than the inverter.
//
// Open-Meteo is free for non-commercial use and needs no API key. It is
// fetched at most once an hour by the poller (see poll.ts) and stored in
// `state.forecast`, so the browser never talks to it directly.

import type { Forecast, ForecastDay, ForecastPoint } from "./model";
import { TZ_OFFSET_HOURS } from "./sun";

export const DEFAULT_PR = 0.8;
const PR_MIN = 0.5;
const PR_MAX = 1.0;
const TEMP_COEFF = -0.0037; // per °C above 25 °C, typical mono-PERC panel
const ALBEDO = 0.2;

export interface PanelSetup {
  lat: number;
  lon: number;
  tilt: number; // degrees from horizontal
  azimuth: number; // Open-Meteo convention: 0 = south, -90 = east, 90 = west
  kwp: number; // panel DC size
  inverterW: number; // AC limit
}

/** One 15-minute slot, `min` = minutes since local midnight of `date`. */
export interface IrradianceSlot {
  date: string; // YYYY-MM-DD, plant-local
  min: number; // slot midpoint
  poa: number; // W/m² on the panel plane
  tempC: number;
  cloud: number; // %
}

export interface WeatherInput {
  slots: IrradianceSlot[];
  dailyCode: Record<string, number>; // YYYY-MM-DD -> WMO weather code
}

// --- Open-Meteo --------------------------------------------------------------

export async function fetchOpenMeteo(setup: PanelSetup): Promise<WeatherInput> {
  const q = new URLSearchParams({
    latitude: String(setup.lat),
    longitude: String(setup.lon),
    minutely_15: "global_tilted_irradiance,temperature_2m,cloud_cover",
    daily: "weather_code",
    tilt: String(setup.tilt),
    azimuth: String(setup.azimuth),
    timezone: "Asia/Kolkata",
    past_days: "7",
    forecast_days: "2",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`, {
    headers: { "User-Agent": "solar-dash (self-hosted dashboard)" },
  });
  if (!res.ok) throw new Error(`open-meteo http ${res.status}`);
  const body = (await res.json()) as {
    minutely_15?: {
      time?: string[];
      global_tilted_irradiance?: (number | null)[];
      temperature_2m?: (number | null)[];
      cloud_cover?: (number | null)[];
    };
    daily?: { time?: string[]; weather_code?: (number | null)[] };
  };
  const m = body.minutely_15 ?? {};
  const slots: IrradianceSlot[] = [];
  (m.time ?? []).forEach((t, i) => {
    const [date, hm] = t.split("T");
    if (!date || !hm) return;
    const [h, mi] = hm.split(":").map(Number);
    // Values are the mean over the preceding 15 minutes; label the slot by
    // its midpoint so it lines up with WAAREE's instantaneous samples.
    const min = h! * 60 + mi! - 7.5;
    if (min < 0) return;
    slots.push({
      date,
      min,
      poa: Math.max(0, m.global_tilted_irradiance?.[i] ?? 0),
      tempC: m.temperature_2m?.[i] ?? 25,
      cloud: m.cloud_cover?.[i] ?? 0,
    });
  });
  const dailyCode: Record<string, number> = {};
  (body.daily?.time ?? []).forEach((d, i) => {
    const c = body.daily?.weather_code?.[i];
    if (c != null) dailyCode[d] = c;
  });
  return { slots, dailyCode };
}

// --- Clear-sky model ----------------------------------------------------------

/** Clear-sky irradiance on the panel plane (W/m²) at `min` minutes past
 * local midnight. NOAA solar position + Meinel's DNI with a flat diffuse
 * share, transposed isotropically. Good to a few percent on a clean day;
 * the calibrated performance ratio absorbs local haze. */
export function clearSkyPoa(setup: PanelSetup, y: number, m: number, d: number, min: number): number {
  const rad = Math.PI / 180;
  const doy = dayOfYear(y, m, d);
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (min / 60 - 12) / 24);
  const eqtime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const tst = min + eqtime + 4 * setup.lon - 60 * TZ_OFFSET_HOURS;
  const ha = (tst / 4 - 180) * rad;
  const lat = setup.lat * rad;
  const cosZ = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  if (cosZ <= 0.01) return 0;
  const zenDeg = Math.acos(cosZ) / rad;
  const sinZ = Math.sqrt(1 - cosZ * cosZ);
  // Sun azimuth, degrees clockwise from north.
  let sunAz = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / rad + 180;
  sunAz = ((sunAz % 360) + 360) % 360;
  const panelAz = 180 + setup.azimuth;
  const beta = setup.tilt * rad;
  const cosInc = cosZ * Math.cos(beta) + sinZ * Math.sin(beta) * Math.cos((sunAz - panelAz) * rad);

  const am = 1 / (cosZ + 0.50572 * Math.pow(96.07995 - zenDeg, -1.6364));
  const dni = 1353 * Math.pow(0.7, Math.pow(am, 0.678));
  const dhi = 0.1 * dni;
  const ghi = dni * cosZ + dhi;
  return Math.max(0, dni * Math.max(0, cosInc) + dhi * (1 + Math.cos(beta)) / 2 + ghi * ALBEDO * (1 - Math.cos(beta)) / 2);
}

function dayOfYear(y: number, m: number, d: number): number {
  const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return cum[m - 1]! + d + (leap && m > 2 ? 1 : 0);
}

// --- Irradiance -> power ------------------------------------------------------

/** DC-side output in W before the inverter cap, for irradiance `poa` at air
 * temperature `tempC`. Cell temperature runs roughly 25 °C over ambient at
 * 800 W/m² (NOCT-style), costing ~0.37%/°C. */
function rawWatts(setup: PanelSetup, poa: number, tempC: number, pr: number): number {
  const cellC = tempC + (poa / 800) * 25;
  const tempFactor = 1 + TEMP_COEFF * (cellC - 25);
  return (poa / 1000) * setup.kwp * 1000 * pr * tempFactor;
}

function watts(setup: PanelSetup, poa: number, tempC: number, pr: number): number {
  return Math.min(setup.inverterW, Math.max(0, rawWatts(setup, poa, tempC, pr)));
}

/** Performance ratio from recent complete days: what the plant actually made
 * divided by what the forecast irradiance says it could have made at 100%.
 * Days where the plant made under a fifth of the model (outage, inverter
 * off, missing data) are skipped. Returns null with fewer than 3 usable days. */
export function calibratePr(
  setup: PanelSetup,
  slots: IrradianceSlot[],
  actualWhByDate: Record<string, number>,
  todayIso: string
): { pr: number; days: number } | null {
  const modelled: Record<string, number> = {};
  for (const s of slots) {
    if (s.date >= todayIso) continue;
    modelled[s.date] = (modelled[s.date] ?? 0) + rawWatts(setup, s.poa, s.tempC, 1) * 0.25;
  }
  let sumActual = 0;
  let sumModel = 0;
  let days = 0;
  for (const [date, model] of Object.entries(modelled)) {
    const actual = actualWhByDate[date];
    if (actual == null || model < 500) continue;
    if (actual < model * 0.2) continue;
    sumActual += actual;
    sumModel += model;
    days++;
  }
  if (days < 3 || sumModel <= 0) return null;
  return { pr: Math.min(PR_MAX, Math.max(PR_MIN, sumActual / sumModel)), days };
}

function hhmm(min: number): string {
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function buildDay(
  setup: PanelSetup,
  date: string,
  slots: IrradianceSlot[],
  code: number | null,
  pr: number,
  withSeries: boolean
): ForecastDay {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const series: ForecastPoint[] = [];
  let expectedWh = 0;
  let clearWh = 0;
  let cloudSum = 0;
  let cloudN = 0;
  for (const s of slots) {
    const clearPoa = clearSkyPoa(setup, y, m, d, s.min);
    const expectedW = watts(setup, s.poa, s.tempC, pr);
    const clearW = Math.max(expectedW, watts(setup, clearPoa, s.tempC, pr));
    expectedWh += expectedW * 0.25;
    clearWh += clearW * 0.25;
    if (clearPoa > 100) {
      cloudSum += s.cloud;
      cloudN++;
    }
    if (withSeries && clearW > 0) {
      series.push({ t: hhmm(s.min), expected_w: Math.round(expectedW), clear_w: Math.round(clearW) });
    }
  }
  return {
    date,
    expected_wh: Math.round(expectedWh),
    clear_wh: Math.round(clearWh),
    weather_code: code,
    cloud_pct: cloudN ? Math.round(cloudSum / cloudN) : null,
    series,
  };
}

export function buildForecast(
  setup: PanelSetup,
  weather: WeatherInput,
  todayIso: string,
  tomorrowIso: string,
  actualWhByDate: Record<string, number>,
  prevPr: number | null,
  source: Forecast["source"],
  fetchedAt: string
): Forecast {
  const cal = calibratePr(setup, weather.slots, actualWhByDate, todayIso);
  const pr = cal?.pr ?? prevPr ?? DEFAULT_PR;
  const on = (date: string) => weather.slots.filter((s) => s.date === date);
  return {
    source,
    fetched_at: fetchedAt,
    pr: Math.round(pr * 1000) / 1000,
    pr_days: cal?.days ?? 0,
    today: buildDay(setup, todayIso, on(todayIso), weather.dailyCode[todayIso] ?? null, pr, true),
    tomorrow: buildDay(setup, tomorrowIso, on(tomorrowIso), weather.dailyCode[tomorrowIso] ?? null, pr, false),
  };
}

// --- Mock weather ---------------------------------------------------------------

/** Deterministic stand-in for Open-Meteo in MOCK=1: the clear-sky curve
 * with a passing-clouds pattern, so the forecast UI can be designed
 * offline. */
export function mockWeather(setup: PanelSetup, dates: string[]): WeatherInput {
  const slots: IrradianceSlot[] = [];
  const dailyCode: Record<string, number> = {};
  dates.forEach((date, di) => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const cloudiness = [0.35, 0.2, 0.55, 0.15, 0.3, 0.45, 0.25, 0.4, 0.1][di % 9]!;
    dailyCode[date] = cloudiness > 0.4 ? 3 : cloudiness > 0.25 ? 2 : 1;
    for (let q = 0; q < 96; q++) {
      const min = q * 15 + 7.5;
      const wobble = 0.5 + 0.5 * Math.sin(q * 0.9 + di * 1.7);
      const cloud = Math.round(100 * Math.min(1, cloudiness * (0.6 + wobble)));
      const poa = clearSkyPoa(setup, y, m, d, min) * (1 - 0.75 * (cloud / 100));
      slots.push({ date, min, poa, tempC: 26 + 6 * Math.sin(((min - 420) / 720) * Math.PI), cloud });
    }
  });
  return { slots, dailyCode };
}
