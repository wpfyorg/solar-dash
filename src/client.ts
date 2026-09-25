// Signed HTTP client for https://digital.waaree.com/ (a rebranded FoxESS
// Cloud). Faithful TS port of solar-dash/src/client.rs: same signature
// recipe, same endpoints, same re-login-on-auth-errno behavior. WebCrypto
// has no MD5, so md5.ts supplies a small pure-JS implementation.

import { md5Hex } from "./md5";
import type {
  AlarmListResult,
  BaseResponse,
  DeviceListResult,
  HistoryRawSeries,
  HistoryReportSeries,
  PlantFlowInfoResult,
  PlantGetResult,
  PlantListResult,
} from "./raw";

const BASE_URL = "https://digital.waaree.com";
const LANG = "en";
const TIMEZONE = "Asia/Kolkata";
const VERSION = "v1.0.3";

// errno values observed to mean "your token is no good any more" in
// FoxESS-Cloud-family APIs, per solar-dash/src/client.rs's AUTH_ERRNOS.
const AUTH_ERRNOS = new Set([41807, 41808, 41809, 40401, 401]);

export function md5(s: string): string {
  return md5Hex(s);
}

function nonce(): number {
  // A cheap, non-cryptographic 31-bit nonce for the signature's trailing
  // ".<random int>" suffix — any value works (api-notes §2.4).
  return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * `md5(path + "\r\n" + token + "\r\n" + lang + "\r\n" + timestamp) + "." + nonce`,
 * using the LITERAL four-character text `\r\n` (backslash r backslash n),
 * not real CR/LF bytes — matches solar-dash/src/client.rs's `signature`.
 */
export function signature(path: string, token: string, timestamp: string): string {
  const toHash = `${path}\\r\\n${token}\\r\\n${LANG}\\r\\n${timestamp}`;
  return `${md5Hex(toHash)}.${nonce()}`;
}

export type ClientErrorKind = "transport" | "api" | "auth_expired";

/** JSON with object keys sorted, byte-identical to what the Rust client
 * sends (serde_json::Value maps are ordered by key). */
function sortedJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val
  );
}

export class ClientError extends Error {
  kind: ClientErrorKind;
  errno?: number;

  constructor(kind: ClientErrorKind, message: string, errno?: number) {
    super(message);
    this.kind = kind;
    this.errno = errno;
  }

  static transport(message: string): ClientError {
    return new ClientError("transport", `transport error: ${message}`);
  }
  static api(errno: number, msg: string): ClientError {
    return new ClientError("api", `api error ${errno}: ${msg}`, errno);
  }
  static authExpired(): ClientError {
    return new ClientError("auth_expired", "auth expired");
  }
}

export interface ClientState {
  username: string;
  passwordMd5: string;
  token: string | null;
}

function headers(path: string, token: string): Record<string, string> {
  const timestamp = Date.now().toString();
  return {
    Connection: "keep-alive",
    lang: LANG,
    timezone: TIMEZONE,
    timestamp,
    signature: signature(path, token, timestamp),
    // Workers' fetch sends no User-Agent; the Rust client (which works)
    // always sent one.
    "User-Agent": "okhttp/4.9.3",
    version: VERSION,
  };
}

export class Client {
  private username: string;
  private passwordMd5: string;
  private token: string | null = null;

  constructor(username: string, passwordMd5: string, token?: string | null) {
    this.username = username;
    this.passwordMd5 = passwordMd5;
    this.token = token ?? null;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  getToken(): string | null {
    return this.token;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  /** POST c/v0/user/login, form-urlencoded, unauthenticated. */
  async login(): Promise<void> {
    const path = "/c/v0/user/login";
    const url = `${BASE_URL}${path}`;
    const body = new URLSearchParams({ user: this.username, password: this.passwordMd5 });
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          ...headers(path, ""),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch (e) {
      throw ClientError.transport(String(e));
    }
    let parsed: BaseResponse<{ access?: number; token: string; user?: string }>;
    try {
      parsed = await resp.json();
    } catch (e) {
      throw ClientError.transport(String(e));
    }
    if (parsed.errno !== 0) {
      throw ClientError.api(parsed.errno, `login: ${parsed.msg ?? ""}`);
    }
    if (!parsed.result) {
      throw ClientError.api(-1, "login: empty result");
    }
    this.token = parsed.result.token;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; jsonBody?: unknown } = {}
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.token === null) throw ClientError.authExpired();
      const token = this.token;
      let url = `${BASE_URL}${path}`;
      if (opts.query) {
        const qs = new URLSearchParams(opts.query);
        url += `?${qs.toString()}`;
      }
      const reqHeaders: Record<string, string> = {
        ...headers(path, token),
        token,
      };
      if (opts.jsonBody !== undefined) {
        reqHeaders["Content-Type"] = "application/json";
      }
      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers: reqHeaders,
          body: opts.jsonBody !== undefined ? sortedJson(opts.jsonBody) : undefined,
        });
      } catch (e) {
        throw ClientError.transport(String(e));
      }
      if (resp.status === 401 || resp.status === 403) {
        if (attempt === 0) {
          await this.login();
          continue;
        }
        throw ClientError.authExpired();
      }
      let body: BaseResponse<T>;
      try {
        body = await resp.json();
      } catch (e) {
        throw ClientError.transport(String(e));
      }
      if (body.errno !== 0) {
        if (AUTH_ERRNOS.has(body.errno) && attempt === 0) {
          await this.login();
          continue;
        }
        throw ClientError.api(body.errno, `${path}: ${body.msg ?? ""}`);
      }
      if (body.result === undefined || body.result === null) {
        throw ClientError.api(-1, "empty result");
      }
      return body.result;
    }
    throw ClientError.authExpired();
  }

  plantList(): Promise<PlantListResult> {
    return this.request("POST", "/c/v1/plant/list", {
      jsonBody: {
        currentPage: 1,
        pageSize: 10,
        condition: { status: 0, content: "", contentType: 1 },
      },
    });
  }

  flowInfo(stationId: string): Promise<PlantFlowInfoResult> {
    return this.request("GET", "/generic/v0/plant/flow/info", {
      query: { stationID: stationId },
    });
  }

  historyRawDay(
    stationId: string,
    variables: string[],
    y: number,
    m: number,
    d: number
  ): Promise<HistoryRawSeries[]> {
    return this.request("POST", "/generic/v0/plant/history/raw", {
      jsonBody: {
        stationID: stationId,
        beginDate: { year: y, month: m, day: d, hour: 0, minute: 0, second: 0 },
        timespan: "day",
        variables,
      },
    });
  }

  historyReport(
    stationId: string,
    reportType: string,
    variables: string[],
    y: number,
    m: number
  ): Promise<HistoryReportSeries[]> {
    return this.request("POST", "/generic/v0/plant/history/report", {
      jsonBody: {
        stationID: stationId,
        reportType,
        queryDate: { year: y, month: m, day: 0, hour: 0 },
        variables,
      },
    });
  }

  deviceList(stationId: string): Promise<DeviceListResult> {
    return this.request("POST", "/c/v0/plant/device/list", {
      jsonBody: { stationID: stationId, currentPage: 1, pageSize: 50 },
    });
  }

  alarmsToday(stationId: string): Promise<AlarmListResult> {
    return this.request("POST", "/c/v0/plant/alarm/today/detail", {
      jsonBody: { stationID: stationId },
    });
  }

  plantGet(stationId: string): Promise<PlantGetResult> {
    return this.request("GET", "/c/v0/plant/get", { query: { stationID: stationId } });
  }
}
