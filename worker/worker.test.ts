// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import sample from "../fixtures/hdb-availability.sample.json";
import ltaSample from "../fixtures/lta-availability.sample.json";
import type { NearbyResponse, OverviewResponse, SearchResponse } from "../shared/domain";
import { getFeed, getLtaFeed, resetFeedMemory } from "./feed";
import worker, { type Env } from "./index";
import { createTestD1 } from "./test-d1";
import { Effect } from "effect";
import { LTA_URL, fetchLta } from "./lta";
import { AVAILABILITY_URL } from "./upstream";

type Step = { status: number; body?: unknown } | "network-error";

function scriptedFetch(steps: Step[]) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: string) => {
    calls.push(input);
    const step = steps.length > 1 ? steps.shift()! : steps[0];
    if (step === "network-error") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status, headers: { "content-type": "application/json" } });
  });
  return { fetcher, calls };
}

const ok: Step = { status: 200, body: sample };
const noWait = () => undefined;

beforeEach(() => resetFeedMemory());

describe("getFeed", () => {
  it("fetches on first use and stores the last good snapshot", async () => {
    const db = createTestD1();
    const { fetcher, calls } = scriptedFetch([ok]);
    const read = await getFeed({ DB: db }, noWait, fetcher, new Date("2026-10-18T03:52:00Z"));
    expect(calls).toEqual([AVAILABILITY_URL]);
    expect(read.snapshot?.carparks.TBM2.C.available).toBe(232);
    expect(read.status.lastError).toBeNull();
  });

  it("retries transient upstream errors before succeeding", async () => {
    const db = createTestD1();
    const { calls, fetcher } = scriptedFetch([{ status: 503 }, { status: 429 }, ok]);
    const read = await getFeed({ DB: db }, noWait, fetcher);
    expect(calls).toHaveLength(3);
    expect(read.snapshot).not.toBeNull();
  });

  it("keeps the last good snapshot and records the error when a refresh fails", async () => {
    const db = createTestD1();
    await getFeed({ DB: db }, noWait, scriptedFetch([ok]).fetcher, new Date("2026-10-18T03:52:00Z"));
    resetFeedMemory();
    const failing = scriptedFetch([{ status: 500 }]);
    // Ten minutes later the snapshot is old enough that the request waits for a refresh.
    const read = await getFeed({ DB: db }, noWait, failing.fetcher, new Date(Date.now() + 10 * 60_000));
    expect(failing.calls).toHaveLength(3);
    expect(read.snapshot?.carparks.TBM2.C.available).toBe(232);
    expect(read.status.lastError).toBe("data.gov.sg returned HTTP 500");
  });

  it("keeps serving the snapshot it read when saving a refresh fails", async () => {
    const db = createTestD1();
    await getFeed({ DB: db }, noWait, scriptedFetch([ok]).fetcher, new Date("2026-10-18T03:52:00Z"));
    resetFeedMemory();
    const failingBatch = Object.assign(Object.create(db), {
      batch: async (statements: { sql: string }[]) => {
        if (statements.some((statement) => statement.sql.includes("INSERT INTO feed_snapshot"))) throw new Error("D1 write failed");
        return db.batch(statements as unknown as D1PreparedStatement[]);
      }
    }) as D1Database;
    const read = await getFeed({ DB: failingBatch }, noWait, scriptedFetch([ok]).fetcher, new Date(Date.now() + 10 * 60_000));
    expect(read.snapshot?.carparks.TBM2.C.available).toBe(232);
    expect(read.status.lastError).toBe("the latest check didn't finish");
  });

  it("answers within the blocking wait when data.gov.sg is slow, and finishes in the background", async () => {
    const db = createTestD1();
    const pending: Promise<unknown>[] = [];
    let release: (response: Response) => void = () => undefined;
    const slow = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const read = await getFeed({ DB: db }, (promise) => pending.push(promise), slow, new Date(), 20);
    expect(read.snapshot).toBeNull();
    expect(read.status.lastError).toBe("data.gov.sg is slow to respond.");
    release(Response.json(sample));
    await Promise.all(pending);
    resetFeedMemory();
    const later = await getFeed({ DB: db }, noWait, scriptedFetch([ok]).fetcher, new Date(Date.now() + 1_000));
    expect(later.snapshot?.carparks.TBM2.C.available).toBe(232);
  });

  it("skips a malformed record instead of rejecting the whole feed", async () => {
    const db = createTestD1();
    const withJunk = { items: [{ ...sample.items[0], carpark_data: [...sample.items[0].carpark_data, { carpark_number: 42 }, null] }] };
    const read = await getFeed({ DB: db }, noWait, scriptedFetch([{ status: 200, body: withJunk }]).fetcher);
    expect(read.snapshot?.carparks.TBM2.C.available).toBe(232);
    expect(read.status.lastError).toBeNull();
  });

  it("does not retry a non-transient error and reports bad formats", async () => {
    const db = createTestD1();
    const { calls, fetcher } = scriptedFetch([{ status: 200, body: { items: "nope" } }]);
    const read = await getFeed({ DB: db }, noWait, fetcher);
    expect(calls).toHaveLength(1);
    expect(read.snapshot).toBeNull();
    expect(read.status.lastError).toBe("data.gov.sg returned an unexpected format");
  });

  it("lets only one request refresh at a time", async () => {
    const db = createTestD1();
    const now = new Date();
    const first = scriptedFetch([{ status: 500 }]);
    await getFeed({ DB: db }, noWait, first.fetcher, now);
    resetFeedMemory();
    const second = scriptedFetch([ok]);
    await getFeed({ DB: db }, noWait, second.fetcher, new Date(now.getTime() + 5_000));
    expect(second.calls).toHaveLength(0);
  });

  it("serves a slightly old snapshot immediately and refreshes in the background", async () => {
    const db = createTestD1();
    const start = new Date();
    await getFeed({ DB: db }, noWait, scriptedFetch([ok]).fetcher, start);
    resetFeedMemory();
    const pending: Promise<unknown>[] = [];
    const later = scriptedFetch([ok]);
    const read = await getFeed({ DB: db }, (promise) => pending.push(promise), later.fetcher, new Date(start.getTime() + 2 * 60_000));
    expect(read.snapshot).not.toBeNull();
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(later.calls).toHaveLength(1);
  });
});

