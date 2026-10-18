import { describe, expect, it } from "vitest";
import sample from "../fixtures/osm-parking.sample.json";
import type { OsmFile, RegistryCarpark } from "./domain";
import { centroid, distanceToGeometry, osmLabel, osmRegistry, OSM_AVAILABILITY, parseHeight, selectOsmCarparks, withoutDuplicates, type OsmFeature } from "./osm";
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
    source: { name: "OpenStreetMap", licence: "ODbL-1.0", extract: "test", dataAt: null, builtAt: "2026-10-18T00:00:00Z" },
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
    expect(zoo).toMatchObject({ source: "osm", carparkType: "Multi-storey carpark", osm: { url: "https://www.openstreetmap.org/way/177625322", access: "yes", atEntrance: true } });
    expect(OSM_AVAILABILITY).toMatchObject({ reportedBy: null, state: "not-in-feed", available: null });
    expect(estimateCost(zoo, new Date("2026-10-19T02:00:00Z"), 120).kind).toBe("unavailable");
  });

  it("drops an OpenStreetMap carpark that duplicates one with a count", () => {
    const zoo = registry.find((carpark) => carpark.id === "osm:way/177625322")!;
    const lta = { ...zoo, source: "lta", id: "lta:99", lat: zoo.lat + 0.0005 } as RegistryCarpark;
    expect(withoutDuplicates(registry, [lta]).map((carpark) => carpark.id)).not.toContain("osm:way/177625322");
    expect(withoutDuplicates(registry, [])).toHaveLength(registry.length);
  });
});
