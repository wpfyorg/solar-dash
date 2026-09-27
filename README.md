# WAAREE Solar Dashboard

Self-hosted **WAAREE PV Hub / FoxESS solar dashboard** with live generation,
weather forecasts, history, power-cut detection and PWA support. Runs on
Cloudflare Workers.

See live production, today's curve, weather-aware forecasts, historical output,
system events, and plant details in one fast page. It also installs as a PWA,
so it works well as a home-screen dashboard on a phone.

![WAAREE Solar Dashboard](docs/screenshot.png)

## What you get

- **Live production** with today's total, current power, peak, and value.
- **Weather-aware forecasting** using Open-Meteo irradiance data and your panel
  orientation.
- **Clear-sky comparison** to show what the system could make in ideal weather.
- **Day, month, and year history** with drill-down into individual days.
- **System status and event log** for power cuts, alarms, and missing readings.
- **Optional meter data** for home usage and grid flow when the installation
  exposes an energy meter.
- **Password protection** with signed sessions and login rate limiting.
- **PWA support** for an app-like experience on mobile.
- **No frontend framework and no build pipeline** — the UI is plain HTML, CSS,
  and JavaScript.

## Why this exists

The WAAREE app exposes the data, but checking live production, comparing days,
and understanding what happened during the day takes more work than it should.

WAAREE Solar Dashboard uses the same cloud data and turns it into a single, glanceable
dashboard designed for a personal solar installation.

## How it works

```text
                 every 5 minutes
Cloudflare Cron ──────────────────▶ Worker ─────▶ WAAREE / FoxESS API
                                      │
                                      ├────────▶ Open-Meteo
                                      │
                                      ▼
                                 Workers KV
                                      ▲
                                      │
Browser ─────▶ password gate ─────▶ /api/state
              │                       │
              └──── static PWA ◀──────┘
```

The Worker polls live data on a schedule and stores the normalized state in KV.
The browser reads that cached state, while historical day/month data is fetched
on demand and cached separately.

The browser never talks directly to WAAREE or Open-Meteo.

## Requirements

- A WAAREE PV Hub account, or a compatible FoxESS white-label account.
- A Cloudflare account with Workers and KV.
- Node.js 20+ and npm.

