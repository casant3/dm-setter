/*
 * Manual mobile inspection.
 *
 * Drives the running app in Chromium at the Android widths the operator
 * actually uses, screenshots the principal screens, and reports the things that
 * are easy to break and hard to notice: horizontal overflow, tap targets that
 * have shrunk below a thumb, console errors, and whether the desktop layout
 * still renders three columns.
 *
 * Playwright is NOT a dependency of this project — CI would then download
 * browsers on every install for a check that needs a human looking at the
 * output anyway. Run it deliberately:
 *
 *   npm run dev
 *   npx --yes playwright@latest node scripts/mobile_check.mjs .shots
 *
 * or, where a Chromium is already present, point at it:
 *
 *   CHROMIUM=/path/to/chrome node scripts/mobile_check.mjs .shots
 */

import { mkdirSync } from "node:fs";
import { chromium, devices } from "playwright";

const WIDTHS = [360, 390, 412, 430];
const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = process.argv[2] || ".shots";
/** Minimum comfortable touch target for a control pressed all day. */
const MIN_TAP = 48;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let failures = 0;

for (const width of WIDTHS) {
  const context = await browser.newContext({
    viewport: { width, height: 780 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: devices["Pixel 7"].userAgent,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/inbox-${width}.png` });

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );

  const leads = await page.locator(".m-lead").count();
  if (leads > 0) {
    await page.locator(".m-lead").first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/conversation-${width}.png` });
    await page.getByRole("button", { name: /generate/i }).click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/reply-${width}.png` });
  }

  const targets = await page.evaluate(() => {
    const measure = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return Math.round(Math.min(rect.height, 999));
    };
    return {
      copy: measure(".m-copy"),
      generate: measure(".m-action.primary"),
      addReply: measure(".m-action"),
      feedback: measure(".m-fb"),
    };
  });

  const small = Object.entries(targets).filter(([, h]) => h !== null && h < MIN_TAP);
  if (overflow > 0 || errors.length > 0 || small.length > 0) failures += 1;

  console.log(
    `${width}px  leads=${leads}  overflow=${overflow}px  targets=${JSON.stringify(targets)}` +
      `${small.length ? `  TOO SMALL: ${small.map(([k]) => k).join(", ")}` : ""}` +
      `${errors.length ? `  ERRORS: ${errors.slice(0, 2).join(" | ")}` : ""}`,
  );
  await context.close();
}

// Desktop must not have regressed into the phone layout.
for (const width of [905, 1100, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/desktop-${width}.png` });
  const columns = await page.locator(".columns .column").count();
  const mobile = await page.locator(".m-app").count();
  if (columns !== 3 || mobile !== 0) failures += 1;
  console.log(`${width}px  columns=${columns}  mobileLayout=${mobile}`);
  await context.close();
}

await browser.close();
console.log(failures === 0 ? "OK" : `${failures} viewport(s) need attention`);
process.exit(failures === 0 ? 0 : 1);
