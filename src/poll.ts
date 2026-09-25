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

import { Client, ClientError } from "./client";
import type { Env } from "./env";
import { isMock } from "./env";
import * as mapping from "./mapping";
import { mockPoll, type MockScenario } from "./mock";
import {
  defaultMonth,
  defaultYear,
  unconfiguredState,
  type State,
} from "./model";
import * as sun from "./sun";

const HISTORY_INTERVAL_SECONDS = 15 * 60; // "history... only if older than 15 min"
const YESTERDAY_INTERVAL_SECONDS = 60 * 60; // refreshed hourly
const STALE_AFTER_SECONDS = 5 * 60;
const POLLING_LOCK_SECONDS = 60; // stampede guard TTL (KV's expirationTtl minimum is 60s)

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
  return isMock(env) || Boolean(env.WAAREE_USERNAME && env.WAAREE_PASSWORD_MD5);
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
    const newState = isMock(env)
      ? mockPoll(
          (env.MOCK_SCENARIO as MockScenario) || "design",
          doHistory,
          doYesterday,
          prevHomeW,
          resolveMockNow(env, nowOverrideParam)
        )
      : await livePoll(env, doHistory, doYesterday, prevHomeW);

    const merged = mergeUpdate(prevState, newState, doHistory, doYesterday);
    recomputeStaleness(merged);
    await putState(env, merged);

    if (doHistory) await env.SOLAR_KV.put("history_at", String(now));
    if (doYesterday) await env.SOLAR_KV.put("yesterday_at", String(now));
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
    },
    live,
    sun: { sunrise, sunset },
    today: {
      series: curve.points,
      produced_wh: curve.produced_wh,
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
  };

  if (state.plant.price_per_kwh !== null) {
    state.today.earned = (state.today.produced_wh / 1000) * state.plant.price_per_kwh;
  }

  if (doYesterday) {
    try {
      const [yy, ym, yd] = mapping.civilYesterday(y, m, d);
      const rawYesterday = await client.historyRawDay(stationId, vars, yy, ym, yd);
      const ycurve = mapping.curveFromHistory(rawYesterday, hasMeter);
      state.today.vs_yesterday_wh =
        state.today.produced_wh - mapping.energyUpTo(ycurve.points, mapping.localHHMM(now));
      state.yesterday = { series: ycurve.points, produced_wh: ycurve.produced_wh };
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
