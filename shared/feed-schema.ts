// Effect Schema for the HDB availability feed. Worker-only: keeps Effect out of the browser bundle.
import { Schema } from "effect";

export const LotInfo = Schema.Struct({
  lot_type: Schema.String,
  lots_available: Schema.optional(Schema.NullOr(Schema.String)),
  total_lots: Schema.optional(Schema.NullOr(Schema.String))
});

export const CarparkRecord = Schema.Struct({
  carpark_number: Schema.String,
  update_datetime: Schema.optional(Schema.NullOr(Schema.String)),
  carpark_info: Schema.Array(LotInfo)
});

export const AvailabilityResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      timestamp: Schema.optional(Schema.NullOr(Schema.String)),
      carpark_data: Schema.Array(CarparkRecord)
    })
  )
});
export type AvailabilityResponse = typeof AvailabilityResponse.Type;
export type LotInfo = typeof LotInfo.Type;

/** The feed's outer shape, with records left undecoded so one malformed record can be skipped on its own. */
export const AvailabilityEnvelope = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      timestamp: Schema.optional(Schema.NullOr(Schema.String)),
      carpark_data: Schema.Array(Schema.Unknown)
    })
  )
});
