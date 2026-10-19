import { describe, expect, it } from "vitest";
import sample from "../fixtures/osm-places.sample.json";
import type { OsmCarpark, OsmFile, RegistryCarpark } from "./domain";
import { distanceM } from "./nearby";
import { OSM_AVAILABILITY, osmId, osmRegistry, placeCarparkTitle, withoutDuplicates, type OsmFeature } from "./osm";
import { GENERIC_PLACE_NAMES, namedAfter, placeOf, possibleVisitorParking, selectPlaceCarparks } from "./osm-places";
import { estimateCost } from "./tariff";

const TODAY = "2026-10-17";
const places = sample.places as unknown as OsmFeature[];
const parking = sample.parking as unknown as OsmFeature[];
const hdb = sample.hdb;
const shown = sample.shown as unknown as OsmCarpark[];
const feature = (id: string) => [...places, ...parking].find((item) => osmId(item) === id)!;
const run = (overrides: { places?: OsmFeature[]; parking?: OsmFeature[]; hdb?: { lat: number; lng: number }[]; shown?: OsmCarpark[] } = {}) =>
  selectPlaceCarparks(overrides.places ?? places, overrides.parking ?? parking, overrides.hdb ?? hdb, overrides.shown ?? shown, TODAY);
const selected = run();
const entry = (id: string) => selected.places.find((place) => place.id === id);
const pointOf = (id: string) => {
  const [lng, lat] = (feature(id).geometry as { coordinates: [number, number] }).coordinates;
  return { lat, lng };
};
/** The fixture without the multi-storey carpark 27 m outside Pinery Mall, so only the mall's own entrances are left. */
const pineryOnly = parking.filter((item) => !["node/12376189571", "way/1337982551"].includes(osmId(item)));
const withTags = (base: OsmFeature, tags: Record<string, string | undefined>): OsmFeature => {
  const properties = { ...base.properties, ...tags };
  for (const [key, value] of Object.entries(tags)) if (value === undefined) delete properties[key];
  return { ...base, properties } as OsmFeature;
};

