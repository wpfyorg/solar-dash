import { describe, expect, it } from "vitest";
import { buildForecast, calibratePr, clearSkyPoa, mockWeather, type PanelSetup } from "../src/forecast";

const setup: PanelSetup = { lat: 28.61, lon: 77.21, tilt: 20, azimuth: 0, kwp: 3.51, inverterW: 3300 };

describe("clearSkyPoa", () => {
  it("is zero at night and near 1 kW/m² at a September noon", () => {
    expect(clearSkyPoa(setup, 2026, 9, 26, 0)).toBe(0);
    expect(clearSkyPoa(setup, 2026, 9, 26, 23 * 60)).toBe(0);
    const noon = clearSkyPoa(setup, 2026, 9, 26, 12 * 60 + 10);
    expect(noon).toBeGreaterThan(850);
    expect(noon).toBeLessThan(1100);
  });

  it("favours mornings for east-facing panels", () => {
    const east = { ...setup, azimuth: -90 };
    expect(clearSkyPoa(east, 2026, 9, 26, 9 * 60)).toBeGreaterThan(clearSkyPoa(east, 2026, 9, 26, 15 * 60));
  });
});

describe("buildForecast", () => {
  const dates = ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];
  const weather = mockWeather(setup, dates);

  it("never exceeds the inverter limit and keeps clear sky above expected", () => {
    const f = buildForecast(setup, weather, "2026-09-26", "2026-09-27", {}, null, "mock", "");
    expect(f.pr).toBe(0.8);
    expect(f.today.series.length).toBeGreaterThan(30);
    for (const p of f.today.series) {
      expect(p.clear_w).toBeLessThanOrEqual(3300);
      expect(p.expected_w).toBeLessThanOrEqual(p.clear_w);
    }
    expect(f.today.clear_wh).toBeGreaterThan(f.today.expected_wh);
    // A clear late-September day on 3.5 kWp: roughly 14–22 kWh.
    expect(f.today.clear_wh / 1000).toBeGreaterThan(14);
    expect(f.today.clear_wh / 1000).toBeLessThan(22);
    expect(f.tomorrow.series).toEqual([]);
  });

  it("calibrates the performance ratio from actual days, skipping outages", () => {
    const at1 = buildForecast(setup, weather, "2026-09-26", "2026-09-27", {}, null, "mock", "");
    // Feed back exactly 70% of the PR=1 model for each past day.
    const model: Record<string, number> = {};
    for (const s of weather.slots) {
      if (s.date >= "2026-09-26") continue;
      const cell = s.tempC + (s.poa / 800) * 25;
      model[s.date] = (model[s.date] ?? 0) + (s.poa / 1000) * 3510 * (1 - 0.0037 * (cell - 25)) * 0.25;
    }
    const actual = Object.fromEntries(Object.entries(model).map(([d, wh]) => [d, wh * 0.7]));
    actual["2026-09-21"] = 50; // inverter off that day
    const cal = calibratePr(setup, weather.slots, actual, "2026-09-26");
    expect(cal?.days).toBe(6);
    expect(cal?.pr).toBeCloseTo(0.7, 3);
    expect(at1.today.expected_wh).toBeGreaterThan(0);
  });
});
