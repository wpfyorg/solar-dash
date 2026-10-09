// Data from the stick gateway (gateway/ in this repo): the inverter's own
// 5-minute records, pushed to POST /api/ingest by a daemon on the LAN. The
// primary source while fresh; WAAREE's cloud is the backup. The stick has no energy meter, so
// only solar figures are filled in.
//
// KV keys:
//   stick_link        - the gateway's WAAREE link {mode, since}; written only
//                       when the mode changes
//   stick:YYYY-MM-DD  - that plant-local day's records, sorted by time. One
//                       write per ingest per day touched; ingest never
//                       writes `state` (poll.ts folds this in on its own
//                       write, which keeps the daily KV budget).

import type { Env } from "./env";
import * as mapping from "./mapping";
import { makeCurvePoint, type CurvePoint, type Month, type MonthDay, type State, type WaareeLink } from "./model";

export interface StickRecord {
  t: number; // real unix seconds (the gateway maps the stick's clock)
  ac_w: number;
  grid_v: number;
  hz: number;
  pv_v: number;
  pv_a: number;
  temp_a: number; // unverified against the inverter display
  life_wh: number; // lifetime generation counter, 100 Wh steps
  state: number; // 2 = generating; other codes unverified
}

const DEDUPE_S = 60;
const KEEP_TTL = 400 * 86400;
// Fresh enough to call "now": the gateway pushes every 5 min and the stick
// samples every 5 min, so allow a missed round.
export const STICK_FRESH_S = 16 * 60;
// Longest gap in samples still integrated as continuous output.
const MAX_GAP_S = 15 * 60;

export function stickEnabled(env: Env): boolean {
  return Boolean(env.INGEST_TOKEN);
}

export function tzMin(env: Env): number {
  const n = Number(env.TZ_OFFSET_MIN);
  return Number.isFinite(n) && n !== 0 ? n : 330;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Plant-local civil date "YYYY-MM-DD" of a real unix time. */
export function localDate(unix: number, tz: number): string {
  const [y, m, d] = mapping.civilFromDays(Math.floor((unix + tz * 60) / 86400));
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

export function localHHMM(unix: number, tz: number): string {
  const s = (((unix + tz * 60) % 86400) + 86400) % 86400;
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}`;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Validates one pushed record; null if it is not usable. */
export function parseRecord(x: unknown, nowSec: number): StickRecord | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const t = num(o.t);
  const ac_w = num(o.ac_w);
  if (t === null || ac_w === null) return null;
  // Not before 2020, not more than a day ahead; power within the physically possible.
  if (t < 1577836800 || t > nowSec + 86400 || ac_w < 0 || ac_w > 100000) return null;
  return {
    t: Math.round(t),
    ac_w: Math.round(ac_w),
    grid_v: num(o.grid_v) ?? 0,
    hz: num(o.hz) ?? 0,
    pv_v: num(o.pv_v) ?? 0,
    pv_a: num(o.pv_a) ?? 0,
    temp_a: num(o.temp_a) ?? 0,
    life_wh: num(o.life_wh) ?? 0,
    state: num(o.state) ?? 0,
  };
}

/** Merges `incoming` into `existing` (both sorted by t); a record within
 * DEDUPE_S of one already held is the same sample and the held one wins. */
export function mergeRecords(existing: StickRecord[], incoming: StickRecord[]): StickRecord[] {
  const out = [...existing];
  for (const r of [...incoming].sort((a, b) => a.t - b.t)) {
    let i = out.length;
    while (i > 0 && out[i - 1]!.t > r.t) i--;
    const before = out[i - 1];
    const after = out[i];
    if ((before && r.t - before.t <= DEDUPE_S) || (after && after.t - r.t <= DEDUPE_S)) continue;
    out.splice(i, 0, r);
  }
  return out;
}

export function groupByDay(recs: StickRecord[], tz: number): Map<string, StickRecord[]> {
  const m = new Map<string, StickRecord[]>();
  for (const r of recs) {
    const k = localDate(r.t, tz);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export function dayCurve(recs: StickRecord[], tz: number): CurvePoint[] {
  return recs.map((r) => makeCurvePoint(localHHMM(r.t, tz), r.ac_w, false, 0, 0, 0));
}

/** The day's generation. The stick's lifetime counter (the inverter's own
 * AC-side meter) differences to the day's energy to within 0.1 kWh; the
 * trapezoid over the samples backs it up when the counter is missing or
 * the day's first samples were lost. */
export function dayProducedWh(recs: StickRecord[]): number {
  if (recs.length === 0) return 0;
  let integ = 0;
  for (let i = 1; i < recs.length; i++) {
    const dt = recs[i]!.t - recs[i - 1]!.t;
    if (dt > 0 && dt <= MAX_GAP_S) integ += ((recs[i]!.ac_w + recs[i - 1]!.ac_w) / 2) * (dt / 3600);
  }
  const first = recs[0]!.life_wh;
  const last = recs[recs.length - 1]!.life_wh;
  const counter = first > 0 && last >= first ? last - first : 0;
  // They agree within a few percent on a good day; if the counter is far
  // under the integral (a reset, or lost first samples) use the integral.
  return counter > 0 && counter >= integ * 0.5 ? counter : integ;
}

function peakOf(points: CurvePoint[]): { peak_w: number; peak_at: string } {
  let peak_w = 0;
  let peak_at = "";
  for (const p of points) {
    if (p.solar_w > peak_w) {
      peak_w = p.solar_w;
      peak_at = p.t;
    }
  }
  return { peak_w, peak_at };
}

export async function loadDay(env: Env, date: string): Promise<StickRecord[]> {
  const raw = await env.SOLAR_KV.get(`stick:${date}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as StickRecord[];
  } catch {
    return [];
  }
}

