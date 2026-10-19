// Carparks mapped at public places on OpenStreetMap (© OpenStreetMap contributors, Open Database Licence 1.0).
// Many malls, venues and parks have their carpark mapped with no access tag, so shared/osm.ts leaves them
// out. scripts/sync-osm.ts also cuts Singapore's named place areas out of the extract and passes them here
// with the parking features. A place gets one entry when a carpark is mapped at it. The entry says only that:
// visitor access is unknown and is always shown as unconfirmed, never as public. Pure, so it's tested.
import type { OsmCarpark, OsmPlaceCarpark, OsmPlaceKind, OsmPlaceRelation } from "./domain";
// .ts extensions: scripts/sync-osm.ts runs this file directly under Node.
import { distanceM, isInSingapore } from "./nearby.ts";
import {
  DUPLICATE_RADIUS_M,
  ENTRANCE_RADIUS_M,
  EXCLUDED_PARKING,
  POINT_ENTRANCE_RADIUS_M,
  SAME_NAME_M,
  SAME_PLACE_M,
  carsAllowed,
  centroid,
  distanceToGeometry,
  hdbRun,
  notForCars,
  osmId,
  parkingOf,
  parseHeight,
  polygons,
  ringArea,
  round,
  sameName,
  tag,
  type Geometry,
  type OsmFeature,
  type Point
} from "./osm.ts";

/** Evidence this far outside a venue's outline still counts, as "next to" it. */
export const NEXT_TO_M = 30;
/** A carpark named after a venue counts up to this far from its outline (Singapore Expo's lots). */
export const NAMED_AFTER_M = 300;

/**
 * Venues (tier A): any mapped carpark area or carpark entrance at the outline counts. Open spaces (tier B):
 * only a carpark area inside the outline counts, because a park's edge often runs along condos and offices.
 * A place tagged as both is treated as an open space, the stricter tier.
 */
type Tier = "venue" | "open-space";
const PLACE_TAGS: { key: string; values: string[]; kind: OsmPlaceKind; tier: Tier }[] = [
  { key: "leisure", values: ["sports_centre", "stadium"], kind: "sports", tier: "open-space" },
  { key: "leisure", values: ["park", "garden", "nature_reserve", "water_park"], kind: "park", tier: "open-space" },
  { key: "aeroway", values: ["terminal"], kind: "terminal", tier: "venue" },
  { key: "shop", values: ["mall"], kind: "mall", tier: "venue" },
  { key: "amenity", values: ["conference_centre", "exhibition_centre"], kind: "venue", tier: "venue" },
  { key: "tourism", values: ["attraction", "museum", "zoo", "theme_park", "aquarium", "gallery"], kind: "attraction", tier: "venue" }
];

/**
 * Staff and visitor parking can't be told apart at hospitals, clinics and campuses, and residents' and visitors'
 * parking can't be told apart in a block of flats with shops below, so these places are left out.
 */
const CAMPUS_TAGS: Record<string, string[]> = {
  amenity: ["hospital", "clinic", "doctors", "university", "college", "school", "kindergarten"],
  healthcare: ["hospital", "clinic"],
  building: ["hospital", "university", "college", "school", "apartments", "residential", "house", "dormitory"]
};
const CAMPUS_NAME = /\b(hospital|polyclinic|clinic|school|university|college|polytechnic)\b/i;
/** Park connectors and linear parks are paths: a carpark along one isn't "at" it. */
const CONNECTOR = /connector|linear park/i;
/**
 * Names that say what a place is rather than which one it is. "Carpark mapped at Tennis Court" helps nobody.
 * Compared with the whole name, ignoring case and a trailing number or letter ("Playground 2").
 */
