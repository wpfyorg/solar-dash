// Background poll orchestration. TS port of solar-dash/src/poll.rs's
// `live_poll` + `apply_update`/`apply_error`/`recompute_staleness`, adapted
// to a Worker: state lives in KV (binding SOLAR_KV) instead of an in-memory
// RwLock, and a poll round runs to completion on the cron trigger or via
// `ctx.waitUntil` from a stale GET /api/state, rather than looping forever
// on a background thread.
//
// KV keys:
//   state           - JSON of the last-known model.State
//   token           - WAAREE session token (live mode only)
//   station_id      - WAAREE stationID (read by history.ts)
//   history_at      - unix-seconds of the last successful history/devices/alarms refresh
//   yesterday_at    - unix-seconds of the last successful yesterday-curve refresh
//   polling_until   - stampede guard for on-demand refresh (unix-seconds)
//   forecast_at     - unix-seconds of the last successful Open-Meteo fetch

import { Client, ClientError } from "./client";
import type { Env } from "./env";
import { isMock, plantOverrides } from "./env";
import { findOutages, updateEvents } from "./events";
import { buildForecast, fetchOpenMeteo, mockWeather, panelSetup } from "./forecast";
import * as mapping from "./mapping";
import { mockPoll, type MockScenario } from "./mock";
import {
  defaultMonth,
  defaultYear,
  unconfiguredState,
  type Forecast,
  type LogEvent,
  type Plant,
  type State,
} from "./model";
import * as sun from "./sun";
import { overlayStick, stickEnabled } from "./stick";

const HISTORY_INTERVAL_SECONDS = 15 * 60; // "history... only if older than 15 min"
const YESTERDAY_INTERVAL_SECONDS = 60 * 60; // refreshed hourly
// Cron runs every 5 min, so a single late run is normal; two missed runs is not.
const STALE_AFTER_SECONDS = 11 * 60;
const POLLING_LOCK_SECONDS = 60; // stampede guard TTL (KV's expirationTtl minimum is 60s)
const FORECAST_INTERVAL_SECONDS = 60 * 60; // Open-Meteo updates hourly

async function getState(env: Env): Promise<State | null> {
  const raw = await env.SOLAR_KV.get("state");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as State;
  } catch {
    return null;
  }
}

async function putState(env: Env, state: State): Promise<void> {
  await env.SOLAR_KV.put("state", JSON.stringify(state));
}

