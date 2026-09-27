# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted Cloudflare Worker dashboard for WAAREE PV Hub (a white-labelled FoxESS Cloud) solar accounts. The backend is TypeScript with no framework. The UI is one static HTML file with no framework and no build step.

## Commands

```bash
npm run dev          # sync-assets, then wrangler dev
npm run deploy       # sync-assets, then wrangler deploy
npm run typecheck    # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm test             # vitest run
npx vitest run test/forecast.test.ts        # one test file
npx vitest run -t "calibrates"              # tests matching a name
```

- **Local dev without a WAAREE account:** `.dev.vars` needs `DASH_PASSWORD` and `SESSION_SECRET` (copy `.dev.vars.example`). Add these vars to use fixtures:
  - `MOCK=1`
  - `MOCK_SCENARIO=design|night`
  - `MOCK_NOW=YYYY-MM-DDTHH:MM`, in plant-local IST. The `design` fixture's day data ends at 12:40.
  - You can also pass them on the command line, e.g. `npx wrangler dev --var MOCK:1 --var MOCK_NOW:2026-09-26T12:40`.
- **Local state:** local KV lives in `.wrangler/state`. `/api/state` only re-polls when the stored state is more than 6 minutes old, and cron doesn't fire in dev. To see a different `MOCK_NOW` take effect, delete `.wrangler/state`.
- **Screenshots:** `?theme=light|dark` forces a theme. `?sky=clear|fair|cloudy|overcast|fog|drizzle|rain|storm` forces the hero's weather backdrop.
- **One-time deploy setup (the user runs these, not agents):** `scripts/setup.sh` creates the KV namespace and patches its id into `wrangler.jsonc`. `scripts/set-secrets.sh` sets the secrets.

## Architecture

```
Cron */5 ──▶ poll.ts runPoll ──▶ WAAREE API (client.ts) + Open-Meteo (forecast.ts)
                    │
                    ▼
             KV "state" (model.State JSON)
                    ▲
Browser ─▶ index.ts (auth gate) ─▶ /api/state (reads KV; kicks a poll via waitUntil if stale)
                                ─▶ /api/day, /api/month (history.ts, on demand, KV-cached)
                                ─▶ static assets (public/, copied from web/)
```

- **`web/` is the source; `public/` is generated.** `scripts/sync-assets.mjs` copies `web/` into `public/`, and runs as `predev`/`predeploy`. Edit `web/index.html`, never `public/`. A new asset file must also be added to the copy list in `sync-assets.mjs`. Bump `CACHE_VERSION` in `web/sw.js` when you change the app shell, or installed PWAs keep the old HTML.
- **`model.ts` is the contract between worker and UI.** `State` is serialized as-is to `/api/state`, and `web/index.html` reads its fields directly. Units are raw W/Wh; the frontend does all kW/kWh/₹ formatting.
  - `CurvePoint`'s meter fields (`home_w` etc.) are omitted entirely when there's no meter, via `makeCurvePoint`.
  - `Live`'s meter fields are always present as `null`.
  - If you add a `State` field, also update `unconfiguredState` and both state builders (`poll.ts` `livePoll` and `mock.ts` `mockPoll`).
- **Poll rounds are partial.** `runPoll` always refreshes the live figures. History, devices and alarms are fetched only every 15 min, yesterday's curve hourly, and the forecast hourly, with timestamps in KV keys `history_at`, `yesterday_at` and `forecast_at`. `mergeUpdate` carries earlier data forward in a live-only round, so a new field fetched on a slower cadence must be preserved there (or set after the merge, as `forecast` is).
- **Plant overrides and forecast run after the merge.** `applyPlantOverrides` applies `PANEL_COUNT`/`PANEL_W`/`INVERTER_KW` from `wrangler.jsonc` vars, because WAAREE only stores a rounded plant size. `plant.capacity_w` means the inverter's AC limit, which is the ceiling on every chart. `refreshForecast` builds `state.forecast` next.
- **`forecast.ts` is pure except for `fetchOpenMeteo`.**
  - Expected output is the Open-Meteo irradiance on the panels' angle (`TILT`, and `AZIMUTH` where 0 is south) × kWp × a temperature factor × the performance ratio, clipped at the inverter's limit.
  - The performance ratio is calibrated from recent actual daily totals (`calibratePr`, using `state.month.days` plus yesterday).
  - Clear-sky output comes from a local model (`clearSkyPoa`).
  - In mock mode, `mockWeather` stands in for Open-Meteo.
