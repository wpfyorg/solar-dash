// MOCK=1 support. TS port of solar-dash/src/mock.rs, reading bundled
// fixtures (imported at build time, see src/fixtures/) instead of files on
// disk (Workers have no filesystem). Exercises the same mapping.ts code the
// live client does.

import * as mapping from "./mapping";
import * as sunlib from "./sun";
import type {
  Plant,
  State,
  Sun,
  Today,
  Yesterday,
} from "./model";
import { defaultPlant, defaultSun, defaultToday, defaultYesterday } from "./model";
import type {
  AlarmListResult,
  DeviceListResult,
  HistoryRawSeries,
  HistoryReportSeries,
  PlantFlowInfoResult,
  PlantGetResult,
  PlantListResult,
} from "./raw";

// Bundled at build time (esbuild resolves JSON imports statically) — mirrors
// solar-dash/fixtures/design and fixtures/night, per the project brief.
import designAlarms from "./fixtures/design/alarms_today.json";
import designDevices from "./fixtures/design/device_list.json";
import designFlow from "./fixtures/design/flow_info.json";
import designRawDay from "./fixtures/design/history_raw_day.json";
import designRawYesterday from "./fixtures/design/history_raw_yesterday.json";
import designPlantGet from "./fixtures/design/plant_get.json";
import designPlantList from "./fixtures/design/plant_list.json";
import designMonth from "./fixtures/design/report_month.json";
import designYear from "./fixtures/design/report_year.json";
import designSun from "./fixtures/design/sun.json";

import nightAlarms from "./fixtures/night/alarms_today.json";
import nightDevices from "./fixtures/night/device_list.json";
import nightFlow from "./fixtures/night/flow_info.json";
import nightRawDay from "./fixtures/night/history_raw_day.json";
import nightRawYesterday from "./fixtures/night/history_raw_yesterday.json";
import nightPlantGet from "./fixtures/night/plant_get.json";
import nightPlantList from "./fixtures/night/plant_list.json";
import nightMonth from "./fixtures/night/report_month.json";
import nightYear from "./fixtures/night/report_year.json";

export type MockScenario = "design" | "night";

interface FixtureSet {
  alarms: AlarmListResult;
  devices: DeviceListResult;
  flow: PlantFlowInfoResult;
  rawDay: HistoryRawSeries[];
  rawYesterday: HistoryRawSeries[];
  plantGet: PlantGetResult;
  plantList: PlantListResult;
  month: HistoryReportSeries[];
  year: HistoryReportSeries[];
  sunOverride?: { sunrise?: string; sunset?: string };
}

const FIXTURES: Record<MockScenario, FixtureSet> = {
  design: {
    alarms: designAlarms as AlarmListResult,
    devices: designDevices as DeviceListResult,
    flow: designFlow as PlantFlowInfoResult,
    rawDay: designRawDay as HistoryRawSeries[],
    rawYesterday: designRawYesterday as HistoryRawSeries[],
    plantGet: designPlantGet as PlantGetResult,
    plantList: designPlantList as PlantListResult,
    month: designMonth as HistoryReportSeries[],
    year: designYear as HistoryReportSeries[],
    sunOverride: designSun as { sunrise?: string; sunset?: string },
  },
  night: {
    alarms: nightAlarms as AlarmListResult,
    devices: nightDevices as DeviceListResult,
    flow: nightFlow as PlantFlowInfoResult,
    rawDay: nightRawDay as HistoryRawSeries[],
    rawYesterday: nightRawYesterday as HistoryRawSeries[],
    plantGet: nightPlantGet as PlantGetResult,
    plantList: nightPlantList as PlantListResult,
    month: nightMonth as HistoryReportSeries[],
    year: nightYear as HistoryReportSeries[],
  },
};

