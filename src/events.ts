// The system log: power cuts, inverter drop-outs and WAAREE alarms, kept
// for a few weeks in `state.events`.
//
// WAAREE doesn't report grid voltage, so cuts are inferred from today's
// power samples. A grid-tied inverter switches off when the mains goes down
// but its logger keeps reporting zeros ("power_cut"); if the logger itself
// loses power or Wi-Fi, samples stop arriving altogether ("no_data"). Either
// only counts in daylight, and only when the forecast expected real output,
// so a dark rainy hour isn't logged as a fault.
//
// Today's outage events are recomputed from scratch on every poll (the day's
// curve is re-fetched each time); earlier days' events are kept as they
// were last seen. The log rides along in the state blob, so it costs no
// extra KV writes.

import type { Alarm, CurvePoint, ForecastPoint, LogEvent } from "./model";

const DEAD_W = 30;
const MIN_SPAN_MIN = 15;
const GAP_MIN = 25; // samples normally arrive every 5 min
const EDGE_MIN = 60; // ignore the low-sun hour after sunrise and before sunset
export const KEEP_DAYS = 45;
export const KEEP_MAX = 100;

export interface OutageInput {
  series: CurvePoint[];
  forecast: ForecastPoint[] | null; // today's, if any
  sunrise: string; // "HH:MM"
  sunset: string;
  nowMin: number; // minutes past local midnight
  capacityW: number;
}

export interface Outage {
  kind: "power_cut" | "no_data";
  from: number;
  to: number;
  ongoing: boolean;
  lostWh: number | null;
}

function toMin(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function hhmm(min: number): string {
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Daylight spans today with no output (or no samples) while the forecast
 * expected some. */
export function findOutages(inp: OutageInput): Outage[] {
  const s = inp.series.map((p) => [toMin(p.t), p.solar_w] as const);
  const sunriseMin = toMin(inp.sunrise);
  const sunsetMin = toMin(inp.sunset);
  const lo = sunriseMin + EDGE_MIN;
  const hi = sunsetMin - EDGE_MIN;
  const isDay = inp.nowMin >= sunriseMin && inp.nowMin <= sunsetMin;
  const end = isDay ? inp.nowMin : sunsetMin;
  const floorW = Math.max(150, inp.capacityW * 0.05);
  const fc = inp.forecast?.map((p) => [toMin(p.t), p.expected_w] as const) ?? [];

  const spans: Outage[] = [];
  const add = (from: number, to: number, kind: Outage["kind"], ongoing: boolean) => {
    from = Math.max(from, lo);
    to = Math.min(to, hi);
    if (to - from < MIN_SPAN_MIN) return;
    const pts = fc.filter(([t]) => t >= from && t <= to);
    if (pts.length && pts.reduce((a, [, w]) => a + w, 0) / pts.length < floorW) return;
    spans.push({ kind, from, to, ongoing, lostWh: pts.length ? pts.reduce((a, [, w]) => a + w * 0.25, 0) : null });
  };

  let start: number | null = null;
  for (let i = 0; i < s.length; i++) {
    const [t, w] = s[i]!;
    const prevT = i > 0 ? s[i - 1]![0] : null;
    if (prevT !== null && t - prevT > GAP_MIN) {
      if (start !== null) {
        add(start, prevT, "power_cut", false);
        start = null;
      }
      add(prevT, t, "no_data", false);
    }
    if (w < DEAD_W) {
      if (start === null) start = t;
    } else if (start !== null) {
      add(start, t, "power_cut", false);
      start = null;
    }
  }
  if (start !== null) add(start, end, "power_cut", isDay);
  // Samples stopped arriving, though WAAREE itself answered this poll.
  const lastT = s.length ? s[s.length - 1]![0] : null;
  if (isDay && lastT !== null && end - lastT > GAP_MIN) add(lastT, end, "no_data", true);
  // Nothing at all from the inverter today (so far).
  if (lastT === null) add(sunriseMin, end, "no_data", isDay);

  // A zero run straight into a silence is one event, named after how it ends.
  spans.sort((a, b) => a.from - b.from);
  const out: Outage[] = [];
  for (const sp of spans) {
    const prev = out[out.length - 1];
    if (prev && sp.from <= prev.to + 5) {
      prev.to = Math.max(prev.to, sp.to);
      prev.ongoing = prev.ongoing || sp.ongoing;
      if (sp.ongoing) prev.kind = sp.kind;
      prev.lostWh = prev.lostWh !== null || sp.lostWh !== null ? (prev.lostWh ?? 0) + (sp.lostWh ?? 0) : null;
    } else {
      out.push({ ...sp });
    }
  }
  return out;
}

/** Merges today's outages and alarms into the kept log, newest first. */
export function updateEvents(
  prev: LogEvent[],
  todayIso: string,
  outages: Outage[],
  alarms: Alarm[]
): LogEvent[] {
  const byId = new Map<string, LogEvent>();
  for (const e of prev) {
    // Today's outages are rebuilt below; anything from an earlier day is
    // final, even if it was still open at that day's last poll.
    if (e.date === todayIso && e.kind !== "alarm") continue;
    byId.set(e.id, e.date < todayIso && e.ongoing ? { ...e, ongoing: false } : e);
  }
  for (const o of outages) {
    const id = `${todayIso}-out-${hhmm(o.from)}`;
    byId.set(id, {
      id,
      date: todayIso,
      kind: o.kind,
      from: hhmm(o.from),
      to: hhmm(o.to),
      ongoing: o.ongoing,
      lost_wh: o.lostWh === null ? null : Math.round(o.lostWh),
      detail: null,
    });
  }
  for (const a of alarms) {
    // WAAREE's times look like "2026-09-26 13:40:53 IST+0530".
    const m = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(a.time);
    const date = m?.[1] ?? todayIso;
    const from = m?.[2] ?? "00:00";
    const id = `${date}-alarm-${from}-${a.code}`;
    if (!byId.has(id)) {
      byId.set(id, { id, date, kind: "alarm", from, to: null, ongoing: false, lost_wh: null, detail: a.content || null });
    }
  }
  const cutoff = shiftIso(todayIso, -KEEP_DAYS);
  return [...byId.values()]
    .filter((e) => e.date >= cutoff)
    .sort((a, b) => (a.date === b.date ? b.from.localeCompare(a.from) : b.date.localeCompare(a.date)))
    .slice(0, KEEP_MAX);
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return t.toISOString().slice(0, 10);
}
