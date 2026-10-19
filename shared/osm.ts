// Public carparks mapped on OpenStreetMap (© OpenStreetMap contributors, Open Database Licence 1.0).
// scripts/sync-osm.ts cuts Singapore's amenity=parking and amenity=parking_entrance features out of
// Geofabrik's extract with osmium and passes them to selectOsmCarparks. The result is bundled as
// worker/osm-carparks.json. These carparks have no count and no price: OpenStreetMap only says where a
// carpark is and who may use it. Carparks mapped at public places with no access tag are picked by
// shared/osm-places.ts and go in the same file; osmRegistry and withoutDuplicates handle both.
import type { CarAvailability, OsmAccess, OsmCarpark, OsmFile, OsmPlaceCarpark, RegistryCarpark } from "./domain";
// .ts extension: scripts/sync-osm.ts runs this file directly under Node.
import { distanceM, isInSingapore } from "./nearby.ts";

export type Position = [number, number];
export type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };

/** One line of `osmium export -f geojsonseq -a type,id`: tags as properties, plus "@type" and "@id". */
export interface OsmFeature {
  type: "Feature";
  geometry: Geometry;
  properties: Record<string, string | number>;
}

export interface Point { lat: number; lng: number }

/** Only explicit tags make a carpark usable by the public. A missing access tag is often a condo or office carpark. */
const PUBLIC_ACCESS = new Set<string>(["yes", "customers", "permissive"]);
/** An entrance with one of these access tags (or none) may be where directions go; private, bus or delivery ones never. */
const ENTRANCE_ACCESS = new Set(["", "yes", "customers", "permissive", "destination"]);
/** Kerbside and lane parking is URA's or HDB's street parking, not a carpark. */
const PARKING_KINDS = new Set(["multi-storey", "underground", "surface", "rooftop"]);
export const EXCLUDED_PARKING = new Set(["street_side", "lane", "on_kerb", "half_on_kerb", "layby", "carports", "garage_boxes", "sheds"]);
const HDB_RUN = /\bHDB\b|housing\s*(&|and)?\s*development\s*board/i;
/** Parking that isn't for a car visit: heavy vehicles, loading, drop-off, season holders, coaches, two-wheelers. */
const NOT_FOR_CARS = /heavy vehicle|\bhgv\b|lorr(y|ies)|loading|drop[\s-]?off|pick[\s-]?up|season|coach|\bbus(es)?\b|motorcycle|motorbike|bicycle/i;

/** An entrance this close to a carpark's outline belongs to that carpark. */
export const ENTRANCE_RADIUS_M = 25;
/** An OpenStreetMap carpark this close to an HDB, LTA or URA carpark is taken to be the same one, and left out. */
export const DUPLICATE_RADIUS_M = 80;
/** A carpark mapped as a single point takes an entrance this close to it. */
export const POINT_ENTRANCE_RADIUS_M = 50;
/** Standalone unnamed entrances of the same operator this close together are one carpark's; one is kept. */
export const ENTRANCE_GROUP_M = 120;
/** Two OpenStreetMap entries this close together are one carpark; the better-described one is kept. */
export const SAME_PLACE_M = 50;
/** Entries with the same name this close together are one carpark, e.g. a mall mapped as a point and as an area. */
export const SAME_NAME_M = 300;
/**
 * An unnamed OpenStreetMap entry this close to an LTA or URA carpark is taken to be part of it. In dense
 * areas such as Orchard Road an unnamed entrance near a mall that reports counts is almost always that mall's.
 */
export const UNNAMED_NEAR_COUNTED_M = 250;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
export const tag = (feature: OsmFeature, key: string) => text(feature.properties[key]) || null;
export const osmId = (feature: OsmFeature) => `${text(feature.properties["@type"])}/${text(feature.properties["@id"])}`;
export const round = (value: number) => Number(value.toFixed(6));

/** "2.1", "2.1 m", "2.10m" -> 2.1; anything else ("default", "none", feet) -> null. */
export function parseHeight(value: string | null): number | null {
  const match = value?.match(/^(\d+(?:\.\d+)?)\s*m?$/i);
  const metres = match ? Number(match[1]) : NaN;
  return Number.isFinite(metres) && metres > 1 && metres < 10 ? metres : null;
}

