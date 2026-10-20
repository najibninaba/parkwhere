// Reads and triages in-app feedback in D1 (see worker/feedback.ts and AGENTS.md rule 12).
//
//   pnpm feedback                       new reports, grouped by carpark
//   pnpm feedback list --all            every report, including done ones
//   pnpm feedback find <text> [--since YYYY-MM-DD]
//                                       reports whose note or carpark matches, for a privacy request
//   pnpm feedback done <id>             marks a report done; it's deleted 180 days later
//   pnpm feedback delete <id>           deletes a report now (D1 Time Travel keeps it 30 more days)
//   pnpm feedback osm <id>              neutral note text and the link to post it on OpenStreetMap by hand
//   pnpm feedback --staging ...         the staging database
//   pnpm feedback --local ...           the local database used by `pnpm dev`
//
// Runs `wrangler d1 execute --remote`, so it needs a Wrangler login (`pnpm exec wrangler login`). Notes are
// untrusted text typed by anyone: they're printed with control characters removed, and never posted anywhere.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { OsmFile, RegistryFile } from "../shared/domain.ts";
import { REASON_LABEL, printable, receivedOn, type FeedbackReason } from "../shared/feedback.ts";
import { osmRegistry } from "../shared/osm.ts";

interface Row {
  id: number;
  received_on: string;
  kind: "carpark" | "general";
  reason: FeedbackReason;
  carpark_id: string | null;
  source: string | null;
  shown: string | null;
  note: string | null;
  app_version: string | null;
  status: "new" | "done";
  closed_on: string | null;
}

const args = process.argv.slice(2);
const staging = args.includes("--staging");
const local = args.includes("--local");
const rest = args.filter((arg) => arg !== "--staging" && arg !== "--local");
const option = (name: string) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
};
const positional = rest.filter((arg, index) => !arg.startsWith("--") && !rest[index - 1]?.startsWith("--since"));
const [command = "list", ...params] = positional;

function d1(sql: string): Row[] {
  const database = staging ? "parkwhere-staging" : "parkwhere-production";
  const output = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", database, local ? "--local" : "--remote", "--json", "--command", sql, ...(staging ? ["--env", "staging"] : [])],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 }
  );
  const parsed = JSON.parse(output) as { results: Row[] }[];
  return parsed.flatMap((part) => part.results ?? []);
}

/** A SQL string literal. Only the owner's own arguments reach here, but quotes are still escaped. */
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

function reportId(value: string | undefined): number {
  if (!value || !/^\d{1,12}$/.test(value)) throw new Error("Give a report number, for example: pnpm feedback done 12");
  return Number(value);
}

const registry = JSON.parse(readFileSync(new URL("../worker/registry.json", import.meta.url), "utf8")) as RegistryFile;
const osm = osmRegistry(JSON.parse(readFileSync(new URL("../worker/osm-carparks.json", import.meta.url), "utf8")) as OsmFile);
const names = new Map<string, string>([...registry.carparks, ...osm].map((carpark) => [carpark.id, carpark.address]));

const SOURCE: Record<string, string> = { hdb: "HDB", lta: "LTA mall", ura: "URA", osm: "OpenStreetMap" };
const indent = (text: string) => text.split("\n").join("\n         ");

function print(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = row.carpark_id ? `${row.carpark_id} · ${SOURCE[row.source ?? ""] ?? row.source} · ${names.get(row.carpark_id) ?? "(not in the bundled files)"}` : "General feedback";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, group] of groups) {
    console.log(`\n${printable(key)}`);
    for (const row of group) {
      console.log(`  #${row.id}  ${row.received_on}  ${REASON_LABEL[row.reason] ?? printable(row.reason)}${row.status === "done" ? `  (done ${row.closed_on})` : ""}`);
      if (row.shown) console.log(`       shown: ${printable(row.shown)}`);
      if (row.note) console.log(`       note: ${indent(printable(row.note))}`);
      if (row.app_version) console.log(`       app: ${printable(row.app_version)}`);
    }
  }
}

