// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import ltaSample from "../fixtures/lta-availability.sample.json";
import type { OsmFile } from "../shared/domain";
import { DAILY_CAP, receivedOn } from "../shared/feedback";
import { normaliseLta } from "../shared/lta";
import { osmRegistry } from "../shared/osm";
import osmFile from "./osm-carparks.json";
import { DIGEST_CRON, DIGEST_TO, PURGE_CRON, digestEmail, feedbackCron, feedbackRoute } from "./feedback";
import worker, { type Env } from "./index";
import { createTestD1 } from "./test-d1";

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const allow = () => ({ limit: vi.fn(async () => ({ success: true })) });
const env = (overrides: Partial<Env> = {}): Env & { DB: ReturnType<typeof createTestD1> } =>
  ({ DB: createTestD1(), ASSETS: { fetch: async () => new Response("asset") }, FEEDBACK_LIMITER: allow(), ...overrides }) as unknown as Env & {
    DB: ReturnType<typeof createTestD1>;
  };
const sameSite = { "sec-fetch-site": "same-origin", origin: "https://parkwhere.test", "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" };
const post = (e: Env, body: unknown, headers: Record<string, string> = sameSite, method = "POST") =>
  worker.fetch(
    new Request("https://parkwhere.test/api/feedback", { method, headers, body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body) }),
    e,
    ctx
  );
const rows = (e: { DB: ReturnType<typeof createTestD1> }) => e.DB.raw.prepare("SELECT * FROM feedback ORDER BY id").all() as Record<string, unknown>[];

const report = { kind: "carpark", reason: "closed", source: "hdb", carparkId: "ACB", note: "Gantry closed for works", appVersion: "2026-10-20.abc1234" };
const osmId = osmRegistry(osmFile as OsmFile)[0].id;

