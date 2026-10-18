// Fetching LTA DataMall's CarParkAvailabilityv2. It pages 500 rows at a time with $skip; the page
// size "may be adjusted from time to time", so paging stops at the first empty page, not a short one.
import { Effect, Schedule, Schema } from "effect";
import type { LtaSnapshot } from "../shared/domain";
import { normaliseLta, type LtaRow } from "../shared/lta";
import { UpstreamError, type Fetcher } from "./upstream";

export const LTA_URL = "https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2";
const ATTEMPT_TIMEOUT_MS = 8_000;
/** Today's feed is about 2,600 rows (6 pages); stop well before a runaway loop. */
const MAX_PAGES = 12;

const Page = Schema.Struct({ value: Schema.Array(Schema.Unknown) });

const page = (fetcher: Fetcher, accountKey: string, skip: number) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetcher(`${LTA_URL}?$skip=${skip}`, {
        headers: { AccountKey: accountKey, accept: "application/json" },
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new UpstreamError({
          message: response.status === 401 || response.status === 403 ? "LTA DataMall refused the account key" : `LTA DataMall returned HTTP ${response.status}`,
          retryable: response.status === 429 || response.status >= 500
        });
      }
      return (await response.json()) as unknown;
    },
    catch: (cause) =>
      cause instanceof UpstreamError
        ? cause
        : new UpstreamError({
            message: cause instanceof Error && cause.name === "TimeoutError" ? "LTA DataMall did not respond in time" : "Could not reach LTA DataMall",
            retryable: true
          })
  }).pipe(
    Effect.retry({ schedule: Schedule.exponential("400 millis"), times: 2, while: (error) => error.retryable }),
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(Page)(body).pipe(
        Effect.mapError(() => new UpstreamError({ message: "LTA DataMall returned an unexpected format", retryable: false }))
      )
    ),
    Effect.map((decoded) => decoded.value as readonly LtaRow[])
  );

/** Fetches every page and keeps the LTA and URA car rows. */
export const fetchLta = (fetcher: Fetcher, accountKey: string, now: () => Date = () => new Date()) =>
  Effect.gen(function* () {
    const rows: LtaRow[] = [];
    for (let index = 0; index < MAX_PAGES; index += 1) {
      const batch = yield* page(fetcher, accountKey, rows.length);
      if (batch.length === 0) {
        const snapshot: LtaSnapshot = normaliseLta(rows, now());
        if (snapshot.carparks.length === 0) return yield* Effect.fail(new UpstreamError({ message: "LTA DataMall returned no carparks", retryable: false }));
        return snapshot;
      }
      rows.push(...batch);
    }
    return yield* Effect.fail(new UpstreamError({ message: "LTA DataMall returned more pages than expected", retryable: false }));
  });
