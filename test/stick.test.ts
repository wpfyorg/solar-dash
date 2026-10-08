import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleIngest } from "../src/ingest";
import { unconfiguredState } from "../src/model";
import {
  dayProducedWh,
  fillMonthDays,
  loadLink,
  localDate,
  localHHMM,
  mergeRecords,
  overlayStick,
  parseRecord,
  type StickRecord,
} from "../src/stick";

class FakeKV {
  store = new Map<string, string>();
  puts = 0;
  async get(k: string) {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.puts++;
    this.store.set(k, v);
  }
}

function env(kv: FakeKV, over: Partial<Env> = {}): Env {
  return { SOLAR_KV: kv as unknown as KVNamespace, TZ_OFFSET_MIN: "330", INGEST_TOKEN: "sekrit", ...over } as Env;
}

// 2026-10-08 00:00 IST
const DAY0 = Date.UTC(2026, 9, 7, 18, 30) / 1000;

function rec(offsetS: number, ac_w: number, life_wh = 0): StickRecord {
  return { t: DAY0 + offsetS, ac_w, grid_v: 230, hz: 50, pv_v: 250, pv_a: 1, temp_a: 30, life_wh, state: 2 };
}

/** Samples every 5 minutes from 06:00 to 12:00 ramping to `peak` W. */
function morning(peak = 2000, life0 = 600_000): StickRecord[] {
  const out: StickRecord[] = [];
  let life = life0;
  for (let s = 6 * 3600; s <= 12 * 3600; s += 300) {
    const w = Math.round(peak * Math.sin(((s - 6 * 3600) / (12 * 3600 - 6 * 3600)) * (Math.PI / 2)));
    out.push(rec(s, w, life));
    life += (w * 300) / 3600;
  }
  return out.map((r) => ({ ...r, life_wh: Math.round(r.life_wh / 100) * 100 }));
}

describe("local time", () => {
  it("maps real time to plant-local date and clock", () => {
    expect(localDate(DAY0 + 3600, 330)).toBe("2026-10-08");
    expect(localDate(DAY0 - 1, 330)).toBe("2026-10-07");
    expect(localHHMM(DAY0 + 6 * 3600 + 25 * 60, 330)).toBe("06:25");
  });
});

describe("parseRecord", () => {
  const now = DAY0 + 3600;
  it("accepts a gateway record and rejects junk", () => {
    expect(parseRecord({ t: DAY0, ac_w: 100.4, life_wh: 5 }, now)).toMatchObject({ t: DAY0, ac_w: 100, life_wh: 5 });
    expect(parseRecord(null, now)).toBeNull();
    expect(parseRecord({ t: "x", ac_w: 1 }, now)).toBeNull();
    expect(parseRecord({ t: 5, ac_w: 1 }, now)).toBeNull(); // 1970
    expect(parseRecord({ t: now + 3 * 86400, ac_w: 1 }, now)).toBeNull();
    expect(parseRecord({ t: DAY0, ac_w: -3 }, now)).toBeNull();
  });
});

describe("mergeRecords", () => {
  it("dedupes within a minute, keeps order, ignores resends", () => {
    const a = [rec(100, 1), rec(400, 2)];
    const m = mergeRecords(a, [rec(430, 9), rec(250, 5), rec(100, 1), rec(700, 3)]);
    expect(m.map((r) => r.t - DAY0)).toEqual([100, 250, 400, 700]);
    expect(m[2]!.ac_w).toBe(2); // the held record wins over the near-duplicate
  });
});

