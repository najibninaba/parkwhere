import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import type { NearbyCarpark, NearbyResponse } from "../shared/domain";
import { DEFAULT_RADIUS_M, RADIUS_OPTIONS_M, isInSingapore } from "../shared/nearby";
import { parseSgtLocal, toSgtLocal } from "../shared/sgt";
import { estimateCost, type CostEstimate } from "../shared/tariff";
import { ApiError, fetchNearby } from "./api";
import { withTimeout } from "./timeout";
import { CarparkCard } from "./components/CarparkCard";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { PlanBar, type SortKey } from "./components/PlanBar";
import { SearchBox, type Destination } from "./components/SearchBox";
import { age, distance, feedSentence, isCurrent, lotTypeNote } from "./format";

const CarparkMap = lazy(() => import("./components/CarparkMap"));
const REFRESH_MS = 60_000;

function initialArrival(now = Date.now()) {
  const fiveMinutes = 5 * 60_000;
  return toSgtLocal(new Date(Math.ceil(now / fiveMinutes) * fiveMinutes));
}

function destinationFromUrl(): Destination | null {
  const params = new URLSearchParams(window.location.search);
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  if (!params.has("lat") || !params.has("lng") || !isInSingapore(lat, lng)) return null;
  return { lat, lng, name: params.get("name")?.slice(0, 80) || "Shared location" };
}

function radiusFromUrl(): number {
  const radius = Number(new URLSearchParams(window.location.search).get("r"));
  return (RADIUS_OPTIONS_M as readonly number[]).includes(radius) ? radius : DEFAULT_RADIUS_M;
}

type Load =
  | { kind: "idle" }
  | { kind: "loading"; key: string; previous: Previous | null }
  | { kind: "ready"; key: string; data: NearbyResponse; receivedAt: number }
  | { kind: "error"; key: string; message: string; previous: Previous | null };

type Previous = { data: NearbyResponse; receivedAt: number };
const REQUEST_TIMEOUT_MS = 20_000;

/** Results already on screen for this exact query. Results for another destination or radius are never carried over. */
function previousFor(load: Load, key: string): Previous | null {
  if (load.kind === "idle" || load.key !== key) return null;
  if (load.kind === "ready") return { data: load.data, receivedAt: load.receivedAt };
  return load.previous;
}

const feedStateAnnouncement = (state: NearbyResponse["feed"]["state"]) =>
  state === "live" ? "Live spaces are current." : state === "last-good" ? "Live spaces may be out of date." : "Live spaces are unavailable.";

const rankCost = (estimate: CostEstimate) => (estimate.kind === "estimate" ? estimate.totalCents : Number.POSITIVE_INFINITY);

