export interface Env {
  SOLAR_KV: KVNamespace;
  ASSETS: Fetcher;

  // vars (wrangler.jsonc "vars")
  LAT: string;
  LON: string;
  TZ_OFFSET_MIN: string;
  // Optional plant details WAAREE doesn't report precisely. Empty = use
  // WAAREE's own figures.
  PANEL_COUNT?: string;
  PANEL_W?: string;
  INVERTER_KW?: string;
  // Panel orientation for the weather forecast. TILT in degrees from flat;
  // AZIMUTH 0 = facing south, -90 = east, 90 = west.
  TILT?: string;
  AZIMUTH?: string;
  // "0" turns the Open-Meteo weather forecast off.
  FORECAST?: string;
  MOCK: string;
  MOCK_SCENARIO: string;
  MOCK_NOW?: string;

  // secrets (scripts/set-secrets.sh / .dev.vars)
  WAAREE_USERNAME?: string;
  WAAREE_PASSWORD_MD5?: string;
  DASH_PASSWORD?: string;
  SESSION_SECRET?: string;
  // Bearer token the stick gateway pushes with (POST /api/ingest). Unset = ingest off.
  INGEST_TOKEN?: string;
}

export function isMock(env: Env): boolean {
  return env.MOCK === "1";
}

function num(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface PlantOverrides {
  panelCount: number | null;
  panelW: number | null;
  inverterW: number | null;
  tilt: number;
  azimuth: number;
}

export function plantOverrides(env: Env): PlantOverrides {
  const inverterKw = num(env.INVERTER_KW);
  return {
    panelCount: num(env.PANEL_COUNT),
    panelW: num(env.PANEL_W),
    inverterW: inverterKw && inverterKw > 0 ? inverterKw * 1000 : null,
    tilt: num(env.TILT) ?? 20,
    azimuth: num(env.AZIMUTH) ?? 0,
  };
}