describe("POST /api/feedback", () => {
  it("stores a report with the SGT date and nothing about the sender", async () => {
    const e = env();
    const response = await post(e, report);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const [row] = rows(e);
    expect(row).toMatchObject({ kind: "carpark", reason: "closed", carpark_id: "ACB", source: "hdb", shown: null, note: "Gantry closed for works", app_version: "2026-10-20.abc1234", status: "new", closed_on: null });
    expect(row.received_on).toBe(receivedOn(new Date()));
    expect(Object.keys(row).sort()).toEqual(["app_version", "carpark_id", "closed_on", "id", "kind", "note", "note_hash", "reason", "received_on", "shown", "source", "status"]);
    // The limiter is keyed on the IP address, but it's stored nowhere.
    expect(e.FEEDBACK_LIMITER!.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
    expect(JSON.stringify(rows(e))).not.toContain("203.0.113.7");
  });

  it("stores what the card showed on a count report, and general feedback with no carpark", async () => {
    const e = env();
    expect((await post(e, { kind: "carpark", reason: "count", source: "hdb", carparkId: "ACB", shown: "41 car lots available out of 143, reported 20 Oct 10:02" })).status).toBe(204);
    expect((await post(e, { kind: "general", reason: "missing", note: "Behind Blk 12 Bedok North" })).status).toBe(204);
    expect(rows(e).map((row) => [row.reason, row.shown, row.carpark_id])).toEqual([
      ["count", "41 car lots available out of 143, reported 20 Oct 10:02", "ACB"],
      ["missing", null, null]
    ]);
  });

  it("accepts LTA and OpenStreetMap carparks that ParkWhere lists", async () => {
    const e = env();
    const lta = normaliseLta(ltaSample.value, new Date());
    e.DB.raw.prepare("INSERT INTO lta_snapshot (id, fetched_at, payload) VALUES (1, ?, ?)").run(lta.fetchedAt, JSON.stringify(lta));
    expect((await post(e, { kind: "carpark", reason: "count", source: "lta", carparkId: "lta:1", shown: "967 car lots available, as reported by LTA, no time or total" })).status).toBe(204);
    expect((await post(e, { kind: "carpark", reason: "not-carpark", source: "osm", carparkId: osmId })).status).toBe(204);
    // An LTA id sent as URA doesn't match.
    expect((await post(e, { kind: "carpark", reason: "closed", source: "ura", carparkId: "lta:1" })).status).toBe(400);
    expect(rows(e)).toHaveLength(2);
  });

  it("drops a report with the hidden field filled in, answering as if it were sent", async () => {
    const e = env();
    expect((await post(e, { ...report, website: "https://spam.example" })).status).toBe(204);
    expect(rows(e)).toEqual([]);
  });

  it("refuses cross-origin requests and requests with neither header", async () => {
    const e = env();
    expect((await post(e, report, { ...sameSite, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(e, report, { ...sameSite, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(e, report, { "content-type": "application/json" })).status).toBe(403);
    expect(rows(e)).toEqual([]);
  });

  it("answers other methods with 405", async () => {
    expect((await post(env(), null, sameSite, "GET")).status).toBe(405);
  });

  it("rejects reasons that don't fit the source, unknown carparks and oversized bodies, calmly", async () => {
    const e = env();
    const rates = await post(e, { ...report, source: "osm", carparkId: osmId, reason: "rates" });
    expect(rates.status).toBe(400);
    expect(await rates.json()).toEqual({ error: "That reason doesn't apply to this carpark." });
    const unknown = await post(e, { ...report, carparkId: "NOPE1" });
    expect(await unknown.json()).toEqual({ error: "ParkWhere doesn't list that carpark." });
    expect((await post(e, { ...report, source: "osm", carparkId: "osm:way/1" })).status).toBe(400);
    // No LTA snapshot: no LTA carpark can be confirmed.
    expect((await post(e, { ...report, source: "lta", carparkId: "lta:1" })).status).toBe(400);
    expect((await post(e, { ...report, reason: "other", note: "" })).status).toBe(400);
    expect((await post(e, JSON.stringify({ ...report, note: "x".repeat(5000) }))).status).toBe(400);
    expect(rows(e)).toEqual([]);
  });

  it("never echoes or logs the note", async () => {
    const e = env();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      e.DB.raw.exec("DROP TABLE feedback");
      const secret = "Call me on 9123 4567";
      const response = await post(e, { ...report, note: secret });
      expect(await response.text()).not.toContain("9123");
      expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toContain("9123");
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("drops a same-day duplicate of the same carpark, reason and note", async () => {
    const e = env();
    expect((await post(e, report)).status).toBe(204);
    expect((await post(e, { ...report, note: "gantry  CLOSED for works " })).status).toBe(204);
    expect((await post(e, { ...report, note: "Barrier down" })).status).toBe(204);
    expect((await post(e, { ...report, reason: "access" })).status).toBe(204);
    expect(rows(e).map((row) => [row.reason, row.note])).toEqual([
      ["closed", "Gantry closed for works"],
      ["closed", "Barrier down"],
      ["access", "Gantry closed for works"]
    ]);
  });

  it("answers 429 when the visitor is over the limit", async () => {
    const e = env({ FEEDBACK_LIMITER: { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit });
    const response = await post(e, report);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Too many reports in a short time. Wait a minute and try again." });
    expect(rows(e)).toEqual([]);
  });

  it("stops at the daily cap, inside the insert", async () => {
    const e = env();
    const now = new Date("2026-10-20T04:00:00Z");
    const insert = e.DB.raw.prepare("INSERT INTO feedback (received_on, kind, reason, note_hash) VALUES (?, 'general', 'idea', ?)");
    for (let i = 0; i < DAILY_CAP - 1; i += 1) insert.run("2026-10-20", `hash-${i}`);
    insert.run("2026-10-19", "yesterday");
    const send = (body: unknown) =>
      feedbackRoute(new Request("https://parkwhere.test/api/feedback", { method: "POST", headers: sameSite, body: JSON.stringify(body) }), new URL("https://parkwhere.test/api/feedback"), e, async () => true, now);
    expect((await send(report)).status).toBe(204);
    const full = await send({ ...report, note: "Another one" });
    expect(full.status).toBe(429);
    expect(await full.json()).toEqual({ error: "ParkWhere has had a lot of reports today. Try again tomorrow." });
    const count = e.DB.raw.prepare("SELECT COUNT(*) AS n FROM feedback WHERE received_on = '2026-10-20'").get() as { n: number };
    expect(count.n).toBe(DAILY_CAP);
  });

  it("answers 503 when the table or the limiter is missing, as in a preview before the migration", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const e = env();
      e.DB.raw.exec("DROP TABLE feedback");
      const missingTable = await post(e, report);
      expect(missingTable.status).toBe(503);
      expect(await missingTable.json()).toEqual({ error: "Feedback isn't available right now." });
      const noLimiter = env({ FEEDBACK_LIMITER: undefined });
      expect((await post(noLimiter, report)).status).toBe(503);
      expect(rows(noLimiter)).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});

describe("feedback Cron", () => {
  const seed = (e: { DB: ReturnType<typeof createTestD1> }) => {
    const insert = e.DB.raw.prepare("INSERT INTO feedback (received_on, kind, reason, source, carpark_id, note, note_hash, status, closed_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("2026-10-18", "carpark", "count", "hdb", "ACB", "Private note one", "a", "new", null);
    insert.run("2026-10-01", "carpark", "closed", "osm", "osm:way/1", "Private note two", "b", "new", null);
    insert.run("2026-09-01", "general", "missing", null, null, "Private note three", "c", "new", null);
    insert.run("2026-03-01", "carpark", "closed", "hdb", "ACB", "closed long ago", "d", "done", "2026-04-23");
    insert.run("2026-04-01", "carpark", "closed", "hdb", "ACB", "closed recently", "e", "done", "2026-04-24");
    insert.run("2025-10-20", "general", "idea", null, null, "a year old", "f", "new", null);
    insert.run("2025-10-21", "general", "idea", null, null, "just under a year", "g", "new", null);
  };

  it("deletes reports 180 days after closing, and 12 months after receipt at the latest", async () => {
    const e = env();
    seed(e);
    await feedbackCron(PURGE_CRON, e, new Date("2026-10-20T01:00:00Z"));
    expect(rows(e).map((row) => row.note)).toEqual(["Private note one", "Private note two", "Private note three", "closed recently", "just under a year"]);
  });

  it("runs from the Worker's scheduled handler", async () => {
    const e = env();
    e.DB.raw.prepare("INSERT INTO feedback (received_on, kind, reason, note, note_hash) VALUES ('2020-01-01', 'general', 'idea', 'old', 'x')").run();
    await worker.scheduled!({ cron: PURGE_CRON, scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, e);
    expect(rows(e)).toEqual([]);
  });

  it("emails counts only, with no note text, and only when something is new", async () => {
    const send = vi.fn(async (_message: unknown) => ({ messageId: "1" }));
    const e = env({ FEEDBACK_EMAIL: { send } as unknown as SendEmail });
    await feedbackCron(DIGEST_CRON, e, new Date("2026-10-20T00:00:00Z"));
    expect(send).not.toHaveBeenCalled();
    seed(e);
    await feedbackCron(DIGEST_CRON, e, new Date("2026-10-20T00:00:00Z"));
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0] as { from: { email: string }; to: string; subject: string; text: string };
    expect(message.to).toBe(DIGEST_TO);
    expect(message.from.email).toBe("parkwhere@bijan.app");
    expect(message.subject).toBe("ParkWhere feedback: 5 new reports");
    expect(message.text).toContain("New reports waiting: 5 (1 report arrived in the last 7 days).");
    expect(message.text).toContain("- The count looks wrong: 1");
    expect(message.text).toContain("- General feedback: 3");
    expect(message.text).toContain("Run `pnpm feedback` to read them.");
    expect(JSON.stringify(message)).not.toMatch(/Private note|a year old/);
  });

  it("does nothing without the email binding, and marks the staging digest", async () => {
    const e = env();
    seed(e);
    await expect(feedbackCron(DIGEST_CRON, e, new Date())).resolves.toBeUndefined();
    const staging = digestEmail([{ reason: "idea", source: null, n: 1, week: 1 }], new Date("2026-10-20T00:00:00Z"), true);
    expect(staging?.subject).toBe("[staging] ParkWhere feedback: 1 new report");
    expect(staging?.text).toContain("pnpm feedback --staging");
  });

  it("logs and carries on when the table is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const e = env();
      e.DB.raw.exec("DROP TABLE feedback");
      await expect(feedbackCron(PURGE_CRON, e)).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe("feedback config", () => {
  const jsonc = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  const config = jsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

  it("schedules the purge and digest, and fixes the digest's one address, in production and staging", () => {
    for (const target of [config, config.env.staging]) {
      expect(target.triggers.crons).toEqual([PURGE_CRON, DIGEST_CRON]);
      expect(target.send_email).toEqual([{ name: "FEEDBACK_EMAIL", destination_address: DIGEST_TO }]);
      expect(target.ratelimits.find((limit: { name: string }) => limit.name === "FEEDBACK_LIMITER").simple).toEqual({ limit: 3, period: 60 });
    }
    expect(config.ratelimits.find((limit: { name: string }) => limit.name === "FEEDBACK_LIMITER").namespace_id).toBe("4205");
    expect(config.env.staging.ratelimits.find((limit: { name: string }) => limit.name === "FEEDBACK_LIMITER").namespace_id).toBe("4206");
  });

  it("gives PR previews the staging limiter but no email binding", () => {
    const preview = readFileSync(new URL("../.github/workflows/preview.yml", import.meta.url), "utf8");
    expect(preview).toContain('{ "name": "FEEDBACK_LIMITER", "namespace_id": "4206", "simple": { "limit": 3, "period": 60 } }');
    expect(preview).not.toContain('"send_email"');
    expect(preview).not.toContain('"triggers"');
  });
});
