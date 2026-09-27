// Simple password auth: HMAC-signed session cookie, constant-time password
// compare, brute-force throttling via a KV counter. No accounts, no OAuth —
// this dashboard is single-user (whoever knows the shared password).

const COOKIE_NAME = "__Host-solar";
const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const MAX_FAILED_ATTEMPTS = 10;
const FAILED_WINDOW_SECONDS = 15 * 60;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toHex(sig);
}

/** Constant-time string compare (equal-length inputs padded first so length
 * itself doesn't leak via early exit). */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    const x = i < aBytes.length ? aBytes[i]! : 0;
    const y = i < bBytes.length ? bBytes[i]! : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

/** Builds the signed cookie value "<expiryUnixSeconds>.<hmacHex>". */
async function makeSessionValue(secret: string, expiry: number): Promise<string> {
  const payload = String(expiry);
  const sig = await sign(payload, secret);
  return `${payload}.${sig}`;
}

async function verifySessionValue(value: string, secret: string): Promise<boolean> {
  const dot = value.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expiry = parseInt(payload, 10);
  if (!Number.isFinite(expiry)) return false;
  if (Date.now() / 1000 > expiry) return false;
  const expected = await sign(payload, secret);
  return constantTimeEqual(sig, expected);
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export async function isAuthenticated(req: Request, sessionSecret: string): Promise<boolean> {
  const cookie = getCookie(req, COOKIE_NAME);
  if (!cookie) return false;
  return verifySessionValue(cookie, sessionSecret);
}

export async function makeSessionCookie(sessionSecret: string): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const value = await makeSessionValue(sessionSecret, expiry);
  return [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_SECONDS}`,
  ].join("; ");
}

export function clearedSessionCookie(): string {
  return [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=0"].join("; ");
}

// --- Brute-force throttling -------------------------------------------------

function bruteForceKey(ip: string): string {
  return `loginfail:${ip}`;
}

export async function isRateLimited(kv: KVNamespace, ip: string): Promise<boolean> {
  const raw = await kv.get(bruteForceKey(ip));
  if (!raw) return false;
  const count = parseInt(raw, 10);
  return Number.isFinite(count) && count >= MAX_FAILED_ATTEMPTS;
}

export async function recordFailedLogin(kv: KVNamespace, ip: string): Promise<void> {
  const key = bruteForceKey(ip);
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  await kv.put(key, String(count + 1), { expirationTtl: FAILED_WINDOW_SECONDS });
}

export async function clearFailedLogins(kv: KVNamespace, ip: string): Promise<void> {
  await kv.delete(bruteForceKey(ip));
}

export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "unknown";
}

// --- Login page --------------------------------------------------------------

export function loginPageHtml(opts: { error?: boolean } = {}): string {
  const errorBlock = opts.error
    ? `<p class="error" role="alert">Wrong password. Try again.</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Solar</title>
<style>
  @font-face {
    font-family: 'Schibsted Grotesk';
    src: url('/font.woff2') format('woff2');
    font-weight: 500 600;
    font-display: swap;
  }
  :root {
    color-scheme: light dark;
    --sky-top: #cfe6f5;
    --sky-bottom: #eaf1f6;
    --paper: #ffffff;
    --ink: #1b2430;
    --ink-dim: #5b6672;
    --leaf: #2f8f4e;
    --leaf-dark: #24713d;
    --error: #c23b3b;
    --border: rgba(27, 36, 48, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --sky-top: #0e2233;
      --sky-bottom: #142b3d;
      --paper: #1b2733;
      --ink: #eef3f7;
      --ink-dim: #a9b6c2;
      --leaf: #3fae66;
      --leaf-dark: #2f8f4e;
      --border: rgba(255, 255, 255, 0.08);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    font-family: 'Schibsted Grotesk', system-ui, -apple-system, sans-serif;
    background: linear-gradient(180deg, var(--sky-top), var(--sky-bottom));
    color: var(--ink);
  }
  .card {
    width: 100%;
    max-width: 360px;
    background: var(--paper);
    border-radius: 20px;
    padding: 32px 28px;
    box-shadow: 0 20px 60px rgba(20, 30, 45, 0.15);
    border: 1px solid var(--border);
  }
  h1 { font-size: 22px; margin: 0 0 8px; font-weight: 600; }
  p.lead { margin: 0 0 24px; color: var(--ink-dim); font-size: 15px; line-height: 1.5; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--ink-dim); }
  input[type="password"] {
    width: 100%;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--ink);
    font-size: 16px;
    font-family: inherit;
    margin-bottom: 16px;
  }
  input[type="password"]:focus { outline: 2px solid var(--leaf); outline-offset: 1px; }
  button {
    width: 100%;
    padding: 12px 14px;
    border-radius: 12px;
    border: none;
    background: var(--leaf);
    color: white;
    font-size: 16px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  button:hover { background: var(--leaf-dark); }
  p.error { color: var(--error); font-size: 14px; margin: -8px 0 16px; }
</style>
</head>
<body>
  <main class="card">
    <h1>Solar</h1>
    <p class="lead">Enter the dashboard password.</p>
    ${errorBlock}
    <form method="POST" action="/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Open dashboard</button>
    </form>
  </main>
</body>
</html>`;
}
