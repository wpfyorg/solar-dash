// On-demand history for the calendar: any past day's production curve
// (GET /api/day?date=YYYY-MM-DD) and any month's daily totals
// (GET /api/month?ym=YYYY-MM). Both reuse the cron poller's stored WAAREE
// token (and save it back if a re-login happened) so they never fight the
// poller for the session. Finished days/months never change, so they are
// cached in KV; the current day/month is served from the polled `state`.
//
// KV keys:
//   station_id      - WAAREE stationID, written by poll.ts when it changes
//   day:YYYY-MM-DD  - cached DayDetail for a finished day
//   month:YYYY-MM   - cached Month for a finished month

import { Client, ClientError } from "./client";
import type { Env } from "./env";
import { isMock } from "./env";
import * as mapping from "./mapping";
import type { CurvePoint, Month, State } from "./model";
import * as sun from "./sun";

const DAY_CACHE_TTL = 400 * 86400;
const MONTH_CACHE_TTL = 400 * 86400;

export interface DayDetail {
  date: string;
  series: CurvePoint[];
  produced_wh: number;
  peak_w: number;
  peak_at: string;
  sunrise: string;
  sunset: string;
}

export class BadRequest extends Error {}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function todayIst(): [number, number, number] {
  return mapping.civilToday(Math.floor(Date.now() / 1000));
}

async function getState(env: Env): Promise<State | null> {
  const raw = await env.SOLAR_KV.get("state");
  return raw ? (JSON.parse(raw) as State) : null;
}

function installDate(state: State | null): [number, number, number] | null {
  const s = state?.plant.install_date;
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return y && m && d ? [y, m, d] : null;
}

/** Runs `fn` with a Client holding the poller's token; persists the token
 * afterwards only if a re-login changed it. */
async function withClient<T>(env: Env, fn: (c: Client, stationId: string) => Promise<T>): Promise<T> {
  if (!env.WAAREE_USERNAME || !env.WAAREE_PASSWORD_MD5) {
    throw ClientError.api(-1, "not configured");
  }
  const stored = await env.SOLAR_KV.get("token");
  const client = new Client(env.WAAREE_USERNAME, env.WAAREE_PASSWORD_MD5, stored);
  if (!client.hasToken()) await client.login();
  try {
    let stationId = await env.SOLAR_KV.get("station_id");
    if (!stationId) {
      const list = await client.plantList();
      stationId = list.plants?.[0]?.stationID ?? null;
      if (!stationId) throw ClientError.api(-1, "no plant found on this account");
      await env.SOLAR_KV.put("station_id", stationId);
    }
    return await fn(client, stationId);
  } finally {
    const t = client.getToken();
    if (t && t !== stored) await env.SOLAR_KV.put("token", t);
  }
}

function parseDate(s: string | null): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) throw new BadRequest("date must be YYYY-MM-DD");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const back = mapping.civilFromDays(mapping.daysFromCivil(y, mo, d));
  if (back[0] !== y || back[1] !== mo || back[2] !== d) throw new BadRequest("invalid date");
  return [y, mo, d];
}

function parseYm(s: string | null): [number, number] {
  const m = /^(\d{4})-(\d{2})$/.exec(s ?? "");
  if (!m) throw new BadRequest("ym must be YYYY-MM");
  const [y, mo] = [Number(m[1]), Number(m[2])];
  if (mo < 1 || mo > 12) throw new BadRequest("invalid month");
  return [y, mo];
}

export async function dayDetail(env: Env, dateParam: string | null): Promise<DayDetail> {
  const [y, m, d] = parseDate(dateParam);
  const date = `${y}-${pad(m)}-${pad(d)}`;
  const [ty, tm, td] = todayIst();
  const dayNum = mapping.daysFromCivil(y, m, d);
  const todayNum = mapping.daysFromCivil(ty, tm, td);
  if (dayNum > todayNum) throw new BadRequest("date is in the future");

  const lat = parseFloat(env.LAT) || sun.DEFAULT_LAT;
  const lon = parseFloat(env.LON) || sun.DEFAULT_LON;
  const { sunrise, sunset } = sun.sunTimes(lat, lon, y, m, d);
  const state = await getState(env);

  const inst = installDate(state);
  if (inst && dayNum < mapping.daysFromCivil(...inst)) {
    return { date, series: [], produced_wh: 0, peak_w: 0, peak_at: "", sunrise, sunset };
  }

  // Today and yesterday are already in the polled state.
  if (state && dayNum === todayNum && state.today.series.length) {
    const t = state.today;
    return { date, series: t.series, produced_wh: t.produced_wh, peak_w: t.peak_w, peak_at: t.peak_at, sunrise, sunset };
  }
  if (state && dayNum === todayNum - 1 && state.yesterday.series.length) {
    const c = peakOf(state.yesterday.series);
    return { date, series: state.yesterday.series, produced_wh: state.yesterday.produced_wh, ...c, sunrise, sunset };
  }

  const key = `day:${date}`;
  const cached = await env.SOLAR_KV.get(key);
  if (cached) return JSON.parse(cached) as DayDetail;

  if (isMock(env)) {
    const series = state?.yesterday.series ?? [];
    return { date, series, produced_wh: state?.yesterday.produced_wh ?? 0, ...peakOf(series), sunrise, sunset };
  }

  const raw = await withClient(env, (c, sid) => c.historyRawDay(sid, ["pvPower"], y, m, d));
  const curve = mapping.curveFromHistory(raw, false);
  const detail: DayDetail = {
    date,
    series: curve.points,
    produced_wh: curve.produced_wh,
    peak_w: curve.peak_w,
    peak_at: curve.peak_at,
    sunrise,
    sunset,
  };
  if (dayNum < todayNum) {
    await env.SOLAR_KV.put(key, JSON.stringify(detail), { expirationTtl: DAY_CACHE_TTL });
  }
  return detail;
}

function peakOf(series: CurvePoint[]): { peak_w: number; peak_at: string } {
  let peak_w = 0;
  let peak_at = "";
  for (const p of series) {
    if (p.solar_w > peak_w) {
      peak_w = p.solar_w;
      peak_at = p.t;
    }
  }
  return { peak_w, peak_at };
}

export async function monthDetail(env: Env, ymParam: string | null): Promise<Month> {
  const [y, m] = parseYm(ymParam);
  const [ty, tm, td] = todayIst();
  if (y * 12 + m > ty * 12 + tm) throw new BadRequest("month is in the future");

  const state = await getState(env);
  const isCurrent = y === ty && m === tm;
  if (isCurrent && state && state.month.days.length) return state.month;

  const inst = installDate(state);
  const beforeInstall = (yy: number, mm: number, dd: number) =>
    inst ? mapping.daysFromCivil(yy, mm, dd) < mapping.daysFromCivil(...inst) : false;

  const key = `month:${y}-${pad(m)}`;
  if (!isCurrent) {
    const cached = await env.SOLAR_KV.get(key);
    if (cached) return JSON.parse(cached) as Month;
  }

  if (isMock(env)) {
    return { ...(state?.month ?? { days: [], total_wh: 0, best_day: null }), month: m, year: y } as Month;
  }

  const report = await withClient(env, (c, sid) => c.historyReport(sid, "month", ["generation"], y, m));
  const month = mapping.monthFromReport(report, y, m, isCurrent ? td : null, beforeInstall);
  // A month is only final once it's over and its data has arrived.
  if (!isCurrent && month.days.length) {
    await env.SOLAR_KV.put(key, JSON.stringify(month), { expirationTtl: MONTH_CACHE_TTL });
  }
  return month;
}
