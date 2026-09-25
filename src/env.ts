export interface Env {
  SOLAR_KV: KVNamespace;
  ASSETS: Fetcher;

  // vars (wrangler.jsonc "vars")
  LAT: string;
  LON: string;
  TZ_OFFSET_MIN: string;
  MOCK: string;
  MOCK_SCENARIO: string;
  MOCK_NOW?: string;

  // secrets (scripts/set-secrets.sh / .dev.vars)
  WAAREE_USERNAME?: string;
  WAAREE_PASSWORD_MD5?: string;
  DASH_PASSWORD?: string;
  SESSION_SECRET?: string;
}

export function isMock(env: Env): boolean {
  return env.MOCK === "1";
}
