// Public carparks mapped on OpenStreetMap (© OpenStreetMap contributors, Open Database Licence 1.0).
// scripts/sync-osm.ts cuts Singapore's amenity=parking and amenity=parking_entrance features out of
// Geofabrik's extract with osmium and passes them to selectOsmCarparks. The result is bundled as
// worker/osm-carparks.json. These carparks have no count and no price: OpenStreetMap only says where a
// carpark is and who may use it.
import type { CarAvailability, OsmAccess, OsmCarpark, OsmFile, RegistryCarpark } from "./domain";
// .ts extension: scripts/sync-osm.ts runs this file directly under Node.
import { distanceM, isInSingapore } from "./nearby.ts";

type Position = [number, number];
type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };

/** One line of `osmium export -f geojsonseq -a type,id`: tags as properties, plus "@type" and "@id". */
export interface OsmFeature {
  type: "Feature";
  geometry: Geometry;
  properties: Record<string, string | number>;
}

interface Point { lat: number; lng: number }

/** Only explicit tags make a carpark usable by the public. A missing access tag is often a condo or office carpark. */
const PUBLIC_ACCESS = new Set<string>(["yes", "customers", "permissive"]);
const CLOSED_ACCESS = new Set(["private", "no", "permit", "delivery", "residents", "employees", "staff"]);
/** Kerbside and lane parking is URA's or HDB's street parking, not a carpark. */
const PARKING_KINDS = new Set(["multi-storey", "underground", "surface", "rooftop"]);
const EXCLUDED_PARKING = new Set(["street_side", "lane", "on_kerb", "half_on_kerb", "layby", "carports", "garage_boxes", "sheds"]);
const HDB_OPERATOR = /\bHDB\b|housing\s*(&|and)?\s*development\s*board/i;

/** An entrance this close to a carpark's outline belongs to that carpark. */
export const ENTRANCE_RADIUS_M = 25;
/** An OpenStreetMap carpark this close to an HDB, LTA or URA carpark is taken to be the same one, and left out. */
export const DUPLICATE_RADIUS_M = 80;
/** Standalone entrances with the same name this close together are one carpark's entrances; one is kept. */
export const ENTRANCE_GROUP_M = 120;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const tag = (feature: OsmFeature, key: string) => text(feature.properties[key]) || null;
const osmId = (feature: OsmFeature) => `${text(feature.properties["@type"])}/${text(feature.properties["@id"])}`;
const round = (value: number) => Number(value.toFixed(6));

/** "2.1", "2.1 m", "2.10m" -> 2.1; anything else ("default", "none", feet) -> null. */
export function parseHeight(value: string | null): number | null {
  const match = value?.match(/^(\d+(?:\.\d+)?)\s*m?$/i);
  const metres = match ? Number(match[1]) : NaN;
  return Number.isFinite(metres) && metres > 1 && metres < 10 ? metres : null;
}

/** Outer ring of a polygon, or of the largest part of a multipolygon. */
function outerRing(geometry: Geometry): Position[] | null {
  if (geometry.type === "Polygon") return geometry.coordinates[0] ?? null;
  if (geometry.type === "MultiPolygon") {
    let best: Position[] | null = null;
    let bestArea = -1;
    for (const polygon of geometry.coordinates) {
      const ring = polygon[0];
      if (!ring) continue;
      const area = Math.abs(ringArea(ring));
      if (area > bestArea) { best = ring; bestArea = area; }
    }
    return best;
  }
  return null;
}

/** Signed shoelace area in degrees², enough to compare parts and weight a centroid. */
function ringArea(ring: Position[]): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return area / 2;
}

/** Area-weighted centroid of the outer ring; the vertex average for degenerate rings. */
export function centroid(geometry: Geometry): Point {
  if (geometry.type === "Point") return { lat: geometry.coordinates[1], lng: geometry.coordinates[0] };
  const ring = outerRing(geometry) ?? [];
  const area = ringArea(ring);
  if (Math.abs(area) < 1e-14) {
    const n = Math.max(ring.length, 1);
    return { lat: ring.reduce((sum, p) => sum + p[1], 0) / n, lng: ring.reduce((sum, p) => sum + p[0], 0) / n };
  }
  let x = 0;
  let y = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    x += (ring[i][0] + ring[i + 1][0]) * cross;
    y += (ring[i][1] + ring[i + 1][1]) * cross;
  }
  return { lat: y / (6 * area), lng: x / (6 * area) };
}

