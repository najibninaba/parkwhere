import { describe, expect, it } from "vitest";
import sample from "../fixtures/osm-parking.sample.json";
import type { OsmFile, RegistryCarpark } from "./domain";
import { centroid, distanceToGeometry, osmLabel, osmRegistry, OSM_AVAILABILITY, parseHeight, sameName, selectOsmCarparks, withoutDuplicates, type OsmFeature } from "./osm";
import { estimateCost } from "./tariff";

const features = sample.features as unknown as OsmFeature[];
// The three HDB carparks nearest Pasir Ris Mall (PM21, PM28, PR3), from worker/registry.json.
const hdb = [
  { lat: 1.371196, lng: 103.949415 },
  { lat: 1.374699, lng: 103.947766 },
  { lat: 1.371063, lng: 103.950715 }
];
const selected = selectOsmCarparks(features, hdb);
const byId = (id: string) => selected.find((carpark) => carpark.id === id);

describe("selectOsmCarparks (real OpenStreetMap features)", () => {
  it("keeps only carparks and entrances explicitly open to the public or customers", () => {
    expect(selected.map((carpark) => carpark.id)).toEqual(["node/594359940", "node/1655458915", "node/11445752102", "way/177625322", "way/987337584"]);
  });

  it("leaves out private, untagged, street-side and HDB-run parking", () => {
    for (const id of ["node/1724845170", "node/571492230", "node/11172233838", "node/8199101021"]) expect(byId(id)).toBeUndefined();
  });

  it("puts the zoo carpark at its public entrance, never its private one", () => {
    expect(byId("way/177625322")).toEqual({
      id: "way/177625322",
      kind: "carpark",
      name: null,
      operator: "Wildlife Reserves Singapore",
      parking: "multi-storey",
      access: "yes",
      maxHeightM: null,
      lat: 1.4047,
      lng: 103.788623,
      atEntrance: true
    });
  });

  it("keeps a public entrance with no mapped carpark, but only the one with an access tag", () => {
    expect(byId("node/11445752102")).toMatchObject({ kind: "entrance", parking: "underground", access: "yes", atEntrance: true });
    // Two more underground entrances near Pasir Ris Mall have no access tag, so they're left out.
    expect(byId("node/8961994519")).toBeUndefined();
    expect(byId("node/10811088411")).toBeUndefined();
  });

  it("leaves out carparks next to an HDB carpark, which data.gov.sg already covers", () => {
    const entrance = features.find((feature) => feature.properties["@id"] === 11445752102)!;
    const [lng, lat] = (entrance.geometry as { coordinates: [number, number] }).coordinates;
    expect(selectOsmCarparks(features, [...hdb, { lat: lat + 0.0003, lng }]).some((carpark) => carpark.id === "node/11445752102")).toBe(false);
  });

  it("reads plain metre heights only", () => {
    expect(byId("node/594359940")?.maxHeightM).toBe(2);
    expect(parseHeight("2.1 m")).toBe(2.1);
    expect(parseHeight("default")).toBeNull();
    expect(parseHeight("7'")).toBeNull();
  });
});

