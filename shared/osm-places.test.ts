import { describe, expect, it } from "vitest";
import sample from "../fixtures/osm-places.sample.json";
import type { OsmCarpark, OsmFile, RegistryCarpark } from "./domain";
import { distanceM } from "./nearby";
import { OSM_AVAILABILITY, centroid, distanceToGeometry, expandAbbreviations, interiorPoint, osmId, osmRegistry, placeCarparkTitle, polygons, withoutDuplicates, type OsmFeature } from "./osm";
import { BIG_BOX_MIN_M2, EXCLUDED, GENERIC_PLACE_NAMES, TITLE_APART_M, areaM2, namedAfter, placeOf, possibleVisitorParking, selectPlaceCarparks, type MapFeature } from "./osm-places";
import { estimateCost } from "./tariff";

const TODAY = "2026-10-17";
const places = sample.places as unknown as OsmFeature[];
const parking = sample.parking as unknown as OsmFeature[];
const hdb = sample.hdb;
const shown = sample.shown as unknown as OsmCarpark[];
const buildings = sample.buildings as unknown as OsmFeature[];
const roads = sample.roads as unknown as MapFeature[];
const construction = sample.construction as unknown as OsmFeature[];
const feature = (id: string) => [...places, ...parking, ...buildings].find((item) => osmId(item) === id)!;
type Overrides = {
  places?: OsmFeature[];
  parking?: OsmFeature[];
  hdb?: { lat: number; lng: number }[];
  shown?: OsmCarpark[];
  buildings?: OsmFeature[];
  roads?: MapFeature[];
  construction?: OsmFeature[];
};
const run = (overrides: Overrides = {}) =>
  selectPlaceCarparks(overrides.places ?? places, overrides.parking ?? parking, overrides.hdb ?? hdb, overrides.shown ?? shown, TODAY, {
    buildings: overrides.buildings ?? buildings,
    roads: overrides.roads ?? roads,
    construction: overrides.construction ?? construction
  });
const selected = run();
const entry = (id: string) => selected.places.find((place) => place.id === id);
const pointOf = (id: string) => {
  const [lng, lat] = (feature(id).geometry as { coordinates: [number, number] }).coordinates;
  return { lat, lng };
};
/**
 * Pinery Mall is inside the Pinery Residences construction site and its driveway is still mapped as being built
 * (highway=construction), so it has no entry. The tests that use it for other rules leave those out.
 */
const PINERY_OPEN: Overrides = { roads: [], construction: [] };
/** The fixture without the multi-storey carpark 27 m outside Pinery Mall, so only the mall's own entrances are left. */
const pineryOnly = parking.filter((item) => !["node/12376189571", "way/1337982551"].includes(osmId(item)));
const withTags = (base: OsmFeature, tags: Record<string, string | undefined>): OsmFeature => {
  const properties = { ...base.properties, ...tags };
  for (const [key, value] of Object.entries(tags)) if (value === undefined) delete properties[key];
  return { ...base, properties } as OsmFeature;
};