/** Outer ring of a polygon, or of the largest part of a multipolygon. Used only to place a centroid. */
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
export function ringArea(ring: Position[]): number {
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

/** Every part of a polygon or multipolygon, each as [outer ring, ...holes]. */
export function polygons(geometry: Geometry): Position[][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

/**
 * Metres from a point to a geometry: 0 inside any part (but not inside one of its holes), otherwise to the
 * nearest edge of any ring. Flat-earth maths, which is fine at carpark scale.
 */
export function distanceToGeometry(point: Point, geometry: Geometry): number {
  if (geometry.type === "Point") return distanceM(point, { lat: geometry.coordinates[1], lng: geometry.coordinates[0] });
  const { inside, edgeM } = edgeDistance(point, geometry);
  return inside ? 0 : edgeM;
}

/** Whether a point is inside a polygon or multipolygon (not in a hole), and metres to its nearest edge. */
function edgeDistance(point: Point, geometry: Geometry): { inside: boolean; edgeM: number } {
  const kx = 111_320 * Math.cos((point.lat * Math.PI) / 180);
  const ky = 110_574;
  const xy = (p: Position) => [(p[0] - point.lng) * kx, (p[1] - point.lat) * ky] as const;
  let best = Infinity;
  /** Ray-casting test for the point (the origin) inside a ring, tracking the nearest edge as it goes. */
  const scan = (ring: Position[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [x1, y1] = xy(ring[i]);
      const [x2, y2] = xy(ring[j]);
      if (y1 > 0 !== y2 > 0 && 0 < ((x2 - x1) * (0 - y1)) / (y2 - y1) + x1) inside = !inside;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
    }
    return inside;
  };
  let inside = false;
  for (const [outer, ...holes] of polygons(geometry)) {
    if (!outer || outer.length < 2) continue;
    const inOuter = scan(outer);
    const inHole = holes.map(scan).some(Boolean);
    if (inOuter && !inHole) inside = true;
  }
  return { inside, edgeM: best };
}

/**
 * A point well inside a carpark area: the centre of the largest circle that fits in its largest part (its pole
 * of inaccessibility), found to within about half a metre. A centroid can fall outside a ring-shaped or
 * L-shaped carpark, on grass or inside a building.
 */
export function interiorPoint(geometry: Geometry): Point {
  const middle = centroid(geometry);
  let part: Position[][] | null = null;
  let largest = -1;
  for (const polygon of polygons(geometry)) {
    const area = Math.abs(ringArea(polygon[0] ?? []));
    if ((polygon[0]?.length ?? 0) >= 4 && area > largest) { part = polygon; largest = area; }
  }
  if (!part) return middle;
  const shape: Geometry = { type: "Polygon", coordinates: part };
  const lats = part[0].map((p) => p[1]);
  const lngs = part[0].map((p) => p[0]);
  const south = Math.min(...lats);
  const west = Math.min(...lngs);
  const kx = 111_320 * Math.cos((south * Math.PI) / 180);
  const ky = 110_574;
  const width = (Math.max(...lngs) - west) * kx;
  const height = (Math.max(...lats) - south) * ky;
  const size = Math.min(width, height);
  if (!(size > 0)) return middle;
  /** Metres from the edge: positive inside, negative outside. */
  const depth = (x: number, y: number) => {
    const { inside, edgeM } = edgeDistance({ lat: south + y / ky, lng: west + x / kx }, shape);
    return inside ? edgeM : -edgeM;
  };
  type Cell = { x: number; y: number; half: number; depth: number; best: number };
  const cell = (x: number, y: number, half: number): Cell => {
    const d = depth(x, y);
    return { x, y, half, depth: d, best: d + half * Math.SQRT2 };
  };
  // Cells by how deep a point inside them could be, deepest first.
  const queue: Cell[] = [];
  const push = (item: Cell) => {
    queue.push(item);
    for (let i = queue.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (queue[parent].best >= queue[i].best) break;
      [queue[parent], queue[i]] = [queue[i], queue[parent]];
      i = parent;
    }
  };
  const pop = (): Cell => {
    const top = queue[0];
    const last = queue.pop()!;
    if (queue.length > 0) {
      queue[0] = last;
      for (let i = 0; ; ) {
        const left = 2 * i + 1;
        const right = left + 1;
        let next = i;
        if (left < queue.length && queue[left].best > queue[next].best) next = left;
        if (right < queue.length && queue[right].best > queue[next].best) next = right;
        if (next === i) break;
        [queue[next], queue[i]] = [queue[i], queue[next]];
        i = next;
      }
    }
    return top;
  };
  for (let x = 0; x < width; x += size) for (let y = 0; y < height; y += size) push(cell(x + size / 2, y + size / 2, size / 2));
  let found = cell((middle.lng - west) * kx, (middle.lat - south) * ky, 0);
  const box = cell(width / 2, height / 2, 0);
  if (box.depth > found.depth) found = box;
  const PRECISION_M = 0.5;
  for (let steps = 0; queue.length > 0 && steps < 10_000; steps += 1) {
    const next = pop();
    if (next.depth > found.depth) found = next;
    if (next.best - found.depth <= PRECISION_M) continue;
    const half = next.half / 2;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) push(cell(next.x + dx * half, next.y + dy * half, half));
  }
  return found.depth > 0 ? { lat: south + found.y / ky, lng: west + found.x / kx } : middle;
}

const accessOf = (feature: OsmFeature): OsmAccess | null => {
  const access = tag(feature, "access");
  return access && PUBLIC_ACCESS.has(access) ? (access as OsmAccess) : null;
};

export const carsAllowed = (feature: OsmFeature) =>
  !["motorcar", "motor_vehicle", "vehicle"].some((key) => ["no", "private"].includes(tag(feature, key) ?? ""));

/** Names that mean the same carpark: "Suntec City" and "Suntec City Carpark", "IMM" and "IMM Building". */
export function sameName(a: string | null, b: string | null): boolean {
  const norm = (name: string | null) =>
    (name ?? "").toLowerCase().replace(/\(off-street\)|car\s*park|parking|multi-storey|basement/g, "").replace(/[^a-z0-9]/g, "");
  const [x, y] = [norm(a), norm(b)];
  if (x.length < 3 || y.length < 3) return false;
  return x === y || x.includes(y) || y.includes(x);
}

const disabledOnly = (feature: OsmFeature) => {
  const capacity = Number(tag(feature, "capacity"));
  return capacity > 0 && Number(tag(feature, "capacity:disabled")) === capacity;
};

/** Heavy-vehicle, loading, drop-off, season-only or disabled-only parking, by tag or by what its name or notes say. */
export const notForCars = (feature: OsmFeature) =>
  ["name", "description", "note", "parking:condition"].some((key) => NOT_FOR_CARS.test(tag(feature, key) ?? "")) ||
  (["yes", "designated"].includes(tag(feature, "hgv") ?? "") && tag(feature, "motorcar") !== "yes") ||
  disabledOnly(feature);

/** Run by HDB, by operator or name: data.gov.sg already lists HDB carparks, with counts. */
export const hdbRun = (feature: OsmFeature) => [tag(feature, "operator"), tag(feature, "name")].some((value) => value !== null && HDB_RUN.test(value));

export const parkingOf = (feature: OsmFeature): OsmCarpark["parking"] => {
  const parking = tag(feature, "parking");
  return parking && PARKING_KINDS.has(parking) ? (parking as OsmCarpark["parking"]) : null;
};

/**
 * Picks the public carparks from Singapore's mapped parking features. A carpark needs an explicit access tag
 * of yes, customers or permissive; street parking, HDB-run carparks and anything within DUPLICATE_RADIUS_M of
 * an HDB carpark (covered by data.gov.sg) are left out. A usable entrance near a kept carpark becomes its
 * point. An entrance with explicit public access and no carpark of its own is kept as an entrance, once per
 * name or operator.
 */
export function selectOsmCarparks(features: readonly OsmFeature[], hdb: readonly Point[]): OsmCarpark[] {
  const nearHdb = (point: Point) => hdb.some((carpark) => distanceM(point, carpark) <= DUPLICATE_RADIUS_M);
  const parkings = features.filter((feature) => tag(feature, "amenity") === "parking");
  const entrances = features
    .filter((feature) => tag(feature, "amenity") === "parking_entrance" && feature.geometry.type === "Point")
    .sort((a, b) => osmId(a).localeCompare(osmId(b), "en", { numeric: true }));
  const entrancePoint = (feature: OsmFeature) => centroid(feature.geometry);
  /** How far from a carpark its entrances can be: its outline, or around its single mapped point. */
  const reach = (feature: OsmFeature) => (feature.geometry.type === "Point" ? POINT_ENTRANCE_RADIUS_M : ENTRANCE_RADIUS_M);
  // Directions never go to a private, bus or delivery entrance, one closed to cars, or an exit.
  const usableEntrance = (feature: OsmFeature) =>
    ENTRANCE_ACCESS.has(tag(feature, "access") ?? "") && carsAllowed(feature) && tag(feature, "entrance") !== "exit" && !/\bexit\b/i.test(tag(feature, "name") ?? "");

  const kept: OsmCarpark[] = [];
  for (const feature of parkings) {
    const access = accessOf(feature);
    const parking = tag(feature, "parking");
    const operator = tag(feature, "operator");
    if (!access || !carsAllowed(feature) || (parking && EXCLUDED_PARKING.has(parking)) || hdbRun(feature) || notForCars(feature)) continue;
    const middle = centroid(feature.geometry);
    if (!isInSingapore(middle.lat, middle.lng) || nearHdb(middle)) continue;
    const entrance = entrances.find((candidate) => usableEntrance(candidate) && distanceToGeometry(entrancePoint(candidate), feature.geometry) <= reach(feature));
    const point = entrance ? entrancePoint(entrance) : middle;
    kept.push({
      id: osmId(feature),
      kind: "carpark",
      name: tag(feature, "name") ?? tag(feature, "name:en"),
      operator,
      parking: parkingOf(feature),
      access,
      // Height limits are often mapped on the entrance rather than the carpark.
      maxHeightM: parseHeight(tag(feature, "maxheight")) ?? (entrance ? parseHeight(tag(entrance, "maxheight")) : null),
      lat: round(point.lat),
      lng: round(point.lng),
      atEntrance: Boolean(entrance)
    });
  }

  // Entrances of any mapped carpark, public or not, aren't standalone: a private carpark's entrance stays private.
  const belongsToCarpark = (point: Point) => parkings.some((feature) => distanceToGeometry(point, feature.geometry) <= reach(feature));
  const standalone: OsmCarpark[] = [];
  for (const feature of entrances) {
    const access = accessOf(feature);
    const operator = tag(feature, "operator");
    if (!access || !usableEntrance(feature) || hdbRun(feature) || notForCars(feature)) continue;
    const point = entrancePoint(feature);
    if (!isInSingapore(point.lat, point.lng) || nearHdb(point) || belongsToCarpark(point)) continue;
    const name = tag(feature, "name") ?? tag(feature, "name:en");
    // Only entrances that share a name (or, unnamed, an operator) are taken as one carpark's. Two unnamed
    // entrances near each other may well be different buildings' carparks, so both are kept.
    const sameCarpark = (other: OsmCarpark) =>
      ((name !== null && other.name === name) || (name === null && other.name === null && operator !== null && other.operator === operator)) &&
      distanceM(other, point) <= ENTRANCE_GROUP_M;
    if (standalone.some(sameCarpark)) continue;
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
  return withoutRepeats([...kept, ...standalone]).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/**
 * One entry per carpark. OpenStreetMap often maps a carpark more than once (as a point and as an area, or as
 * a carpark and its entrances), so entries within SAME_PLACE_M, or with the same name within SAME_NAME_M, are
 * one carpark. Mapped areas beat points, carparks beat entrances, and named entries beat unnamed ones.
 */
function withoutRepeats(entries: OsmCarpark[]): OsmCarpark[] {
  const rank = (entry: OsmCarpark) => (entry.kind === "carpark" ? 0 : 4) + (entry.id.startsWith("node/") ? 2 : 0) + (entry.name ? 0 : 1);
  const ordered = [...entries].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, "en", { numeric: true }));
  const kept: OsmCarpark[] = [];
  for (const entry of ordered) {
    const repeat = kept.some((other) => {
      const distance = distanceM(other, entry);
      return distance <= SAME_PLACE_M || (distance <= SAME_NAME_M && sameName(other.name, entry.name));
    });
    if (!repeat) kept.push(entry);
  }
  return kept;
}

export const PARKING_LABEL: Record<NonNullable<OsmCarpark["parking"]>, string> = {
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

/** What a carpark mapped at a public place is, from its point: "Underground carpark entrance", "Surface carpark". */
export function placeCarparkType(place: Pick<OsmPlaceCarpark, "parking" | "atEntrance">): string {
  const kind = place.parking ? PARKING_LABEL[place.parking] : "Carpark";
  return place.atEntrance ? `${kind} entrance` : kind;
}

/**
 * A carpark mapped at a public place, as a card title: "Carpark mapped at Jewel Changi Airport", or with the
 * carpark's own name when it has one in the file: "Carpark mapped at Changi Beach Park (Carpark 1)".
 */
export const placeCarparkTitle = (place: Pick<OsmPlaceCarpark, "placeName" | "relation" | "carparkName">) =>
  `Carpark mapped ${place.relation === "at" ? "at" : "next to"} ${place.placeName}${place.carparkName ? ` (${place.carparkName})` : ""}`;

/** Carparks mapped at public places, in the shape the nearby search uses. Access stays "unknown". */
function placeRegistry(file: OsmFile | null): RegistryCarpark[] {
  return (file?.places ?? []).map((place) => ({
    source: "osm",
    id: `osm:place:${place.id}`,
    address: placeCarparkTitle(place),
    lat: place.lat,
    lng: place.lng,
    carparkType: placeCarparkType(place),
    parkingSystem: "UNKNOWN",
    shortTermParking: "UNKNOWN",
    freeParking: "UNKNOWN",
    nightParking: false,
    gantryHeightM: place.maxHeightM,
    basement: place.parking === "underground",
    osm: {
      url: `https://www.openstreetmap.org/${place.evidence[0]}`,
      access: "unknown",
      atEntrance: place.atEntrance,
      named: true,
      place: { name: place.placeName, kind: place.placeKind, relation: place.relation }
    }
  }));
}

/** OpenStreetMap carparks in the shape the nearby search uses. HDB-only attributes are "UNKNOWN". */
export function osmRegistry(file: OsmFile | null): RegistryCarpark[] {
  return [...publicRegistry(file), ...placeRegistry(file)];
}

function publicRegistry(file: OsmFile | null): RegistryCarpark[] {
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
    osm: { url: `https://www.openstreetmap.org/${carpark.id}`, access: carpark.access, atEntrance: carpark.atEntrance, named: carpark.name !== null }
  }));
}

