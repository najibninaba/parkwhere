// Mobile usability check against a running app (default http://localhost:5173).
// Emulates phones, fails on horizontal overflow or small tap targets, and saves screenshots. It also opens
// the feedback sheet from the first card and checks it the same way. Sending is answered in the browser,
// so the check never stores a report.
//   pnpm dev   (in another terminal)
//   pnpm check:mobile [baseUrl]
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright-core";
import { markAsCheck } from "./check-traffic.ts";

const base = process.argv[2] ?? "http://localhost:5173";
const out = new URL("../screenshots/", import.meta.url);
const devices = [
  { name: "iphone-se", width: 320, height: 568 },
  { name: "iphone-15", width: 390, height: 844 },
  { name: "pixel-8", width: 412, height: 915 }
];
const path = "/?lat=1.30106&lng=103.85412&name=Albert%20Centre";

/** Visible controls under 40px tall. A radio or checkbox is measured by its label, which is what's tapped. */
const smallTargets = (page: Page, scope: string) =>
  page.evaluate((selector) =>
    [...document.querySelectorAll<HTMLElement>(`${selector} :is(button, a.button, a.link, summary, input, select, textarea)`)]
      .filter((el) => el.offsetParent !== null && !el.closest("[aria-hidden='true']"))
      .map((el) => {
        const target = el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox") ? (el.closest("label") ?? el) : el;
        return { text: (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30), h: target.getBoundingClientRect().height };
      })
      .filter((t) => t.h < 40), scope);

/** Opens "Report a problem" on the first card, checks the sheet, sends (answered locally) and checks Sent. */
async function checkSheet(page: Page, name: string): Promise<string[]> {
  const problems: string[] = [];
  const card = page.locator(".card").first();
  const link = card.getByRole("button", { name: /^Report a problem/ });
  await link.scrollIntoViewIfNeeded();
  await card.screenshot({ path: new URL(`${name}-card.png`, out).pathname });
  await page.route("**/api/feedback", (route) => route.fulfill({ status: 204 }));
  await link.click();
  const sheet = page.locator("dialog.sheet[open]");
  await sheet.waitFor({ timeout: 5_000 });
  // Let the slide-up finish, so the screenshot shows the sheet as it settles.
  await sheet.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  const fit = await sheet.evaluate((el) => ({ right: el.getBoundingClientRect().right, inner: el.scrollWidth - el.clientWidth, width: window.innerWidth }));
  if (fit.right > fit.width + 1 || fit.inner > 0) problems.push(`feedback sheet wider than the screen (${Math.round(fit.right)}px, ${fit.inner}px inside)`);
  const small = await smallTargets(page, "dialog.sheet");
  if (small.length) problems.push(`sheet tap targets under 40px: ${small.map((t) => `${t.text} (${Math.round(t.h)}px)`).join(", ")}`);
  await page.screenshot({ path: new URL(`${name}-sheet.png`, out).pathname });
  await sheet.getByRole("radio").first().check();
  await sheet.getByRole("button", { name: "Send report" }).click();
  try {
    await sheet.getByText("Thanks. Your report was sent to ParkWhere.").waitFor({ timeout: 5_000 });
    await page.screenshot({ path: new URL(`${name}-sent.png`, out).pathname });
  } catch {
    problems.push("the sheet didn't show Sent after a 204");
  }
  await page.keyboard.press("Escape");
  if (await sheet.count()) problems.push("Esc didn't close the feedback sheet");
  await page.unroute("**/api/feedback");
  return problems;
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let failures = 0;
try {
  for (const device of devices) {
    const context = await browser.newContext({ viewport: { width: device.width, height: device.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-SG", timezoneId: "Asia/Singapore" });
    await markAsCheck(context);
    const page = await context.newPage();
    // Right after a deploy the first load can be slow; allow 30 s and one reload before failing.
    await page.goto(base + path, { waitUntil: "networkidle" });
    try {
      await page.locator(".card").first().waitFor({ timeout: 30_000 });
    } catch {
      await page.reload({ waitUntil: "networkidle" });
      await page.locator(".card").first().waitFor({ timeout: 30_000 });
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const small = await smallTargets(page, "body");
    // Big numbers (counts, prices) must never be cut off by their box.
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".spaces-count, .cost-total")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent?.trim() ?? "")
    );
    await page.screenshot({ path: new URL(`${device.name}.png`, out).pathname, fullPage: true });
    const problems = [
      overflow > 0 ? `horizontal overflow of ${overflow}px` : null,
      small.length ? `tap targets under 40px: ${small.map((t) => `${t.text} (${Math.round(t.h)}px)`).join(", ")}` : null,
      clipped.length ? `numbers cut off: ${clipped.join(", ")}` : null,
      ...(await checkSheet(page, device.name))
    ].filter(Boolean);
    console.log(`${device.name} ${device.width}px: ${problems.length ? problems.join("; ") : "ok"}`);
    failures += problems.length;
    await context.close();
  }
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
