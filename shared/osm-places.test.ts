import { describe, expect, it } from "vitest";
import sample from "../fixtures/osm-places.sample.json";
import type { OsmCarpark, OsmFile, RegistryCarpark } from "./domain";
import { distanceM } from "./nearby";
import { OSM_AVAILABILITY, expandAbbreviations, osmId, osmRegistry, placeCarparkTitle, withoutDuplicates, type OsmFeature } from "./osm";
import { GENERIC_PLACE_NAMES, namedAfter, placeOf, possibleVisitorParking, selectPlaceCarparks } from "./osm-places";
import { estimateCost } from "./tariff";

const TODAY = "2026-10-17";
const places = sample.places as unknown as OsmFeature[];
const parking = sample.parking as unknown as OsmFeature[];
const hdb = sample.hdb;
const shown = sample.shown as unknown as OsmCarpark[];
const buildings = sample.buildings as unknown as OsmFeature[];
const feature = (id: string) => [...places, ...parking].find((item) => osmId(item) === id)!;
type Overrides = { places?: OsmFeature[]; parking?: OsmFeature[]; hdb?: { lat: number; lng: number }[]; shown?: OsmCarpark[]; buildings?: OsmFeature[] };
const run = (overrides: Overrides = {}) =>
  selectPlaceCarparks(overrides.places ?? places, overrides.parking ?? parking, overrides.hdb ?? hdb, overrides.shown ?? shown, TODAY, overrides.buildings ?? buildings);
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
      "Bedok Mall: at",
      "i12 Katong: at",
      "Tampines Mall: at",
      "Velocity @ Novena Square: next-to",
      "Square 2: at",
      "Singapore Expo: at",
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

  it("says next to when the carpark is just outside the outline, and at when it's inside", () => {
    expect(entry("way/172529118")).toMatchObject({ relation: "next-to", atEntrance: true, parking: "underground", evidence: ["node/11823943799"] });
    expect(placeCarparkTitle(entry("way/172529118")!)).toBe("Carpark mapped next to Velocity @ Novena Square");
    expect(placeCarparkTitle(entry("way/172529121")!)).toBe("Carpark mapped at Square 2");
  });

  it("never takes an entrance just outside a place that is closer to another building", () => {
    // Icon Village's only nearby entrance is inside the Mapletree Anson tower, 18 m from the mall.
    expect(entry("way/152598430")).toBeUndefined();
    expect(run({ buildings: [] }).places.find((place) => place.id === "way/152598430")?.evidence).toEqual(["node/7037935683"]);
    // Funan's two untagged entrances are 5 and 9 m from Funan but under 5 m from the office at 100 High Street.
    expect(entry("way/432515092")).toBeUndefined();
    expect(run({ buildings: [] }).places.find((place) => place.id === "way/432515092")).toMatchObject({ relation: "next-to", evidence: ["node/612392167", "node/6045374651"] });
    // And Funan's exit is never used.
    expect(possibleVisitorParking(feature("node/12525830322"), TODAY)).toBe(false);
  });

  it("points a mall at its car entrance, never the bus interchange's", () => {
    // Bedok Mall: node/5272230471 (bus=yes) and node/7474946002 (multi-storey, maxheight 4) are both inside.
    expect(possibleVisitorParking(feature("node/5272230471"), TODAY)).toBe(false);
    expect(entry("relation/9382787")).toMatchObject({ relation: "at", evidence: ["node/7474946002"], parking: "multi-storey", maxHeightM: 4 });
  });

  it("leaves out neighbourhoods and blocks of flats with shops below", () => {
    expect(placeOf(feature("way/41662089"), TODAY)).toBeNull(); // Emerald Hill, place=neighbourhood
    expect(placeOf(feature("way/328531477"), TODAY)).toBeNull(); // Balestier Plaza, building=apartments
    expect(entry("way/41662089")).toBeUndefined();
    expect(entry("way/328531477")).toBeUndefined();
  });

  it("never takes a park's carpark from an entrance, only from a carpark area inside it", () => {
    // Henry Park's only evidence is a condo's carpark entrance 7 m outside the park.
    expect(entry("way/190023271")).toBeUndefined();
    expect(entry("way/877498629")).toMatchObject({ placeKind: "park", relation: "at", atEntrance: false, evidence: ["way/895588282"] });
  });

  it("gives a shared entrance to one place: a venue, then the one it's inside, then the smaller", () => {
    // Without building outlines, so the entrances just outside Royal Square and Katong Square still count.
    const loose = run({ buildings: [] });
    const looseEntry = (id: string) => loose.places.find((place) => place.id === id);
    // Royal Square at Novena and Square 2 share Novena Square 2's entrance; it's inside Square 2.
    expect(looseEntry("way/172529121")?.evidence).toEqual(["node/1834245738"]);
    expect(looseEntry("way/260571322")).toBeUndefined();
    expect(loose.removed.shared).toContain("way/260571322");
    // Katong Square and i12 Katong share one entrance, inside i12 Katong.
    expect(looseEntry("way/44121574")?.evidence).toEqual(["node/4623296185"]);
    expect(looseEntry("way/561552023")).toBeUndefined();
    for (const result of [loose, selected]) {
      const evidence = result.places.flatMap((place) => place.evidence);
      expect(new Set(evidence).size).toBe(evidence.length);
    }
  });

  it("ranks a place again once it has lost the carparks inside it", () => {
    // A large mall holds a small mall with entrance A inside both; entrance B is 17 m outside the large mall
    // and 17 m outside a second small mall. The first small mall takes A; the large mall is then only "next
    // to" B, like the second small mall, which is smaller and so takes B.
    const square = (id: number, name: string, west: number, south: number, size: number): OsmFeature =>
      ({
        type: "Feature",
        geometry: { type: "MultiPolygon", coordinates: [[[[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]]]] },
        properties: { "@type": "way", "@id": id, shop: "mall", name }
      }) as OsmFeature;
    const gate = (id: number, lng: number, lat: number): OsmFeature =>
      ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { "@type": "node", "@id": id, amenity: "parking_entrance" } }) as OsmFeature;
    const result = selectPlaceCarparks(
      [square(1, "Large Mall", 103.85, 1.3, 0.001), square(2, "Inner Mall", 103.8502, 1.3002, 0.0002), square(3, "East Mall", 103.8513, 1.3004, 0.0002)],
      [gate(10, 103.8503, 1.3003), gate(11, 103.85115, 1.3005)],
      [],
      [],
      TODAY
    );
    expect(result.places.map((place) => [place.placeName, place.relation, place.evidence])).toEqual([
      ["Inner Mall", "at", ["node/10"]],
      ["East Mall", "next-to", ["node/11"]]
    ]);
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
    // An HDB-run entrance is left out. The other entrance near the mall, 27 m outside it, is 11 m from the flats
    // at 973B Tampines Street 94, so it isn't the mall's either, and the mall has no entry. Without building
    // outlines it would fall back to that entrance.
    const hdbRun = (features: OsmFeature[], overrides: Overrides = {}) =>
      run({ ...overrides, parking: features.map((item) => (osmId(item) === "node/13652313510" ? withTags(item, { operator: "Housing & Development Board" }) : item)) });
    expect(hdbRun(parking).places.some((place) => place.id === "way/1489454435")).toBe(false);
    expect(hdbRun(parking, { buildings: [] }).places.find((place) => place.id === "way/1489454435")).toMatchObject({ relation: "next-to", evidence: ["node/12376189571"] });
    expect(hdbRun(pineryOnly, { buildings: [] }).places.some((place) => place.id === "way/1489454435")).toBe(false);
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
      { motorcar: "delivery" },
      { motor_vehicle: "agricultural" },
      { vehicle: "forestry" },
      { bus: "yes" },
      { psv: "designated" },
      { goods: "yes" },
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
      { building: "construction" },
      { opening_date: "2027-03" },
      { end_date: "2024-10" }
    ];
    for (const tags of rejected) expect([tags, possibleVisitorParking(withTags(entrance, tags), TODAY)]).toEqual([tags, false]);
    const kept: Record<string, string>[] = [
      { access: "yes" },
      { access: "customers" },
      { access: "destination" },
      { motorcar: "yes" },
      { bus: "yes", motorcar: "yes" },
      { opening_date: "2019" },
      { end_date: "2030" },
      { parking: "underground" }
    ];
    for (const tags of kept) {
      expect([tags, possibleVisitorParking(withTags(entrance, tags), TODAY)]).toEqual([tags, true]);
    }
    expect(possibleVisitorParking(withTags(entrance, { amenity: "parking_exit" }), TODAY)).toBe(false);
    expect(possibleVisitorParking(withTags(entrance, { amenity: undefined, entrance: "yes" }), TODAY)).toBe(false);
    // An entrance mapped as an area isn't used (way/1264215746 is one).
    const mall = feature("way/1489454435");
    expect(possibleVisitorParking({ ...entrance, geometry: mall.geometry }, TODAY)).toBe(false);
  });
});