export const GENERIC_PLACE_NAMES = [
  "tennis court",
  "tennis courts",
  "sport hall",
  "sports hall",
  "sports complex",
  "sports and recreation centre",
  "common green",
  "playground",
  "fitness corner",
  "multi-purpose court",
  "multi purpose court",
  "futsal",
  "futsal court",
  "basketball court",
  "badminton court",
  "community garden",
  "park",
  "garden"
];
const GENERIC = new Set(GENERIC_PLACE_NAMES);
const generic = (name: string) => GENERIC.has(name.toLowerCase().replace(/\s+/g, " ").replace(/\s+([0-9]+|[a-z])$/, "").trim());

/** Anything but these access values (private, no, permit, delivery, residents, staff, bus, licence...) rules a feature out. */
const OPEN_ACCESS = new Set(["", "yes", "customers", "permissive", "destination", "public"]);
const CLOSED = /\bclosed\b|\bconstruction\b/i;
const EXIT = /\bexit\b/i;
/** Text that says who may use it, when that isn't visitors: "Access to residents' carpark (level 2)". */
const NOT_FOR_VISITORS = /\bresidents?\b|\bresidential\b|\bcondo(minium)?s?\b|\bstaff\b|\bemployees?\b|\btenants?\b|\bprivate\b|\bauthori[sz]ed\b|\bmembers?\b|\bvip\b/i;

/** Under construction, disused, closed (end_date passed) or not open yet. `today` is YYYY-MM-DD. */
function retired(feature: OsmFeature, today: string): boolean {
  if (["construction", "disused", "abandoned", "demolished"].some((key) => tag(feature, key) !== null)) return true;
  if (tag(feature, "landuse") === "construction" || tag(feature, "building") === "construction") return true;
  const date = (key: string) => {
    const value = tag(feature, key);
    return value && /^\d{4}(-\d{2}){0,2}$/.test(value) ? { value, today: today.slice(0, value.length) } : null;
  };
  const opening = date("opening_date");
  if (opening && opening.value > opening.today) return true;
  const end = date("end_date");
  if (end && end.value <= end.today) return true;
  return ["name", "description", "note"].some((key) => CLOSED.test(tag(feature, key) ?? ""));
}

/**
 * Cars may use it. Unlike shared/osm.ts's carsAllowed, any mode-specific restriction rules it out
 * (motorcar=delivery, vehicle=forestry), and so does parking for buses, coaches or goods vehicles
 * (bus=yes, psv=designated) unless cars are explicitly allowed too.
 */
const OPEN_MODE = new Set(["", "yes", "customers", "permissive", "destination", "public", "designated"]);
function carsOpen(feature: OsmFeature): boolean {
  if (!["motorcar", "motor_vehicle", "vehicle"].every((key) => OPEN_MODE.has(tag(feature, key) ?? ""))) return false;
  const otherVehicles = ["bus", "psv", "hgv", "goods", "coach", "tourist_bus"].some((key) => ["yes", "designated"].includes(tag(feature, key) ?? ""));
  return !otherVehicles || ["yes", "designated"].includes(tag(feature, "motorcar") ?? "");
}

/**
 * A parking feature that could be a visitor carpark: amenity=parking or parking_entrance, open or untagged
 * access, open to cars (no mode-specific restriction, not for buses or goods vehicles), not for heavy
 * vehicles, loading, drop-off, season holders, coaches, motorcycles or disabled drivers only, not HDB-run, not street parking, not an exit or service entrance, not described as
 * for residents, staff or tenants, not named after a hospital or school, and not closed.
 */