async function getTimestamp(env: Env, key: string): Promise<number> {
  const raw = await env.SOLAR_KV.get(key);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isConfigured(env: Env): boolean {
  return isMock(env) || Boolean(env.WAAREE_USERNAME && env.WAAREE_PASSWORD_MD5) || stickEnabled(env);
}

/** Guards against concurrent polls (e.g. several stale GET /api/state hits
 * racing an in-flight cron poll): returns true and claims the lock if the
 * caller should proceed. */
export async function claimPollLock(env: Env): Promise<boolean> {
  const until = await getTimestamp(env, "polling_until");
  const now = nowSeconds();
  if (until > now) return false;
  await env.SOLAR_KV.put("polling_until", String(now + POLLING_LOCK_SECONDS), {
    expirationTtl: POLLING_LOCK_SECONDS,
  });
  return true;
}

export async function runPoll(env: Env, nowOverrideParam?: number | null): Promise<void> {
  if (!isConfigured(env)) {
    await putState(env, unconfiguredState(mapping.nowIso()));
    return;
  }

  const historyAt = await getTimestamp(env, "history_at");
  const yesterdayAt = await getTimestamp(env, "yesterday_at");
  const now = nowSeconds();
  const doHistory = now - historyAt >= HISTORY_INTERVAL_SECONDS;
  const doYesterday = now - yesterdayAt >= YESTERDAY_INTERVAL_SECONDS;

  const prevState = await getState(env);
  const prevHomeW =
    prevState?.today.series[prevState.today.series.length - 1]?.home_w ??
    prevState?.live.home_w ??
    0;

  try {
    let newState: State | null = null;
    let failure: unknown = null;
    if (isMock(env)) {
      newState = mockPoll(
        (env.MOCK_SCENARIO as MockScenario) || "design",
        doHistory,
        doYesterday,
        prevHomeW,
        resolveMockNow(env, nowOverrideParam)
      );
    } else if (env.WAAREE_USERNAME && env.WAAREE_PASSWORD_MD5) {
      try {
        newState = await livePoll(env, doHistory, doYesterday, prevHomeW);
      } catch (e) {
        failure = e;
      }
    }
    if (!newState) {
      // WAAREE unreachable (or not configured): carry the last state forward
      // so the stick's records can still update it.
      const base = prevState ?? unconfiguredState(mapping.nowIso());
      newState = { ...base, server_now: mapping.nowIso() };
      if (!newState.sun.sunrise) {
        const [y, m, d] = mapping.civilToday(now);
        newState.sun = sun.sunTimes(parseFloat(env.LAT) || sun.DEFAULT_LAT, parseFloat(env.LON) || sun.DEFAULT_LON, y, m, d);
      }
    }

    const merged = mergeUpdate(prevState, newState, doHistory, doYesterday);
    applyPlantOverrides(merged.plant, env);
    const fromStick = await overlayStick(env, merged, now);
    if (failure && !fromStick) {
      await applyError(env, failure);
      return;
    }
    merged.forecast = await refreshForecast(env, merged, prevState?.forecast ?? null, prevState?.events ?? [], now);
    merged.events = logEvents(merged, prevState?.events ?? []);
    recomputeStaleness(merged);
    await putState(env, merged);

    if (doHistory && !failure) await env.SOLAR_KV.put("history_at", String(now));
    if (doYesterday && !failure) await env.SOLAR_KV.put("yesterday_at", String(now));
  } catch (e) {
    await applyError(env, e);
  }
}

function resolveMockNow(env: Env, override?: number | null): number | null {
  if (override !== undefined && override !== null) return override;
  if (env.MOCK_NOW) {
    const parsed = mapping.parseNowOverride(env.MOCK_NOW);
    if (parsed !== null) return parsed;
  }
  return null;
}

async function applyError(env: Env, e: unknown): Promise<void> {
  // Messages carry only the endpoint path and WAAREE's errno/msg, never
  // credentials or the token.
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error("poll failed:", msg);
  await env.SOLAR_KV.put("last_error", JSON.stringify({ at: mapping.nowIso(), msg }));
  const state = await getState(env);
  const base: State = state ?? unconfiguredState(mapping.nowIso());
  const isAuth = e instanceof ClientError && e.kind === "auth_expired";
  base.status = isAuth ? "auth_failed" : "api_error";
  await putState(env, base);
}

/** Mirrors apply_update: a realtime-only round (do_history/do_yesterday both
 * false) must not blow away the previously fetched history/yesterday/month/
 * year/devices — only live/sun/has_meter/plant/status always win. */
function mergeUpdate(prev: State | null, next: State, doHistory: boolean, doYesterday: boolean): State {
  if (!prev) return next;
  const merged: State = { ...next };
  if (!doHistory) {
    if (next.today.series.length === 0 && prev.today.series.length > 0) {
      merged.today = prev.today;
      merged.today.vs_yesterday_wh = next.today.vs_yesterday_wh ?? prev.today.vs_yesterday_wh;
    }
    if (next.month.days.length === 0 && prev.month.days.length > 0) merged.month = prev.month;
    if (next.year.months.length === 0 && prev.year.months.length > 0) merged.year = prev.year;
    if (next.devices.length === 0 && prev.devices.length > 0) merged.devices = prev.devices;
    if (next.alarms.length === 0 && prev.alarms.length > 0) merged.alarms = prev.alarms;
  }
  if (!doYesterday && next.yesterday.series.length === 0 && prev.yesterday.series.length > 0) {
    merged.yesterday = prev.yesterday;
    merged.today.vs_yesterday_wh = merged.today.vs_yesterday_wh ?? prev.today.vs_yesterday_wh;
  }
  return merged;
}

/** WAAREE only stores a rounded plant size (e.g. "4 kWp", "3.5 kW"); the
 * PANEL_COUNT/PANEL_W/INVERTER_KW vars give the real figures. */
function applyPlantOverrides(plant: Plant, env: Env): void {
  const o = plantOverrides(env);
  if (o.panelCount && o.panelW) {
    plant.panel_count = o.panelCount;
    plant.panel_w = o.panelW;
    plant.panel_kwp = (o.panelCount * o.panelW) / 1000;
  }
  if (o.inverterW) plant.capacity_w = o.inverterW;
}

/** Keeps the stored forecast for up to an hour (same day only), then
 * refetches. A failed fetch keeps the previous forecast if it's still for
 * today — a forecast an hour or two old beats none. */
async function refreshForecast(
  env: Env,
  state: State,
  prev: Forecast | null,
  events: LogEvent[],
  now: number
): Promise<Forecast | null> {
  if (env.FORECAST === "0") return null;
  const serverNow = parseRfc3339(state.server_now) ?? now;
  const [y, m, d] = mapping.civilToday(serverNow);
  const todayIso = fmtDate([y, m, d]);
  const tomorrowIso = fmtDate(mapping.civilFromDays(mapping.daysFromCivil(y, m, d) + 1));
  const prevToday = prev && prev.today.date === todayIso ? prev : null;
  const forecastAt = await getTimestamp(env, "forecast_at");
  if (prevToday && now - forecastAt < FORECAST_INTERVAL_SECONDS) return prevToday;

  const setup = panelSetup(env, state.plant);
  if (!setup) return null;

  // What the plant actually made on recent days, to calibrate against.
  const actual: Record<string, number> = {};
  for (const day of state.month.days) {
    if (day.produced_wh != null) actual[fmtDate([state.month.year, state.month.month, day.day])] = day.produced_wh;
  }
  const [yy, ym, yd] = mapping.civilYesterday(y, m, d);
  if (state.yesterday.produced_wh > 0) actual[fmtDate([yy, ym, yd])] = state.yesterday.produced_wh;
  // A day with a power cut says nothing about how well the panels work.
  for (const e of events) if (e.kind !== "alarm") delete actual[e.date];

  try {
    let weather;
    if (isMock(env)) {
      const dates: string[] = [];
      for (let k = -7; k <= 1; k++) dates.push(fmtDate(mapping.civilFromDays(mapping.daysFromCivil(y, m, d) + k)));
      weather = mockWeather(setup, dates);
    } else {
      weather = await fetchOpenMeteo(setup);
    }
    const f = buildForecast(
      setup,
      weather,
      todayIso,
      tomorrowIso,
      actual,
      prev?.pr ?? null,
      isMock(env) ? "mock" : "open-meteo",
      mapping.nowIso()
    );
    await env.SOLAR_KV.put("forecast_at", String(now));
    return f;
  } catch (e) {
    console.error("forecast failed:", e instanceof Error ? e.message : String(e));
    return prevToday;
  }
}

/** Adds today's outages and alarms to the kept log. */
function logEvents(state: State, prev: LogEvent[]): LogEvent[] {
  const serverNow = parseRfc3339(state.server_now) ?? nowSeconds();
  const todayIso = fmtDate(mapping.civilToday(serverNow));
  const fc = state.forecast && state.forecast.today.date === todayIso ? state.forecast.today.series : null;
  const [h, mi] = mapping.localHHMM(serverNow).split(":").map(Number);
  const outages = findOutages({
    series: state.today.series,
    forecast: fc,
    sunrise: state.sun.sunrise,
    sunset: state.sun.sunset,
    nowMin: h! * 60 + mi!,
    capacityW: state.plant.capacity_w,
  });
  return updateEvents(prev, todayIso, outages, state.alarms);
}

function recomputeStaleness(state: State): void {
  if (state.status !== "ok") return;
  const updated = parseRfc3339(state.live.updated_at);
  if (updated === null) return;
  if (nowSeconds() - updated > STALE_AFTER_SECONDS) {
    state.status = "stale";
  }
}

function parseRfc3339(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number) as unknown as number[];
  return mapping.daysFromCivil(y!, mo!, d!) * 86400 + h! * 3600 + mi! * 60 + se!;
}

