// Raw wire shapes for the WAAREE/FoxESS-Cloud REST API. TS mirror of
// solar-dash/src/raw.rs — field names and shapes kept identical (including
// the API's own camelCase) so this can be diffed against that file directly.

export interface BaseResponse<T> {
  errno: number;
  msg?: string;
  result?: T | null;
}

export interface LoginResult {
  access?: number;
  token: string;
  user?: string;
}

export interface PlantsBean {
  stationID?: string;
  name?: string;
  capacity?: number;
  generationToday?: number;
}

export interface PlantListResult {
  plants?: PlantsBean[];
}

export interface FlowPowerValue {
  display?: boolean;
  unit?: string;
  value?: string;
}

export interface FlowNodeBean {
  display?: boolean;
  power?: FlowPowerValue;
}

export function flowNodeKw(n: FlowNodeBean | undefined): number {
  const v = n?.power?.value?.trim();
  if (!v) return 0;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : 0;
}

export interface FlowInfo {
  solarToDevice?: number;
  genToHidden?: number;
  loadToHidden?: number;
  gridToHidden?: number;
  deviceToHidden?: number;
  batToDevice?: number;
  chargerToHidden?: number;
}

export interface FlowNode {
  solar?: FlowNodeBean;
  device?: FlowNodeBean;
  grid?: FlowNodeBean;
  load?: FlowNodeBean;
  bat?: FlowNodeBean;
  gen?: FlowNodeBean;
  charger?: FlowNodeBean;
}

export interface FlowStatus {
  state?: number;
  lastUpdateDate?: string;
  yieldToday?: string;
}

export interface PlantFlowInfoResult {
  flow?: FlowInfo;
  node?: FlowNode;
  status?: FlowStatus;
}

export interface HistoryRawPoint {
  time: string;
  value: number;
}

export interface HistoryRawSeries {
  variable: string;
  data?: HistoryRawPoint[];
}

export interface HistoryReportPoint {
  index: number;
  value: number;
}

export interface HistoryReportSeries {
  variable: string;
  data?: HistoryReportPoint[];
}

export interface DeviceBean {
  deviceSN?: string;
  deviceType?: string;
  status?: number;
  power?: number;
  generationToday?: number;
  generationTotal?: number;
}

export interface DeviceListResult {
  devices?: DeviceBean[];
}

export interface AlarmBean {
  time?: string;
  content?: string;
  code?: number;
  deviceSN?: string;
  alarmType?: number;
}

export interface AlarmListResult {
  data?: AlarmBean[];
}

export interface PlantDetails {
  price?: number;
  createdDate?: string;
  systemCapacity?: number;
  currency?: string | null;
}

export interface PlantGetResult {
  details?: PlantDetails;
}

export interface EarningPeriod {
  earnings?: number;
  generation?: number;
}

export interface EarningDetailResult {
  today?: EarningPeriod;
  month?: EarningPeriod;
  year?: EarningPeriod;
  cumulate?: EarningPeriod;
  currency?: string | null;
}
