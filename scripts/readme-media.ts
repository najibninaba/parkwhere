// Regenerates the README screenshots, walkthrough and diagram images in docs/media from a running app.
//   pnpm dev            (or point at staging / production)
//   pnpm media [baseUrl]
// Needs Google Chrome and Playwright's ffmpeg (pnpm exec playwright-core install ffmpeg), plus
// ffmpeg on PATH for the GIF. Commit the results after checking them.
import { execFileSync } from "node:child_process";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
/** Marks ParkWhere's own checks so the Worker never counts them in the usage numbers. */
const CHECK_HEADERS = { "x-parkwhere-check": "1" };

const base = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");
const out = new URL("../docs/media/", import.meta.url).pathname;
const bugis = "/?lat=1.29911&lng=103.85541&name=Bugis%20Junction";
const suntec = "/?lat=1.29375&lng=103.85718&name=Suntec%20City";

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const phoneOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-SG", timezoneId: "Asia/Singapore" };
const settle = (ms = 1200) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  // Desktop: landing and results.
  const desktop = await browser.newContext({ extraHTTPHeaders: CHECK_HEADERS, viewport: { width: 1280, height: 800 }, locale: "en-SG", timezoneId: "Asia/Singapore" });
  const page = await desktop.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await settle(1800);
  await page.screenshot({ path: join(out, "landing-desktop.png") });
  await page.goto(`${base}${bugis}`, { waitUntil: "networkidle" });
  await page.locator(".card").first().waitFor();
  await settle(1800);
  await page.screenshot({ path: join(out, "results-desktop.png") });
  await desktop.close();

  // Phone: landing, HDB results, LTA results.
  const phone = await browser.newContext({ ...phoneOptions, extraHTTPHeaders: CHECK_HEADERS });
  const p = await phone.newPage();
  await p.goto(`${base}/`, { waitUntil: "networkidle" });
  await settle(1800);
  await p.screenshot({ path: join(out, "landing-phone.png") });
  await p.goto(`${base}${bugis}`, { waitUntil: "networkidle" });
  await p.locator(".card").first().waitFor();
  await settle();
  await p.locator(".card").first().scrollIntoViewIfNeeded();
  await p.locator(".card").first().getByText("Rates", { exact: true }).click();
  await settle(400);
  await p.locator(".card").first().screenshot({ path: join(out, "card-phone.png") });
  await p.evaluate(() => window.scrollTo(0, 0));
  await settle(400);
  await p.screenshot({ path: join(out, "results-phone.png") });
  await p.goto(`${base}${suntec}`, { waitUntil: "networkidle" });
  await p.locator(".card").first().waitFor();
  await settle();
  await p.locator(".card").first().screenshot({ path: join(out, "lta-card-phone.png") });
  await phone.close();

  // Walkthrough on a phone, recorded, then made into a small GIF.
  const videoDir = join(out, "video-tmp");
  const recorded = await browser.newContext({ extraHTTPHeaders: CHECK_HEADERS, ...phoneOptions, deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: { width: 390, height: 844 } } });
  const w = await recorded.newPage();
  await w.goto(`${base}/`, { waitUntil: "networkidle" });
  await settle(2200);
  await w.getByRole("button", { name: "Chinatown" }).click();
  await w.locator(".card").first().waitFor();
  await settle(2200);
  await w.getByRole("button", { name: "Cheapest" }).click();
  await settle(900);
  await w.locator(".card").first().scrollIntoViewIfNeeded();
  await settle(900);
  await w.locator(".card").first().getByText("Directions", { exact: true }).click();
  await settle(1500);
  await recorded.close();
  const [video] = await readdir(videoDir);
  await rename(join(videoDir, video), join(out, "walkthrough.webm"));
  await rm(videoDir, { recursive: true, force: true });
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y", "-i", join(out, "walkthrough.webm"),
    "-vf", "fps=8,scale=280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    join(out, "walkthrough.gif")
  ]);
  await rm(join(out, "walkthrough.webm"));

  // Diagrams: docs/diagrams/*.html, exported at 2x so GitHub shows them with the right fonts.
  const diagrams = new URL("../docs/diagrams/", import.meta.url).pathname;
  const sheet = await browser.newContext({ extraHTTPHeaders: CHECK_HEADERS, viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
  const d = await sheet.newPage();
  for (const name of (await readdir(diagrams)).filter((file) => file.endsWith(".html"))) {
    await d.goto(`file://${join(diagrams, name)}`, { waitUntil: "networkidle" });
    await d.evaluate(() => document.fonts.ready);
    await d.locator("#diagram").screenshot({ path: join(out, name.replace(/\.html$/, ".png")) });
  }
  await sheet.close();
} finally {
  await browser.close();
}
console.log(`Wrote README media to ${out}`);
