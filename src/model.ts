// Normalized /api/state document. TS mirror of solar-dash/src/model.rs —
// field names, nesting and null-vs-absent semantics must stay identical so
// the existing frontend (web/index.html) works unchanged. All power/energy
// values are W/Wh floats; the frontend does kW/kWh/currency formatting.

export type Status = "ok" | "stale" | "unconfigured" | "auth_failed" | "api_error";

export interface Plant {
  name: string;
  // The most the system can deliver: the inverter's AC limit.
  capacity_w: number;
  price_per_kwh: number | null;
  panel_kwp: number | null;
  install_date: string | null;
  // From wrangler.jsonc (PANEL_COUNT/PANEL_W) when set — WAAREE only knows
  // a rounded total. Null when not configured.
  panel_count: number | null;
  panel_w: number | null;
}

export function defaultPlant(): Plant {
  return {
    name: "",
    capacity_w: 0,
    price_per_kwh: null,
    panel_kwp: null,
    install_date: null,
    panel_count: null,
    panel_w: null,
  };
}

export interface ForecastPoint {
  t: string; // "HH:MM", plant-local, 15-minute slot midpoint
  expected_w: number;
  clear_w: number;
}

/** Sky conditions for one hour, from Open-Meteo. */
export interface SkyPoint {
  t: string; // "HH:MM", slot midpoint
  code: number | null; // WMO weather code
  cloud: number; // %
  temp: number; // °C
}

/** A day's weather in brief, from Open-Meteo's daily values. */
export interface DayWeather {
  code: number | null; // WMO; the day's most significant weather, so a single shower counts
  cloud_pct: number | null; // mean over 24 h
  precip_mm: number | null;
  temp_min: number | null; // °C
  temp_max: number | null;
}

export interface ForecastDay {
  date: string;
  expected_wh: number;
  clear_wh: number;
  weather_code: number | null; // WMO code
  cloud_pct: number | null; // daylight average
  temp_min: number | null; // °C
  temp_max: number | null;
  precip_mm: number | null;
  series: ForecastPoint[]; // today only; empty for tomorrow
  sky: SkyPoint[]; // today only, hourly around the clock; empty for tomorrow
}

export interface Forecast {
  source: "open-meteo" | "mock";
  fetched_at: string;
  // Performance ratio: actual output / what the irradiance alone predicts.
  // Calibrated from the plant's own recent days when pr_days >= 3.
  pr: number;
  pr_days: number;
  today: ForecastDay;
  tomorrow: ForecastDay;
}

export interface Live {
  solar_w: number;
  home_w: number | null;
  export_w: number | null;
  import_w: number | null;
  updated_at: string;
}

export function defaultLive(): Live {
  return { solar_w: 0, home_w: null, export_w: null, import_w: null, updated_at: "" };
}

export interface Sun {
  sunrise: string;
  sunset: string;
}

export function defaultSun(): Sun {
  return { sunrise: "", sunset: "" };
}

export interface CurvePoint {
  t: string;
  solar_w: number;
  // Serialized only when non-null (serde's skip_serializing_if in Rust).
  home_w?: number | null;
  export_w?: number | null;
  import_w?: number | null;
}

export interface Today {
  series: CurvePoint[];
  produced_wh: number;
  earned: number | null;
  peak_w: number;
  peak_at: string;
  vs_yesterday_wh: number | null;
  home_wh: number | null;
  exported_wh: number | null;
  imported_wh: number | null;
}

export function defaultToday(): Today {
  return {
    series: [],
    produced_wh: 0,
    earned: null,
    peak_w: 0,
    peak_at: "",
    vs_yesterday_wh: null,
    home_wh: null,
    exported_wh: null,
    imported_wh: null,
  };
}

export interface Yesterday {
  series: CurvePoint[];
  produced_wh: number;
}

export function defaultYesterday(): Yesterday {
  return { series: [], produced_wh: 0 };
}

export interface MonthDay {
  day: number;
  produced_wh: number | null;
  not_installed: boolean;
}

export interface BestDay {
  day: number;
  produced_wh: number;
}

export interface Month {
  month: number;
  year: number;
  days: MonthDay[];
  total_wh: number;
  best_day: BestDay | null;
}

export function defaultMonth(): Month {
  return { month: 0, year: 0, days: [], total_wh: 0, best_day: null };
}

export interface YearMonth {
  month: number;
  produced_wh: number | null;
  not_installed: boolean;
}

export interface Year {
  year: number;
  months: YearMonth[];
  since_install_wh: number;
}

export function defaultYear(): Year {
  return { year: 0, months: [], since_install_wh: 0 };
}

export interface Device {
  sn: string;
  device_type: string;
  status: number;
  power_w: number;
}

export interface Alarm {
  time: string;
  content: string;
  code: number;
  device_sn: string;
  alarm_type: number;
}

/** One line in the system log (see events.ts). */
export interface LogEvent {
  id: string;
  date: string; // YYYY-MM-DD, plant-local
  kind: "power_cut" | "no_data" | "alarm";
  from: string; // "HH:MM"
  to: string | null; // null for alarms
  ongoing: boolean;
  lost_wh: number | null; // forecast output missed during the span
  detail: string | null; // alarm text
}

/** The stick gateway's link to WAAREE's cloud. "relaying": the stick talks
 * to WAAREE through the gateway; "down": WAAREE is unreachable or silent and
 * the gateway answers instead; "off": relay not configured. */
export interface WaareeLink {
  mode: "relaying" | "down" | "off" | "unknown";
  since: string; // RFC 3339 UTC
}

export interface State {
  status: Status;
  server_now: string;
  has_meter: boolean;
  plant: Plant;
  live: Live;
  sun: Sun;
  today: Today;
  yesterday: Yesterday;
  month: Month;
  year: Year;
  devices: Device[];
  alarms: Alarm[];
  forecast: Forecast | null;
  events: LogEvent[]; // newest first
  // Null when no stick gateway is feeding the dashboard.
  waaree_link: WaareeLink | null;
}

export function unconfiguredState(nowIso: string): State {
  return {
    status: "unconfigured",
    server_now: nowIso,
    has_meter: false,
    plant: defaultPlant(),
    live: defaultLive(),
    sun: defaultSun(),
    today: defaultToday(),
    yesterday: defaultYesterday(),
    month: defaultMonth(),
    year: defaultYear(),
    devices: [],
    alarms: [],
    forecast: null,
    events: [],
    waaree_link: null,
  };
}

/**
 * Builds a CurvePoint, omitting home_w/export_w/import_w entirely when
 * `hasMeter` is false — matches Rust's
 * `#[serde(skip_serializing_if = "Option::is_none")]` on CurvePoint (as
 * opposed to Live.home_w, which is always serialized, `null` included).
 */
export function makeCurvePoint(
  t: string,
  solarW: number,
  hasMeter: boolean,
  homeW: number,
  exportW: number,
  importW: number
): CurvePoint {
  const p: CurvePoint = { t, solar_w: solarW };
  if (hasMeter) {
    p.home_w = homeW;
    p.export_w = exportW;
    p.import_w = importW;
  }
  return p;
}

/** Plain JSON serialization — CurvePoint fields are already shaped correctly
 * by `makeCurvePoint` (keys omitted, not null), so no replacer is needed. */
export function serializeState(state: State): string {
  return JSON.stringify(state);
}