/** Stores a pushed batch; returns the number of new records. */
export async function storeRecords(env: Env, incoming: StickRecord[]): Promise<number> {
  const tz = tzMin(env);
  let added = 0;
  for (const [date, recs] of groupByDay(incoming, tz)) {
    const have = await loadDay(env, date);
    const merged = mergeRecords(have, recs);
    if (merged.length === have.length) continue;
    added += merged.length - have.length;
    await env.SOLAR_KV.put(`stick:${date}`, JSON.stringify(merged), { expirationTtl: KEEP_TTL });
  }
  return added;
}

function parseIso(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(s);
  if (!m) return 0;
  const [, y, mo, d, h, mi, se] = m.map(Number) as unknown as number[];
  return mapping.daysFromCivil(y!, mo!, d!) * 86400 + h! * 3600 + mi! * 60 + se!;
}

/** Month with the given days' totals filled from the stick where `month`
 * has nothing; unfilled days keep their value. Returns true if it changed. */
export function fillMonthDays(month: Month, totals: Map<number, number>): boolean {
  let changed = false;
  for (const d of month.days) {
    const wh = totals.get(d.day);
    if (wh !== undefined && wh > 0 && !d.not_installed && !(d.produced_wh && d.produced_wh > 0)) {
      d.produced_wh = wh;
      changed = true;
    }
  }
  if (changed) {
    month.total_wh = month.days.reduce((a, d) => a + (d.produced_wh ?? 0), 0);
    let best: Month["best_day"] = null;
    for (const d of month.days) if (d.produced_wh != null && (!best || d.produced_wh > best.produced_wh)) best = { day: d.day, produced_wh: d.produced_wh };
    month.best_day = best;
  }
  return changed;
}

/** Day totals for a month, from whatever stick days are stored. */
export async function monthTotals(env: Env, y: number, m: number): Promise<Map<number, number>> {
  const n = mapping.daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - mapping.daysFromCivil(y, m, 1);
  const days = Array.from({ length: n }, (_, i) => i + 1);
  const lists = await Promise.all(days.map((d) => loadDay(env, `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`)));
  const out = new Map<number, number>();
  lists.forEach((l, i) => {
    if (l.length) out.set(days[i]!, dayProducedWh(l));
  });
  return out;
}

export function monthFromTotals(y: number, m: number, todayDay: number | null, totals: Map<number, number>): Month {
  const n = mapping.daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - mapping.daysFromCivil(y, m, 1);
  const days: MonthDay[] = [];
  for (let d = 1; d <= n; d++) {
    const future = todayDay !== null && d > todayDay;
    days.push({ day: d, produced_wh: future ? null : (totals.get(d) ?? 0), not_installed: false });
  }
  const month: Month = { month: m, year: y, days, total_wh: 0, best_day: null };
  month.total_wh = days.reduce((a, d) => a + (d.produced_wh ?? 0), 0);
  for (const d of days) if (d.produced_wh && (!month.best_day || d.produced_wh > month.best_day.produced_wh)) month.best_day = { day: d.day, produced_wh: d.produced_wh };
  return month;
}