describe("selectPlaceCarparks (real OpenStreetMap features)", () => {
  it("lists one carpark per place, and only places with one mapped there", () => {
    expect(selected.places.map((place) => `${place.placeName}: ${place.relation}`)).toEqual([
      "i12 Katong: at",
      "Tampines Mall: at",
      "Square 2: at",
      "Singapore Expo: at",
      "Funan: next-to",
      "Jewel Changi Basement: at",
      "Hampstead Wetlands Park: at",
      "Causeway Point: at",
      "Pinery Mall: at"
    ]);
    for (const place of selected.places) expect(place).toMatchObject({ kind: "place", access: "unknown" });
  });

  it("finds Jewel's carpark from its basement entrances and points directions at one", () => {
    expect(entry("way/547383951")).toEqual({
      id: "way/547383951",
      kind: "place",
      placeName: "Jewel Changi Basement",
      placeKind: "mall",
      relation: "at",
      evidence: ["node/13856188306", "node/13856188307", "node/13856216820", "node/13856216822"],
      atEntrance: true,
      parking: "underground",
      maxHeightM: 2.1,
      access: "unknown",
      lat: 1.360483,
      lng: 103.990853
    });
    // The same entrances are 15 to 35 m outside Jewel Changi Airport's outline: one carpark, one card.
    expect(entry("way/744520551")).toBeUndefined();
    expect(selected.removed.shared).toContain("way/744520551");
  });

  it("finds Singapore Expo's carpark from lots named after it, and uses the middle of a lot", () => {
    expect(entry("way/173028306")).toMatchObject({ placeKind: "venue", relation: "at", atEntrance: false, parking: "surface" });
    expect(entry("way/173028306")?.evidence).toContain("way/171494334");
    expect(namedAfter("Singapore Expo", "Singapore Expo")).toBe(true);
    expect(namedAfter("Singapore EXPO Car Park A", "Singapore Expo")).toBe(true);
    expect(namedAfter("Expo Car Park", "Singapore Expo")).toBe(false);
    expect(namedAfter("Plaza Carpark", "Plaza Singapura")).toBe(false);
    expect(namedAfter("Nexus Carpark", "NEX")).toBe(false);
    expect(namedAfter("NEX Carpark", "NEX")).toBe(true);
  });

  it("says next to when the carpark is just outside the outline, and never uses Funan's exit", () => {
    expect(entry("way/432515092")).toMatchObject({ relation: "next-to", atEntrance: true, evidence: ["node/612392167", "node/6045374651"] });
    expect(possibleVisitorParking(feature("node/12525830322"), TODAY)).toBe(false);
    expect(placeCarparkTitle(entry("way/432515092")!)).toBe("Carpark mapped next to Funan");
    expect(placeCarparkTitle(entry("way/172529121")!)).toBe("Carpark mapped at Square 2");
  });

  it("never takes a park's carpark from an entrance, only from a carpark area inside it", () => {
    // Henry Park's only evidence is a condo's carpark entrance 7 m outside the park.
    expect(entry("way/190023271")).toBeUndefined();
    expect(entry("way/877498629")).toMatchObject({ placeKind: "park", relation: "at", atEntrance: false, evidence: ["way/895588282"] });
  });

  it("gives a shared entrance to one place: a venue, then the one it's inside, then the smaller", () => {
    // Royal Square at Novena and Square 2 share Novena Square 2's entrance; it's inside Square 2.
    expect(entry("way/172529121")?.evidence).toEqual(["node/1834245738"]);
    expect(entry("way/260571322")).toBeUndefined();
    // Katong Square and i12 Katong share one entrance, inside i12 Katong.
    expect(entry("way/44121574")?.evidence).toEqual(["node/4623296185"]);
    expect(entry("way/561552023")).toBeUndefined();
    const evidence = selected.places.flatMap((place) => place.evidence);
    expect(new Set(evidence).size).toBe(evidence.length);
  });

  it("lists a place mapped in several parts with one name once", () => {
    // Without the public Suntec City carpark, its four parts still make one entry.
    const suntec = run({ shown: [] }).places.filter((place) => place.placeName === "Suntec City");
    expect(suntec).toHaveLength(1);
  });

  it("skips a place that already has a public carpark from osm-carparks.json", () => {
    expect(selected.places.some((place) => place.placeName === "Suntec City")).toBe(false);
    expect(selected.removed.shown).toEqual(expect.arrayContaining(["way/46595137", "way/393210508", "way/393210509", "way/492114727"]));
  });

  it("drops only true HDB duplicates: HDB-run or within 80 m of an HDB carpark", () => {
    // Causeway Point's entrance is 122 m from an HDB carpark, so it stays.
    const causeway = entry("way/1395633020")!;
    expect(Math.min(...hdb.map((carpark) => distanceM(carpark, causeway)))).toBeGreaterThan(80);
    expect(Math.min(...hdb.map((carpark) => distanceM(carpark, causeway)))).toBeLessThan(150);
    // An HDB carpark 30 m from Pinery Mall's entrance makes it HDB's.
    const pinery = pointOf("node/13652313510");
    const result = run({ hdb: [...hdb, { lat: pinery.lat + 0.00027, lng: pinery.lng }] });
    expect(result.places.some((place) => place.id === "way/1489454435")).toBe(false);
    expect(result.removed.hdb).toContain("way/1489454435");
    // An HDB-run entrance is left out. The mall falls back to an entrance 27 m outside it; without that, it has no entry.
    const hdbRun = (features: OsmFeature[]) =>
      run({ parking: features.map((item) => (osmId(item) === "node/13652313510" ? withTags(item, { operator: "Housing & Development Board" }) : item)) });
    expect(hdbRun(parking).places.find((place) => place.id === "way/1489454435")).toMatchObject({ relation: "next-to", evidence: ["node/12376189571"] });
    expect(hdbRun(pineryOnly).places.some((place) => place.id === "way/1489454435")).toBe(false);
  });

  it("leaves out an entrance at a carpark that is private or not for cars", () => {
    const parking = pineryOnly;
    const pinery = pointOf("node/13652313510");
    const d = 0.00005;
    const ring: [number, number][] = [[pinery.lng - d, pinery.lat - d], [pinery.lng + d, pinery.lat - d], [pinery.lng + d, pinery.lat + d], [pinery.lng - d, pinery.lat + d], [pinery.lng - d, pinery.lat - d]];
    const area = (tags: Record<string, string>) =>
      ({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: [[ring]] }, properties: { "@type": "way", "@id": 1, amenity: "parking", ...tags } }) as OsmFeature;
    for (const tags of [{ access: "private" }, { name: "Loading Bay" }, { access: "residents" }] as Record<string, string>[]) {
      expect(run({ parking: [...parking, area(tags)] }).places.some((place) => place.id === "way/1489454435")).toBe(false);
    }
    // An untagged carpark there is fine: the entrance is its entrance.
    expect(run({ parking: [...parking, area({})] }).places.find((place) => place.id === "way/1489454435")?.atEntrance).toBe(true);
  });
});

