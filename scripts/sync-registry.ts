// Refreshes worker/registry.json from data.gov.sg's HDB Carpark Information dataset.
// Run with `pnpm registry`, review the diff, then commit and deploy.
import { writeFile } from "node:fs/promises";
import { svy21ToWgs84 } from "../shared/svy21.ts";
import type { RegistryFile, RegistryCarpark } from "../shared/domain.ts";

const DATASET_ID = "d_23f946fa557947f93a8043bbef41dd09";
const POLL_URL = `https://api-open.data.gov.sg/v1/public/api/datasets/${DATASET_ID}/poll-download`;
const OUT = new URL("../worker/registry.json", import.meta.url);

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const headers = { "user-agent": "parkwhere-registry-sync/0.1", ...(process.env.DATA_GOV_SG_API_KEY ? { "x-api-key": process.env.DATA_GOV_SG_API_KEY } : {}) };

async function main() {
  const poll = await fetch(POLL_URL, { headers });
  if (!poll.ok) throw new Error(`poll-download returned HTTP ${poll.status}`);
  const body = (await poll.json()) as { code: number; data?: { status?: string; url?: string }; errorMsg?: string };
  if (body.code !== 0 || !body.data?.url) throw new Error(`poll-download failed: ${body.errorMsg || body.data?.status || "no url"}`);
  const csv = await fetch(body.data.url);
  if (!csv.ok) throw new Error(`CSV download returned HTTP ${csv.status}`);

  const [header, ...rows] = parseCsv(await csv.text());
  const col = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`registry CSV is missing column ${name}`);
    return index;
  };
  const c = {
    id: col("car_park_no"), address: col("address"), x: col("x_coord"), y: col("y_coord"), type: col("car_park_type"),
    system: col("type_of_parking_system"), shortTerm: col("short_term_parking"), free: col("free_parking"),
    night: col("night_parking"), decks: col("car_park_decks"), gantry: col("gantry_height"), basement: col("car_park_basement")
  };

  const carparks: RegistryCarpark[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const id = row[c.id]?.trim().toUpperCase();
    const x = Number(row[c.x]);
    const y = Number(row[c.y]);
    if (!id || !Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) { skipped.push(id || "(blank)"); continue; }
    const { lat, lng } = svy21ToWgs84(y, x);
    const gantry = Number(row[c.gantry]);
    carparks.push({
      id,
      address: row[c.address].trim(),
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      carparkType: row[c.type].trim(),
      parkingSystem: row[c.system].trim(),
      shortTermParking: row[c.shortTerm].trim(),
      freeParking: row[c.free].trim(),
      nightParking: row[c.night].trim() === "YES",
      gantryHeightM: Number.isFinite(gantry) && gantry > 0 ? gantry : null,
      basement: row[c.basement].trim() === "Y"
    });
  }
  carparks.sort((left, right) => left.id.localeCompare(right.id));
  const file: RegistryFile = {
    source: { datasetId: DATASET_ID, name: "HDB Carpark Information", publisher: "Housing & Development Board", fetchedAt: new Date().toISOString() },
    carparks
  };
  await writeFile(OUT, `${JSON.stringify(file, null, 0)}\n`);
  console.log(`Wrote ${carparks.length} carparks to worker/registry.json${skipped.length ? `; skipped ${skipped.length} without coordinates: ${skipped.join(", ")}` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
