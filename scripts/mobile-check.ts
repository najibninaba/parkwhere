// Mobile usability check against a running app (default http://localhost:5173).
// Emulates phones, fails on horizontal overflow or small tap targets, and saves screenshots.
//   pnpm dev   (in another terminal)
//   pnpm check:mobile [baseUrl]
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173";
const out = new URL("../screenshots/", import.meta.url);
const devices = [
  { name: "iphone-se", width: 320, height: 568 },
  { name: "iphone-15", width: 390, height: 844 },
  { name: "pixel-8", width: 412, height: 915 }
];
const path = "/?lat=1.30106&lng=103.85412&name=Albert%20Centre";

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let failures = 0;
try {
  for (const device of devices) {
    const context = await browser.newContext({ viewport: { width: device.width, height: device.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-SG", timezoneId: "Asia/Singapore" });
    const page = await context.newPage();
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.locator(".card").first().waitFor({ timeout: 15_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const smallTargets = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("button, a.button, summary, input, select")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ text: (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30), h: el.getBoundingClientRect().height }))
        .filter((t) => t.h < 40)
    );
    // Big numbers (counts, prices) must never be cut off by their box.
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".spaces-count, .cost-total")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent?.trim() ?? "")
    );
    await page.screenshot({ path: new URL(`${device.name}.png`, out).pathname, fullPage: true });
    const problems = [
      overflow > 0 ? `horizontal overflow of ${overflow}px` : null,
      smallTargets.length ? `tap targets under 40px: ${smallTargets.map((t) => `${t.text} (${Math.round(t.h)}px)`).join(", ")}` : null,
      clipped.length ? `numbers cut off: ${clipped.join(", ")}` : null
    ].filter(Boolean);
    console.log(`${device.name} ${device.width}px: ${problems.length ? problems.join("; ") : "ok"}`);
    failures += problems.length;
    await context.close();
  }
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