/** Metres from a point to a geometry: 0 inside a polygon, otherwise to its nearest edge (flat-earth, fine at this scale). */
export function distanceToGeometry(point: Point, geometry: Geometry): number {
  if (geometry.type === "Point") return distanceM(point, { lat: geometry.coordinates[1], lng: geometry.coordinates[0] });
  const ring = outerRing(geometry);
  if (!ring || ring.length < 2) return Infinity;
  const kx = 111_320 * Math.cos((point.lat * Math.PI) / 180);
  const ky = 110_574;
  const xy = (p: Position) => [(p[0] - point.lng) * kx, (p[1] - point.lat) * ky] as const;
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [x1, y1] = xy(ring[i]);
    const [x2, y2] = xy(ring[j]);
    if (y1 > 0 !== y2 > 0 && 0 < ((x2 - x1) * (0 - y1)) / (y2 - y1) + x1) inside = !inside;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
  }
  return inside ? 0 : best;
}

const accessOf = (feature: OsmFeature): OsmAccess | null => {
  const access = tag(feature, "access");
  return access && PUBLIC_ACCESS.has(access) ? (access as OsmAccess) : null;
};

const carsAllowed = (feature: OsmFeature) =>
  !["motorcar", "motor_vehicle", "vehicle"].some((key) => ["no", "private"].includes(tag(feature, key) ?? ""));

const parkingOf = (feature: OsmFeature): OsmCarpark["parking"] => {
  const parking = tag(feature, "parking");
  return parking && PARKING_KINDS.has(parking) ? (parking as OsmCarpark["parking"]) : null;
};

/**
 * Picks the public carparks from Singapore's mapped parking features. A carpark needs an explicit access tag
 * of yes, customers or permissive; street parking, HDB-run carparks and anything within DUPLICATE_RADIUS_M of
 * an HDB carpark (covered by data.gov.sg) are left out. Entrances near a kept carpark become its point. An
 * entrance with explicit public access and no carpark of its own is kept as an entrance, once per name.
 */