describe("dayProducedWh", () => {
  it("uses the lifetime counter and agrees with the integral", () => {
    const d = morning();
    const counter = d[d.length - 1]!.life_wh - d[0]!.life_wh;
    expect(dayProducedWh(d)).toBe(counter);
    let integ = 0;
    for (let i = 1; i < d.length; i++) integ += ((d[i]!.ac_w + d[i - 1]!.ac_w) / 2) * (300 / 3600);
    expect(Math.abs(counter - integ) / integ).toBeLessThan(0.02);
  });
  it("falls back to the integral without a usable counter", () => {
    const d = morning().map((r) => ({ ...r, life_wh: 0 }));
    expect(dayProducedWh(d)).toBeGreaterThan(5000);
    expect(dayProducedWh([])).toBe(0);
  });
  it("does not integrate across a long silence", () => {
    const d = [rec(0, 1000), rec(300, 1000), rec(5 * 3600, 1000)].map((r) => ({ ...r, life_wh: 0 }));
    expect(dayProducedWh(d)).toBeCloseTo(1000 * (300 / 3600), 3);
  });
});

describe("POST /api/ingest", () => {
  const post = (kv: FakeKV, body: unknown, token = "sekrit", over: Partial<Env> = {}) =>
    handleIngest(
      new Request("https://x/api/ingest", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      env(kv, over)
    );

  it("rejects bad tokens, wrong methods, and when not configured", async () => {
    const kv = new FakeKV();
    expect((await post(kv, { records: [] }, "nope")).status).toBe(401);
    expect((await post(kv, { records: [] }, "sekrit", { INGEST_TOKEN: undefined })).status).toBe(404);
    const get = await handleIngest(new Request("https://x/api/ingest"), env(kv));
    expect(get.status).toBe(405);
    expect((await post(kv, { nope: 1 })).status).toBe(400);
    expect(kv.puts).toBe(0);
  });

  it("stores per local day, dedupes resends, writes once per day touched", async () => {
    const kv = new FakeKV();
    const yday = [{ ...rec(-3600, 500, 100) }];
    const recs = [...yday, ...morning()];
    const r1 = await (await post(kv, { records: recs })).json();
    expect(r1).toMatchObject({ ok: true, received: recs.length, valid: recs.length, added: recs.length });
    expect(kv.puts).toBe(2);
    expect([...kv.store.keys()].sort()).toEqual(["stick:2026-10-07", "stick:2026-10-08"]);
    const again = await (await post(kv, { records: recs })).json();
    expect(again).toMatchObject({ added: 0 });
    expect(kv.puts).toBe(2); // nothing new, nothing written
  });
});

describe("WAAREE link", () => {
  const post = (kv: FakeKV, body: unknown) =>
    handleIngest(new Request("https://x", { method: "POST", headers: { Authorization: "Bearer sekrit" }, body: JSON.stringify(body) }), env(kv));
  const since = DAY0 + 100;

  it("is stored on change only, with no records needed", async () => {
    const kv = new FakeKV();
    expect(await loadLink(env(kv))).toBeNull();
    expect(await (await post(kv, { records: [], link: { mode: "down", since } })).json()).toMatchObject({ link_changed: true });
    expect(kv.puts).toBe(1);
    expect(await loadLink(env(kv))).toEqual({ mode: "down", since: "2026-10-07T18:31:40Z" });
    expect(await (await post(kv, { records: [], link: { mode: "down", since: since + 60 } })).json()).toMatchObject({ link_changed: false });
    expect(kv.puts).toBe(1);
    await post(kv, { records: [], link: { mode: "relaying", since: since + 120 } });
    expect((await loadLink(env(kv)))!.mode).toBe("relaying");
    expect(kv.puts).toBe(2);
  });

  it("ignores junk", async () => {
    const kv = new FakeKV();
    await post(kv, { records: [], link: { mode: "weird", since } });
    await post(kv, { records: [], link: "x" });
    expect(kv.puts).toBe(0);
  });
});

describe("overlayStick", () => {
  const nowSec = DAY0 + 12 * 3600 + 120;

  it("does nothing without data or when ingest is off", async () => {
    const kv = new FakeKV();
    const st = unconfiguredState("2026-10-08T06:30:00Z");
    expect(await overlayStick(env(kv), st, nowSec)).toBe(false);
    await handleIngest(
      new Request("https://x", { method: "POST", headers: { Authorization: "Bearer sekrit" }, body: JSON.stringify({ records: morning() }) }),
      env(kv)
    );
    expect(await overlayStick(env(kv, { INGEST_TOKEN: undefined }), st, nowSec)).toBe(false);
  });

  it("fills live, today, yesterday and the month from the stick when it is fresher", async () => {
    const kv = new FakeKV();
    const e = env(kv);
    const body = { records: [...morning(1800, 500_000).map((r) => ({ ...r, t: r.t - 86400 })), ...morning(2000, 600_000)] };
    await handleIngest(new Request("https://x", { method: "POST", headers: { Authorization: "Bearer sekrit" }, body: JSON.stringify(body) }), e);

    const st = unconfiguredState("2026-10-08T06:30:00Z");
    st.plant.price_per_kwh = 5;
    st.month = {
      year: 2026,
      month: 10,
      total_wh: 0,
      best_day: null,
      days: Array.from({ length: 31 }, (_, i) => ({ day: i + 1, produced_wh: null, not_installed: false })),
    };
    expect(await overlayStick(e, st, nowSec)).toBe(true);
    expect(st.status).toBe("ok");
    expect(st.has_meter).toBe(false);
    expect(st.live.solar_w).toBe(2000);
    expect(st.live.updated_at).toBe("2026-10-08T06:30:00Z");
    expect(st.today.series[0]).toEqual({ t: "06:00", solar_w: 0 });
    expect(st.today.series[st.today.series.length - 1]).toEqual({ t: "12:00", solar_w: 2000 });
    expect(st.today.peak_w).toBe(2000);
    expect(st.today.peak_at).toBe("11:55"); // first sample to reach the peak
    expect(st.today.produced_wh).toBeGreaterThan(5000);
    expect(st.today.earned).toBeCloseTo((st.today.produced_wh / 1000) * 5, 6);
    expect(st.yesterday.series.length).toBeGreaterThan(50);
    expect(st.month.days[7]!.produced_wh).toBe(st.today.produced_wh); // Oct 8
    expect(st.month.days[6]!.produced_wh).toBe(st.yesterday.produced_wh); // Oct 7
    expect(st.month.total_wh).toBe(st.today.produced_wh + st.yesterday.produced_wh);
    expect(st.month.best_day!.day).toBe(8);
  });

  it("stays out of the way when WAAREE's data is newer", async () => {
    const kv = new FakeKV();
    const e = env(kv);
    await handleIngest(new Request("https://x", { method: "POST", headers: { Authorization: "Bearer sekrit" }, body: JSON.stringify({ records: morning() }) }), e);
    const st = unconfiguredState("2026-10-08T06:31:00Z");
    st.live.updated_at = "2026-10-08T06:31:00Z";
    expect(await overlayStick(e, st, nowSec)).toBe(false);
    expect(st.today.series).toHaveLength(0);
  });

  it("reports a stale stick as zero output, not ok", async () => {
    const kv = new FakeKV();
    const e = env(kv);
    await handleIngest(new Request("https://x", { method: "POST", headers: { Authorization: "Bearer sekrit" }, body: JSON.stringify({ records: morning() }) }), e);
    const st = unconfiguredState("2026-10-08T09:00:00Z");
    expect(await overlayStick(e, st, nowSec + 3 * 3600)).toBe(true);
    expect(st.status).toBe("unconfigured");
    expect(st.live.solar_w).toBe(0);
  });
});

describe("fillMonthDays", () => {
  it("fills only empty days and recomputes totals", () => {
    const m = {
      year: 2026,
      month: 10,
      total_wh: 3000,
      best_day: { day: 1, produced_wh: 3000 },
      days: [
        { day: 1, produced_wh: 3000, not_installed: false },
        { day: 2, produced_wh: 0, not_installed: false },
        { day: 3, produced_wh: null, not_installed: false },
      ],
    };
    expect(fillMonthDays(m, new Map([[1, 9], [2, 5000], [3, 100]]))).toBe(true);
    expect(m.days.map((d) => d.produced_wh)).toEqual([3000, 5000, 100]);
    expect(m.total_wh).toBe(8100);
    expect(m.best_day).toEqual({ day: 2, produced_wh: 5000 });
  });
});