describe("selectOsmCarparks edge cases (from Astra's review)", () => {
  // A 100 m square carpark north of Mandai, far from any HDB carpark.
  const ring: [number, number][] = [[103.79, 1.42], [103.7909, 1.42], [103.7909, 1.4209], [103.79, 1.4209], [103.79, 1.42]];
  const carpark = (properties: Record<string, string | number>, coordinates: unknown = [ring]): OsmFeature =>
    ({ type: "Feature", geometry: { type: "Polygon", coordinates }, properties: { amenity: "parking", access: "yes", "@type": "way", "@id": 1, ...properties } }) as OsmFeature;
  const entrance = (id: number, lng: number, lat: number, properties: Record<string, string> = {}): OsmFeature =>
    ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { amenity: "parking_entrance", "@type": "node", "@id": id, ...properties } }) as OsmFeature;

  it("never sends directions to an exit or an entrance closed to cars", () => {
    for (const tags of [{ entrance: "exit" }, { motorcar: "no" }, { motor_vehicle: "private" }, { access: "bus" }] as Record<string, string>[]) {
      const [kept] = selectOsmCarparks([carpark({}), entrance(5, 103.79, 1.4204, tags)], []);
      expect(kept.atEntrance).toBe(false);
    }
    const [kept] = selectOsmCarparks([carpark({}), entrance(5, 103.79, 1.4204, { maxheight: "2.1" })], []);
    expect(kept).toMatchObject({ atEntrance: true, maxHeightM: 2.1 });
  });

  it("treats every part of a multipolygon as the carpark, and a hole as outside it", () => {
    const small: [number, number][] = [[103.8, 1.42], [103.8003, 1.42], [103.8003, 1.4203], [103.8, 1.4203], [103.8, 1.42]];
    const privateTwoParts = { ...carpark({ access: "private" }), geometry: { type: "MultiPolygon", coordinates: [[ring], [small]] } } as OsmFeature;
    // A public entrance inside the private carpark's smaller part belongs to that private carpark.
    expect(selectOsmCarparks([privateTwoParts, entrance(6, 103.80015, 1.42015, { access: "yes" })], [])).toEqual([]);
    const hole: [number, number][] = [[103.7903, 1.4203], [103.7906, 1.4203], [103.7906, 1.4206], [103.7903, 1.4206], [103.7903, 1.4203]];
    expect(distanceToGeometry({ lat: 1.42045, lng: 103.79045 }, { type: "Polygon", coordinates: [ring, hole] })).toBeGreaterThan(10);
  });

  it("keeps unnamed entrances of different operators apart, and groups same-named ones", () => {
    const shopA = entrance(7, 103.85, 1.42, { access: "yes", operator: "Shop A" });
    const shopB = entrance(8, 103.8505, 1.42, { access: "yes", operator: "Shop B" });
    expect(selectOsmCarparks([shopA, shopB], []).map((carpark) => carpark.id)).toEqual(["node/7", "node/8"]);
    const plaza1 = entrance(9, 103.86, 1.42, { access: "yes", name: "Plaza Carpark" });
    const plaza2 = entrance(10, 103.8605, 1.42, { access: "yes", name: "Plaza Carpark" });
    expect(selectOsmCarparks([plaza1, plaza2], []).map((carpark) => carpark.id)).toEqual(["node/9"]);
  });
});

describe("selectOsmCarparks edge cases (from Fable's review)", () => {
  const node = (id: number, lng: number, lat: number, properties: Record<string, string>): OsmFeature =>
    ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { "@type": "node", "@id": id, ...properties } }) as OsmFeature;
  const publicCarpark = (id: number, lng: number, lat: number, properties: Record<string, string> = {}) =>
    node(id, lng, lat, { amenity: "parking", access: "yes", ...properties });

  it("leaves out heavy-vehicle, loading, drop-off, disabled-only and HDB-named parking", () => {
    const cases: Record<string, string>[] = [
      { name: "Jalan Bahar Heavy Vehicle Park" },
      { hgv: "yes" },
      { note: "loading/unloading only" },
      { name: "Pick up/Drop off point" },
      { capacity: "4", "capacity:disabled": "4" },
      { name: "HDB Hub" }
    ];
    for (const [index, tags] of cases.entries()) expect(selectOsmCarparks([publicCarpark(100 + index, 103.85, 1.42, tags)], [])).toEqual([]);
    expect(selectOsmCarparks([publicCarpark(99, 103.85, 1.42, { capacity: "40", "capacity:disabled": "4" })], [])).toHaveLength(1);
  });

  it("lists a carpark once when it's mapped as a point, an area and entrances", () => {
    // UOB Tampines Centre: a carpark point with two public entrances within 45 m.
    const uob = [
      publicCarpark(2871632528, 103.9445, 1.3535, { name: "UOB Tampines Centre Carpark" }),
      node(2871632384, 103.9448, 1.3535, { amenity: "parking_entrance", access: "yes" }),
      node(2871632530, 103.9445, 1.3538, { amenity: "parking_entrance", access: "yes" })
    ];
    expect(selectOsmCarparks(uob, []).map((carpark) => carpark.id)).toEqual(["node/2871632528"]);
    // The same mall as a named point and a named area 60 m apart.
    const square: [number, number][] = [[103.7465, 1.3345], [103.747, 1.3345], [103.747, 1.335], [103.7465, 1.335], [103.7465, 1.3345]];
    const imm = [
      publicCarpark(3500806966, 103.7462, 1.3342, { name: "IMM" }),
      { type: "Feature", geometry: { type: "Polygon", coordinates: [square] }, properties: { "@type": "way", "@id": 429038696, amenity: "parking", access: "yes", name: "IMM Building Carpark" } } as OsmFeature
    ];
    expect(selectOsmCarparks(imm, []).map((carpark) => carpark.id)).toEqual(["way/429038696"]);
  });

  it("matches names loosely but not too loosely", () => {
    expect(sameName("Suntec City", "Suntec City Carpark")).toBe(true);
    expect(sameName("VivoCity P2", "VivoCity")).toBe(true);
    expect(sameName("Plaza Singapura", "Parklane Shopping Mall")).toBe(false);
    expect(sameName(null, null)).toBe(false);
  });
});

