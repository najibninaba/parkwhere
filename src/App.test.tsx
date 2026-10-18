import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NearbyCarpark, NearbyResponse } from "../shared/domain";
import App from "./App";

vi.mock("./components/ParkMap", () => ({ default: () => <div data-testid="map" /> }));

const base: Omit<NearbyCarpark, "id" | "address" | "distanceM" | "car"> = {
  lat: 1.3011,
  lng: 103.8541,
  carparkType: "MULTI-STOREY CAR PARK",
  parkingSystem: "ELECTRONIC PARKING",
  shortTermParking: "WHOLE DAY",
  freeParking: "NO",
  nightParking: true,
  gantryHeightM: 2.15,
  basement: false
};

const nowIso = () => new Date(Date.now() - 2 * 60_000).toISOString();

function nearby(overrides: Partial<NearbyResponse> = {}): NearbyResponse {
  return {
    query: { lat: 1.3011, lng: 103.8541, radiusM: 500 },
    feed: { state: "live", fetchedAt: nowIso(), feedTimestamp: nowIso(), refreshError: null, lastAttemptAt: nowIso() },
    registry: { datasetId: "d_x", name: "HDB Carpark Information", publisher: "HDB", fetchedAt: "2026-10-18T03:57:35Z", count: 2261 },
    lta: null,
    withinRadius: 3,
    carparks: [
      { ...base, id: "K1", address: "BLK 1 KNOWN STREET", distanceM: 120, car: { reportedBy: "HDB", state: "known", available: 42, total: 100, recordedAt: nowIso(), freshness: "current" } },
      { ...base, id: "U1", address: "BLK 2 UNKNOWN ROAD", distanceM: 260, car: { reportedBy: "HDB", state: "unknown", available: null, total: null, recordedAt: "2026-08-03T16:00:00Z", freshness: "stale" } },
      { ...base, id: "N1", address: "BLK 3 NOFEED AVENUE", distanceM: 410, parkingSystem: "COUPON PARKING", car: { reportedBy: "HDB", state: "not-in-feed", available: null, total: null, recordedAt: null, freshness: "unknown" } }
    ],
    ...overrides
  };
}