describe("getLtaFeed", () => {
  it("is off without an account key", () => {
    expect(getLtaFeed({ DB: createTestD1() }, noWait, scriptedFetch([ok]).fetcher)).toBeNull();
  });

  it("pages until an empty page and keeps the account key in a header", async () => {
    const seen: { url: string; key: string | null }[] = [];
    const pages = [ltaSample.value, []];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      seen.push({ url: input, key: new Headers(init?.headers).get("AccountKey") });
      return Response.json({ value: pages.shift() ?? [] });
    });
    const read = await getLtaFeed({ DB: createTestD1(), LTA_DATAMALL_ACCOUNT_KEY: "test-key" }, noWait, fetcher)!;
    expect(seen.map((call) => call.url)).toEqual([`${LTA_URL}?$skip=0`, `${LTA_URL}?$skip=9`]);
    expect(seen.every((call) => call.key === "test-key")).toBe(true);
    expect(read.snapshot?.carparks.map((carpark) => carpark.key)).toEqual(["lta:1", "lta:2", "lta:3", "ura:A0007", "ura:B0031"]);
  });

  it("follows a smaller page size than today's 500", async () => {
    const all = ltaSample.value;
    const skips: number[] = [];
    const fetcher = vi.fn(async (input: string) => {
      const skip = Number(new URL(input).searchParams.get("$skip"));
      skips.push(skip);
      return Response.json({ value: all.slice(skip, skip + 2) });
    });
    const read = await getLtaFeed({ DB: createTestD1(), LTA_DATAMALL_ACCOUNT_KEY: "test-key" }, noWait, fetcher)!;
    expect(skips).toEqual([0, 2, 4, 6, 8, 9]);
    expect(read.snapshot?.carparks).toHaveLength(5);
  });

  it("gives up cleanly when the whole paged fetch runs past its budget", async () => {
    const slowPages = vi.fn(async (_input: string, init?: RequestInit) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 60);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        });
      });
      return Response.json({ value: ltaSample.value });
    });
    const outcome = await Effect.runPromise(Effect.result(fetchLta(slowPages, "test-key", () => new Date(), 150)));
    expect(outcome._tag).toBe("Failure");
    expect(outcome._tag === "Failure" && outcome.failure.message).toMatch(/LTA DataMall (is too slow to respond|did not respond in time)/);
    expect(slowPages.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("reports a refused key without retrying", async () => {
    const { fetcher, calls } = scriptedFetch([{ status: 401 }]);
    const read = await getLtaFeed({ DB: createTestD1(), LTA_DATAMALL_ACCOUNT_KEY: "bad" }, noWait, fetcher)!;
    expect(calls).toHaveLength(1);
    expect(read.status.lastError).toBe("LTA DataMall refused the account key");
  });
});

