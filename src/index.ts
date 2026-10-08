// Worker entrypoint: auth gate in front of the static UI + /api/state, plus
// the cron-triggered poll. Everything except the public asset allowlist
// requires a valid session cookie; unauthenticated HTML requests are
// redirected to /login, unauthenticated /api/* requests get 401 JSON.

import {
  clearedSessionCookie,
  clearFailedLogins,
  clientIp,
  constantTimeEqual,
  isAuthenticated,
  isRateLimited,
  loginPageHtml,
  makeSessionCookie,
  recordFailedLogin,
} from "./auth";
import type { Env } from "./env";
import { BadRequest, dayDetail, monthDetail } from "./history";
import { handleIngest } from "./ingest";
import { claimPollLock, runPoll } from "./poll";
import { serializeState, unconfiguredState } from "./model";

const PUBLIC_PATHS = new Set(["/login", "/manifest.webmanifest", "/sw.js", "/font.woff2"]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/icons/")) return true;
  if (pathname.startsWith("/favicon")) return true;
  return false;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
};

function withSecurityHeaders(resp: Response): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (!env.SESSION_SECRET || !env.DASH_PASSWORD) {
      return withSecurityHeaders(
        new Response("Dashboard not configured: DASH_PASSWORD/SESSION_SECRET secrets are missing.", {
          status: 500,
        })
      );
    }

    if (pathname === "/login" && req.method === "GET") {
      return withSecurityHeaders(htmlResponse(loginPageHtml()));
    }

    if (pathname === "/login" && req.method === "POST") {
      return withSecurityHeaders(await handleLogin(req, env));
    }

    if (pathname === "/logout" && req.method === "POST") {
      return withSecurityHeaders(handleLogout());
    }

    // The stick gateway authenticates with its own bearer token, not a session.
    if (pathname === "/api/ingest") {
      return withSecurityHeaders(await handleIngest(req, env));
    }

    if (!isPublicPath(pathname)) {
      const authed = await isAuthenticated(req, env.SESSION_SECRET);
      if (!authed) {
        if (pathname.startsWith("/api/")) {
          return withSecurityHeaders(
            new Response(JSON.stringify({ error: "unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            })
          );
        }
        return withSecurityHeaders(
          new Response(null, { status: 302, headers: { Location: "/login" } })
        );
      }
    }

    if (pathname === "/api/state") {
      return withSecurityHeaders(await handleApiState(env, ctx));
    }

    if (pathname === "/api/day" || pathname === "/api/month") {
      return withSecurityHeaders(await handleHistory(pathname, url.searchParams, env));
    }

    // Everything else: static assets (index.html, manifest, sw.js, font, icons).
    const assetResp = await env.ASSETS.fetch(req);
    return withSecurityHeaders(assetResp);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPoll(env));
  },
};

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handleLogin(req: Request, env: Env): Promise<Response> {
  const ip = clientIp(req);
  if (await isRateLimited(env.SOLAR_KV, ip)) {
    return new Response("Too many attempts. Try again later.", { status: 429 });
  }

  const form = await req.formData().catch(() => null);
  const password = form?.get("password");

  if (typeof password !== "string" || !constantTimeEqual(password, env.DASH_PASSWORD!)) {
    await recordFailedLogin(env.SOLAR_KV, ip);
    return htmlResponse(loginPageHtml({ error: true }), 401);
  }

  await clearFailedLogins(env.SOLAR_KV, ip);
  const cookie = await makeSessionCookie(env.SESSION_SECRET!);
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": cookie },
  });
}

function handleLogout(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Set-Cookie": clearedSessionCookie(),
      // Ensures the service worker's cached /api/state (and any other
      // per-origin storage) doesn't leak dashboard data to whoever opens
      // the browser next on a shared device.
      "Clear-Site-Data": '"cache", "storage"',
    },
  });
}

const STALE_REFRESH_SECONDS = 6 * 60;

async function handleApiState(env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await env.SOLAR_KV.get("state");
  const state = raw ? JSON.parse(raw) : null;

  if (!state) {
    // Nothing polled yet: kick a poll and return `unconfigured`-shaped data
    // immediately rather than blocking the request on a live network round
    // trip (poll.ts's runPoll writes state to KV; the next GET picks it up).
    ctx.waitUntil(triggerPollIfNeeded(env));
    return jsonResponse(unconfiguredState(new Date().toISOString().replace(/\.\d+Z$/, "Z")));
  }

  const updatedAt = Date.parse(state.live?.updated_at ?? "");
  const ageSeconds = Number.isFinite(updatedAt) ? (Date.now() - updatedAt) / 1000 : Infinity;
  if (ageSeconds > STALE_REFRESH_SECONDS) {
    ctx.waitUntil(triggerPollIfNeeded(env));
  }

  return jsonResponse(state);
}

async function triggerPollIfNeeded(env: Env): Promise<void> {
  if (await claimPollLock(env)) {
    await runPoll(env);
  }
}

async function handleHistory(pathname: string, params: URLSearchParams, env: Env): Promise<Response> {
  try {
    const body =
      pathname === "/api/day" ? await dayDetail(env, params.get("date")) : await monthDetail(env, params.get("ym"));
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=300" },
    });
  } catch (e) {
    const status = e instanceof BadRequest ? 400 : 502;
    const msg = e instanceof Error ? e.message : String(e);
    if (status === 502) console.error(`${pathname} failed:`, msg);
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function jsonResponse(state: unknown): Response {
  return new Response(serializeState(state as Parameters<typeof serializeState>[0]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