describe("geometry helpers", () => {
  const square = { type: "Polygon" as const, coordinates: [[[103.8, 1.3], [103.801, 1.3], [103.801, 1.301], [103.8, 1.301], [103.8, 1.3]] as [number, number][]] };

  it("finds a polygon's centre and the distance to its edge", () => {
    expect(centroid(square)).toEqual({ lat: expect.closeTo(1.3005, 6), lng: expect.closeTo(103.8005, 6) });
    expect(distanceToGeometry({ lat: 1.3005, lng: 103.8005 }, square)).toBe(0);
    expect(distanceToGeometry({ lat: 1.3005, lng: 103.8012 }, square)).toBeCloseTo(22.3, 0);
  });
});

describe("osmRegistry and osmLabel", () => {
  const file: OsmFile = {
    source: { name: "OpenStreetMap", licence: "ODbL-1.0", extract: "test", dataAt: null },
    carparks: selected
  };
  const registry = osmRegistry(file);

  it("names a carpark by its name, else its operator, else what it is", () => {
    expect(registry.map((carpark) => carpark.address)).toEqual([
      "Orchard Point Carpark",
      "OG Building",
      "Underground carpark entrance",
      "Wildlife Reserves Singapore carpark",
      "Main Entrance Basement Carpark"
    ]);
    expect(osmLabel({ ...selected[0], name: null, operator: null, parking: null })).toBe("Carpark");
  });

  it("links each carpark to its OpenStreetMap object and has no count or price", () => {
    const zoo = registry.find((carpark) => carpark.id === "osm:way/177625322")!;
    expect(zoo).toMatchObject({ source: "osm", carparkType: "Multi-storey carpark", osm: { url: "https://www.openstreetmap.org/way/177625322", access: "yes", atEntrance: true, named: false } });
    expect(OSM_AVAILABILITY).toMatchObject({ reportedBy: null, state: "not-in-feed", available: null });
    expect(estimateCost(zoo, new Date("2026-10-19T02:00:00Z"), 120).kind).toBe("unavailable");
  });

  it("drops an OpenStreetMap carpark that duplicates one with a count", () => {
    const zoo = registry.find((carpark) => carpark.id === "osm:way/177625322")!;
    const lta = { ...zoo, source: "lta", id: "lta:99", lat: zoo.lat + 0.0005 } as RegistryCarpark;
    expect(withoutDuplicates(registry, [lta]).map((carpark) => carpark.id)).not.toContain("osm:way/177625322");
    expect(withoutDuplicates(registry, [])).toHaveLength(registry.length);
    // Suntec City: LTA's point is 89 m from OpenStreetMap's, so it's matched by name.
    const osmSuntec = { ...zoo, id: "osm:node/1834868786", address: "Suntec City", lat: 1.29455, lng: 103.85714 };
    const ltaSuntec = { ...zoo, source: "lta", id: "lta:1", address: "Suntec City", lat: 1.29375, lng: 103.85718 } as RegistryCarpark;
    expect(withoutDuplicates([osmSuntec], [ltaSuntec])).toEqual([]);
    // An unnamed entry near a carpark with counts is taken to be part of it; a named, differently named one isn't.
    const unnamed = { ...zoo, lat: 1.2955, lng: 103.85718 };
    expect(withoutDuplicates([unnamed], [ltaSuntec])).toEqual([]);
    expect(withoutDuplicates([{ ...unnamed, address: "Raffles City", osm: { ...zoo.osm!, named: true } }], [ltaSuntec])).toHaveLength(1);
    // HDB addresses are block numbers, so a name match against them never counts.
    expect(withoutDuplicates([osmSuntec], [{ ...ltaSuntec, source: undefined, id: "X1" }])).toHaveLength(1);
  });
});
