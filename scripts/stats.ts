// Reports ParkWhere's anonymous usage counts from Workers Analytics Engine (see shared/usage.ts).
//
//   pnpm stats                      last 7 days, printed
//   pnpm stats --days 30            last 30 days
//   pnpm stats --month 2026-10      one calendar month (UTC), printed
// Only rows in the current layout (blob1 = USAGE_SCHEMA "v1") are read; bump both together.
//   pnpm stats --month 2026-10 --write   also saves docs/stats/2026-10.md (Analytics Engine keeps 3 months)
//   pnpm stats --staging            the staging dataset
//
// Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN (an API token with Account Analytics: Read),
// from the environment or .dev.vars. Counts are weighted by _sample_interval, so they're estimates. In the
// area and referrer tables, a row backed by fewer than MIN_ROWS stored data points is hidden, so a rare
// area or referrer can't single anyone out (a sampled row can stand for several events).
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MIN_ROWS = 3;

function setting(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const vars = new URL("../.dev.vars", import.meta.url);
  if (existsSync(vars)) {
    const line = readFileSync(vars, "utf8").split("\n").find((entry) => entry.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim().replace(/^"|"$/g, "");
  }
  throw new Error(`${name} isn't set. Add it to .dev.vars or the environment.`);
}

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const dataset = args.includes("--staging") ? "parkwhere_staging_events" : "parkwhere_events";
const month = option("month");
const days = Number(option("days") ?? 7);
if (month && !/^\d{4}-\d{2}$/.test(month)) throw new Error("--month takes YYYY-MM");
if (!month && (!Number.isInteger(days) || days < 1 || days > 90)) throw new Error("--days takes 1 to 90");

function period(): { where: string; label: string } {
  if (!month) return { where: `blob1 = 'v1' AND timestamp >= NOW() - INTERVAL '${days}' DAY`, label: `the last ${days} days` };
  const [year, mon] = month.split("-").map(Number);
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
  // Calendar months in UTC (Singapore's month starts 8 hours earlier).
  return { where: `blob1 = 'v1' AND timestamp >= toDateTime('${month}-01 00:00:00') AND timestamp < toDateTime('${next}-01 00:00:00')`, label: `${month} (UTC)` };
}

type Row = Record<string, string | number>;

async function query(sql: string): Promise<Row[]> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${setting("CLOUDFLARE_ACCOUNT_ID")}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${setting("CLOUDFLARE_ANALYTICS_TOKEN")}` },
    body: `${sql} FORMAT JSON`
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Analytics Engine returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { data: Row[] }).data;
}

const { where, label } = period();
const n = "SUM(_sample_interval)";
/** Counts of one event, grouped by one of its blobs. */
const by = (event: string, blob: number, extra = "") =>
  query(`SELECT blob${blob} AS key, ${n} AS n, count() AS stored FROM ${dataset} WHERE index1 = '${event}' AND ${where} ${extra} GROUP BY key ORDER BY n DESC`);

const num = (value: unknown) => Number(value ?? 0);
const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");
const total = (rows: Row[]) => rows.reduce((sum, row) => sum + num(row.n), 0);
const table = (rows: Row[], heading: string, whole: number, hideSmall = false) => {
  const shown = rows.filter((row) => !hideSmall || num(row.stored) >= MIN_ROWS);
  if (shown.length === 0) return `| ${heading} | Count | Share |\n|---|---|---|\n| (none${hideSmall ? ` with ${MIN_ROWS} or more` : ""}) | | |`;
  return [`| ${heading} | Count | Share |`, "|---|---|---|", ...shown.map((row) => `| ${row.key || "(none)"} | ${Math.round(num(row.n))} | ${share(num(row.n), whole)} |`)].join("\n");
};

async function main() {
  const [events, via, answered, hdbFeed, firsts, apps, sources, display, device, referrers, gaps, search, errors, latency] = await Promise.all([
    query(`SELECT index1 AS key, ${n} AS n FROM ${dataset} WHERE ${where} GROUP BY key`),
    by("lookup", 2),
    by("lookup", 3),
    by("lookup", 4),
    by("directions", 4),
    by("directions", 2),
    by("directions", 3),
    by("visit", 2),
    by("visit", 3),
    by("visit", 5, "AND blob5 != ''"),
    by("lookup", 9, "AND blob9 != ''"),
    by("search", 3),
    by("error", 2),
    query(`SELECT SUM(_sample_interval * double8) / SUM(_sample_interval) AS ms FROM ${dataset} WHERE index1 = 'lookup' AND ${where}`)
  ]);
  const count = (event: string) => num(events.find((row) => row.key === event)?.n);
  const lookups = count("lookup");
  const current = num(answered.find((row) => row.key === "current-count")?.n);
  const handoffs = num(firsts.find((row) => row.key === "first")?.n);
  const visits = count("visit");

  const report = `# ParkWhere usage, ${label}

Anonymous counts from Workers Analytics Engine, estimated from sampled data. No cookies, IDs, IP addresses, search text or exact locations are recorded (see the README's Privacy section). Rows under ${MIN_ROWS} are hidden in the area and referrer tables.

## Headline

| Measure | Value |
|---|---|
| Lookups (destinations looked up) | ${Math.round(lookups)} |
| Answered with a current count nearby | ${share(current, lookups)} |
| Directions hand-offs per lookup | ${share(handoffs, lookups)} (${Math.round(handoffs)} hand-offs) |
| Visits (page loads) | ${Math.round(visits)} |
| Lookups per visit | ${visits > 0 ? (lookups / visits).toFixed(2) : "–"} |
| Average lookup time | ${Math.round(num(latency[0]?.ms))} ms |

"Answered" means at least one HDB carpark within the chosen radius had a count from the last 15 minutes. A hand-off is the first map app opened for a destination; it isn't proof of parking. Hand-offs and lookups are counted separately, so their ratio can pass 100% (for example, a lookup late on the last day of a period and its hand-off after midnight).

## Lookups

${table(via, "How the destination was chosen", lookups)}

${table(answered, "What the lookup found", lookups)}

${table(hdbFeed, "HDB feed at the time", lookups)}

## Coverage gaps

Rough areas (about 2 km across, "lat,lng" of the south-west corner) where a lookup found no carpark inside the radius. Near me lookups are never included.

${table(gaps, "Area", total(gaps), true)}

## Directions

${table(apps, "Map app", total(apps))}

${table(sources, "Carpark source", total(sources))}

## Visits

${table(display, "Opened as", visits)}

${table(device, "Device", visits)}

${table(referrers, "Came from", visits, true)}

## Search and errors

${table(search, "Place search results", total(search))}

${table(errors, "Server errors by route", total(errors))}
`;
  console.log(report);
  if (month && args.includes("--write")) {
    const dir = new URL("../docs/stats/", import.meta.url);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL(`${month}.md`, dir), report);
    console.log(`Saved docs/stats/${month}.md`);
  }
}

// pathToFileURL, so a checkout path with spaces or other escaped characters still matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
