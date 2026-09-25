# solar-dash

A clean, fast, self-hosted dashboard for **WAAREE PV Hub** solar accounts —
and, since WAAREE is a white-labelled reseller of it, any account on the
underlying **FoxESS Cloud** API. It replaces the official app's charts with a
single page: live production, today's curve against yesterday's, a
browsable calendar and year of history, and PWA install support.

It's a Cloudflare Worker: no server to run, a free-tier deployment, and a
password gate so it's safe to leave on the public internet.

## Why this exists

The official WAAREE app is slow, ad-hoc, and doesn't make it easy to just
glance at what your panels are doing right now, or scroll back through past
days. This dashboard talks to the same backend API the app uses and presents
it as one legible page instead.

**What it can show:** solar production — live, today's curve, yesterday's
for comparison, any past day, a calendar month, and a year of totals —
plus your inverter's status and today's alarms.

**What it can't show:** home usage, grid import/export, or battery state —
*if* your installation has no energy meter. WAAREE's API only reports these
when a meter is present; without one, `loadsPower` and
`gridConsumptionPower` are always zero. The dashboard detects this
automatically (`has_meter` in the API) and hides those figures rather than
show zeroes. If your installation *does* have a meter, it'll show them.

## How it works

```
Cron (every 5 min) ──▶ WAAREE Cloud API ──▶ Cloudflare KV (cached state)
                                                     │
Browser ──▶ Worker (password gate) ──▶ /api/state ──┘
                    │
                    └─▶ static UI (HTML/CSS/JS, no framework, no build step)
```

- A scheduled Worker trigger polls WAAREE every 5 minutes and writes the
  result to Workers KV.
- `GET /api/state` serves that cached state to the browser — fast, and it
  never blocks a page load on a live WAAREE round trip.
- `GET /api/day` and `GET /api/month` fetch a specific past day or month on
  demand (for the calendar), reusing the same session token, and cache
  finished (unchanging) days/months in KV so they never ask WAAREE twice.
- A simple password gate (`/login`) sits in front of everything — an
  HMAC-signed session cookie, rate-limited login attempts — since this is
  meant to be reachable from anywhere, not just your home network.
- The UI is one static page: no build step, no framework, a small embedded
  font subset. It installs as a PWA (add to home screen) on phones.

## Requirements

- A WAAREE PV Hub account (or another FoxESS-white-label account) with at
  least one plant.
- A [Cloudflare](https://cloudflare.com) account (the free tier is enough —
  see [Costs](#costs) below).
- Node.js 20+ and `npm`.

**Region assumption:** WAAREE is India-only, so this dashboard hardcodes
`Asia/Kolkata` (UTC+5:30) for "today"/"this month" boundaries and formats
currency as INR. If you're adapting this for a different FoxESS-white-label
brand outside India, you'll need to generalize `TZ_OFFSET_MIN` handling in
`src/mapping.ts` (some of it is still a literal `330`) and the `en-IN`/`INR`
formatting in `web/index.html`.

## Setup

```bash
git clone <this repo>
cd solar-dash
npm install
npx wrangler login        # opens a browser to authorize Cloudflare
scripts/setup.sh          # creates your KV namespace, patches wrangler.jsonc
scripts/set-secrets.sh    # prompts for WAAREE + dashboard credentials
npm run deploy
```

`scripts/set-secrets.sh` asks for:

| Secret | What it is |
|---|---|
| `WAAREE_USERNAME` | Your WAAREE login username |
| `WAAREE_PASSWORD_MD5` | Computed locally from your password (the script hashes it — your plaintext password is never sent to Cloudflare or written to disk) |
| `DASH_PASSWORD` | The password *you* pick to view the dashboard itself |
| `SESSION_SECRET` | Random, generated for you (`openssl rand -hex 32`) |

None of these are ever written to a file in this repo or committed —
they're pushed straight to Cloudflare as encrypted Worker secrets.

Set your plant's coordinates in `wrangler.jsonc` (`LAT`/`LON`) so the
sunrise/sunset times are accurate — they default to New Delhi's, which will
be wrong for you.

### Custom domain (optional)

By default you'll get `https://solar-dash.<your-subdomain>.workers.dev`.
To use your own domain instead, its DNS zone needs to be on the same
Cloudflare account you deployed with — then uncomment the `routes` block in
`wrangler.jsonc` with your domain and redeploy.

### Local development

```bash
cp .dev.vars.example .dev.vars   # fill in your own values, or leave MOCK=1
npm run dev
```

Set `MOCK=1` in `.dev.vars` to run entirely against bundled fixture data —
no real WAAREE account needed. `MOCK_SCENARIO` picks a fixture (`design`,
`night`); `MOCK_NOW=YYYY-MM-DDTHH:MM` pins the simulated time.

## Project layout

```
src/            Worker source (TypeScript)
  index.ts        entrypoint: auth gate, routing, the scheduled poll
  client.ts        WAAREE API client (login, signed requests, retry-on-expiry)
  poll.ts          the 5-minute cron poll → cached state in KV
  history.ts       on-demand /api/day and /api/month (calendar drill-down)
  mapping.ts       WAAREE's raw API shapes → this app's data model
  mock.ts          MOCK=1 fixture-backed responses for local dev
  sun.ts           sunrise/sunset (NOAA approximation)
  auth.ts          password gate: session cookies, rate limiting
web/            The UI you actually edit (plain HTML/CSS/JS, no build step)
public/         Built output of web/ (generated by `npm run sync-assets`,
                git-ignored — don't edit these directly)
test/           Vitest unit tests
scripts/        One-time setup + secret management (run these yourself)
```

## Costs

Everything here fits Cloudflare's free tier for a single-plant, personal-use
deployment:

- **Workers**: cron runs every 5 min (~8,640/month) plus page loads — well
  under the free tier's 100,000 requests/day.
- **Workers KV**: the cron poll writes to KV only when something actually
  changes (state, and the session token on re-login), which keeps it well
  under the free tier's 1,000 writes/day. Reads are unmetered on the free
  tier up to 100,000/day.

If you deploy for multiple plants or many viewers, check your usage against
current Cloudflare Workers/KV free-tier limits.

## Security notes

- The dashboard sits behind a single shared password — treat it like any
  other credential. There's no per-user login.
- Rate limiting on `/login` blocks an IP after repeated failed attempts.
- Only one active session (poller) can be logged into a given WAAREE
  account at a time — each login invalidates the previous one. Don't run
  `npm run dev` against your real WAAREE credentials while your deployed
  Worker is also live, or they'll repeatedly log each other out.

## License

MIT — see [LICENSE](LICENSE).

This project is not affiliated with, endorsed by, or supported by WAAREE
or FoxESS. It's an independent client for their public API, built by
reverse-engineering the official Android app's network traffic.