/**
 * Folds the stick's records into a polled `state` when they are newer than
 * what it holds. Returns true if anything changed. `nowSec` is real time.
 */
export async function overlayStick(env: Env, state: State, nowSec: number): Promise<boolean> {
  if (!stickEnabled(env)) return false;
  const tz = tzMin(env);
  const todayD = localDate(nowSec, tz);
  const yesterdayD = localDate(nowSec - 86400, tz);
  const [today, yesterday] = await Promise.all([loadDay(env, todayD), loadDay(env, yesterdayD)]);
  const latest = today[today.length - 1] ?? yesterday[yesterday.length - 1];
  if (!latest) return false;
  // The stick is the primary source: while it is fresh it wins outright,
  // since WAAREE's cloud keeps gaps and lags even when it is up. WAAREE is the
  // backup once the stick goes quiet, but only while it reports real output:
  // its updated_at is our poll time, not its data time, so a poll that got
  // only zeros (cloud gone, or night) always looks newer.
  const fresh = nowSec - latest.t <= STICK_FRESH_S;
  if (!fresh && state.live.solar_w > 0 && latest.t <= parseIso(state.live.updated_at)) return false;

  const price = state.plant.price_per_kwh;
  state.has_meter = false;
  state.live = { solar_w: fresh ? latest.ac_w : 0, home_w: null, export_w: null, import_w: null, updated_at: mapping.isoFromUnix(latest.t) };
  if (fresh) state.status = "ok";

  const tPoints = dayCurve(today, tz);
  const yPoints = dayCurve(yesterday, tz);
  const producedToday = dayProducedWh(today);
  const producedYesterday = dayProducedWh(yesterday);
  state.today = {
    series: tPoints,
    produced_wh: producedToday,
    earned: price !== null ? (producedToday / 1000) * price : null,
    ...peakOf(tPoints),
    vs_yesterday_wh: null,
    home_wh: null,
    exported_wh: null,
    imported_wh: null,
  };
  if (yPoints.length) {
    state.yesterday = { series: yPoints, produced_wh: producedYesterday };
    const cutoff = localHHMM(nowSec, tz);
    state.today.vs_yesterday_wh = producedToday - mapping.energyUpTo(yPoints, cutoff);
  }

  // Keep the month calendar current: every stored stick day this month fills
  // a day the cloud left empty (up to 31 KV reads a poll, well inside the
  // read budget), and today's figure always comes from the stick.
  const [ty, tm, td] = mapping.civilFromDays(Math.floor((nowSec + tz * 60) / 86400));
  if (state.month.days.length && state.month.year === ty && state.month.month === tm) {
    const totals = await monthTotals(env, ty, tm);
    totals.set(td, producedToday);
    if (yesterdayD.slice(0, 7) === todayD.slice(0, 7) && producedYesterday > 0) totals.set(td - 1, producedYesterday);
    // Today's cloud figure is stale or missing; overwrite it, not just fill.
    const d0 = state.month.days.find((d) => d.day === td);
    if (d0) d0.produced_wh = null;
    fillMonthDays(state.month, totals);
  }
  return true;
}

const LINK_MODES = new Set(["relaying", "down", "off", "unknown"]);

/** Validates the `link` object a gateway push carries. */
export function parseLink(x: unknown): WaareeLink | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const since = num(o.since);
  if (typeof o.mode !== "string" || !LINK_MODES.has(o.mode) || since === null || since < 1577836800) return null;
  return { mode: o.mode as WaareeLink["mode"], since: mapping.isoFromUnix(since) };
}

export async function loadLink(env: Env): Promise<WaareeLink | null> {
  if (!stickEnabled(env)) return null;
  const raw = await env.SOLAR_KV.get("stick_link");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WaareeLink;
  } catch {
    return null;
  }
}

/** Stores the link only when its mode differs from the stored one. */
export async function storeLink(env: Env, link: WaareeLink): Promise<boolean> {
  const have = await loadLink(env);
  if (have && have.mode === link.mode) return false;
  await env.SOLAR_KV.put("stick_link", JSON.stringify(link));
  return true;
}