let nearbyResponse: () => Response;
let overviewResponse: () => Response;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  nearbyResponse = () => Response.json(nearby());
  overviewResponse = () =>
    Response.json({
      feed: { state: "live", fetchedAt: nowIso(), feedTimestamp: nowIso(), refreshError: null, lastAttemptAt: nowIso() },
      lta: null,
      counts: { carparks: 2120, reporting: 1987, withSpaces: 1412 },
      points: [[1.3, 103.85, 4]]
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/search")) {
        const other = url.includes("other");
        return Response.json({
          query: "x",
          source: "onemap",
          results: [other ? { name: "Other Place", address: "9 Other Road", postal: "654321", lat: 1.35, lng: 103.95 } : { name: "Known Street Market", address: "1 Known Street", postal: "123456", lat: 1.3011, lng: 103.8541 }]
        });
      }
      if (url.startsWith("/api/nearby")) return nearbyResponse();
      if (url.startsWith("/api/overview")) return overviewResponse();
      return new Response("not found", { status: 404 });
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

async function searchAndChoose() {
  const user = userEvent.setup();
  render(<App />);
  await user.type(screen.getByRole("combobox", { name: /where are you going/i }), "known");
  await user.click(await screen.findByRole("option", { name: /Known Street Market/ }));
  return user;
}

describe("ParkWhere app", () => {
  it("starts with a clear call to action and no fake results", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /park near where you’re going/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /where are you going/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /near me/i })).toBeInTheDocument();
    expect(document.querySelector(".card")).toBeNull();
  });

  it("starts a search from a quick pick", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Chinatown" }));
    expect(await screen.findByText("Blk 1 Known Street")).toBeInTheDocument();
    expect(screen.getByText("People's Park Complex")).toBeInTheDocument();
    expect(window.location.search).toContain("lat=1.28413");
  });

  it("says how many carparks have spaces on the landing map", async () => {
    render(<App />);
    expect(await screen.findByText(/carparks have car spaces now/)).toHaveTextContent(/1,412 HDB carparks have car spaces now · 1,987 reported in the last 15 min · updated \d min ago/);
  });

  it("stops claiming 'now' when the overview is out of date, and says when it can't load", async () => {
    overviewResponse = () =>
      Response.json({
        feed: { state: "last-good", fetchedAt: new Date(Date.now() - 40 * 60_000).toISOString(), feedTimestamp: null, refreshError: "data.gov.sg returned HTTP 503", lastAttemptAt: nowIso() },
        lta: null,
        counts: { carparks: 2120, reporting: 1987, withSpaces: 1412 },
        points: []
      });
    const { unmount } = render(<App />);
    expect(await screen.findByText(/Live counts are out of date/)).toHaveTextContent(/last updated (39|40) min ago · refresh failed/);
    expect(screen.queryByText(/have car spaces now/)).not.toBeInTheDocument();
    unmount();
    overviewResponse = () => Response.json({ error: "down" }, { status: 503 });
    render(<App />);
    expect(await screen.findByText(/Couldn't load live counts/)).toBeInTheDocument();
  });

  it("labels a failed refresh even while the last counts are recent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App />);
      expect(await screen.findByText(/have car spaces now/)).toBeInTheDocument();
      overviewResponse = () => Response.json({ error: "down" }, { status: 503 });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await screen.findByText(/had car spaces .* ago/)).toHaveTextContent(/latest refresh failed/);
      expect(screen.queryByText(/have car spaces now/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says on the landing map when the LTA feed behind mall and URA dots is failing", async () => {
    overviewResponse = () =>
      Response.json({
        feed: { state: "live", fetchedAt: nowIso(), feedTimestamp: nowIso(), refreshError: null, lastAttemptAt: nowIso() },
        lta: { state: "unavailable", fetchedAt: null, feedTimestamp: null, refreshError: "LTA DataMall returned HTTP 503", lastAttemptAt: nowIso() },
        counts: { carparks: 2120, reporting: 1987, withSpaces: 1412 },
        points: []
      });
    render(<App />);
    expect(await screen.findByText(/have car spaces now/)).toHaveTextContent(/mall and URA carparks unavailable/);
  });

  it("moves focus to the results heading after a quick pick", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Bugis" }));
    expect(screen.getByRole("heading", { name: /Parking near Bugis Junction/ })).toHaveFocus();
  });

  it("goes back to the landing page with Clear", async () => {
    const user = await searchAndChoose();
    await screen.findByText("Blk 1 Known Street");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("heading", { name: /park near where you’re going/i })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("shows nearby carparks with spaces, their age and a cost estimate", async () => {
    await searchAndChoose();
    const card = (await screen.findByText("Blk 1 Known Street")).closest("li")!;
    expect(within(card).getByText("42")).toBeInTheDocument();
    expect(within(card).getByText(/car lots free of 100/)).toBeInTheDocument();
    expect(within(card).getByText(/reported 2 min ago/)).toBeInTheDocument();
    expect(within(card).getByText(/^\$\d+\.\d\d$/)).toBeInTheDocument();
    expect(screen.getByText(/HDB data fetched 2 min ago/)).toBeInTheDocument();
    expect(window.location.search).toContain("name=Known+Street+Market");
  });

  it("never shows an unknown count as zero", async () => {
    await searchAndChoose();
    const unknown = (await screen.findByText("Blk 2 Unknown Road")).closest("li")!;
    expect(within(unknown).getByText("?")).toBeInTheDocument();
    expect(within(unknown).queryByText("0")).not.toBeInTheDocument();
    expect(within(unknown).getByText(/Count unknown/)).toBeInTheDocument();
    const missing = screen.getByText("Blk 3 Nofeed Avenue").closest("li")!;
    expect(within(missing).getByText(/No live count/)).toBeInTheDocument();
    expect(within(missing).getByText("No estimate")).toBeInTheDocument();
  });

  it("labels last-good data and the failed refresh", async () => {
    nearbyResponse = () =>
      Response.json(
        nearby({ feed: { state: "last-good", fetchedAt: new Date(Date.now() - 14 * 60_000).toISOString(), feedTimestamp: null, refreshError: "data.gov.sg returned HTTP 503", lastAttemptAt: nowIso() } })
      );
    await searchAndChoose();
    expect(await screen.findByText(/Latest refresh failed \(data.gov.sg returned HTTP 503\)\. Showing the last good HDB data, fetched 14 min ago\./)).toBeInTheDocument();
  });

  it("explains when live spaces are unavailable but still lists carparks", async () => {
    nearbyResponse = () => Response.json(nearby({ feed: { state: "unavailable", fetchedAt: null, feedTimestamp: null, refreshError: "Could not reach data.gov.sg", lastAttemptAt: nowIso() } }));
    await searchAndChoose();
    expect(await screen.findByText(/Live spaces are unavailable: Could not reach data.gov.sg/)).toBeInTheDocument();
    expect(screen.getByText("Blk 1 Known Street")).toBeInTheDocument();
  });

  it("shows an error with a retry when the API fails", async () => {
    nearbyResponse = () => Response.json({ error: "Something went wrong on our side." }, { status: 500 });
    const user = await searchAndChoose();
    expect(await screen.findByText(/Something went wrong on our side/, { selector: ".banner" })).toBeInTheDocument();
    nearbyResponse = () => Response.json(nearby());
  overviewResponse = () =>
    Response.json({
      feed: { state: "live", fetchedAt: nowIso(), feedTimestamp: nowIso(), refreshError: null, lastAttemptAt: nowIso() },
      lta: null,
      counts: { carparks: 2120, reporting: 1987, withSpaces: 1412 },
      points: [[1.3, 103.85, 4]]
    });
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText("Blk 1 Known Street")).toBeInTheDocument();
  });

  it("never shows one destination's carparks under another", async () => {
    const user = await searchAndChoose();
    await screen.findByText("Blk 1 Known Street");
    nearbyResponse = () => Response.json({ error: "Something went wrong on our side." }, { status: 500 });
    await user.type(screen.getByRole("combobox", { name: /where are you going/i }), "other");
    await user.click(await screen.findByRole("option", { name: /Other Place/ }));
    expect(await screen.findByText(/Something went wrong on our side/, { selector: ".banner" })).toBeInTheDocument();
    expect(screen.getByText("Other Place")).toBeInTheDocument();
    expect(screen.queryByText("Blk 1 Known Street")).not.toBeInTheDocument();
  });

  it("doesn't call an old zero 'full now'", async () => {
    nearbyResponse = () =>
      Response.json(
        nearby({
          carparks: [{ ...base, id: "S1", address: "BLK 9 OLD ROAD", distanceM: 90, car: { reportedBy: "HDB", state: "known", available: 0, total: 50, recordedAt: "2026-01-01T00:00:00Z", freshness: "stale" } }]
        })
      );
    await searchAndChoose();
    const card = (await screen.findByText("Blk 9 Old Road")).closest("li")!;
    expect(within(card).queryByText(/full now/)).not.toBeInTheDocument();
    expect(within(card).getByText(/full when last reported/)).toBeInTheDocument();
  });

  it("shows LTA counts as reported, with no time, total or price", async () => {
    nearbyResponse = () =>
      Response.json(
        nearby({
          lta: { state: "live", fetchedAt: nowIso(), feedTimestamp: null, refreshError: null, lastAttemptAt: nowIso() },
          carparks: [
            {
              ...base,
              source: "lta",
              id: "lta:1",
              address: "Suntec City",
              carparkType: "Mall or development carpark",
              parkingSystem: "UNKNOWN",
              shortTermParking: "UNKNOWN",
              freeParking: "UNKNOWN",
              nightParking: false,
              gantryHeightM: null,
              distanceM: 40,
              car: { reportedBy: "LTA", state: "known", available: 967, total: null, recordedAt: null, freshness: "unknown" }
            }
          ]
        })
      );
    await searchAndChoose();
    const card = (await screen.findByText("Suntec City")).closest("li")!;
    expect(within(card).getByText("967")).toBeInTheDocument();
    expect(within(card).getByText(/car lots free, as reported/)).toBeInTheDocument();
    expect(within(card).getByText(/LTA gives no time or total/)).toBeInTheDocument();
    expect(within(card).getByText("No estimate")).toBeInTheDocument();
    expect(within(card).queryByText(/of /)).not.toBeInTheDocument();
    expect(screen.getByText(/Mall and URA counts from LTA DataMall, fetched 2 min ago/)).toBeInTheDocument();
  });

  it("says when LTA is down even if no mall carparks are listed", async () => {
    nearbyResponse = () => Response.json(nearby({ lta: { state: "unavailable", fetchedAt: null, feedTimestamp: null, refreshError: "LTA DataMall returned HTTP 503", lastAttemptAt: nowIso() } }));
    await searchAndChoose();
    expect(await screen.findByText(/Mall and URA counts are unavailable: LTA DataMall returned HTTP 503/, { selector: ".banner" })).toBeInTheDocument();
    expect(screen.getByText(/when it last reported, not a reservation/)).toBeInTheDocument();
    expect(screen.queryByText(/right now/)).not.toBeInTheDocument();
  });

  it("opens directions in external map apps", async () => {
    const user = await searchAndChoose();
    const card = (await screen.findByText("Blk 1 Known Street")).closest("li")!;
    await user.click(within(card).getByText("Directions"));
    expect(within(card).getByRole("link", { name: "Google Maps" })).toHaveAttribute("href", "https://www.google.com/maps/dir/?api=1&destination=1.301100,103.854100&travelmode=driving");
    expect(within(card).getByText(/may not be its entrance/)).toBeInTheDocument();
  });

  it("re-sorts by most spaces", async () => {
    const user = await searchAndChoose();
    await screen.findByText("Blk 1 Known Street");
    await user.click(screen.getByRole("button", { name: "Most spaces" }));
    const names = screen.getAllByRole("listitem").filter((item) => item.classList.contains("card")).map((item) => within(item).getByText(/^Blk/).textContent);
    expect(names[0]).toBe("Blk 1 Known Street");
  });
});
