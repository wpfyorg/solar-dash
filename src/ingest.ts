// POST /api/ingest: the stick gateway on the LAN pushes batches of inverter
// records here. Sits outside the session-cookie gate (index.ts) and is
// guarded by a bearer token instead.

import { constantTimeEqual } from "./auth";
import type { Env } from "./env";
import { parseRecord, storeRecords, stickEnabled, type StickRecord } from "./stick";

const MAX_BODY = 1_000_000;
const MAX_RECORDS = 2000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function handleIngest(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!stickEnabled(env)) return json({ error: "ingest not configured" }, 404);

  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!constantTimeEqual(token, env.INGEST_TOKEN!)) return json({ error: "unauthorized" }, 401);

  const len = Number(req.headers.get("Content-Length") ?? "0");
  if (len > MAX_BODY) return json({ error: "too large" }, 413);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: "too large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const list = (body as { records?: unknown })?.records;
  if (!Array.isArray(list) || list.length > MAX_RECORDS) return json({ error: "records must be an array of up to 2000" }, 400);

  const now = Math.floor(Date.now() / 1000);
  const recs: StickRecord[] = [];
  for (const x of list) {
    const r = parseRecord(x, now);
    if (r) recs.push(r);
  }
  const added = await storeRecords(env, recs);
  return json({ ok: true, received: list.length, valid: recs.length, added });
}
