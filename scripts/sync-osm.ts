// Refreshes worker/osm-carparks.json: public carparks mapped on OpenStreetMap, cut from Geofabrik's
// Malaysia, Singapore and Brunei extract. Needs osmium-tool (`brew install osmium-tool`).
// Run with `pnpm osm`, review the diff, then commit. The extract (about 250 MB) stays in .cache/osm/,
// which git ignores; pass --refresh to download a new one.
// The output is derived from OpenStreetMap and is available under the Open Database Licence 1.0.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { OsmFile, RegistryFile } from "../shared/domain.ts";
import { selectOsmCarparks, type OsmFeature } from "../shared/osm.ts";

const EXTRACT_URL = "https://download.geofabrik.de/asia/malaysia-singapore-brunei-latest.osm.pbf";
/** Singapore's national boundary (admin_level 2). */
const SINGAPORE_RELATION = 536780;
const CACHE = new URL("../.cache/osm/", import.meta.url);
const OUT = new URL("../worker/osm-carparks.json", import.meta.url);
const REGISTRY = new URL("../worker/registry.json", import.meta.url);
const file = (name: string) => new URL(name, CACHE).pathname;
const headers = { "user-agent": "parkwhere-osm-sync/0.1 (+https://github.com/najibninaba/parkwhere)" };

function osmium(...args: string[]): string {
  return execFileSync("osmium", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
}

async function md5(path: string): Promise<string> {
  const hash = createHash("md5");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Downloads the extract unless a verified copy is already cached (or --refresh is passed). */
async function extract(refresh: boolean): Promise<string> {
  const path = file("extract.osm.pbf");
  if (!refresh && existsSync(path)) {
    const ageDays = (Date.now() - (await stat(path)).mtimeMs) / 86_400_000;
    console.log(`Using the cached extract (${ageDays.toFixed(1)} days old). Pass --refresh for a new one.`);
    return path;
  }
  const expected = await fetch(`${EXTRACT_URL}.md5`, { headers }).then(async (response) => {
    if (!response.ok) throw new Error(`checksum download returned HTTP ${response.status}`);
    return (await response.text()).trim().split(/\s+/)[0];
  });
  console.log(`Downloading ${EXTRACT_URL} …`);
  const response = await fetch(EXTRACT_URL, { headers });
  if (!response.ok || !response.body) throw new Error(`extract download returned HTTP ${response.status}`);
  const partial = `${path}.partial`;
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(partial));
  const actual = await md5(partial);
  if (actual !== expected) throw new Error(`extract checksum mismatch: expected ${expected}, got ${actual}`);
  await rename(partial, path);
  return path;
}

function readGeojsonSeq(text: string): OsmFeature[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\x1e/, "").trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OsmFeature);
}

async function main() {
  try {
    osmium("--version");
  } catch {
    throw new Error("osmium isn't installed. Install osmium-tool (brew install osmium-tool) and run again.");
  }
  await mkdir(CACHE, { recursive: true });
  const source = await extract(process.argv.includes("--refresh"));

  // Cut along Singapore's own boundary. The relation's sub-relations (CDC districts) come along with -r,
  // so only the national boundary feature is written out as the clipping polygon.
  osmium("getid", "-r", "--overwrite", "-o", file("boundary.osm.pbf"), source, `r${SINGAPORE_RELATION}`);
  osmium("export", "-f", "geojson", "-a", "type,id", "--geometry-types=polygon", "--overwrite", "-o", file("boundary.geojson"), file("boundary.osm.pbf"));
  const boundaries = JSON.parse(await readFile(file("boundary.geojson"), "utf8")) as { features: OsmFeature[] };
  const singapore = boundaries.features.filter((feature) => feature.properties["@type"] === "relation" && feature.properties["@id"] === SINGAPORE_RELATION);
  if (singapore.length !== 1) throw new Error(`expected one Singapore boundary, found ${singapore.length}`);
  await writeFile(file("singapore.geojson"), JSON.stringify({ type: "FeatureCollection", features: singapore }));

  osmium("extract", "-p", file("singapore.geojson"), "--overwrite", "-o", file("singapore.osm.pbf"), source);
  osmium("tags-filter", "--overwrite", "-o", file("parking.osm.pbf"), file("singapore.osm.pbf"), "nwr/amenity=parking,parking_entrance");
  osmium("export", "-f", "geojsonseq", "-a", "type,id", "--geometry-types=point,polygon", "--overwrite", "-o", file("parking.geojsonseq"), file("parking.osm.pbf"));
  const features = readGeojsonSeq(await readFile(file("parking.geojsonseq"), "utf8"));

  const registry = JSON.parse(await readFile(REGISTRY, "utf8")) as RegistryFile;
  const carparks = selectOsmCarparks(features, registry.carparks);
  const dataAt = osmium("fileinfo", "-g", "header.option.osmosis_replication_timestamp", source).trim() || null;
  const out: OsmFile = {
    source: { name: "OpenStreetMap", licence: "ODbL-1.0", extract: EXTRACT_URL, dataAt },
    carparks
  };
  await writeFile(OUT, `${JSON.stringify(out, null, 0)}\n`);

  const kinds = carparks.reduce<Record<string, number>>((counts, carpark) => ({ ...counts, [`${carpark.kind} ${carpark.access}`]: (counts[`${carpark.kind} ${carpark.access}`] ?? 0) + 1 }), {});
  console.log(`Read ${features.length} parking features (data as of ${dataAt ?? "unknown"}).`);
  console.log(`Wrote ${carparks.length} public carparks and entrances to worker/osm-carparks.json:`, kinds);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