describe("Worker routes", () => {
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const env = (overrides: Partial<Env> = {}): Env =>
    ({ DB: createTestD1(), ASSETS: { fetch: async () => new Response("asset") }, ...overrides }) as unknown as Env;

  const call = (path: string, e: Env) => worker.fetch(new Request(`https://parkwhere.test${path}`), e, ctx);

  it("validates nearby queries", async () => {
    const e = env();
    expect((await call("/api/nearby", e)).status).toBe(400);
    expect((await call("/api/nearby?lat=51.5&lng=-0.12", e)).status).toBe(422);
  });

  it("returns nearby carparks with feed status", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = scriptedFetch([ok]).fetcher as unknown as typeof fetch;
    try {
      const response = await call("/api/nearby?lat=1.30106&lng=103.85412&radius=300", env());
      expect(response.status).toBe(200);
      const body = (await response.json()) as NearbyResponse;
      expect(body.query.radiusM).toBe(300);
      expect(body.carparks[0].id).toBe("ACB");
      expect(body.feed.fetchedAt).not.toBeNull();
      expect(body.registry.count).toBeGreaterThan(2000);
      expect(body.carparks.some((carpark) => carpark.id === "TPL")).toBe(false); // loading bay
    } finally {
      globalThis.fetch = original;
    }
  });

  it("returns every short-term carpark as a map dot with honest counts", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = scriptedFetch([ok]).fetcher as unknown as typeof fetch;
    try {
      const response = await call("/api/overview", env());
      expect(response.status).toBe(200);
      const body = (await response.json()) as OverviewResponse;
      expect(body.points.length).toBe(body.counts.carparks);
      expect(body.counts.carparks).toBeGreaterThan(2000);
      expect(body.points.every(([lat, lng, code]) => lat > 1.1 && lat < 1.5 && lng > 103.5 && lng < 104.1 && code >= 0 && code <= 4)).toBe(true);
      // The fixture holds only a handful of carparks, and its records are hours old by now: none count as current.
      expect(body.counts.withSpaces).toBeLessThanOrEqual(body.counts.reporting);
      expect(body.points.filter(([, , code]) => code !== 0).length).toBe(body.counts.reporting);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("shows LTA carparks as grey dots on the overview, outside the 'reporting' count", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(LTA_URL)) return url.endsWith("$skip=0") ? Response.json({ value: ltaSample.value }) : Response.json({ value: [] });
      return Response.json(sample);
    }) as typeof fetch;
    try {
      const withLta = (await (await call("/api/overview", env({ LTA_DATAMALL_ACCOUNT_KEY: "test-key" }))).json()) as OverviewResponse;
      resetFeedMemory();
      const without = (await (await call("/api/overview", env())).json()) as OverviewResponse;
      // Five LTA and URA dots are added. OpenStreetMap carparks that duplicate them are left out, so the
      // total grows by at most five.
      expect(withLta.counts.carparks).toBeGreaterThan(without.counts.carparks);
      expect(withLta.counts.carparks).toBeLessThanOrEqual(without.counts.carparks + 5);
      expect(withLta.lta?.state).toBe("live");
      expect(without.lta).toBeNull();
      expect(withLta.counts.reporting).toBe(without.counts.reporting);
      const suntec = withLta.points.find(([lat, lng]) => lat === 1.29375 && lng === 103.85718);
      expect(suntec?.[2]).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("adds LTA and URA carparks next to HDB ones, and keeps them apart when one feed fails", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(LTA_URL)) return url.endsWith("$skip=0") ? Response.json({ value: ltaSample.value }) : Response.json({ value: [] });
      return Response.json(sample);
    }) as typeof fetch;
    try {
      const body = (await (await call("/api/nearby?lat=1.29375&lng=103.85718&radius=500", env({ LTA_DATAMALL_ACCOUNT_KEY: "test-key" }))).json()) as NearbyResponse;
      const suntec = body.carparks.find((carpark) => carpark.id === "lta:1");
      expect(suntec).toMatchObject({ source: "lta", address: "Suntec City", car: { reportedBy: "LTA", available: 967, total: null, recordedAt: null } });
      // OpenStreetMap also maps Suntec City, 89 m away; it's the same carpark, so it isn't listed again without a count.
      expect(body.carparks.filter((carpark) => /suntec city/i.test(carpark.address))).toHaveLength(1);
      expect(body.lta?.state).toBe("live");
    } finally {
      globalThis.fetch = original;
    }
    resetFeedMemory();
    globalThis.fetch = (async (input: RequestInfo | URL) => (String(input).startsWith(LTA_URL) ? new Response("", { status: 503 }) : Response.json(sample))) as typeof fetch;
    try {
      const body = (await (await call("/api/nearby?lat=1.30106&lng=103.85412", env({ LTA_DATAMALL_ACCOUNT_KEY: "test-key" }))).json()) as NearbyResponse;
      expect(body.lta).toMatchObject({ state: "unavailable", refreshError: "LTA DataMall returned HTTP 503" });
      expect(body.feed.state).not.toBe("unavailable");
      resetFeedMemory();
      const overview = (await (await call("/api/overview", env({ LTA_DATAMALL_ACCOUNT_KEY: "test-key" }))).json()) as OverviewResponse;
      expect(overview.lta).toMatchObject({ state: "unavailable", refreshError: "LTA DataMall returned HTTP 503" });
      expect(body.carparks[0].id).toBe("ACB");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("lists public carparks mapped on OpenStreetMap, with no count and no price", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = scriptedFetch([ok]).fetcher as unknown as typeof fetch;
    try {
      // Singapore Zoo, as OneMap places it. No HDB carpark is within 2 km.
      const body = (await (await call("/api/nearby?lat=1.40433&lng=103.79304&radius=500", env())).json()) as NearbyResponse;
      const zoo = body.carparks.find((carpark) => carpark.id === "osm:way/177625322");
      expect(zoo).toMatchObject({
        source: "osm",
        address: "Wildlife Reserves Singapore carpark",
        carparkType: "Multi-storey carpark",
        osm: { url: "https://www.openstreetmap.org/way/177625322", access: "yes", atEntrance: true, named: false },
        car: { reportedBy: null, state: "not-in-feed", available: null }
      });
      expect(body.withinRadius).toBeGreaterThanOrEqual(1);
      const health = (await (await call("/health", env())).json()) as { osmCarparks: number };
      expect(health.osmCarparks).toBeGreaterThan(200);
    } finally {
      globalThis.fetch = original;
    }
  });

  describe("usage counts", () => {
    const ua = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1" };
    const recorder = () => {
      const points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
      return { points, EVENTS: { writeDataPoint: (point: { indexes: string[]; blobs: string[]; doubles: number[] }) => points.push(point) } };
    };
    const get = (path: string, e: Env, headers: Record<string, string> = ua) => worker.fetch(new Request(`https://parkwhere.test${path}`, { headers }), e, ctx);

    it("counts a lookup once per destination, with a visit on the page's first request", async () => {
      const original = globalThis.fetch;
      globalThis.fetch = scriptedFetch([ok]).fetcher as unknown as typeof fetch;
      try {
        const { points, EVENTS } = recorder();
        const e = env({ EVENTS } as unknown as Partial<Env>);
        await get("/api/nearby?lat=1.40433&lng=103.79304&radius=500&c=1&via=search&first=1&ref=www.google.com", e);
        // A refresh carries no "via": not another lookup.
        await get("/api/nearby?lat=1.40433&lng=103.79304&radius=500&c=1", e);
        // Without c=1 (counting off in the browser) nothing is counted, even with via.
        await get("/api/nearby?lat=1.40433&lng=103.79304&radius=500&via=search", e);
        expect(points.map((point) => point.indexes[0])).toEqual(["visit", "lookup"]);
        expect(points[0].blobs).toEqual(["v1", "browser", "mobile", "", "google.com"]);
        // The zoo's OpenStreetMap carpark is 493 m away, inside 500 m, with no count; no gap area is written.
        expect(points[1].blobs.slice(0, 3)).toEqual(["v1", "search", "no-count"]);
        expect(points[1].blobs[8]).toBe("");
        // Within 300 m there's nothing, so the lookup is a gap and its rough area is written.
        await get("/api/nearby?lat=1.40433&lng=103.79304&radius=300&c=1&via=search", e);
        expect(points[2].blobs.slice(2, 3)).toEqual(["outside-radius"]);
        expect(points[2].blobs[8]).toBe("1.40,103.78");
        // A link (which includes reloading a Near me result) never records an area.
        await get("/api/nearby?lat=1.40433&lng=103.79304&radius=300&c=1&via=link", e);
        expect(points[3].blobs[8]).toBe("");
        expect(JSON.stringify(points)).not.toContain("1.40433");
      } finally {
        globalThis.fetch = original;
      }
    });

    it("counts nothing for Global Privacy Control, Do Not Track, bots or previews without the binding", async () => {
      const original = globalThis.fetch;
      globalThis.fetch = scriptedFetch([ok]).fetcher as unknown as typeof fetch;
      try {
        const { points, EVENTS } = recorder();
        const e = env({ EVENTS } as unknown as Partial<Env>);
        await get("/api/nearby?lat=1.30106&lng=103.85412&c=1&via=pick&first=1", e, { ...ua, "sec-gpc": "1" });
        await get("/api/nearby?lat=1.30106&lng=103.85412&c=1&via=pick&first=1", e, { ...ua, dnt: "1" });
        await get("/api/nearby?lat=1.30106&lng=103.85412&c=1&via=pick&first=1", e, { "user-agent": "curl/8.7.1" });
        await get("/api/search?q=bugis", e, { ...ua, "sec-gpc": "1" });
        await get("/api/search?q=bugis", e);
        expect(points).toEqual([]);
        expect((await get("/api/nearby?lat=1.30106&lng=103.85412&c=1&via=pick&first=1", env())).status).toBe(200);
      } finally {
        globalThis.fetch = original;
      }
    });

    it("accepts only same-origin, allowlisted directions events, and always answers 204", async () => {
      const { points, EVENTS } = recorder();
      const e = env({ EVENTS } as unknown as Partial<Env>);
      const post = (body: string, headers: Record<string, string>) =>
        worker.fetch(new Request("https://parkwhere.test/api/event", { method: "POST", body, headers: { ...ua, ...headers } }), e, ctx);
      const good = JSON.stringify({ event: "directions", app: "waze", source: "osm", first: true, display: "standalone" });
      expect((await post(good, { "sec-fetch-site": "same-origin" })).status).toBe(204);
      expect((await post(good, { "sec-fetch-site": "cross-site" })).status).toBe(204);
      expect((await post(good, { origin: "https://evil.example" })).status).toBe(204);
      // A same-origin fetch-site header doesn't excuse a foreign Origin, and neither header means no count.
      expect((await post(good, { "sec-fetch-site": "same-origin", origin: "https://evil.example" })).status).toBe(204);
      expect((await post(good, {})).status).toBe(204);
      expect((await post(JSON.stringify({ event: "directions", pad: "x".repeat(4000) }), { "sec-fetch-site": "same-origin" })).status).toBe(204);
      expect((await post(JSON.stringify({ event: "pageview", url: "/x" }), { "sec-fetch-site": "same-origin" })).status).toBe(204);
      expect(points).toEqual([{ indexes: ["directions"], blobs: ["v1", "waze", "osm", "first", "standalone", ""], doubles: [] }]);
    });
  });

  it("still lists carparks when the availability feed is down", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = scriptedFetch(["network-error"]).fetcher as unknown as typeof fetch;
    try {
      const body = (await (await call("/api/nearby?lat=1.30106&lng=103.85412", env())).json()) as NearbyResponse;
      expect(body.feed).toMatchObject({ state: "unavailable", refreshError: "Could not reach data.gov.sg" });
      expect(body.carparks.length).toBeGreaterThan(0);
      expect(body.carparks.every((carpark) => carpark.car.available === null)).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("searches HDB carpark addresses when OneMap isn't configured", async () => {
    const response = await call("/api/search?q=albert%20centre", env());
    const body = (await response.json()) as SearchResponse;
    expect(body.source).toBe("hdb-registry");
    expect(body.results[0].name).toMatch(/Albert Centre/i);
  });

  it("uses OneMap with a cached token when configured", async () => {
    const original = globalThis.fetch;
    const calls: { url: string; auth: string | null }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.includes("getToken")) return Response.json({ access_token: "tok", expiry_timestamp: String(Math.floor(Date.now() / 1000) + 3 * 86400) });
      return Response.json({ results: [{ SEARCHVAL: "RAFFLES CITY", ADDRESS: "252 NORTH BRIDGE ROAD SINGAPORE 179103", POSTAL: "179103", LATITUDE: "1.2938", LONGITUDE: "103.8531" }] });
    }) as typeof fetch;
    try {
      const e = env({ ONEMAP_EMAIL: "dev@example.test", ONEMAP_PASSWORD: "test-only" });
      const first = (await (await call("/api/search?q=raffles", e)).json()) as SearchResponse;
      await call("/api/search?q=raffles%20city", e);
      expect(first).toMatchObject({ source: "onemap", results: [{ name: "Raffles City", postal: "179103" }] });
      expect(calls.filter((c) => c.url.includes("getToken"))).toHaveLength(1);
      expect(calls.filter((c) => c.url.includes("elastic/search")).every((c) => c.auth === "tok")).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports health as 503 when the feed isn't live", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = scriptedFetch([{ status: 500 }]).fetcher as unknown as typeof fetch;
    try {
      const response = await call("/health", env());
      expect(response.status).toBe(503);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rate-limits search per visitor", async () => {
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const response = await call("/api/search?q=albert", env({ SEARCH_LIMITER: limiter as unknown as RateLimit }));
    expect(response.status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "unknown" });
  });

  it("serves the app for other paths", async () => {
    expect(await (await call("/", env())).text()).toBe("asset");
    expect((await call("/api/unknown", env())).status).toBe(404);
  });
});