describe("selectPlaceCarparks (real OpenStreetMap features)", () => {
  it("lists one carpark per place, and only places with one mapped there", () => {
    expect(selected.places.map((place) => `${placeCarparkTitle(place)}: ${place.relation}`)).toEqual([
      "Carpark mapped at Bedok Mall: at",
      "Carpark mapped at Gardens by the Bay East: at",
      "Carpark mapped at Windsor Nature Park: at",
      "Carpark mapped next to Giant Hypermarket: next-to",
      "Carpark mapped at i12 Katong: at",
      "Carpark mapped at Peninsula Plaza: at",
      "Carpark mapped at Tampines Mall: at",
      "Carpark mapped at IKEA: at",
      "Carpark mapped next to Paragon: next-to",
      "Carpark mapped at Square 2: at",
      "Carpark mapped at Singapore Expo: at",
      "Carpark mapped at Changi Beach Park (Carpark 6): at",
      "Carpark mapped at Changi Beach Park (Carpark 1): at",
      "Carpark mapped at Choa Chu Kang Park (SAFRA Choa Chu Kang): at",
      "Carpark mapped at Jewel Changi Airport: at",
      "Carpark mapped at IKEA: at",
      "Carpark mapped at Hampstead Wetlands Park: at",
      "Carpark mapped at Sengkang Grand Mall: at",
      "Carpark mapped at Causeway Point: at",
      "Carpark mapped at Yio Chu Kang Sports Complex: at"
    ]);
    for (const place of selected.places) expect(place).toMatchObject({ kind: "place", access: "unknown" });
  });

  it("finds Jewel's carpark from its basement entrances, names it after Jewel and points directions at one", () => {
    // The entrances are inside "Jewel Changi Basement", a part of Jewel that shares them with Jewel Changi Airport.
    expect(entry("way/547383951")).toEqual({
      id: "way/547383951",
      kind: "place",
      placeName: "Jewel Changi Airport",
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
    expect(entry("way/172518496")).toMatchObject({ relation: "next-to", atEntrance: true, parking: "underground", evidence: ["node/6926232973"] });
    expect(placeCarparkTitle(entry("way/172518496")!)).toBe("Carpark mapped next to Paragon");
    expect(placeCarparkTitle(entry("way/172529121")!)).toBe("Carpark mapped at Square 2");
  });

  it("never takes an entrance just outside a place that is closer to another building", () => {
    // Icon Village's only nearby entrance is inside the Mapletree Anson tower, 18 m from the mall.
    expect(entry("way/152598430")).toBeUndefined();
    expect(run({ buildings: [] }).places.find((place) => place.id === "way/152598430")?.evidence).toEqual(["node/7037935683"]);
    // Funan's two untagged entrances are 5 and 9 m from Funan but under 5 m from the office at 100 High Street.
    expect(entry("way/432515092")).toBeUndefined();
    // (node/612392167 is on a parking aisle tagged access=no; an aisle's tag doesn't decide who may drive in.)
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
    expect(run(PINERY_OPEN).places.some((place) => place.id === "way/1489454435")).toBe(true);
    const result = run({ ...PINERY_OPEN, hdb: [...hdb, { lat: pinery.lat + 0.00027, lng: pinery.lng }] });
    expect(result.places.some((place) => place.id === "way/1489454435")).toBe(false);
    expect(result.removed.hdb).toContain("way/1489454435");
    // An HDB-run entrance is left out. The other entrance near the mall, 27 m outside it, is 11 m from the flats
    // at 973B Tampines Street 94, so it isn't the mall's either, and the mall has no entry. Without building
    // outlines it would fall back to that entrance.
    const hdbRun = (features: OsmFeature[], overrides: Overrides = {}) =>
      run({ ...PINERY_OPEN, ...overrides, parking: features.map((item) => (osmId(item) === "node/13652313510" ? withTags(item, { operator: "Housing & Development Board" }) : item)) });
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
      expect(run({ ...PINERY_OPEN, parking: [...parking, area(tags)] }).places.some((place) => place.id === "way/1489454435")).toBe(false);
    }
    // An untagged carpark there is fine: the entrance is its entrance.
    expect(run({ ...PINERY_OPEN, parking: [...parking, area({})] }).places.find((place) => place.id === "way/1489454435")?.atEntrance).toBe(true);
  });
});

describe("hand-check fixes (real features, checked 19 Oct 2026)", () => {
  const has = (result: { places: { id: string }[] }, id: string) => result.places.some((place) => place.id === id);
  const road = (id: string) => roads.find((item) => osmId(item as OsmFeature) === id)!;
  const retag = (item: MapFeature, tags: Record<string, string | undefined>) => withTags(item as OsmFeature, tags) as MapFeature;

  it("leaves out an entrance on a residents' driveway, and anything inside a construction site", () => {
    // PARKTOWN's only entrance is on way/1367936292: access=private, "service road for residence carpark",
    // still being built. The mall is inside the Parktown Tampines construction site. Either rule removes it.
    expect(road("way/1367936292").properties).toMatchObject({ access: "private", description: "service road for residence carpark" });
    expect(has(selected, "relation/18841366")).toBe(false);
    expect(has(run({ construction: [] }), "relation/18841366")).toBe(false);
    expect(has(run({ roads: [] }), "relation/18841366")).toBe(false);
    expect(run({ roads: [], construction: [] }).places.find((place) => place.id === "relation/18841366")?.evidence).toEqual(["node/12668615520"]);
  });

  it("treats a road that is private, closed to cars, for residents or staff, or being built as closed; paths don't count", () => {
    const parkTown = (tags: Record<string, string | undefined>) =>
      has(run({ construction: [], roads: roads.map((item) => (osmId(item as OsmFeature) === "way/1367936292" ? retag(item, tags) : item)) }), "relation/18841366");
    const open = { access: undefined, description: undefined, highway: "service", construction: undefined };
    expect(parkTown(open)).toBe(true);
    expect(parkTown({ ...open, access: "destination" })).toBe(true);
    expect(parkTown({ ...open, highway: "footway", access: "private" })).toBe(true);
    for (const tags of [{ access: "private" }, { access: "no" }, { motor_vehicle: "private" }, { description: "Residents only" }, { name: "Staff Carpark Road" }, { highway: "construction", construction: "service" }]) {
      expect([tags, parkTown({ ...open, ...tags })]).toEqual([tags, false]);
    }
  });

  it("leaves out a carpark that only private roads lead into", () => {
    // Haw Par Villa's upper lot: the one road into it is a driveway tagged access=private. Its steps don't count.
    expect(road("way/792403493").properties).toMatchObject({ access: "private", highway: "service" });
    expect(has(selected, "way/54519182")).toBe(false);
    expect(run({ roads: [] }).places.find((place) => place.id === "way/54519182")?.evidence).toEqual(["way/1064840497"]);
    const opened = roads.map((item) => (osmId(item as OsmFeature) === "way/792403493" ? retag(item, { access: undefined }) : item));
    expect(has(run({ roads: opened }), "way/54519182")).toBe(true);
  });

  it("leaves out a carpark mapped as a point on a private driveway", () => {
    // Sengkang Grand Mall's point is on way/1152354273, an untagged driveway. Tagged private, it's left out.
    expect(road("way/1152354273").properties).toMatchObject({ highway: "service", service: "driveway" });
    const closed = roads.map((item) => (osmId(item as OsmFeature) === "way/1152354273" ? retag(item, { access: "private" }) : item));
    expect(has(run({ roads: closed }), "way/1122039326")).toBe(false);
  });

  it("finds a road crossing a carpark between two nodes outside it, wherever its nodes are", () => {
    // A road straight through Hampstead Wetlands Park's lot, with both ends outside it, and the same road with
    // an extra node in the middle of the lot: the verdict and the way in are the same.
    const through = (tags: Record<string, string>, nodes: [number, number][]): MapFeature => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: nodes },
      properties: { "@type": "way", "@id": 3, highway: "service", ...tags }
    });
    const ends: [number, number][] = [[103.869, 1.41033], [103.8695, 1.41033]];
    const withMiddle: [number, number][] = [ends[0], [103.86923, 1.41033], ends[1]];
    const hampstead = (road: MapFeature) => run({ roads: [road] }).places.find((place) => place.id === "way/877498629");
    for (const nodes of [ends, withMiddle]) {
      expect(hampstead(through({ access: "private" }, nodes))).toBeUndefined();
      const open = hampstead(through({}, nodes))!;
      expect(distanceToGeometry(open, feature("way/895588282").geometry)).toBeLessThan(1);
    }
    expect(hampstead(through({}, ends))).toEqual(hampstead(through({}, withMiddle)));
  });

  it("closes a place only when a construction site larger than it holds it", () => {
    // Gardens by the Bay East's middle is inside the Bay East Garden site (Founders' Memorial), about half its
    // size. The park is open; PARKTOWN is a mall inside a much larger site.
    const site = construction.find((item) => osmId(item) === "way/884118657")!;
    const park = feature("relation/10247957");
    expect(distanceToGeometry(interiorPoint(park.geometry), site.geometry)).toBe(0);
    expect(has(selected, "relation/10247957")).toBe(true);
    const grown = { ...site, geometry: { type: "Polygon", coordinates: [[[103.85, 1.27], [103.89, 1.27], [103.89, 1.31], [103.85, 1.31], [103.85, 1.27]]] } } as OsmFeature;
    expect(has(run({ construction: [grown] }), "relation/10247957")).toBe(false);
  });

  it("doesn't let a parking aisle's access tag decide an entrance", () => {
    // Peninsula Plaza's only entrance is on a 9 m parking aisle tagged access=private, as many aisles are to keep
    // routers out. The carpark is the mall's public one.
    expect(road("way/1388549604").properties).toMatchObject({ access: "private", service: "parking_aisle" });
    expect(entry("way/46594832")).toMatchObject({ evidence: ["node/12853402280"], atEntrance: true });
    // A driveway tagged private still rules an entrance out (Sim Lim Square).
    expect(has(selected, "way/30527021")).toBe(false);
  });

  it("ignores roads that aren't built: proposed, planned or gone", () => {
    const parkTown = (highway: string) =>
      has(run({ construction: [], roads: roads.map((item) => (osmId(item as OsmFeature) === "way/1367936292" ? retag(item, { highway, construction: undefined }) : item)) }), "relation/18841366");
    for (const highway of ["proposed", "planned", "abandoned"]) expect([highway, parkTown(highway)]).toEqual([highway, true]);
  });

  it("excludes only what the map can't show, by id and with a reason", () => {
    expect(Object.keys(EXCLUDED).sort()).toEqual(["node/11823943799", "relation/2746776", "way/1149136196"]);
    // Kranji Racecourse closed in October 2024, but its tags still say it's open.
    expect(EXCLUDED["relation/2746776"]).toMatch(/Kranji Racecourse: closed/);
    expect(placeOf(feature("relation/2746776"), TODAY)).toBeNull();
    expect(has(selected, "relation/2746776")).toBe(false);
    // Velocity's only evidence looks like a loading entrance on Street View; its tags look fine.
    expect(EXCLUDED["node/11823943799"]).toMatch(/loading/);
    expect(possibleVisitorParking(feature("node/11823943799"), TODAY)).toBe(true);
    expect(has(selected, "way/172529118")).toBe(false);
  });

  it("doesn't treat shops in an MRT station or underground link as a place", () => {
    // "Bencoolen" is the station's shops (shop=mall, landuse=retail, level -1, underground). Its "carpark" was
    // the Strand Hotel's ramp above.
    const bencoolen = feature("way/743764000");
    expect(placeOf(bencoolen, TODAY)).toBeNull();
    expect(has(selected, "way/743764000")).toBe(false);
    const aboveGround = withTags(bencoolen, { location: undefined, level: undefined });
    expect(placeOf(aboveGround, TODAY)).not.toBeNull();
    for (const tags of [{ location: "underground" }, { underground: "yes" }, { level: "-1" }, { layer: "-2" }]) {
      expect([tags, placeOf(withTags(aboveGround, tags), TODAY)]).toEqual([tags, null]);
    }
    // A mall on several levels, some above ground, isn't underground.
    expect(placeOf(withTags(aboveGround, { level: "-1;0;1" }), TODAY)).not.toBeNull();
    expect(placeOf(withTags(aboveGround, { level: "-2;-1" }), TODAY)).toBeNull();
    // A mall building with floors below ground is still a place: Jewel Changi Basement is building=commercial, layer -1.
    expect(placeOf(withTags(bencoolen, { building: "retail" }), TODAY)).not.toBeNull();
    expect(placeOf(feature("way/547383951"), TODAY)).not.toBeNull();
  });

  it("names a part of a venue after the venue, only when they share the carpark", () => {
    expect(placeCarparkTitle(entry("way/547383951")!)).toBe("Carpark mapped at Jewel Changi Airport");
    // Without Jewel Changi Airport there's nothing to name it after.
    const alone = run({ places: [feature("way/547383951")] }).places;
    expect(alone.map(placeCarparkTitle)).toEqual(["Carpark mapped at Jewel Changi Basement"]);
  });

  it("never gives two cards that can be listed together the same title", () => {
    // Changi Beach Park is mapped as two areas, each with its own named carparks.
    expect(placeCarparkTitle(entry("way/174717943")!)).toBe("Carpark mapped at Changi Beach Park (Carpark 6)");
    expect(placeCarparkTitle(entry("way/174717944")!)).toBe("Carpark mapped at Changi Beach Park (Carpark 1)");
    for (const a of selected.places) {
      for (const b of selected.places) {
        if (a !== b && distanceM(a, b) <= TITLE_APART_M) expect(placeCarparkTitle(a)).not.toBe(placeCarparkTitle(b));
      }
    }
    // Two stores of one brand far apart keep the plain name: they never meet in one list of results.
    expect([entry("way/166723949"), entry("way/736484880")].map((item) => placeCarparkTitle(item!))).toEqual(["Carpark mapped at IKEA", "Carpark mapped at IKEA"]);
    expect(distanceM(entry("way/166723949")!, entry("way/736484880")!)).toBeGreaterThan(TITLE_APART_M);
    // A name that isn't repeated keeps the plain title.
    expect(run({ places: [feature("way/174717944")] }).places.map(placeCarparkTitle)).toEqual(["Carpark mapped at Changi Beach Park"]);
    // When the carparks have no names, one card is kept and the other is left out.
    const unnamed = parking.map((item) => withTags(item, { name: undefined, "name:en": undefined, operator: undefined }));
    const result = run({ parking: unnamed, places: [feature("way/174717943"), feature("way/174717944")] });
    expect(result.places.map(placeCarparkTitle)).toEqual(["Carpark mapped at Changi Beach Park"]);
    expect(result.removed.shared).toHaveLength(1);
  });

  it("names a park's carpark after the building it's under", () => {
    // Choa Chu Kang Park's underground carpark is SAFRA Choa Chu Kang's (club=sport, operator SAFRA).
    expect(feature("way/1181991525").properties).toMatchObject({ name: "SAFRA Choa Chu Kang", operator: "SAFRA" });
    expect(entry("way/458846541")).toMatchObject({ carparkName: "SAFRA Choa Chu Kang", parking: "underground", evidence: ["way/1360470090"] });
    expect(run({ buildings: [] }).places.find((place) => place.id === "way/458846541")?.carparkName).toBeUndefined();
    // A sports ground's buildings are its own halls, so they don't rename its carpark.
    expect(entry("way/1468050244")?.carparkName).toBeUndefined();
  });

  it("puts an open space's point on its carpark, where a road comes in, not at the centroid", () => {
    // Windsor Nature Park's lot is V-shaped: its centroid is on the grass between the arms, and its widest part
    // is the arm away from the road. The point is where the parking aisle comes in at the north end.
    const windsor = entry("relation/13480855")!;
    const lot = feature("relation/5964829");
    expect(distanceToGeometry(windsor, lot.geometry)).toBeLessThan(1);
    expect({ lat: windsor.lat, lng: windsor.lng }).toEqual({ lat: 1.35991, lng: 103.827463 });
    expect(distanceM(windsor, centroid(lot.geometry))).toBeGreaterThan(60);
    // Without roads it's a point well inside the lot.
    const inside = run({ roads: [] }).places.find((place) => place.id === "relation/13480855")!;
    expect(distanceToGeometry(inside, lot.geometry)).toBe(0);
    // Hampstead Wetlands Park's centroid was 12 m off its lot; its point is now on it.
    const hampsteadLot = feature("way/895588282").geometry;
    expect(distanceToGeometry(centroid(hampsteadLot), hampsteadLot)).toBeGreaterThan(10);
    expect(distanceToGeometry(entry("way/877498629")!, hampsteadLot)).toBeLessThan(1);
  });

  it("lists Yio Chu Kang once, for the sports complex, with its point on a lot and not in the hall", () => {
    // The hall's ring-shaped lot has its centroid inside the hall, so the hall has a carpark "at" it. The hall is
    // inside Yio Chu Kang Sports Complex, so the complex's card covers it.
    const hall = feature("way/153583762");
    expect(distanceToGeometry(centroid(feature("way/1468445315").geometry), hall.geometry)).toBe(0);
    expect(has(selected, "way/153583762")).toBe(false);
    expect(selected.removed.shared).toContain("way/153583762");
    const complex = entry("way/1468050244")!;
    expect(complex.evidence).toContain("way/1468445315");
    expect(distanceToGeometry(complex, feature(complex.evidence[0]).geometry)).toBeLessThan(1);
    expect(distanceToGeometry(complex, hall.geometry)).toBeGreaterThan(10);
    // On its own, the hall would get a card, and its point would be on the lot, not in the hall.
    const alone = run({ places: [hall] }).places[0];
    expect(alone).toMatchObject({ placeName: "Yio Chu Kang Sport Hall", evidence: ["way/1468445315"] });
    expect(distanceToGeometry(alone, hall.geometry)).toBeGreaterThan(10);
    // A hall inside a complex with another name is a place of its own.
    const renamed = run({ places: [hall, withTags(feature("way/1468050244"), { name: "Ang Mo Kio Sports Complex" })] });
    expect(renamed.places.map((place) => place.placeName).sort()).toEqual(["Ang Mo Kio Sports Complex", "Yio Chu Kang Sport Hall"]);
  });

  it("takes a carpark mapped as a bare point inside a venue", () => {
    // Sengkang Grand Mall's only parking feature is node/10718509124, an underground carpark point inside it.
    expect(entry("way/1122039326")).toMatchObject({ relation: "at", atEntrance: false, parking: "underground", evidence: ["node/10718509124"] });
    // A point outside the venue doesn't count.
    const [lng, lat] = (feature("node/10718509124").geometry as { coordinates: [number, number] }).coordinates;
    const moved = parking.map((item) => (osmId(item) === "node/10718509124" ? ({ ...item, geometry: { type: "Point", coordinates: [lng, lat + 0.005] } } as OsmFeature) : item));
    expect(has(run({ parking: moved }), "way/1122039326")).toBe(false);
  });
});