/** An LTA or URA carpark this close to a carpark mapped at a place is the same carpark, whatever its name (Ridout Tea Garden). */
export const SAME_SPOT_M = 30;

/** LTA's short forms, spelt out so "Bt Panjang Plaza" matches "Bukit Panjang Plaza". */
const ABBREVIATIONS: Record<string, string> = { bt: "bukit", jln: "jalan", rd: "road", ave: "avenue", st: "street", ctr: "centre", sq: "square", pk: "park", upp: "upper", lor: "lorong" };
export const expandAbbreviations = (name: string) => name.replace(/\b([a-z]+)\b\.?/gi, (word, letters: string) => ABBREVIATIONS[letters.toLowerCase()] ?? word);

/** OpenStreetMap gives no counts. */
export const OSM_AVAILABILITY: CarAvailability = { reportedBy: null, state: "not-in-feed", available: null, total: null, recordedAt: null, freshness: "unknown" };

/**
 * Leaves out OpenStreetMap carparks that duplicate a carpark from a source with counts, so a mall that
 * reports to LTA is listed once, with its count: any within DUPLICATE_RADIUS_M, or an LTA or URA carpark
 * with the same name within SAME_NAME_M (LTA's point for Suntec City is 89 m from OpenStreetMap's), or an
 * unnamed one within UNNAMED_NEAR_COUNTED_M of an LTA or URA carpark. HDB
 * addresses are block numbers, so only distance applies to them. Uses a ~1 km grid to stay cheap per request.
 *
 * A carpark mapped at a public place is left out only when it's a true duplicate: within DUPLICATE_RADIUS_M of
 * an HDB carpark, or an LTA or URA carpark within SAME_SPOT_M or with the place's name within SAME_NAME_M
 * (Suntec City; "Bt Panjang Plaza" for Bukit Panjang Plaza). A nearby LTA or URA carpark with another name is
 * another carpark, so the place keeps its entry.
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
        const duplicate = (other: RegistryCarpark) => {
          const distance = distanceM(carpark, other);
          const place = carpark.osm?.place;
          if (place) {
            if ((other.source ?? "hdb") === "hdb") return distance <= DUPLICATE_RADIUS_M;
            if (other.source === "osm") return false;
            return distance <= SAME_SPOT_M || (distance <= SAME_NAME_M && sameName(expandAbbreviations(place.name), expandAbbreviations(other.address)));
          }
          if (distance <= DUPLICATE_RADIUS_M) return true;
          if ((other.source ?? "hdb") === "hdb") return false;
          return carpark.osm?.named === false ? distance <= UNNAMED_NEAR_COUNTED_M : distance <= SAME_NAME_M && sameName(carpark.address, other.address);
        };
        if (nearby.some(duplicate)) return false;
      }
    }
    return true;
  });
}