export default function App() {
  const [destination, setDestination] = useState<Destination | null>(destinationFromUrl);
  const [radiusM, setRadiusM] = useState(radiusFromUrl);
  const [arrival, setArrival] = useState(() => initialArrival());
  const [durationMinutes, setDurationMinutes] = useState(120);
  const [sort, setSort] = useState<SortKey>("distance");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (destination) {
      params.set("lat", destination.lat.toFixed(5));
      params.set("lng", destination.lng.toFixed(5));
      params.set("name", destination.name);
      if (radiusM !== DEFAULT_RADIUS_M) params.set("r", String(radiusM));
    }
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
    document.title = destination ? `Parking near ${destination.name} · ParkWhere` : "ParkWhere · Singapore HDB parking";
  }, [destination, radiusM]);

  const queryKey = destination ? `${destination.lat},${destination.lng},${radiusM}` : null;

  useEffect(() => {
    if (!destination || !queryKey) return;
    const controller = new AbortController();
    let inFlight = false;
    const run = () => {
      // One request at a time, so a slow response can never overwrite a newer one.
      if (inFlight) return;
      inFlight = true;
      setLoad((current) => ({ kind: "loading", key: queryKey, previous: previousFor(current, queryKey) }));
      const request = withTimeout(controller.signal, REQUEST_TIMEOUT_MS);
      fetchNearby(destination.lat, destination.lng, radiusM, request.signal)
        .then((data) => {
          if (controller.signal.aborted) return;
          setLoad({ kind: "ready", key: queryKey, data, receivedAt: Date.now() });
          setNow(Date.now());
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const message = request.timedOut()
              ? "The request timed out."
              : error instanceof ApiError
                ? error.message
                : "Couldn't load carparks.";
          setLoad((current) => ({ kind: "error", key: queryKey, message, previous: previousFor(current, queryKey) }));
        })
        .finally(() => {
          request.clear();
          inFlight = false;
        });
    };
    run();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [destination, radiusM, queryKey, reloadKey]);

  const shown = queryKey ? previousFor(load, queryKey) : null;
  const data = shown?.data ?? null;
  const arrivalDate = useMemo(() => parseSgtLocal(arrival) ?? new Date(), [arrival]);

  const rows = useMemo(() => {
    if (!data) return [];
    const withEstimates = data.carparks.map((carpark) => ({ carpark, estimate: estimateCost(carpark, arrivalDate, durationMinutes) }));
    const sorted = [...withEstimates];
    // Only current counts rank by spaces; old or unknown counts go after them.
    const spaces = (carpark: NearbyCarpark) => (isCurrent(carpark.car, now) ? (carpark.car.available ?? -1) : -1);
    if (sort === "spaces") sorted.sort((a, b) => spaces(b.carpark) - spaces(a.carpark) || a.carpark.distanceM - b.carpark.distanceM);
    if (sort === "cost") sorted.sort((a, b) => rankCost(a.estimate) - rankCost(b.estimate) || a.carpark.distanceM - b.carpark.distanceM);
    return sorted;
  }, [data, arrivalDate, durationMinutes, sort, now]);

  const sortedCarparks = useMemo(() => rows.map((row) => row.carpark), [rows]);
  const select = useCallback((id: string) => {
    setSelectedId(id);
    document.getElementById(`carpark-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const choose = (next: Destination) => {
    setSelectedId(null);
    setDestination(next);
  };

  const feed = data ? feedSentence(data.feed, now) : null;
  const padded = data ? data.carparks.length > data.withinRadius : false;
  const capped = data ? data.withinRadius > data.carparks.length : false;

  return (
    <div className="app">
      <Header />
      <main className="layout">
        <section className="controls" aria-label="Plan">
          <SearchBox destination={destination} onChoose={choose} />
          {destination && (
            <p className="destination">
              Parking near <strong>{destination.name}</strong>
            </p>
          )}
          <PlanBar
            arrival={arrival}
            onArrival={setArrival}
            durationMinutes={durationMinutes}
            onDuration={setDurationMinutes}
            radiusM={radiusM}
            onRadius={setRadiusM}
            sort={sort}
            onSort={setSort}
          />
        </section>

        {!destination && (
          <section className="empty">
            <h1>Find HDB parking near where you’re going.</h1>
            <p>Search for a place, or use your location. You’ll see live car spaces, how old each count is, and what your stay should cost.</p>
          </section>
        )}

        {destination && (
          <>
            <div className="status">
              {/* Announce changes of state only; the ages in the banners tick and would repeat endlessly. */}
              <p className="sr-only" aria-live="polite">
                {load.kind === "loading" && !data ? "Loading carparks." : ""}
                {load.kind === "error" ? `Couldn't load carparks: ${load.message}` : ""}
                {data ? `${data.carparks.length} carparks listed. ${feedStateAnnouncement(data.feed.state)}` : ""}
              </p>
              {load.kind === "loading" && !data && <p className="banner">Loading carparks…</p>}
              {load.kind === "error" && (
                <p className="banner banner-bad">
                  {data ? `Couldn't refresh (${load.message}). Showing results loaded ${age(shown ? new Date(shown.receivedAt).toISOString() : null, now)}.` : load.message}{" "}
                  <button type="button" className="link" onClick={() => setReloadKey((key) => key + 1)}>
                    Try again
                  </button>
                </p>
              )}
              {feed && <p className={`banner banner-${feed.tone}`}>{feed.text}</p>}
            </div>

            {data && (
              <div className="results">
                <div className="map-wrap">
                  <Suspense fallback={<div className="map map-loading">Loading map…</div>}>
                    <CarparkMap destination={destination} carparks={sortedCarparks} radiusM={data.query.radiusM} selectedId={selectedId} onSelect={select} />
                  </Suspense>
                </div>
                <div className="list-wrap">
                  {rows.length === 0 ? (
                    <p className="banner">No HDB carparks with short-term parking within 2 km. HDB carparks are the only ones covered so far.</p>
                  ) : (
                    <>
                      {padded && (
                        <p className="banner banner-warn">
                          {data.withinRadius === 0 ? "Nothing" : `Only ${data.withinRadius}`} within {distance(data.query.radiusM)}, so the nearest HDB carparks up to 2 km away are included.
                        </p>
                      )}
                      {capped && (
                        <p className="banner">
                          Showing the nearest {data.carparks.length} of {data.withinRadius} HDB carparks within {distance(data.query.radiusM)}. Sorting applies to these {data.carparks.length}.
                        </p>
                      )}
                      <p className="hint">{lotTypeNote} Distances are straight-line from your destination.</p>
                      <ol className="list">
                        {rows.map(({ carpark, estimate }, index) => (
                          <CarparkCard
                            key={carpark.id}
                            carpark={carpark}
                            rank={index + 1}
                            estimate={estimate}
                            durationMinutes={durationMinutes}
                            selected={carpark.id === selectedId}
                            onSelect={() => setSelectedId(carpark.id)}
                            now={now}
                          />
                        ))}
                      </ol>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>
      <Footer registryFetchedAt={data?.registry.fetchedAt ?? null} />
    </div>
  );
}