describe("possibleVisitorParking", () => {
  const entrance = feature("node/13652313510");

  it("rejects residents', hospital, lorry and exit features from the real data", () => {
    expect(possibleVisitorParking(entrance, TODAY)).toBe(true);
    expect(possibleVisitorParking(feature("node/13652313523"), TODAY)).toBe(false); // "Access to residents' carpark"
    expect(possibleVisitorParking(feature("node/1834256907"), TODAY)).toBe(false); // "Mount Elizabeth Novena Hospital"
    expect(possibleVisitorParking(feature("way/162376933"), TODAY)).toBe(false); // "Buses and Lorries Only"
    expect(possibleVisitorParking(feature("node/12525830322"), TODAY)).toBe(false); // "Funan Carpark Exit"
  });

  it("rejects closed access, vehicles other than cars, street parking, exits and closures", () => {
    const rejected: Record<string, string>[] = [
      ...["private", "no", "permit", "delivery", "residents", "employees", "staff", "bus", "licence"].map((access) => ({ access })),
      { motorcar: "no" },
      { motor_vehicle: "private" },
      { hgv: "yes" },
      { name: "Heavy Vehicle Park" },
      { note: "loading/unloading only" },
      { description: "Drop-off only" },
      { name: "Season Parking" },
      { name: "Coach Bay" },
      { name: "Motorcycle Lots" },
      { capacity: "3", "capacity:disabled": "3" },
      { operator: "HDB" },
      { parking: "street_side" },
      { parking: "lane" },
      { entrance: "exit" },
      { entrance: "service" },
      { name: "Carpark Exit" },
      { name: "Carpark (closed)" },
      { description: "Under construction" },
      { note: "staff only" },
      { construction: "yes" },
      { disused: "yes" },
      { opening_date: "2027-03" }
    ];
    for (const tags of rejected) expect([tags, possibleVisitorParking(withTags(entrance, tags), TODAY)]).toEqual([tags, false]);
    for (const tags of [{ access: "yes" }, { access: "customers" }, { access: "destination" }, { opening_date: "2019" }, { parking: "underground" }]) {
      expect([tags, possibleVisitorParking(withTags(entrance, tags), TODAY)]).toEqual([tags, true]);
    }
    expect(possibleVisitorParking(withTags(entrance, { amenity: "parking_exit" }), TODAY)).toBe(false);
    expect(possibleVisitorParking(withTags(entrance, { amenity: undefined, entrance: "yes" }), TODAY)).toBe(false);
  });
});