describe("interiorPoint", () => {
  const square = (west: number, south: number, size: number): [number, number][] => [[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]];

  it("finds a point well inside a ring-shaped carpark, never in its hole", () => {
    const ring = { type: "Polygon" as const, coordinates: [square(103.8, 1.3, 0.001), square(103.8001, 1.3001, 0.0008)] };
    const point = interiorPoint(ring);
    expect(distanceToGeometry(centroid(ring), ring)).toBeGreaterThan(0); // the centroid is in the hole
    expect(distanceToGeometry(point, ring)).toBe(0);
  });

  it("finds a point inside an L-shaped carpark, and the middle of a square", () => {
    const l = { type: "Polygon" as const, coordinates: [[[103.8, 1.3], [103.801, 1.3], [103.801, 1.3001], [103.8001, 1.3001], [103.8001, 1.301], [103.8, 1.301], [103.8, 1.3]] as [number, number][]] };
    expect(distanceToGeometry(centroid(l), l)).toBeGreaterThan(0);
    expect(distanceToGeometry(interiorPoint(l), l)).toBe(0);
    const middle = interiorPoint({ type: "Polygon", coordinates: [square(103.8, 1.3, 0.001)] });
    expect(middle.lat).toBeCloseTo(1.3005, 5);
    expect(middle.lng).toBeCloseTo(103.8005, 5);
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

describe("big-box stores and retail areas (real features, checked 19 Oct 2026)", () => {
  const retailPark = feature("way/34408623");
  const ikea = feature("way/166723949");
  const courts = feature("way/34408616");
  const giant = feature("way/34408631");
  const has = (result: { places: { id: string }[] }, id: string) => result.places.some((place) => place.id === id);

  it("lists IKEA and Giant in Tampines Retail Park, each under its own name", () => {
    // IKEA's two multi-storey entrances are inside both IKEA and the retail park: the store names the card.
    expect(entry("way/166723949")).toMatchObject({
      placeName: "IKEA",
      placeKind: "store",
      relation: "at",
      atEntrance: true,
      parking: "multi-storey",
      access: "unknown",
      evidence: ["node/8655176324", "node/13294083098"]
    });
    // The surface lot inside the park, 8 m outside Giant's building, goes to Giant.
    expect(entry("way/34408631")).toMatchObject({ placeName: "Giant Hypermarket", placeKind: "store", relation: "next-to", evidence: ["way/1557879658"] });
    // The park keeps nothing for itself: every carpark inside it is a store's.
    expect(has(selected, "way/34408623")).toBe(false);
    expect(selected.removed.shared).toContain("way/34408623");
    // Courts has no carpark mapped within 30 m: its rooftop ramp isn't on the map, and IKEA's entrances are 73 m away.
    expect(placeOf(courts, TODAY)).toMatchObject({ kind: "store", tier: "venue" });
    expect(has(selected, "way/34408616")).toBe(false);
  });

  it("gives a retail area the carparks inside it when no store is there, but nothing outside it", () => {
    // Without the stores, the park itself has IKEA's entrances and the lot.
    const alone = run({ places: [retailPark, courts] });
    expect(alone.places).toEqual([expect.objectContaining({ id: "way/34408623", placeName: "Tampines Retail Park", placeKind: "retail", relation: "at" })]);
    // The entrance 49 m outside the park (node/11731444682) never counts for it.
    expect(alone.places[0]!.evidence).not.toContain("node/11731444682");
    const outside = parking.filter((item) => osmId(item) === "node/11731444682");
    expect(run({ places: [retailPark], parking: outside }).places).toEqual([]);
    // A store wins a carpark even when it's only next to the store and inside the park. The park keeps IKEA's
    // entrances when IKEA isn't there to take them.
    expect(run({ places: [retailPark, giant] }).places.map((item) => `${item.placeName}: ${item.evidence.join(", ")}`)).toEqual([
      "Tampines Retail Park: node/8655176324, node/13294083098",
      "Giant Hypermarket: way/1557879658"
    ]);
    expect(run({ places: [retailPark, ikea, giant] }).places.map((item) => item.placeName).sort()).toEqual(["Giant Hypermarket", "IKEA"]);
  });

  it("doesn't give a retail area an entrance on its edge that belongs to a carpark outside it", () => {
    // Real tags on simple shapes: a 110 m square area, an entrance 5 m inside its east edge, and a lot 11 m outside.
    const box = (west: number, south: number, east: number, north: number) =>
      ({ type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] }) as OsmFeature["geometry"];
    const area = { ...retailPark, geometry: box(103.93, 1.37, 103.931, 1.371) } as OsmFeature;
    const entrance = { ...feature("node/8655176324"), geometry: { type: "Point", coordinates: [103.93095, 1.3704] } } as OsmFeature;
    const lot = (west: number, east: number) => ({ ...feature("way/1557879658"), geometry: box(west, 1.3702, east, 1.3706) }) as OsmFeature;
    const bare = { roads: [], hdb: [], shown: [], buildings: [], construction: [] };
    expect(run({ ...bare, places: [area], parking: [lot(103.9311, 103.9316), entrance] }).places).toEqual([]);
    // The same entrance to a lot inside the area is the area's.
    expect(run({ ...bare, places: [area], parking: [lot(103.9303, 103.9308), entrance] }).places).toEqual([
      expect.objectContaining({ placeName: "Tampines Retail Park", relation: "at", atEntrance: true, lat: 1.3704, lng: 103.93095 })
    ]);
    // When the lot outside is a public carpark already shown, its entrance on the edge doesn't make the area's
    // own lot a duplicate.
    const inside = { ...lot(103.9302, 103.9304), properties: { ...lot(0, 0).properties, "@id": 1 } } as OsmFeature;
    const outside = lot(103.9311, 103.9316);
    const publicLot = { id: osmId(outside), kind: "carpark", name: null, operator: null, parking: "surface", access: "yes", maxHeightM: null, lat: 1.3704, lng: 103.93135, atEntrance: false } as OsmCarpark;
    const result = run({ ...bare, shown: [publicLot], places: [area], parking: [inside, outside, entrance] });
    expect(result.places).toEqual([expect.objectContaining({ placeName: "Tampines Retail Park", evidence: ["way/1"] })]);
    expect(result.removed.shown).toEqual([]);
  });

  it("measures a store without its courtyard, and keeps a standalone store tagged with a level", () => {
    const outer = polygons(ikea.geometry)[0]![0]!;
    // A hole almost as big as the building: what's left is under 3,000 m².
    const middle = centroid(ikea.geometry);
    const hole = outer.map(([x, y]) => [middle.lng + (x - middle.lng) * 0.97, middle.lat + (y - middle.lat) * 0.97]);
    const ring = { ...ikea, geometry: { type: "Polygon", coordinates: [outer, hole] } } as OsmFeature;
    expect(areaM2(ring.geometry)).toBeLessThan(BIG_BOX_MIN_M2);
    expect(placeOf(ring, TODAY)).toBeNull();
    expect(placeOf(withTags(ikea, { level: "0" }), TODAY)).toMatchObject({ kind: "store" });
  });

  it("takes only big stores of the listed kinds, mapped as a building or area of their own", () => {
    expect(areaM2(ikea.geometry)).toBeGreaterThan(20_000);
    for (const shop of ["furniture", "electronics", "department_store", "supermarket", "doityourself", "hardware", "garden_centre", "wholesale"]) {
      expect([shop, placeOf(withTags(ikea, { shop }), TODAY)?.kind]).toEqual([shop, "store"]);
    }
    // Car dealers' parking is the showroom's; other shops aren't big-box stores.
    expect(placeOf(withTags(ikea, { shop: "car" }), TODAY)).toBeNull();
    expect(placeOf(withTags(ikea, { shop: "clothes" }), TODAY)).toBeNull();
    // Far East Flora Centre (2,900 m²) is too small, though entrances are mapped beside it.
    const flora = feature("way/1188401266");
    expect(areaM2(flora.geometry)).toBeLessThan(BIG_BOX_MIN_M2);
    expect(placeOf(flora, TODAY)).toBeNull();
    expect(run({ places: [flora] }).places).toEqual([]);
    expect(run({ places: [withTags(ikea, { name: "Far East Flora Centre" })] }).places).toHaveLength(1);
    // FairPrice Xtra in Parkway Parade is a room inside the mall (indoor=room, level 2): the mall's card covers it.
    expect(areaM2(feature("way/746049621").geometry)).toBeGreaterThan(BIG_BOX_MIN_M2);
    expect(placeOf(feature("way/746049621"), TODAY)).toBeNull();
  });

  it("leaves a store inside a mall to the mall", () => {
    // IKEA's outline tagged as a mall too large to be inside, and a store inside it.
    const mall = withTags(retailPark, { landuse: undefined, shop: "mall", name: "Retail Park Mall" });
    const result = run({ places: [mall, ikea] });
    expect(result.places.map((item) => item.placeName)).toEqual(["Retail Park Mall"]);
    // A larger mall that only overlaps the store (a long strip across its middle) doesn't hold it.
    const { lat, lng } = interiorPoint(ikea.geometry);
    const strip = { type: "Polygon", coordinates: [[[lng - 0.0001, lat - 0.005], [lng + 0.0001, lat - 0.005], [lng + 0.0001, lat + 0.005], [lng - 0.0001, lat + 0.005], [lng - 0.0001, lat - 0.005]]] };
    const overlapping = { ...mall, geometry: strip } as OsmFeature;
    expect(areaM2(overlapping.geometry)).toBeGreaterThan(areaM2(ikea.geometry));
    expect(run({ places: [overlapping, ikea] }).places.map((item) => item.placeName)).toContain("IKEA");
  });

  it("leaves out food centres, markets and petrol stations mapped as retail areas or shops", () => {
    // East Coast Lagoon Food Village is tagged only landuse=retail; its name says what it is.
    expect(placeOf(feature("way/44122372"), TODAY)).toBeNull();
    expect(placeOf(withTags(feature("way/44122372"), { name: "East Coast Lagoon Village" }), TODAY)).toMatchObject({ kind: "retail", tier: "retail-area" });
    for (const tags of [{ amenity: "food_court" }, { amenity: "marketplace" }, { amenity: "fuel" }, { name: "Adam Food Centre" }, { name: "Pasar 216 Bedok Central" }, { name: "Tekka Market" }]) {
      expect([tags, placeOf(withTags(retailPark, tags), TODAY)]).toEqual([tags, null]);
      expect([tags, placeOf(withTags(ikea, tags), TODAY)]).toEqual([tags, null]);
    }
    // A retail area that holds homes too may have the residents' carparks.
    expect(placeOf(withTags(retailPark, { name: "Bedok Mall/Bedok Residences" }), TODAY)).toBeNull();
    // Bedok Corner is a food centre tagged only landuse=retail, with a coupon carpark: left out by id.
    expect(EXCLUDED["way/1149136196"]).toMatch(/food centre/);
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
      { access: "members" },
      { access: "staff" },
      { access: "permit" },
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
    expect(byPlace("Paragon")).toMatchObject({
      source: "osm",
      id: "osm:place:way/172518496",
      address: "Carpark mapped next to Paragon",
      carparkType: "Underground carpark entrance",
      osm: { url: "https://www.openstreetmap.org/node/6926232973", access: "unknown", atEntrance: true, place: { name: "Paragon", kind: "mall", relation: "next-to" } }
    });
    expect(byPlace("Jewel Changi Airport")).toMatchObject({ address: "Carpark mapped at Jewel Changi Airport", carparkType: "Underground carpark entrance", gantryHeightM: 2.1 });
    expect(byPlace("Windsor Nature Park")).toMatchObject({ carparkType: "Carpark", osm: { atEntrance: false } });
    expect(byPlace("Choa Chu Kang Park")).toMatchObject({ address: "Carpark mapped at Choa Chu Kang Park (SAFRA Choa Chu Kang)", carparkType: "Underground carpark" });
    expect(OSM_AVAILABILITY.available).toBeNull();
    expect(estimateCost(byPlace("Paragon"), new Date("2026-10-19T02:00:00Z"), 120).kind).toBe("unavailable");
  });

  it("drops one only as a true duplicate: HDB within 80 m, an LTA or URA carpark within 30 m or with the place's name", () => {
    const paragon = byPlace("Paragon");
    const lta = (name: string, dLat: number, source = "lta") =>
      ({ ...paragon, source, id: `${source}:${name}`, address: name, lat: paragon.lat + dLat, osm: undefined }) as RegistryCarpark;
    const hdbAt = (dLat: number) => ({ ...paragon, source: undefined, id: "X1", address: "BLK 1", lat: paragon.lat + dLat, osm: undefined }) as RegistryCarpark;
    expect(withoutDuplicates([paragon], [lta("Paragon", 0.002)])).toEqual([]);
    // A differently named carpark 50 m away is another carpark; one 20 m away is this one.
    expect(withoutDuplicates([paragon], [lta("United Square", 0.00045)])).toHaveLength(1);
    expect(withoutDuplicates([paragon], [lta("Queensway (off-street) (Ride Out Tea Garden)", 0.00018, "ura")])).toEqual([]);
    expect(withoutDuplicates([paragon], [lta("Paragon", 0.004)])).toHaveLength(1);
    expect(withoutDuplicates([paragon], [hdbAt(0.0005)])).toEqual([]);
    expect(withoutDuplicates([paragon], [hdbAt(0.0012)])).toHaveLength(1);
    // LTA's short forms: "Bt Panjang Plaza" is Bukit Panjang Plaza.
    const plaza = { ...paragon, osm: { ...paragon.osm!, place: { name: "Bukit Panjang Plaza", kind: "mall" as const, relation: "at" as const } } };
    expect(withoutDuplicates([plaza], [lta("Bt Panjang Plaza", 0.0005)])).toEqual([]);
    expect(expandAbbreviations("Bt Panjang Plaza")).toBe("bukit Panjang Plaza");
  });

  it("leaves public OpenStreetMap carparks' dedupe as it was", () => {
    const publicOne = { ...byPlace("Paragon"), id: "osm:node/1", address: "Novena Square Carpark", osm: { url: "x", access: "yes" as const, atEntrance: true, named: true } };
    const lta = { ...publicOne, source: "lta" as const, id: "lta:9", address: "United Square", lat: publicOne.lat + 0.0005, osm: undefined };
    // Within DUPLICATE_RADIUS_M (80 m) of any LTA carpark, a public OpenStreetMap carpark is still left out.
    expect(withoutDuplicates([publicOne, byPlace("Paragon")], [lta]).map((carpark) => carpark.id)).toEqual(["osm:place:way/172518496"]);
  });
});