export function mockPoll(
  scenario: MockScenario,
  doHistory: boolean,
  doYesterday: boolean,
  prevHomeW: number,
  nowOverride: number | null
): State {
  const fx = FIXTURES[scenario] ?? FIXTURES.design;

  const plantBean = fx.plantList.plants?.[0];
  const plantGet = fx.plantGet;

  const now = nowOverride ?? Math.floor(Date.now() / 1000);
  const [y, m, d] = mapping.civilToday(now);

  const computed = sunlib.sunTimes(sunlib.DEFAULT_LAT, sunlib.DEFAULT_LON, y, m, d);
  const sunrise = fx.sunOverride?.sunrise ?? computed.sunrise;
  const sunset = fx.sunOverride?.sunset ?? computed.sunset;

  const hasMeter = mapping.detectHasMeter(fx.month, d);

  const live = mapping.mapFlowInfo(fx.flow, hasMeter, prevHomeW);
  const curve = mapping.curveFromHistory(fx.rawDay, hasMeter);

  const installDate = mapping.parseInstallDate(plantGet.details?.createdDate ?? "");

  const plant: Plant = {
    name: plantBean?.name ?? "My solar",
    capacity_w:
      (plantGet.details?.systemCapacity ?? 0) > 0
        ? plantGet.details!.systemCapacity! * 1000
        : (plantBean?.capacity ?? 0) > 0
          ? plantBean!.capacity! * 1000
          : 3500,
    price_per_kwh: (plantGet.details?.price ?? 0) > 0 ? plantGet.details!.price! : null,
    panel_kwp: (plantBean?.capacity ?? 0) > 0 ? plantBean!.capacity! : null,
    install_date: installDate ? fmtDate(installDate) : null,
    panel_count: null,
    panel_w: null,
  };

  const today: Today = {
    series: curve.points,
    produced_wh: curve.produced_wh,
    earned: null,
    peak_w: curve.peak_w,
    peak_at: curve.peak_at,
    vs_yesterday_wh: null,
    home_wh: curve.home_wh,
    exported_wh: curve.exported_wh,
    imported_wh: curve.imported_wh,
  };

  if (plant.price_per_kwh !== null) {
    today.earned = (today.produced_wh / 1000) * plant.price_per_kwh;
  }

  let yesterday: Yesterday = defaultYesterday();
  if (doYesterday && fx.rawYesterday.length > 0) {
    const ycurve = mapping.curveFromHistory(fx.rawYesterday, hasMeter);
    const cutoff = mapping.localHHMM(now);
    today.vs_yesterday_wh = today.produced_wh - mapping.energyUpTo(ycurve.points, cutoff);
    yesterday = { series: ycurve.points, produced_wh: ycurve.produced_wh };
  }

  let month = { month: 0, year: 0, days: [], total_wh: 0, best_day: null } as State["month"];
  let year: State["year"] = { year: 0, months: [], since_install_wh: 0 };
  let devices: State["devices"] = [];
  let alarms: State["alarms"] = [];

  if (doHistory) {
    month = mapping.monthFromReport(fx.month, y, m, d, (yy, mm, _dd) =>
      installDate ? mapping.ymBefore(yy, mm, installDate[0], installDate[1]) : false
    );
    year = mapping.yearFromReport(fx.year, y, m, (yy, mm) =>
      installDate ? mapping.ymBefore(yy, mm, installDate[0], installDate[1]) : false
    );
    devices = mapping.devicesFromList(fx.devices);
    year.since_install_wh = mapping.lifetimeFromDevices(fx.devices);
    alarms = mapping.alarmsFromList(fx.alarms);
  }

  const state: State = {
    status: "ok",
    server_now: mapping.isoFromUnix(now),
    has_meter: hasMeter,
    plant,
    live,
    sun: { sunrise, sunset } as Sun,
    today,
    yesterday,
    month,
    year,
    devices,
    alarms,
    forecast: null,
    events: [],
  };

  return state;
}

function fmtDate([y, m, d]: [number, number, number]): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
