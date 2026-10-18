// Fetching the HDB availability feed. All network failure modes become typed errors.
import { Data, Effect, Schedule, Schema } from "effect";
import { normaliseAvailability } from "../shared/availability";
import { AvailabilityEnvelope, CarparkRecord, type AvailabilityResponse } from "../shared/feed-schema";
import type { AvailabilitySnapshot } from "../shared/domain";

export const AVAILABILITY_URL = "https://api.data.gov.sg/v1/transport/carpark-availability";
const ATTEMPT_TIMEOUT_MS = 8_000;

export class UpstreamError extends Data.TaggedError("UpstreamError")<{
  /** Short, user-safe description. Never contains the API key or response bodies. */
  readonly message: string;
  readonly retryable: boolean;
}> {}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const requestOnce = (fetcher: Fetcher, apiKey: string | undefined) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetcher(AVAILABILITY_URL, {
        headers: { accept: "application/json", "user-agent": "parkwhere/0.1 (+https://parkwhere.bijan.app)", ...(apiKey ? { "x-api-key": apiKey } : {}) },
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new UpstreamError({
          message: response.status === 429 ? "data.gov.sg rate limit reached" : `data.gov.sg returned HTTP ${response.status}`,
          retryable: response.status === 429 || response.status >= 500
        });
      }
      return (await response.json()) as unknown;
    },
    catch: (cause) =>
      cause instanceof UpstreamError
        ? cause
        : new UpstreamError({
            message: cause instanceof Error && cause.name === "TimeoutError" ? "data.gov.sg did not respond in time" : "Could not reach data.gov.sg",
            retryable: true
          })
  });

/** Decodes records one by one so a single malformed record is skipped instead of failing the whole feed. */
export function decodeRecords(envelope: typeof AvailabilityEnvelope.Type): AvailabilityResponse {
  const decode = Schema.decodeUnknownResult(CarparkRecord);
  let skipped = 0;
  const items = envelope.items.map((item) => ({
    timestamp: item.timestamp,
    carpark_data: item.carpark_data.flatMap((record) => {
      const result = decode(record);
      if (result._tag === "Success") return [result.success];
      skipped += 1;
      return [];
    })
  }));
  if (skipped) console.warn(`ParkWhere skipped ${skipped} malformed availability records`);
  return { items };
}

/** Fetches, decodes and normalises the feed. Retries transient failures twice with backoff. */
export const fetchAvailability = (fetcher: Fetcher, apiKey: string | undefined, now: () => Date = () => new Date()) =>
  requestOnce(fetcher, apiKey).pipe(
    Effect.retry({ schedule: Schedule.exponential("400 millis"), times: 2, while: (error) => error.retryable }),
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(AvailabilityEnvelope)(body).pipe(
        Effect.mapError(() => new UpstreamError({ message: "data.gov.sg returned an unexpected format", retryable: false }))
      )
    ),
    Effect.map((envelope): AvailabilityResponse => decodeRecords(envelope)),
    Effect.flatMap((decoded): Effect.Effect<AvailabilitySnapshot, UpstreamError> => {
      const snapshot = normaliseAvailability(decoded, now());
      return Object.keys(snapshot.carparks).length === 0
        ? Effect.fail(new UpstreamError({ message: "data.gov.sg returned no carparks", retryable: false }))
        : Effect.succeed(snapshot);
    })
  );
