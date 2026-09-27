// Field mapping and unit conversion. TS port of solar-dash/src/mapping.rs —
// kept 1:1 with that file's logic (including comments on the confirmed real
// shapes) so a `probe`-style diff stays meaningful across both codebases.

import {
  flowNodeKw,
  type AlarmListResult,
  type DeviceListResult,
  type HistoryRawSeries,
  type HistoryReportSeries,
  type PlantFlowInfoResult,
} from "./raw";
import {
  makeCurvePoint,
  type Alarm,
  type BestDay,
  type CurvePoint,
  type Device,
  type Live,
  type Month,
  type MonthDay,
  type Year,
  type YearMonth,
} from "./model";
import { TZ_OFFSET_HOURS } from "./sun";

const KW_TO_W = 1000.0;

// `updated_at` is always the REAL wall-clock time, even in mock mode (see
// solar-dash/src/mock.rs's comment: the real `status.lastUpdateDate` field is
// a human string, not a timestamp, so map_flow_info always stamps `now_iso()`
// regardless of any `--now`/MOCK_NOW override — mock fixtures still read as
// fresh on every poll).
export function mapFlowInfo(f: PlantFlowInfoResult, hasMeter: boolean, prevHomeW: number): Live {
  const solarW = Math.max(flowNodeKw(f.node?.solar), 0) * KW_TO_W;

  if (!hasMeter) {
    return { solar_w: solarW, home_w: null, export_w: null, import_w: null, updated_at: nowIso() };
  }

  const deviceW = Math.max(flowNodeKw(f.node?.device), 0) * KW_TO_W;
  const prevHome = Math.max(prevHomeW, 0);
  const gridToHidden = f.flow?.gridToHidden ?? 0;
  const exporting = gridToHidden < 0;
  const importing = gridToHidden > 0;

  let homeW: number, exportW: number, importW: number;
  if (exporting) {
    homeW = Math.min(prevHome, deviceW);
    exportW = Math.max(deviceW - homeW, 0);
    importW = 0;
  } else if (importing) {
    homeW = Math.max(prevHome, deviceW);
    exportW = 0;
    importW = Math.max(homeW - deviceW, 0);
  } else {
    homeW = deviceW;
    exportW = 0;
    importW = 0;
  }

  return { solar_w: solarW, home_w: homeW, export_w: exportW, import_w: importW, updated_at: nowIso() };
}

/** True only if any day in the given month report shows nonzero loadsPower/
 * gridConsumptionPower energy over roughly the last 7 days. */
export function detectHasMeter(monthReport: HistoryReportSeries[], todayDay: number): boolean {
  const hasNonzero = (varName: string): boolean => {
    const series = monthReport.find((s) => s.variable === varName);
    if (!series) return false;
    return (series.data ?? []).some(
      (d) => d.index <= todayDay && d.index + 7 > todayDay && Math.abs(d.value) > 0.001
    );
  };
  return hasNonzero("loads") || hasNonzero("gridConsumption");
}

export function nowIso(): string {
  return civilFromUnix(Math.floor(Date.now() / 1000));
}

export function isoFromUnix(unix: number): string {
  return civilFromUnix(unix);
}

