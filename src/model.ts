// Normalized /api/state document. TS mirror of solar-dash/src/model.rs —
// field names, nesting and null-vs-absent semantics must stay identical so
// the existing frontend (web/index.html) works unchanged. All power/energy
// values are W/Wh floats; the frontend does kW/kWh/currency formatting.

export type Status = "ok" | "stale" | "unconfigured" | "auth_failed" | "api_error";

export interface Plant {
  name: string;
  capacity_w: number;
  price_per_kwh: number | null;
  panel_kwp: number | null;
  install_date: string | null;
}

export function defaultPlant(): Plant {
  return { name: "", capacity_w: 0, price_per_kwh: null, panel_kwp: null, install_date: null };
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
