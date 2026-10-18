// Captures proof that a deployed ParkWhere build works: screenshots, a walkthrough video and checks.
//   node scripts/pr-proof.ts <baseUrl> <outDir>
// Writes PNGs, walkthrough.webm and summary.md into outDir. Exits non-zero if a check fails.
// Needs Google Chrome (preinstalled on GitHub's ubuntu runners).
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const [baseUrl, outDir = "proof"] = process.argv.slice(2);
if (!baseUrl) {
  console.error("usage: node scripts/pr-proof.ts <baseUrl> [outDir]");
  process.exit(2);
}
const base = baseUrl.replace(/\/$/, "");
const destination = "/?lat=1.30106&lng=103.85412&name=Albert%20Centre";

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

async function api() {
  const nearby = await fetch(`${base}/api/nearby?lat=1.30106&lng=103.85412&radius=500`);
  const body = nearby.ok ? ((await nearby.json()) as { carparks: unknown[]; feed: { state: string; refreshError: string | null } }) : null;
  check("API /api/nearby", nearby.ok && Boolean(body?.carparks.length), `HTTP ${nearby.status}, ${body?.carparks.length ?? 0} carparks`);
  check("Availability feed", body?.feed.state === "live", body ? `${body.feed.state}${body.feed.refreshError ? ` (${body.feed.refreshError})` : ""}` : "no response");
  const health = await fetch(`${base}/health`);
  check("GET /health", health.status === 200, `HTTP ${health.status}`);
}

const noOverflow = async (page: Page, label: string) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`No horizontal overflow (${label})`, overflow <= 0, overflow > 0 ? `${overflow}px wider than the screen` : "fits");
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".spaces-count, .cost-total")].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent?.trim() ?? "")
  );
  check(`No numbers cut off (${label})`, clipped.length === 0, clipped.length ? clipped.join(", ") : "none");
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await api().catch((error: unknown) => check("API reachable", false, error instanceof Error ? error.message : String(error)));

// Any failure part-way still produces a summary, so the PR shows what broke.
try {
  await capture();
} catch (error) {
  check("Capture completed", false, (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200));
}

async function capture() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // Phone walkthrough, recorded.
    const videoDir = join(outDir, "video-tmp");
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: "en-SG",
      timezoneId: "Asia/Singapore",
      recordVideo: { dir: videoDir, size: { width: 390, height: 844 } }
    });
    const page = await phone.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

    await page.goto(`${base}/`, { waitUntil: "networkidle" });
    await page.screenshot({ path: join(outDir, "01-start-phone.png") });

    await page.goto(`${base}${destination}`, { waitUntil: "networkidle" });
    await page.locator(".card").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(outDir, "02-results-phone.png") });
    await noOverflow(page, "390px");

    await page.getByRole("button", { name: "Cheapest" }).click();
    await page.locator(".card").first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.locator(".card").first().getByText("Rates", { exact: true }).click();
    await page.waitForTimeout(400);
    await page.locator(".card").first().screenshot({ path: join(outDir, "03-card-rates-phone.png") });

    await page.locator(".card").first().getByText("Directions", { exact: true }).click();
    await page.waitForTimeout(400);
    await page.locator(".card").first().screenshot({ path: join(outDir, "04-card-directions-phone.png") });
    const links = await page.locator(".card").first().locator(".directions-menu a").count();
    check("Directions offer external map apps", links === 3, `${links} links`);
    await page.waitForTimeout(600);
    check("No browser errors", errors.length === 0, errors.length ? errors.slice(0, 3).join(" | ") : "none");
    await phone.close();
    const [video] = await readdir(videoDir);
    if (video) await rename(join(videoDir, video), join(outDir, "walkthrough.webm"));
    await rm(videoDir, { recursive: true, force: true });

    // Smallest phone.
    const small = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const smallPage = await small.newPage();
    await smallPage.goto(`${base}${destination}`, { waitUntil: "networkidle" });
    await smallPage.locator(".card").first().waitFor({ timeout: 20_000 });
    await noOverflow(smallPage, "320px");
    await small.close();

    // Desktop.
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-SG", timezoneId: "Asia/Singapore" });
    const desktopPage = await desktop.newPage();
    await desktopPage.goto(`${base}${destination}`, { waitUntil: "networkidle" });
    await desktopPage.locator(".card").first().waitFor({ timeout: 20_000 });
    await desktopPage.waitForTimeout(800);
    await desktopPage.screenshot({ path: join(outDir, "05-results-desktop.png") });
    await desktop.close();
  } finally {
    await browser.close();
  }
}

const failed = checks.filter((c) => !c.ok);
// The feed and /health depend on data.gov.sg, so they warn rather than fail the build.
const advisory = new Set(["Availability feed", "GET /health"]);
const blocking = failed.filter((c) => !advisory.has(c.name));
const summary = [
  "| Check | Result |",
  "|---|---|",
  ...checks.map((c) => `| ${c.name} | ${c.ok ? "✅" : advisory.has(c.name) ? "⚠️" : "❌"} ${c.detail} |`)
].join("\n");
await writeFile(join(outDir, "summary.md"), `${summary}\n`);
console.log(summary);
process.exit(blocking.length ? 1 : 0);