/** "HH:MM" in the plant's local time (IST, UTC+5:30) for a real UTC unix timestamp. */
export function localHHMM(unix: number): string {
  const secsOfDay = remEuclid(unix + Math.round(TZ_OFFSET_HOURS * 3600), 86400);
  const h = Math.floor(secsOfDay / 3600);
  const m = Math.floor(secsOfDay / 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Parses "YYYY-MM-DDTHH:MM" (plant-local, IST) into a UTC unix timestamp.
 * Returns null on malformed input. Mirrors parse_now_override. */
export function parseNowOverride(s: string): number | null {
  const parts = s.split("T");
  if (parts.length !== 2) return null;
  const [date, time] = parts as [string, string];
  const d = date.split("-");
  if (d.length !== 3) return null;
  const y = parseInt(d[0]!, 10);
  const mo = parseInt(d[1]!, 10);
  const da = parseInt(d[2]!, 10);
  const t = time.split(":");
  if (t.length < 2) return null;
  const h = parseInt(t[0]!, 10);
  const mi = parseInt(t[1]!, 10);
  if ([y, mo, da, h, mi].some((n) => Number.isNaN(n))) return null;
  const localSecs = daysFromCivil(y, mo, da) * 86400 + h * 3600 + mi * 60;
  return localSecs - (5 * 3600 + 30 * 60);
}

function remEuclid(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? r + b : r;
}

function divEuclid(a: number, b: number): number {
  const q = Math.trunc(a / b);
  return a % b < 0 ? q - Math.sign(b) : q;
}

function civilFromUnix(unix: number): string {
  const days = divEuclid(unix, 86400);
  const secsOfDay = remEuclid(unix, 86400);
  const [y, m, d] = civilFromDays(days);
  const hh = Math.floor(secsOfDay / 3600);
  const mm = Math.floor(secsOfDay / 60) % 60;
  const ss = secsOfDay % 60;
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}Z`;
}

export function civilToday(unix: number): [number, number, number] {
  const days = divEuclid(unix + 330 * 60, 86400);
  return civilFromDays(days);
}

export function civilYesterday(y: number, m: number, d: number): [number, number, number] {
  const days = daysFromCivil(y, m, d) - 1;
  return civilFromDays(days);
}

// Howard Hinnant's civil-from-days / days-from-civil algorithm — same as
// solar-dash/src/mapping.rs's civil_from_days/days_from_civil.
export function civilFromDays(z: number): [number, number, number] {
  z += 719468;
  const era = (z >= 0 ? z : z - 146096) / 146097;
  const eraFloor = Math.floor(era);
  const doe = z - eraFloor * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + eraFloor * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const yy = m <= 2 ? y + 1 : y;
  return [yy, m, d];
}

export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

export interface CurveResult {
  points: CurvePoint[];
  produced_wh: number;
  peak_w: number;
  peak_at: string;
  home_wh: number | null;
  exported_wh: number | null;
  imported_wh: number | null;
}

export function curveFromHistory(series: HistoryRawSeries[], hasMeter: boolean): CurveResult {
  const find = (name: string) => series.find((s) => s.variable === name);
  const solar = find("pvPower");
  const home = find("loadsPower");
  const exportS = find("feedinPower");
  const importS = find("gridConsumptionPower");

  const len = solar?.data?.length ?? 0;
  const points: CurvePoint[] = [];
  let producedWh = 0;
  let exportedWh = 0;
  let importedWh = 0;
  let homeWh = 0;
  let peakW = 0;
  let peakAt = "";
  let prevSecs: number | null = null;

  for (let i = 0; i < len; i++) {
    const s = (solar?.data?.[i]?.value ?? 0) * KW_TO_W;
    const h = (home?.data?.[i]?.value ?? 0) * KW_TO_W;
    const e = (exportS?.data?.[i]?.value ?? 0) * KW_TO_W;
    const im = (importS?.data?.[i]?.value ?? 0) * KW_TO_W;
    const rawT = solar?.data?.[i]?.time ?? "";
    const secs = secondsOfDay(rawT);
    let intervalH: number;
    if (prevSecs !== null && secs !== null && secs > prevSecs) {
      intervalH = (secs - prevSecs) / 3600;
    } else {
      intervalH = 5 / 60;
    }
    if (secs !== null) prevSecs = secs;
    const t = hhMm(rawT);
    if (s > peakW) {
      peakW = s;
      peakAt = t;
    }
    points.push(makeCurvePoint(t, s, hasMeter, h, e, im));
    producedWh += s * intervalH;
    exportedWh += e * intervalH;
    importedWh += im * intervalH;
    homeWh += h * intervalH;
  }

  return {
    points,
    produced_wh: producedWh,
    peak_w: peakW,
    peak_at: peakAt,
    home_wh: hasMeter ? homeWh : null,
    exported_wh: hasMeter ? exportedWh : null,
    imported_wh: hasMeter ? importedWh : null,
  };
}

// The curve integrates pvPower, which is DC power on the panel side.
// WAAREE's own energy counters are AC energy the inverter delivered, a few
// percent less after conversion losses. The counters are what the calendar
// shows and what the meter credits, so day totals use them; the curve is
// the day's shape.

/** WAAREE's counter for today so far, from the flow endpoint ("9.900" kWh). */
export function yieldTodayWh(f: PlantFlowInfoResult): number | null {
  const v = parseFloat(f.status?.yieldToday ?? "");
  return Number.isFinite(v) && v >= 0 ? v * KW_TO_W : null;
}

/** One day's counter total from a month report, if it has that day. */
export function reportDayWh(series: HistoryReportSeries[], day: number): number | null {
  const p = series.find((s) => s.variable === "generation")?.data?.find((x) => x.index === day);
  return p ? p.value * KW_TO_W : null;
}

export function energyUpTo(points: CurvePoint[], cutoffHhmm: string): number {
  let prevSecs: number | null = null;
  let total = 0;
  for (const p of points) {
    const secs = hhMmToSecs(p.t);
    let intervalH: number;
    if (prevSecs !== null && secs !== null && secs > prevSecs) {
      intervalH = (secs - prevSecs) / 3600;
    } else {
      intervalH = 5 / 60;
    }
    if (secs !== null) prevSecs = secs;
    if (p.t > cutoffHhmm) break;
    total += p.solar_w * intervalH;
  }
  return total;
}

function hhMmToSecs(hhmm: string): number | null {
  const parts = hhmm.split(":");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0]!, 10);
  const m = parseInt(parts[1]!, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 3600 + m * 60;
}

export function monthFromReport(
  series: HistoryReportSeries[],
  year: number,
  month: number,
  todayDay: number | null,
  installedBefore: (y: number, m: number, d: number) => boolean
): Month {
  const produced = series.find((s) => s.variable === "generation");
  const daysInMonth = produced?.data?.length ?? 0;
  const days: MonthDay[] = [];
  let totalWh = 0;
  let best: BestDay | null = null;

  for (let i = 0; i < daysInMonth; i++) {
    const day = produced?.data?.[i]?.index ?? i + 1;
    const notInstalled = installedBefore(year, month, day);
    const isFuture = todayDay !== null && day > todayDay;
    let producedWh: number | null;
    if (notInstalled || isFuture) {
      producedWh = null;
    } else {
      const p = (produced?.data?.[i]?.value ?? 0) * KW_TO_W;
      totalWh += p;
      if (best === null || p > best.produced_wh) {
        best = { day, produced_wh: p };
      }
      producedWh = p;
    }
    days.push({ day, produced_wh: producedWh, not_installed: notInstalled });
  }

  return { month, year, days, total_wh: totalWh, best_day: best };
}

export function yearFromReport(
  series: HistoryReportSeries[],
  year: number,
  currentMonth: number | null,
  installedBefore: (y: number, m: number) => boolean
): Year {
  const produced = series.find((s) => s.variable === "generation");
  const n = produced?.data?.length ?? 0;
  const months: YearMonth[] = [];

  for (let i = 0; i < n; i++) {
    const month = produced?.data?.[i]?.index ?? i + 1;
    const notInstalled = installedBefore(year, month);
    const isFuture = currentMonth !== null && month > currentMonth;
    const producedWh = notInstalled || isFuture ? null : (produced?.data?.[i]?.value ?? 0) * KW_TO_W;
    months.push({ month, produced_wh: producedWh, not_installed: notInstalled });
  }

  return { year, months, since_install_wh: 0 };
}

/** Parses "HH:MM:SS" out of "2026-09-25 13:40:53 IST+0530" into seconds-since-midnight. */
function secondsOfDay(raw: string): number | null {
  const parts = raw.split(/\s+/);
  const timePart = parts[1];
  if (!timePart) return null;
  const t = timePart.split(":");
  if (t.length < 3) return null;
  const h = parseInt(t[0]!, 10);
  const m = parseInt(t[1]!, 10);
  const s = parseInt(t[2]!, 10);
  if ([h, m, s].some((n) => Number.isNaN(n))) return null;
  return h * 3600 + m * 60 + s;
}

/** "HH:MM" for the chart x-axis, from the same timestamp shape. */
function hhMm(raw: string): string {
  const parts = raw.split(/\s+/);
  const t = parts[1];
  if (t && t.length >= 5) return t.slice(0, 5);
  return raw;
}

/** Parses the "YYYY-MM-DD" prefix out of PlantDetails.createdDate. */
export function parseInstallDate(raw: string): [number, number, number] | null {
  const datePart = raw.split(/\s+/)[0];
  if (!datePart) return null;
  const parts = datePart.split("-");
  if (parts.length !== 3) return null;
  const y = parseInt(parts[0]!, 10);
  const m = parseInt(parts[1]!, 10);
  const d = parseInt(parts[2]!, 10);
  if ([y, m, d].some((n) => Number.isNaN(n))) return null;
  return [y, m, d];
}

export function devicesFromList(list: DeviceListResult): Device[] {
  return (list.devices ?? []).map((d) => ({
    sn: d.deviceSN ?? "",
    device_type: d.deviceType ?? "",
    status: d.status ?? 0,
    power_w: (d.power ?? 0) * KW_TO_W,
  }));
}

export function lifetimeFromDevices(list: DeviceListResult): number {
  return (list.devices ?? []).reduce((sum, d) => sum + (d.generationTotal ?? 0) * KW_TO_W, 0);
}

export function alarmsFromList(list: AlarmListResult): Alarm[] {
  return (list.data ?? []).map((a) => ({
    time: a.time ?? "",
    content: a.content ?? "",
    code: a.code ?? 0,
    device_sn: a.deviceSN ?? "",
    alarm_type: a.alarmType ?? 0,
  }));
}

/** Lexicographic (year, month) comparison: true if (yy, mm) < (iy, im). */
export function ymBefore(yy: number, mm: number, iy: number, im: number): boolean {
  if (yy !== iy) return yy < iy;
  return mm < im;
}

export function normalizeCurrency(raw: string): string {
  const idx = raw.indexOf("(");
  return (idx >= 0 ? raw.slice(0, idx) : raw).trim();
}