const COLUMNS = "id, received_on, kind, reason, carpark_id, source, shown, note, app_version, status, closed_on";

/** What a mapper is asked to check, in ParkWhere's own words. The reporter's note is never included. */
const OSM_ASK: Partial<Record<FeedbackReason, string>> = {
  location: "the carpark or its entrance may be mapped in the wrong place",
  closed: "the carpark may be closed or gone",
  access: "the carpark may be only for residents, staff or season holders, so its access tags may need checking",
  "not-carpark": "this may not be a carpark",
  other: "something about how this carpark is mapped may be wrong"
};

function osmNote(row: Row) {
  if (row.source !== "osm" || !row.carpark_id) throw new Error(`Report #${row.id} isn't about an OpenStreetMap carpark.`);
  const carpark = osm.find((entry) => entry.id === row.carpark_id);
  if (!carpark?.osm) throw new Error(`${row.carpark_id} isn't in worker/osm-carparks.json any more.`);
  const ask = OSM_ASK[row.reason] ?? OSM_ASK.other;
  console.log("Check the report first (on the ground, or against imagery), then post it from your own OpenStreetMap account.");
  console.log("The reporter's note is left out on purpose: notes are public and permanent.\n");
  console.log(`  A visitor to ParkWhere (parkwhere.bijan.app) reported in ${row.received_on.slice(0, 7)} that ${ask}. Could a local mapper check? Mapped object: ${carpark.osm.url}\n`);
  console.log(`Post it at: https://www.openstreetmap.org/note/new#map=19/${carpark.lat.toFixed(5)}/${carpark.lng.toFixed(5)}`);
}

function main() {
  const where = staging ? " (staging)" : "";
  if (command === "list") {
    const all = rest.includes("--all");
    const rows = d1(`SELECT ${COLUMNS} FROM feedback ${all ? "" : "WHERE status = 'new' "}ORDER BY carpark_id IS NULL, carpark_id, id`);
    console.log(`${rows.length} ${all ? "" : "new "}${rows.length === 1 ? "report" : "reports"}${where}.${all ? "" : " Add --all to include done ones."}`);
    print(rows);
    return;
  }
  if (command === "find") {
    const text = params[0];
    if (!text) throw new Error("Give some text to look for, for example: pnpm feedback find \"gantry\" --since 2026-10-01");
    const since = option("since");
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("--since takes YYYY-MM-DD");
    const like = literal(`%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    const rows = d1(
      `SELECT ${COLUMNS} FROM feedback WHERE (note LIKE ${like} ESCAPE '\\' OR carpark_id LIKE ${like} ESCAPE '\\')${since ? ` AND received_on >= ${literal(since)}` : ""} ORDER BY id`
    );
    console.log(`${rows.length} matching ${rows.length === 1 ? "report" : "reports"}${where}.`);
    if (rows.length !== 1) console.log("For a privacy request, act only on one clear match. Otherwise ask for more of the note's text.");
    print(rows);
    return;
  }
  if (command === "done") {
    const id = reportId(params[0]);
    d1(`UPDATE feedback SET status = 'done', closed_on = ${literal(receivedOn(new Date()))} WHERE id = ${id}`);
    console.log(`Marked report #${id} done${where}. It's deleted automatically 180 days from today.`);
    return;
  }
  if (command === "delete") {
    const id = reportId(params[0]);
    d1(`DELETE FROM feedback WHERE id = ${id}`);
    console.log(`Deleted report #${id}${where}. D1 Time Travel can still restore it for up to 30 days.`);
    return;
  }
  if (command === "osm") {
    const id = reportId(params[0]);
    const [row] = d1(`SELECT ${COLUMNS} FROM feedback WHERE id = ${id}`);
    if (!row) throw new Error(`There's no report #${id}${where}.`);
    osmNote(row);
    return;
  }
  throw new Error(`Unknown command "${printable(command)}". Use list, find, done, delete or osm.`);
}

// pathToFileURL, so a checkout path with spaces or other escaped characters still matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
