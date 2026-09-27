import { describe, expect, it } from "vitest";
import { findOutages, updateEvents } from "../src/events";
import type { CurvePoint, ForecastPoint, LogEvent } from "../src/model";

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** 5-minute samples from 05:35 to `until`, with `w(min)` watts. */
function series(until: number, w: (min: number) => number, skip: (min: number) => boolean = () => false): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (let t = 335; t <= until; t += 5) if (!skip(t)) out.push({ t: hm(t), solar_w: w(t) });
  return out;
}
function forecast(w: number): ForecastPoint[] {
  const out: ForecastPoint[] = [];
  for (let t = 337; t < 1060; t += 15) out.push({ t: hm(t), expected_w: w, clear_w: w });
  return out;
}
const base = { sunrise: "05:32", sunset: "17:35", capacityW: 3300 };

describe("findOutages", () => {
  it("finds a finished midday power cut and what it cost", () => {
    const s = series(785, (t) => (t >= 723 && t <= 770 ? 0 : 2000)); // off 12:05-12:50
    const out = findOutages({ ...base, series: s, forecast: forecast(1900), nowMin: 785 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "power_cut", from: 725, to: 775, ongoing: false });
    expect(out[0]!.lostWh).toBeGreaterThan(1500);
  });

  it("marks a cut still going on", () => {
    const s = series(780, (t) => (t >= 723 ? 0 : 2000));
    const out = findOutages({ ...base, series: s, forecast: forecast(1900), nowMin: 782 });
    expect(out[0]).toMatchObject({ kind: "power_cut", from: 725, to: 782, ongoing: true });
  });

  it("calls silence from the inverter no_data", () => {
    const s = series(700, () => 2000);
    const out = findOutages({ ...base, series: s, forecast: forecast(1900), nowMin: 760 });
    expect(out[0]).toMatchObject({ kind: "no_data", from: 700, ongoing: true });
  });

  it("logs a day with no samples at all as one silence", () => {
    const out = findOutages({ ...base, series: [], forecast: forecast(1900), nowMin: 24 * 60 });
    expect(out).toEqual([expect.objectContaining({ kind: "no_data", from: 392, to: 995, ongoing: false })]);
  });

  it("does not call an empty day an outage before sunrise", () => {
    expect(findOutages({ ...base, series: [], forecast: forecast(1900), nowMin: 300 })).toHaveLength(0);
  });

  it("ignores zero output when the forecast expected almost nothing", () => {
    const s = series(785, (t) => (t >= 723 && t <= 770 ? 0 : 400));
    expect(findOutages({ ...base, series: s, forecast: forecast(90), nowMin: 785 })).toHaveLength(0);
  });

  it("ignores the low-sun edges of the day", () => {
    const s = series(1000, (t) => (t < 380 ? 0 : 2000));
    expect(findOutages({ ...base, series: s, forecast: forecast(1900), nowMin: 1000 })).toHaveLength(0);
  });
});

describe("updateEvents", () => {
  it("rebuilds today's outages, keeps older days, closes stale open ones", () => {
    const prev: LogEvent[] = [
      { id: "2026-09-27-out-12:03", date: "2026-09-27", kind: "power_cut", from: "12:03", to: "12:40", ongoing: true, lost_wh: 1000, detail: null },
      { id: "2026-09-26-out-10:00", date: "2026-09-26", kind: "no_data", from: "10:00", to: "10:30", ongoing: true, lost_wh: null, detail: null },
    ];
    const out = updateEvents(prev, "2026-09-27", [{ kind: "power_cut", from: 723, to: 776, ongoing: false, lostWh: 1873.4 }], [
      { time: "2026-09-27 12:04:10 IST+0530", content: "Grid lost", code: 7, device_sn: "x", alarm_type: 1 },
    ]);
    expect(out.map((e) => e.id)).toEqual(["2026-09-27-alarm-12:04-7", "2026-09-27-out-12:03", "2026-09-26-out-10:00"]);
    expect(out[1]).toMatchObject({ to: "12:56", ongoing: false, lost_wh: 1873 });
    expect(out[2]!.ongoing).toBe(false);
  });
});