describe("placeOf", () => {
  const mall = feature("way/1489454435");
  const park = feature("way/877498629");

  it("knows venues and open spaces, and treats a place that is both as an open space", () => {
    expect(placeOf(mall, TODAY)).toMatchObject({ name: "Pinery Mall", kind: "mall", tier: "venue" });
    expect(placeOf(park, TODAY)).toMatchObject({ kind: "park", tier: "open-space" });
    expect(placeOf(withTags(mall, { shop: undefined, aeroway: "terminal" }), TODAY)).toMatchObject({ kind: "terminal", tier: "venue" });
    // Changi Airport's terminals are also tagged shop=mall; they're terminals.
    expect(placeOf(withTags(mall, { aeroway: "terminal" }), TODAY)).toMatchObject({ kind: "terminal" });
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
      { building: "construction" },
      { opening_date: "2027-01-01" },
      { end_date: "2024-10-05" },
      { name: "Pinery Mall (closed)" },
      { building: "apartments" },
      { building: "residential" },
      { place: "neighbourhood" }
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
    expect(byPlace("Velocity @ Novena Square")).toMatchObject({
      source: "osm",
      id: "osm:place:way/172529118",
      address: "Carpark mapped next to Velocity @ Novena Square",
      carparkType: "Underground carpark entrance",
      osm: { url: "https://www.openstreetmap.org/node/11823943799", access: "unknown", atEntrance: true, place: { name: "Velocity @ Novena Square", kind: "mall", relation: "next-to" } }
    });
    expect(byPlace("Jewel Changi Basement")).toMatchObject({ address: "Carpark mapped at Jewel Changi Basement", carparkType: "Underground carpark entrance", gantryHeightM: 2.1 });
    expect(byPlace("Hampstead Wetlands Park")).toMatchObject({ carparkType: "Carpark", osm: { atEntrance: false } });
    expect(OSM_AVAILABILITY.available).toBeNull();
    expect(estimateCost(byPlace("Velocity @ Novena Square"), new Date("2026-10-19T02:00:00Z"), 120).kind).toBe("unavailable");
  });

  it("drops one only as a true duplicate: HDB within 80 m, an LTA or URA carpark within 30 m or with the place's name", () => {
    const velocity = byPlace("Velocity @ Novena Square");
    const lta = (name: string, dLat: number, source = "lta") =>
      ({ ...velocity, source, id: `${source}:${name}`, address: name, lat: velocity.lat + dLat, osm: undefined }) as RegistryCarpark;
    const hdbAt = (dLat: number) => ({ ...velocity, source: undefined, id: "X1", address: "BLK 1", lat: velocity.lat + dLat, osm: undefined }) as RegistryCarpark;
    expect(withoutDuplicates([velocity], [lta("Velocity", 0.002)])).toEqual([]);
    // A differently named carpark 50 m away is another carpark; one 20 m away is this one.
    expect(withoutDuplicates([velocity], [lta("United Square", 0.00045)])).toHaveLength(1);
    expect(withoutDuplicates([velocity], [lta("Queensway (off-street) (Ride Out Tea Garden)", 0.00018, "ura")])).toEqual([]);
    expect(withoutDuplicates([velocity], [lta("Velocity", 0.004)])).toHaveLength(1);
    expect(withoutDuplicates([velocity], [hdbAt(0.0005)])).toEqual([]);
    expect(withoutDuplicates([velocity], [hdbAt(0.0012)])).toHaveLength(1);
    // LTA's short forms: "Bt Panjang Plaza" is Bukit Panjang Plaza.
    const plaza = { ...velocity, osm: { ...velocity.osm!, place: { name: "Bukit Panjang Plaza", kind: "mall" as const, relation: "at" as const } } };
    expect(withoutDuplicates([plaza], [lta("Bt Panjang Plaza", 0.0005)])).toEqual([]);
    expect(expandAbbreviations("Bt Panjang Plaza")).toBe("bukit Panjang Plaza");
  });

  it("leaves public OpenStreetMap carparks' dedupe as it was", () => {
    const publicOne = { ...byPlace("Velocity @ Novena Square"), id: "osm:node/1", address: "Novena Square Carpark", osm: { url: "x", access: "yes" as const, atEntrance: true, named: true } };
    const lta = { ...publicOne, source: "lta" as const, id: "lta:9", address: "United Square", lat: publicOne.lat + 0.0005, osm: undefined };
    // Within DUPLICATE_RADIUS_M (80 m) of any LTA carpark, a public OpenStreetMap carpark is still left out.
    expect(withoutDuplicates([publicOne, byPlace("Velocity @ Novena Square")], [lta]).map((carpark) => carpark.id)).toEqual(["osm:place:way/172529118"]);
  });
});