describe("placeOf", () => {
  const mall = feature("way/1489454435");
  const park = feature("way/877498629");

  it("knows venues and open spaces, and treats a place that is both as an open space", () => {
    expect(placeOf(mall, TODAY)).toMatchObject({ name: "Pinery Mall", kind: "mall", tier: "venue" });
    expect(placeOf(park, TODAY)).toMatchObject({ kind: "park", tier: "open-space" });
    expect(placeOf(withTags(mall, { shop: undefined, aeroway: "terminal" }), TODAY)).toMatchObject({ kind: "terminal", tier: "venue" });
    expect(placeOf(withTags(mall, { shop: undefined, tourism: "museum" }), TODAY)).toMatchObject({ kind: "attraction", tier: "venue" });
    expect(placeOf(withTags(mall, { leisure: "stadium" }), TODAY)).toMatchObject({ kind: "sports", tier: "open-space" });
    expect(placeOf(withTags(park, { tourism: "attraction" }), TODAY)).toMatchObject({ tier: "open-space" });
  });

  it("leaves out unnamed places, points, hospitals, schools, private places, connectors and closed places", () => {
    const rejected: Record<string, string | undefined>[] = [
      { name: undefined },
      { amenity: "hospital" },
      { healthcare: "clinic" },
      { amenity: "university" },
      { amenity: "school" },
      { building: "college" },
      { name: "Tan Tock Seng Hospital Mall" },
      { name: "Bedok Polyclinic" },
      { access: "private" },
      { access: "no" },
      { name: "Bukit Timah Park Connector" },
      { name: "Kim Seng Linear Park" },
      { construction: "yes" },
      { disused: "yes" },
      { landuse: "construction" },
      { opening_date: "2027-01-01" },
      { name: "Pinery Mall (closed)" }
    ];
    for (const tags of rejected) expect([tags, placeOf(withTags(park, tags), TODAY)]).toEqual([tags, null]);
    expect(placeOf({ ...park, geometry: { type: "Point", coordinates: [103.87, 1.41] } }, TODAY)).toBeNull();
    expect(placeOf(withTags(park, { opening_date: "2020-06-01" }), TODAY)).not.toBeNull();
  });

  it("leaves out generic names, which say what a place is but not which one", () => {
    expect(GENERIC_PLACE_NAMES).toEqual(
      expect.arrayContaining(["tennis court", "sport hall", "sports hall", "sports complex", "common green", "playground", "fitness corner", "multi-purpose court", "futsal"])
    );
    for (const name of ["Tennis Court", "Sports Hall", "Sport Hall", "Sports Complex", "Common Green", "Playground", "Playground 2", "Fitness Corner", "Multi-Purpose Court", "multi-purpose court A", "Futsal"]) {
      expect([name, placeOf(withTags(park, { name }), TODAY)]).toEqual([name, null]);
    }
    for (const name of ["Jurong East Sports Complex", "Yio Chu Kang Sport Hall", "Kallang Tennis Centre"]) {
      expect(placeOf(withTags(park, { name }), TODAY)?.name).toBe(name);
    }
  });
});

describe("carparks mapped at public places at run time", () => {
  const file: OsmFile = { source: { name: "OpenStreetMap", licence: "ODbL-1.0", extract: "test", dataAt: null }, carparks: [], places: selected.places };
  const registry = osmRegistry(file);
  const byPlace = (name: string) => registry.find((carpark) => carpark.osm?.place?.name === name)!;

  it("names the place and what was mapped, links the mapped feature and never claims access", () => {
    expect(byPlace("Funan")).toMatchObject({
      source: "osm",
      id: "osm:place:way/432515092",
      address: "Carpark mapped next to Funan",
      carparkType: "Carpark entrance",
      osm: { url: "https://www.openstreetmap.org/node/612392167", access: "unknown", atEntrance: true, place: { name: "Funan", kind: "mall", relation: "next-to" } }
    });
    expect(byPlace("Jewel Changi Basement")).toMatchObject({ address: "Carpark mapped at Jewel Changi Basement", carparkType: "Underground carpark entrance", gantryHeightM: 2.1 });
    expect(byPlace("Hampstead Wetlands Park")).toMatchObject({ carparkType: "Carpark", osm: { atEntrance: false } });
    expect(OSM_AVAILABILITY.available).toBeNull();
    expect(estimateCost(byPlace("Funan"), new Date("2026-10-19T02:00:00Z"), 120).kind).toBe("unavailable");
  });

  it("drops one only when an HDB carpark is within 80 m or an LTA or URA carpark has the place's name", () => {
    const funan = byPlace("Funan");
    const lta = (name: string, dLat: number) => ({ ...funan, source: "lta", id: `lta:${name}`, address: name, lat: funan.lat + dLat, osm: undefined }) as RegistryCarpark;
    const hdbAt = (dLat: number) => ({ ...funan, source: undefined, id: "X1", address: "BLK 1", lat: funan.lat + dLat, osm: undefined }) as RegistryCarpark;
    expect(withoutDuplicates([funan], [lta("Funan Mall", 0.002)])).toEqual([]);
    // Another carpark nearby, even 30 m away, is a different carpark.
    expect(withoutDuplicates([funan], [lta("Capitol Singapore", 0.0003)])).toHaveLength(1);
    expect(withoutDuplicates([funan], [lta("Funan Mall", 0.004)])).toHaveLength(1);
    expect(withoutDuplicates([funan], [hdbAt(0.0005)])).toEqual([]);
    expect(withoutDuplicates([funan], [hdbAt(0.0012)])).toHaveLength(1);
  });
});