export function possibleVisitorParking(feature: OsmFeature, today: string): boolean {
  const amenity = tag(feature, "amenity");
  if (amenity !== "parking" && amenity !== "parking_entrance") return false;
  // An entrance is a point; one mapped as an area isn't a carpark and isn't used.
  if (amenity === "parking_entrance" && feature.geometry.type !== "Point") return false;
  if (!OPEN_ACCESS.has(tag(feature, "access") ?? "") || !carsAllowed(feature) || !carsOpen(feature) || notForCars(feature) || hdbRun(feature)) return false;
  if (EXCLUDED_PARKING.has(tag(feature, "parking") ?? "")) return false;
  if (["exit", "service"].includes(tag(feature, "entrance") ?? "") || EXIT.test(tag(feature, "name") ?? "")) return false;
  if (["name", "description", "note", "parking:condition"].some((key) => NOT_FOR_VISITORS.test(tag(feature, key) ?? ""))) return false;
  // A hospital's or school's carpark is left out for the same reason the place would be.
  if (CAMPUS_NAME.test(tag(feature, "name") ?? "")) return false;
  return !retired(feature, today);
}

/** Lower case words with parking words dropped: "Singapore EXPO Car Park A" -> "singapore expo a". */
const words = (name: string) =>
  ` ${name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/\b(car\s*parks?|parking|multi[\s-]?storey|basement|mscp)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;

/** A carpark named after a place: the place's whole name appears in the carpark's as whole words. */
export function namedAfter(carparkName: string | null, placeName: string): boolean {
  const place = words(placeName);
  return carparkName !== null && place.trim().length >= 3 && words(carparkName).includes(place);
}

export interface Place {
  feature: OsmFeature;
  id: string;
  name: string;
  kind: OsmPlaceKind;
  tier: Tier;
  /** For choosing the more specific of two places that share a carpark. Degrees², only compared. */
  area: number;
}

/** A named area of a kind that can have visitor parking, or null with nothing said about why. */
export function placeOf(feature: OsmFeature, today: string): Place | null {
  if (feature.geometry.type === "Point") return null;
  const name = tag(feature, "name") ?? tag(feature, "name:en");
  if (!name) return null;
  const match = PLACE_TAGS.find(({ key, values }) => values.includes(tag(feature, key) ?? ""));
  if (!match) return null;
  if (Object.entries(CAMPUS_TAGS).some(([key, values]) => values.includes(tag(feature, key) ?? "")) || CAMPUS_NAME.test(name)) return null;
  // place=* marks a neighbourhood or locality (Emerald Hill), not a venue with a carpark of its own.
  if (tag(feature, "place") !== null) return null;
  if (["private", "no"].includes(tag(feature, "access") ?? "")) return null;
  if (CONNECTOR.test(name) || generic(name) || retired(feature, today)) return null;
  const area = polygons(feature.geometry).reduce((sum, [outer]) => sum + Math.abs(ringArea(outer ?? [])), 0);
  return { feature, id: osmId(feature), name, kind: match.kind, tier: match.tier, area };
}

interface Bounds { minLat: number; maxLat: number; minLng: number; maxLng: number }
function boundsOf(geometry: Geometry, marginM = 0): Bounds {
  const points = geometry.type === "Point" ? [geometry.coordinates] : polygons(geometry).flatMap((parts) => parts.flat());
  const lats = points.map((p) => p[1]);
  const lngs = points.map((p) => p[0]);
  const dLat = marginM / 110_574;
  const dLng = marginM / (111_320 * Math.cos(((lats[0] ?? 1.3) * Math.PI) / 180));
  return { minLat: Math.min(...lats) - dLat, maxLat: Math.max(...lats) + dLat, minLng: Math.min(...lngs) - dLng, maxLng: Math.max(...lngs) + dLng };
}
const within = (point: Point, b: Bounds) => point.lat >= b.minLat && point.lat <= b.maxLat && point.lng >= b.minLng && point.lng <= b.maxLng;

/** Buildings that are carparks themselves (a mall's multi-storey carpark block) don't claim an entrance. */
const PARKING_BUILDINGS = new Set(["parking", "garage", "garages", "carport"]);

/**
 * Finds how far a point is from the nearest building other than a place, within `limit` metres: Infinity when
 * none is closer. Buildings that are carparks, the place itself and buildings inside the place don't count.
 */
function buildingIndex(buildings: readonly OsmFeature[]) {
  const CELL = 0.002; // about 220 m
  const key = (lat: number, lng: number) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;
  const grid = new Map<string, { feature: OsmFeature; id: string; middle: Point }[]>();
  for (const feature of buildings) {
    if (feature.geometry.type === "Point" || tag(feature, "amenity") === "parking" || tag(feature, "parking") !== null) continue;
    if (PARKING_BUILDINGS.has(tag(feature, "building") ?? "")) continue;
    const b = boundsOf(feature.geometry);
    const item = { feature, id: osmId(feature), middle: centroid(feature.geometry) };
    for (let lat = Math.floor(b.minLat / CELL); lat <= Math.floor(b.maxLat / CELL); lat += 1) {
      for (let lng = Math.floor(b.minLng / CELL); lng <= Math.floor(b.maxLng / CELL); lng += 1) {
        const cell = `${lat}:${lng}`;
        grid.set(cell, [...(grid.get(cell) ?? []), item]);
      }
    }
  }
  return (point: Point, limit: number, place: OsmFeature): number => {
    const placeId = osmId(place);
    const seen = new Set<string>();
    let best = Infinity;
    for (const dLat of [-1, 0, 1]) {
      for (const dLng of [-1, 0, 1]) {
        for (const item of grid.get(key(point.lat + dLat * CELL, point.lng + dLng * CELL)) ?? []) {
          if (seen.has(item.id) || item.id === placeId) continue;
          seen.add(item.id);
          if (distanceToGeometry(item.middle, place.geometry) === 0) continue;
          const distance = distanceToGeometry(point, item.feature.geometry);
          if (distance < limit) best = Math.min(best, distance);
        }
      }
    }
    return best;
  };
}

/** A parking feature that may be evidence, with what's needed to group it and choose a point. */
interface Parking {
  feature: OsmFeature;
  id: string;
  point: Point;
  entrance: boolean;
  /** The carpark it belongs to: an entrance joins the carpark areas it's at. */
  group: string;
  /** For an area, its usable entrances (within ENTRANCE_RADIUS_M), lowest id first. */
  entrances: Parking[];
}

interface Evidence { parking: Parking; distanceM: number; named: boolean }

export interface PlaceSelection {
  places: OsmPlaceCarpark[];
  /** Places with mapped evidence that was all left out, by why. Ids only, for the sync summary. */
  removed: {
    /** Every carpark feature is HDB-run or within DUPLICATE_RADIUS_M of an HDB carpark. */
    hdb: string[];
    /** A public carpark from osm-carparks.json is already shown there. */
    shown: string[];
    /** Its carparks are already another place's entry. */
    shared: string[];
  };
}

/**
 * One entry per public place with a carpark mapped at it.
 *
 * - Venues (malls, conference and exhibition centres, attractions, museums, zoos, terminals): a carpark area
 *   or entrance inside the outline or within NEXT_TO_M of it, or a carpark area named after the place within
 *   NAMED_AFTER_M. The point is a usable entrance when there is one.
 * - Open spaces (parks, gardens, nature reserves, sports centres, stadiums, water parks): only a carpark area
 *   inside the outline. The point is its middle, or one of its entrances.
 * - Every feature passes possibleVisitorParking, and an entrance also needs every carpark it's at to pass.
 * - Evidence just outside a venue's outline doesn't count when it's closer to another building (`buildings`).
 * - A feature that is HDB-run or within DUPLICATE_RADIUS_M of an HDB carpark is dropped; data.gov.sg lists it.
 * - A place that already has a public carpark from `shown` (osm-carparks.json) gets no entry.
 * - One carpark makes at most one entry. Places that share one are resolved in favour of venues, then
 *   carparks inside the outline, then the smaller place.
 */
export function selectPlaceCarparks(
  placeFeatures: readonly OsmFeature[],
  parkingFeatures: readonly OsmFeature[],
  hdb: readonly Point[],
  shown: readonly OsmCarpark[],
  today: string,
  buildings: readonly OsmFeature[] = []
): PlaceSelection {
  const nearHdb = (point: Point) => hdb.some((carpark) => distanceM(point, carpark) <= DUPLICATE_RADIUS_M);
  const shownIds = new Set(shown.map((carpark) => carpark.id));
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, "en", { numeric: true });
  const nearestBuilding = buildingIndex(buildings);

  // Every parking feature, with its own verdict. Areas and points are carparks; entrances are joined to them.
  // An entrance mapped as an area is neither, so it's left out.
  const all = parkingFeatures
    .filter((feature) => {
      const amenity = tag(feature, "amenity");
      return amenity === "parking" || (amenity === "parking_entrance" && feature.geometry.type === "Point");
    })
    .map((feature) => ({ feature, id: osmId(feature), point: centroid(feature.geometry), entrance: tag(feature, "amenity") === "parking_entrance" && feature.geometry.type === "Point" }))
    .filter((parking) => isInSingapore(parking.point.lat, parking.point.lng))
    .sort(byId);
  const carparks = all.filter((parking) => !parking.entrance).map((parking) => ({ ...parking, bounds: boundsOf(parking.feature.geometry, POINT_ENTRANCE_RADIUS_M) }));
  const reach = (feature: OsmFeature) => (feature.geometry.type === "Point" ? POINT_ENTRANCE_RADIUS_M : ENTRANCE_RADIUS_M);
  const parentsOf = (point: Point) =>
    carparks.filter((carpark) => within(point, carpark.bounds) && distanceToGeometry(point, carpark.feature.geometry) <= reach(carpark.feature));
  const fine = (parking: { feature: OsmFeature; point: Point }) => possibleVisitorParking(parking.feature, today) && !nearHdb(parking.point);
  /** Already in osm-carparks.json, so close to an entry there that it was merged into it, or holding one. */
  const isShown = (parking: { id: string; feature: OsmFeature; point: Point }) =>
    shownIds.has(parking.id) ||
    shown.some(
      (carpark) =>
        distanceM(carpark, parking.point) <= SAME_PLACE_M ||
        (parking.feature.geometry.type !== "Point" && distanceToGeometry(carpark, parking.feature.geometry) <= ENTRANCE_RADIUS_M)
    );

  const usable = new Map<string, Parking>();
  const shownParking = new Set<string>();
  for (const carpark of carparks) {
    if (isShown(carpark)) shownParking.add(carpark.id);
    else if (fine(carpark)) usable.set(carpark.id, { ...carpark, group: carpark.id, entrances: [] });
  }
  for (const entrance of all.filter((parking) => parking.entrance)) {
    const parents = parentsOf(entrance.point);
    // An entrance at a shown carpark is that carpark's; one at a private, loading or HDB carpark is too.
    if (isShown(entrance) || parents.some((parent) => shownParking.has(parent.id))) {
      shownParking.add(entrance.id);
      continue;
    }
    if (!fine(entrance) || parents.some((parent) => !usable.has(parent.id))) continue;
    const areas = parents.map((parent) => usable.get(parent.id)!);
    const parking: Parking = { ...entrance, group: areas[0]?.group ?? entrance.id, entrances: [] };
    usable.set(entrance.id, parking);
    for (const area of areas) area.entrances.push(parking);
    // An entrance shared by two mapped carparks joins them into one.
    for (const area of areas.slice(1)) {
      const from = area.group;
      for (const other of usable.values()) if (other.group === from) other.group = parking.group;
    }
  }
  const usableList = [...usable.values()];
  const shownList = all.filter((parking) => shownParking.has(parking.id));

  const removed: PlaceSelection["removed"] = { hdb: [], shown: [], shared: [] };
  type Candidate = { place: Place; evidence: Evidence[] };
  const candidates: Candidate[] = [];
  for (const feature of placeFeatures) {
    const place = placeOf(feature, today);
    if (!place) continue;
    const reachM = place.tier === "venue" ? NAMED_AFTER_M : 0;
    const bounds = boundsOf(feature.geometry, reachM);
    /** How a parking feature relates to this place, or null when it isn't evidence for it. */
    const evidenceOf = (parking: { feature: OsmFeature; point: Point; entrance: boolean }): { distanceM: number; named: boolean } | null => {
      if (!within(parking.point, bounds)) return null;
      const area = parking.feature.geometry.type !== "Point";
      if (place.tier === "open-space" && !area) return null;
      const distance = distanceToGeometry(parking.point, feature.geometry);
      if (place.tier === "open-space") return distance === 0 ? { distanceM: 0, named: false } : null;
      // Just outside the outline, it must not be closer to (or inside) another building: then it's that building's.
      const otherBuilding = () => nearestBuilding(parking.point, distance, feature) < distance;
      if (distance === 0 && (area || parking.entrance)) return { distanceM: 0, named: false };
      if (distance <= NEXT_TO_M && (area || parking.entrance) && !otherBuilding()) return { distanceM: distance, named: false };
      if (area && distance <= NAMED_AFTER_M && namedAfter(tag(parking.feature, "name"), place.name)) return { distanceM: distance, named: true };
      return null;
    };
    // A public carpark at the place, or one with its name nearby ("Suntec City"), is already shown.
    const shownHere =
      shown.some(
        (carpark) =>
          within(carpark, bounds) &&
          (distanceToGeometry(carpark, feature.geometry) <= (place.tier === "venue" ? NEXT_TO_M : 0) ||
            (sameName(carpark.name, place.name) && distanceToGeometry(carpark, feature.geometry) <= SAME_NAME_M))
      ) || shownList.some((parking) => evidenceOf(parking));
    if (shownHere) {
      removed.shown.push(place.id);
      continue;
    }
    const evidence = usableList.flatMap((parking) => {
      const found = evidenceOf(parking);
      return found ? [{ parking, ...found }] : [];
    });
    if (evidence.length > 0) {
      candidates.push({ place, evidence });
      continue;
    }
    // Was there evidence before the HDB rule? Only for the summary.
    const hdbOnly = all.some((parking) => evidenceOf(parking) && possibleVisitorParking(parking.feature, today) && nearHdb(parking.point));
    if (hdbOnly) removed.hdb.push(place.id);
  }

  // Venues first, then places with a carpark inside, then the smaller (more specific) place.
  const built = candidates.filter((candidate) => entryFor(candidate.place, candidate.evidence) !== null);
  const tierRank = (tier: Tier) => (tier === "venue" ? 0 : 1);
  type Ranked = { place: Place; entry: OsmPlaceCarpark };
  const rank = (a: Ranked, b: Ranked) =>
    tierRank(a.place.tier) - tierRank(b.place.tier) ||
    (a.entry.relation === "at" ? 0 : 1) - (b.entry.relation === "at" ? 0 : 1) ||
    a.place.area - b.place.area ||
    byId(a.place, b.place);
  // Take the best place first, then rank the rest again on what's left: a place that lost the carparks inside
  // it to another place falls back to "next to" and ranks as that.
  const used = new Set<string>();
  const kept: { entry: OsmPlaceCarpark; place: Place }[] = [];
  let remaining = built.map(({ place, evidence }) => ({ place, evidence }));
  while (remaining.length > 0) {
    const ranked = remaining.map((candidate) => {
      const free = candidate.evidence.filter((item) => !used.has(item.parking.group));
      return { ...candidate, free, entry: free.length > 0 ? entryFor(candidate.place, free) : null };
    });
    for (const gone of ranked.filter((candidate) => !candidate.entry)) removed.shared.push(gone.place.id);
    const live = ranked.filter((candidate): candidate is typeof candidate & { entry: OsmPlaceCarpark } => candidate.entry !== null);
    if (live.length === 0) break;
    const best = live.reduce((a, b) => (rank(a, b) <= 0 ? a : b));
    remaining = live.filter((candidate) => candidate !== best).map(({ place, evidence }) => ({ place, evidence }));
    const { place, evidence, free, entry } = best;
    // A place that lost a carpark to another place, and whose next carpark is beside that place's, is the same.
    // So is one mapped in several parts with one name (Suntec City's towers), unless the parts are far apart.
    const collapsed = kept.some(
      (other) =>
        (free.length < evidence.length && distanceM(other.entry, entry) <= SAME_PLACE_M) ||
        (words(other.place.name) === words(place.name) &&
          Math.min(distanceToGeometry(entry, other.place.feature.geometry), distanceToGeometry(other.entry, place.feature.geometry)) <= SAME_NAME_M)
    );
    if (collapsed) {
      removed.shared.push(place.id);
      continue;
    }
    kept.push({ entry, place });
    for (const id of entry.evidence) used.add(usable.get(id)!.group);
  }
  return { places: kept.map(({ entry }) => entry).sort(byId), removed };
}

/**
 * The entry for a place from its evidence, or null. Only the closest evidence is used: carparks inside the
 * outline when there are any ("at"), otherwise those next to it or named after it ("next-to").
 */
function entryFor(place: Place, evidence: Evidence[]): OsmPlaceCarpark | null {
  const inside = evidence.filter((item) => item.distanceM === 0);
  const relation: OsmPlaceRelation = inside.length > 0 ? "at" : "next-to";
  // Closest first; then an entrance that says what it's for (parking=*, maxheight) over a bare one.
  const described = (item: Evidence) => (tag(item.parking.feature, "parking") !== null || tag(item.parking.feature, "maxheight") !== null ? 0 : 1);
  const used = [...(inside.length > 0 ? inside : evidence)].sort(
    (a, b) => a.distanceM - b.distanceM || described(a) - described(b) || a.parking.id.localeCompare(b.parking.id, "en", { numeric: true })
  );
  const areas = used.filter((item) => !item.parking.entrance).map((item) => item.parking);
  const entrances = used.filter((item) => item.parking.entrance).map((item) => item.parking);
  let point: Parking | undefined;
  let carpark: Parking | undefined;
  if (place.tier === "venue") {
    // Prefer an entrance: one at the place, else one of a carpark at the place.
    point = entrances[0] ?? areas.flatMap((area) => area.entrances)[0];
    carpark = point ? areas.find((area) => area.entrances.includes(point!)) ?? areas[0] : areas[0];
  } else {
    // An open space's carpark area, at one of its own entrances when one is mapped.
    carpark = [...areas].sort((a, b) => (a.entrances.length > 0 ? 0 : 1) - (b.entrances.length > 0 ? 0 : 1))[0];
    point = carpark?.entrances[0];
  }
  const at = point ?? carpark;
  if (!at) return null;
  const ids = [at.id, ...(carpark && carpark !== at ? [carpark.id] : []), ...used.map((item) => item.parking.id)];
  const describe = (feature: OsmFeature | undefined) => (feature ? { parking: parkingOf(feature), height: parseHeight(tag(feature, "maxheight")) } : { parking: null, height: null });
  const fromPoint = describe(at.feature);
  const fromCarpark = describe(carpark?.feature);
  return {
    id: place.id,
    kind: "place",
    placeName: place.name,
    placeKind: place.kind,
    relation,
    evidence: [...new Set(ids)],
    atEntrance: Boolean(point),
    parking: fromPoint.parking ?? fromCarpark.parking,
    maxHeightM: fromPoint.height ?? fromCarpark.height,
    access: "unknown",
    lat: round(at.point.lat),
    lng: round(at.point.lng)
  };
}