export function selectOsmCarparks(features: readonly OsmFeature[], hdb: readonly Point[]): OsmCarpark[] {
  const nearHdb = (point: Point) => hdb.some((carpark) => distanceM(point, carpark) <= DUPLICATE_RADIUS_M);
  const parkings = features.filter((feature) => tag(feature, "amenity") === "parking");
  const entrances = features
    .filter((feature) => tag(feature, "amenity") === "parking_entrance" && feature.geometry.type === "Point")
    .sort((a, b) => osmId(a).localeCompare(osmId(b), "en", { numeric: true }));
  const entrancePoint = (feature: OsmFeature) => centroid(feature.geometry);

  const kept: OsmCarpark[] = [];
  for (const feature of parkings) {
    const access = accessOf(feature);
    const parking = tag(feature, "parking");
    const operator = tag(feature, "operator");
    if (!access || !carsAllowed(feature) || (parking && EXCLUDED_PARKING.has(parking)) || (operator && HDB_OPERATOR.test(operator))) continue;
    const middle = centroid(feature.geometry);
    if (!isInSingapore(middle.lat, middle.lng) || nearHdb(middle)) continue;
    // A private or staff entrance (access=private, no, permit...) never becomes where directions go.
    const entrance = entrances.find(
      (candidate) => !CLOSED_ACCESS.has(tag(candidate, "access") ?? "") && distanceToGeometry(entrancePoint(candidate), feature.geometry) <= ENTRANCE_RADIUS_M
    );
    const point = entrance ? entrancePoint(entrance) : middle;
    kept.push({
      id: osmId(feature),
      kind: "carpark",
      name: tag(feature, "name") ?? tag(feature, "name:en"),
      operator,
      parking: parkingOf(feature),
      access,
      maxHeightM: parseHeight(tag(feature, "maxheight")),
      lat: round(point.lat),
      lng: round(point.lng),
      atEntrance: Boolean(entrance)
    });
  }

  // Entrances of any mapped carpark, public or not, aren't standalone: a private carpark's entrance stays private.
  const belongsToCarpark = (point: Point) => parkings.some((feature) => feature.geometry.type !== "Point" && distanceToGeometry(point, feature.geometry) <= ENTRANCE_RADIUS_M);
  const standalone: OsmCarpark[] = [];
  for (const feature of entrances) {
    const access = accessOf(feature);
    const operator = tag(feature, "operator");
    if (!access || !carsAllowed(feature) || (operator && HDB_OPERATOR.test(operator))) continue;
    const point = entrancePoint(feature);
    if (!isInSingapore(point.lat, point.lng) || nearHdb(point) || belongsToCarpark(point)) continue;
    const name = tag(feature, "name") ?? tag(feature, "name:en");
    if (standalone.some((other) => other.name === name && distanceM(other, point) <= ENTRANCE_GROUP_M)) continue;
    standalone.push({
      id: osmId(feature),
      kind: "entrance",
      name,
      operator,
      parking: parkingOf(feature),
      access,
      maxHeightM: parseHeight(tag(feature, "maxheight")),
      lat: round(point.lat),
      lng: round(point.lng),
      atEntrance: true
    });
  }
  return [...kept, ...standalone].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

const PARKING_LABEL: Record<NonNullable<OsmCarpark["parking"]>, string> = {
  "multi-storey": "Multi-storey carpark",
  underground: "Underground carpark",
  surface: "Surface carpark",
  rooftop: "Rooftop carpark"
};

/** What a card calls an OpenStreetMap carpark: its name, else its operator's, else what it is. */
export function osmLabel(carpark: OsmCarpark): string {
  if (carpark.name) return carpark.name;
  if (carpark.operator) return `${carpark.operator} ${carpark.kind === "entrance" ? "carpark entrance" : "carpark"}`;
  const kind = carpark.parking ? PARKING_LABEL[carpark.parking] : "Carpark";
  return carpark.kind === "entrance" ? `${kind} entrance` : kind;
}

/** OpenStreetMap carparks in the shape the nearby search uses. HDB-only attributes are "UNKNOWN". */
export function osmRegistry(file: OsmFile | null): RegistryCarpark[] {
  return (file?.carparks ?? []).map((carpark) => ({
    source: "osm",
    id: `osm:${carpark.id}`,
    address: osmLabel(carpark),
    lat: carpark.lat,
    lng: carpark.lng,
    carparkType: carpark.kind === "entrance" ? "Carpark entrance" : carpark.parking ? PARKING_LABEL[carpark.parking] : "Carpark",
    parkingSystem: "UNKNOWN",
    shortTermParking: "UNKNOWN",
    freeParking: "UNKNOWN",
    nightParking: false,
    gantryHeightM: carpark.maxHeightM,
    basement: carpark.parking === "underground",
    osm: { url: `https://www.openstreetmap.org/${carpark.id}`, access: carpark.access, atEntrance: carpark.atEntrance }
  }));
}

/** OpenStreetMap gives no counts. */
export const OSM_AVAILABILITY: CarAvailability = { reportedBy: null, state: "not-in-feed", available: null, total: null, recordedAt: null, freshness: "unknown" };

/**
 * Leaves out OpenStreetMap carparks within DUPLICATE_RADIUS_M of a carpark from a source with counts, so a
 * mall that reports to LTA is listed once, with its count. Uses a ~1 km grid so it stays cheap per request.
 */
export function withoutDuplicates(osm: readonly RegistryCarpark[], others: readonly RegistryCarpark[]): RegistryCarpark[] {
  const cell = (lat: number, lng: number) => `${Math.floor(lat * 100)}:${Math.floor(lng * 100)}`;
  const grid = new Map<string, RegistryCarpark[]>();
  for (const carpark of others) {
    const key = cell(carpark.lat, carpark.lng);
    grid.set(key, [...(grid.get(key) ?? []), carpark]);
  }
  return osm.filter((carpark) => {
    for (const dLat of [-1, 0, 1]) {
      for (const dLng of [-1, 0, 1]) {
        const nearby = grid.get(cell(carpark.lat + dLat / 100, carpark.lng + dLng / 100)) ?? [];
        if (nearby.some((other) => distanceM(carpark, other) <= DUPLICATE_RADIUS_M)) return false;
      }
    }
    return true;
  });
}