// --- Live polling ------------------------------------------------------------

async function livePoll(env: Env, doHistory: boolean, doYesterday: boolean, prevHomeW: number): Promise<State> {
  const lat = parseFloat(env.LAT) || sun.DEFAULT_LAT;
  const lon = parseFloat(env.LON) || sun.DEFAULT_LON;

  const storedToken = await env.SOLAR_KV.get("token");
  const client = new Client(env.WAAREE_USERNAME!, env.WAAREE_PASSWORD_MD5!, storedToken);

  if (!client.hasToken()) {
    await client.login();
  }

  const plantList = await client.plantList();
  const plantBean = plantList.plants?.[0];
  const stationId = plantBean?.stationID;
  if (!stationId) {
    throw ClientError.api(-1, "no plant found on this account");
  }
  // history.ts reads this for on-demand day/month lookups.
  if ((await env.SOLAR_KV.get("station_id")) !== stationId) {
    await env.SOLAR_KV.put("station_id", stationId);
  }

  let plantGet;
  try {
    plantGet = await client.plantGet(stationId);
  } catch {
    plantGet = null; // non-essential
  }

  const now = Math.floor(Date.now() / 1000);
  const [y, m, d] = mapping.civilToday(now);
  const { sunrise, sunset } = sun.sunTimes(lat, lon, y, m, d);

  const vars = ["pvPower", "loadsPower", "feedinPower", "gridConsumptionPower"];
  const rawToday = await client.historyRawDay(stationId, vars, y, m, d);

  const monthVars = ["generation", "feedin", "loads", "gridConsumption"];
  const monthReport = await client.historyReport(stationId, "month", monthVars, y, m);
  const hasMeter = mapping.detectHasMeter(monthReport, d);

  const flow = await client.flowInfo(stationId);
  const live = mapping.mapFlowInfo(flow, hasMeter, prevHomeW);
  const curve = mapping.curveFromHistory(rawToday, hasMeter);

  const installDate = plantGet?.details?.createdDate
    ? mapping.parseInstallDate(plantGet.details.createdDate)
    : null;

  const state: State = {
    status: "ok",
    server_now: mapping.nowIso(),
    has_meter: hasMeter,
    plant: {
      name: plantBean?.name ?? "",
      capacity_w:
        (plantGet?.details?.systemCapacity ?? 0) > 0
          ? plantGet!.details!.systemCapacity! * 1000
          : (plantBean?.capacity ?? 0) > 0
            ? plantBean!.capacity! * 1000
            : 3500,
      price_per_kwh: (plantGet?.details?.price ?? 0) > 0 ? plantGet!.details!.price! : null,
      panel_kwp: (plantBean?.capacity ?? 0) > 0 ? plantBean!.capacity! : null,
      install_date: installDate ? fmtDate(installDate) : null,
      panel_count: null,
      panel_w: null,
    },
    live,
    sun: { sunrise, sunset },
    today: {
      series: curve.points,
      produced_wh: mapping.yieldTodayWh(flow) ?? mapping.reportDayWh(monthReport, d) ?? curve.produced_wh,
      earned: null,
      peak_w: curve.peak_w,
      peak_at: curve.peak_at,
      vs_yesterday_wh: null,
      home_wh: curve.home_wh,
      exported_wh: curve.exported_wh,
      imported_wh: curve.imported_wh,
    },
    yesterday: { series: [], produced_wh: 0 },
    month: defaultMonth(),
    year: defaultYear(),
    devices: [],
    alarms: [],
    forecast: null,
    events: [],
  };

  if (state.plant.price_per_kwh !== null) {
    state.today.earned = (state.today.produced_wh / 1000) * state.plant.price_per_kwh;
  }

  if (doYesterday) {
    try {
      const [yy, ym, yd] = mapping.civilYesterday(y, m, d);
      const rawYesterday = await client.historyRawDay(stationId, vars, yy, ym, yd);
      const ycurve = mapping.curveFromHistory(rawYesterday, hasMeter);
      // Yesterday's counter total. On the 1st it lives in the previous
      // month's report; scale the curve to match so "by now" compares AC to AC.
      let yCounter = d > 1 ? mapping.reportDayWh(monthReport, d - 1) : null;
      if (d === 1) {
        try {
          const prevMonthReport = await client.historyReport(stationId, "month", ["generation"], yy, ym);
          yCounter = mapping.reportDayWh(prevMonthReport, yd);
        } catch {
          // Fall back to comparing both raw DC curves below.
        }
      }
      const cutoff = mapping.localHHMM(now);
      const yesterdayByNow = mapping.energyUpTo(ycurve.points, cutoff);
      const scale = yCounter !== null && ycurve.produced_wh > 0 ? yCounter / ycurve.produced_wh : 1;
      const todayComparable = yCounter !== null ? state.today.produced_wh : mapping.energyUpTo(curve.points, cutoff);
      state.today.vs_yesterday_wh = todayComparable - yesterdayByNow * scale;
      state.yesterday = { series: ycurve.points, produced_wh: yCounter ?? ycurve.produced_wh };
    } catch {
      // non-essential
    }
  }

  if (doHistory) {
    const yearVars = ["generation", "feedin"];
    const yearReport = await client.historyReport(stationId, "year", yearVars, y, m);
    state.month = mapping.monthFromReport(monthReport, y, m, d, (yy, mm, _dd) =>
      installDate ? mapping.ymBefore(yy, mm, installDate[0], installDate[1]) : false
    );
    state.year = mapping.yearFromReport(yearReport, y, m, (yy, mm) =>
      installDate ? mapping.ymBefore(yy, mm, installDate[0], installDate[1]) : false
    );

    try {
      const devices = await client.deviceList(stationId);
      state.devices = mapping.devicesFromList(devices);
      state.year.since_install_wh = mapping.lifetimeFromDevices(devices);
    } catch {
      // non-essential
    }

    try {
      const alarms = await client.alarmsToday(stationId);
      state.alarms = mapping.alarmsFromList(alarms);
    } catch {
      // non-essential
    }
  }

  // Persist the token for the next invocation, only if a (re-)login changed
  // it — KV's free tier allows 1,000 writes a day.
  const finalToken = client.getToken();
  if (finalToken && finalToken !== storedToken) await env.SOLAR_KV.put("token", finalToken);

  return state;
}

function fmtDate([y, m, d]: [number, number, number]): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