- **Mock mode uses the same code path as live.** `mock.ts` feeds the bundled JSON fixtures in `src/fixtures/{design,night}/` (shaped like WAAREE's raw responses, see `raw.ts`) through the same `mapping.ts` functions the live client uses.
- **Everything assumes India.** The plant is IST (UTC+5:30), and the currency is INR (`en-IN` formatting in the UI).
  - The worker uses `TZ_OFFSET_HOURS` from `sun.ts`, but some places still hard-code `330`: `mapping.ts` `civilToday`, and `istNow()` in the UI. Dates are computed with manual civil-date math (`mapping.ts`), not `Date` local time.
  - "Now" in the UI comes from `state.server_now`, which `MOCK_NOW` can pin, not from the browser clock.
- **WAAREE client (`client.ts`).** Requests are signed as `md5(path + "\r\n" + token + "\r\n" + lang + "\r\n" + timestamp)`, where `\r\n` is the literal four-character text, not CR/LF. `md5.ts` provides MD5 because WebCrypto has none. Auth-expiry errnos trigger a re-login.
  - The session token is shared in KV (`token`) between the poller and `history.ts`. Write it back only when it changed.
  - Comments call this a port of a Rust `solar-dash` codebase. Keep logic and comments 1:1 with that original where noted.
- **Auth (`auth.ts`).** One shared password (`DASH_PASSWORD`), an HMAC-signed `__Host-` session cookie (`SESSION_SECRET`), and failed logins rate-limited per IP in KV. Everything except the `PUBLIC_PATHS` allowlist in `index.ts` needs a session.
  - The CSP is `connect-src 'self'`, so the browser can only call this worker. Any third-party data (like Open-Meteo) must be fetched server-side.
- **KV write budget.** The free tier allows 1,000 writes a day, and polling already uses roughly 430. Avoid adding per-poll KV writes.

## UI notes (`web/index.html`)

- All state is re-rendered from `render()` every second and after each 5-second `/api/state` poll.
  - Sections use `innerHTML` and guard against needless DOM churn with `__html` comparisons.
  - Wrap user-visible strings from the API in `esc()`.
- **Hero chart.**
  - The SVG viewBox tracks its pixel size (`syncArcViewbox`), so one viewBox unit is one CSS pixel.
  - Curves use `smoothPath`, a monotone cubic that never overshoots the data. Don't reintroduce Catmull-Rom, which dipped below zero.
  - `chartView` switches between `curve` and `hourly` and is saved in `localStorage`, with every access wrapped in try/catch.
- **Sky backdrop.** `#sky-fx` shows the current hour's weather from `forecast.today.sky` (hourly WMO code and cloud %). It is built once per sky kind (`renderSky`), uses CSS container units, and animates only transform/opacity. Reduced motion freezes it.
- **Outages.** WAAREE has no grid-voltage data, so `findOutages` infers cuts. A daylight run of zero output means the inverter is up but the mains is down. A gap in samples means the inverter lost power or Wi-Fi. Either only counts when the forecast expected real output. `diagnose` turns an ongoing one into the hero note and the System headline. Past ones become chart bands and the Today note.
- **Staleness.** Figures are stale after 11 minutes (`STALE_SEC` in the UI, `STALE_AFTER_SECONDS` in `poll.ts`), because the cron runs every 5 minutes and one late run is normal.
- **Layout.** Breakpoints are 1099px (tablet), 600px and 480px (phone), and the hero uses different grid areas at each. Check phone width after any hero change.
- **Copy style.** Plain, lowercase labels under figures, e.g. "worth today, at ₹4.5 a unit", "peak, at 1:11 pm". Money is "worth", not "earned", because without an energy meter there's no import/export data.