The project currently assumes an Indian installation: **IST (UTC+5:30)** and
**INR** formatting. See [Regional assumptions](#regional-assumptions) if you
want to adapt it elsewhere.

## Quick start

```bash
git clone https://github.com/wpfyorg/waaree-solar-dashboard.git
cd waaree-solar-dashboard
npm install

npx wrangler login
scripts/setup.sh
scripts/set-secrets.sh

npm run deploy
```

After deployment, Wrangler prints your `workers.dev` URL.

### 1. Create the KV namespace

```bash
scripts/setup.sh
```

This creates the `SOLAR_KV` namespace and writes its ID into `wrangler.jsonc`.

### 2. Set secrets

```bash
scripts/set-secrets.sh
```

The script configures:

| Secret | Purpose |
| --- | --- |
| `WAAREE_USERNAME` | WAAREE / FoxESS white-label login |
| `WAAREE_PASSWORD_MD5` | MD5 form expected by the upstream API |
| `DASH_PASSWORD` | Password used to open this dashboard |
| `SESSION_SECRET` | HMAC secret used to sign dashboard sessions |

The WAAREE password hash is generated locally by the setup script. These
values are sent to Cloudflare as Worker secrets and are not committed to the
repository.

### 3. Configure the plant

Edit `wrangler.jsonc`:

| Variable | Example | Purpose |
| --- | --- | --- |
| `LAT`, `LON` | `21.1292`, `86.7323` | Sunrise/sunset and weather forecast |
| `PANEL_COUNT` | `6` | Number of panels |
| `PANEL_W` | `585` | Panel wattage |
| `INVERTER_KW` | `3.3` | AC inverter limit used by charts/forecast |
| `TILT` | `26` | Panel tilt in degrees from flat |
| `AZIMUTH` | `0` | `0` south, `-90` east, `90` west |
| `FORECAST` | `1` | Set to `0` to disable weather forecasting |

WAAREE may report a rounded plant size, so the panel and inverter values can be
used to override it with your actual hardware.

## Forecasting

Once an hour, the Worker fetches irradiance data from
[Open-Meteo](https://open-meteo.com/) and estimates production from:

1. irradiance on the configured panel angle,
2. installed panel capacity,
3. a temperature correction,
4. a performance ratio calibrated from recent real production, and
5. the inverter's AC limit.

A local clear-sky model provides the ideal-weather comparison shown on the
chart.

## Local development

You can run the dashboard without a WAAREE account by using the bundled
fixtures.

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

Useful development variables:

```text
MOCK=1
MOCK_SCENARIO=design|night
MOCK_NOW=YYYY-MM-DDTHH:MM
```

`MOCK_NOW` uses plant-local IST. Local KV state lives under `.wrangler/state`,
so remove that local state when you need a completely fresh mock run.

### Checks

```bash
npm run typecheck
npm test
```

Run a single test file with:

```bash
npx vitest run test/forecast.test.ts
```

## Project structure

```text
src/
  index.ts       request routing, auth gate, scheduled poll
  client.ts      WAAREE / FoxESS API client
  poll.ts        polling and state refresh
  history.ts     day/month history endpoints and caching
  mapping.ts     upstream responses → dashboard model
  model.ts       Worker ↔ frontend state contract
  forecast.ts    forecast, clear-sky model, calibration
  events.ts      power-cut / alarm event detection
  mock.ts        fixture-backed mock mode
  auth.ts        password sessions and rate limiting

web/             source UI — edit this
public/          generated static assets — do not edit directly
test/            Vitest tests
scripts/         setup, secret configuration, asset sync
```

`web/` is the source of truth for frontend assets. `npm run dev` and
`npm run deploy` sync it into `public/` automatically.

## API and caching

- `GET /api/state` returns the latest cached dashboard state.
- `GET /api/day` loads a specific day's curve/history.
- `GET /api/month` loads a month of historical production.
- live figures refresh every poll round;
- slower-changing history, devices, alarms, yesterday's curve, and forecast
  are refreshed on longer cadences to reduce upstream calls and KV writes.

## Energy meter support

Some WAAREE installations expose only inverter production. Home consumption,
grid import/export, and related meter fields are available only when the plant
has a compatible energy meter.

The dashboard detects this and hides unavailable values instead of presenting
zeroes as real measurements.

## Security model

WAAREE Solar Dashboard is designed as a single-household dashboard rather than a multi-user
service.

- One shared dashboard password protects the app.
- Sessions use an HMAC-signed `__Host-` cookie.
- Failed login attempts are rate-limited per IP in KV.
- WAAREE credentials remain server-side.
- Browser CSP only permits same-origin network requests.

WAAREE allows one active session per account. Running local development with
real credentials while the production Worker is active can cause the two
sessions to invalidate each other.

## Regional assumptions

The current implementation is optimized for India:

- timezone: IST / UTC+5:30;
- currency: INR;
- formatting: `en-IN`;
- some date/time code still assumes a `330` minute offset directly.

Supporting other regions cleanly would require moving those remaining
assumptions into configuration.

## Deployment notes

The dashboard is designed to fit comfortably into a small personal Cloudflare
Workers deployment. Actual Cloudflare quotas and pricing can change, so check
the current Workers and KV limits for your account before relying on a specific
free-tier allowance.

To use a custom domain, add a `routes` entry to `wrangler.jsonc` and redeploy.

## License

MIT — see [LICENSE](LICENSE).

This project is independent and is not affiliated with, endorsed by, or
supported by WAAREE or FoxESS. The API integration is based on reverse
engineering of the official Android app's network behavior.
