// Headless screenshot + checks of the built quota panel (dist/), for "done" evidence.
//
//   npm run build            # or deploy:local, so dist/ is current
//   npm run shot -- [--out <dir>] [--set key=value ...]
//
// - Display settings come from the real %APPDATA%\t3-deskcat\settings.json (the user's actual
//   theme / layout / appearance / usage display); account-private fields are dropped.
// - Accounts are a fixed fixture covering every state (usable, low, out of quota, idle, error),
//   so colours and sort order can be checked without touching any provider.
// - Runs the desktop panel in Chromium (same engine as WebView2) and the phone page in WebKit
//   (iPhone 15), and prints the checks as JSON. Exit code 1 when a check fails.
import { chromium, devices, webkit } from "playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const dist = join(repo, "dist");
const args = process.argv.slice(2);
let outDir = join(tmpdir(), "t3-deskcat-shots");
const overrides = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") outDir = resolve(args[++i]);
  else if (args[i] === "--set") {
    const [k, ...v] = args[++i].split("=");
    const raw = v.join("=");
    overrides[k] = raw === "true" ? true : raw === "false" ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
  }
}
mkdirSync(outDir, { recursive: true });
if (!existsSync(join(dist, "panel.html"))) {
  console.error("dist/panel.html missing: run npm run build first.");
  process.exit(1);
}

// ---- settings: the user's real display choices, minus anything account-private
const PRIVATE = [
  "accountPrefs", "accountOrder", "customImageWorking", "customImageSweating", "customImageSleeping",
  "extraAccountDirs", "modelPrices", "picksPinnedIds", "hudPinnedIds",
];
let settings = {};
const settingsPath = join(process.env.APPDATA ?? "", "t3-deskcat", "settings.json");
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    settings = {};
  }
}
for (const k of PRIVATE) delete settings[k];
settings = {
  workingThreshold: 50, sleepingThreshold: 20, scoreMode: "max_avg", refreshIntervalSecs: 120,
  notifyEnabled: true, showAntigravityExtra: false, launchAtStartup: false, petSize: 64, petX: null, petY: null,
  ...settings,
  ...overrides,
  accountPrefs: {},
  accountOrder: [],
};

// ---- fixture accounts (fake names; times relative to now, in seconds)
const now = Math.floor(Date.now() / 1000);
const h = 3600;
const win = (label, remainingPercent, resetIn) => ({ label, remainingPercent, resetAt: resetIn == null ? null : now + resetIn });
const acc = (id, provider, name, status, windows, extra = {}) => ({
  id, provider, name, plan: provider === "claude" ? "max" : null,
  effectiveRemaining: windows.length ? Math.min(...windows.map((w) => w.remainingPercent)) : 0,
  primaryWindows: windows, extraWindows: [], status, error: null, updatedAt: now - 60, ...extra,
});
const accounts = [
  acc("c-ok", "claude", "claude-usable", "ok", [win("5h", 82, 3 * h), win("Wk", 64, 4 * 24 * h)]),
  acc("c-low", "claude", "claude-low", "ok", [win("5h", 12, 2 * h), win("Wk", 35, 3 * 24 * h)]),
  acc("c-out", "claude", "claude-out", "ok", [win("5h", 0, 1 * h), win("Wk", 41, 5 * 24 * h)]),
  acc("a-ok", "antigravity", "ag-usable", "ok", [win("5h", 100, 5 * h), win("Wk", 90, 6 * 24 * h)]),
  acc("a-idle", "antigravity", "ag-idle", "idle", [win("5h", 100, null), win("Wk", 77, 2 * 24 * h)]),
  acc("a-out", "antigravity", "ag-out", "ok", [win("5h", 0, 4 * h), win("Wk", 0, 3 * 24 * h)]),
  acc("a-err", "antigravity", "ag-error", "error", [], { error: "fixture: read failed" }),
];
const snapshot = {
  accounts, picks: [], overallScore: 64, mood: "working", tooltipText: "fixture",
  lastRefreshedAt: now, settings, offline: false, forecasts: {}, usageToday: {}, burnRates: {},
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ttf": "font/ttf", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };
const ORIGIN = "http://deskcat.fixture";

async function open(browserType, contextOpts) {
  const browser = await browserType.launch();
  const ctx = await browser.newContext({ ...contextOpts, colorScheme: settings.appearance === "light" ? "light" : "dark" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/invoke/")) {
      const cmd = url.pathname.slice("/api/invoke/".length);
      const body = cmd === "get_snapshot" ? snapshot : cmd === "get_settings" ? settings : {};
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    const file = join(dist, url.pathname === "/" ? "panel.html" : decodeURIComponent(url.pathname));
    if (!file.startsWith(dist) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await page.goto(`${ORIGIN}/panel.html`);
  await page.waitForSelector("[data-acc-id]", { timeout: 10000 });
  await page.waitForTimeout(400);
  return { browser, page, errors };
}

async function rowChecks(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-acc-id]")).filter((e) => e.offsetParent !== null);
    return rows.map((r) => {
      const vals = Array.from(r.querySelectorAll(".d-wval, .g-big-pct, .g-sub-val")).map((v) => ({
        text: v.textContent.trim(), cls: v.className, color: getComputedStyle(v).color,
      }));
      return { id: r.dataset.accId, cls: r.className.replace(/\s+/g, " ").trim(), opacity: getComputedStyle(r).opacity, vals };
    });
  });
}

const report = { settingsSource: existsSync(settingsPath) ? settingsPath : "(none, defaults)", look: {
  panelTheme: settings.panelTheme, panelLayout: settings.panelLayout, appearance: settings.appearance,
  usageDisplay: settings.usageDisplay, panelOpacity: settings.panelOpacity }, overrides, shots: [], checks: {} };
let failed = false;

// ---- desktop panel (Chromium ~ WebView2)
{
  const { browser, page, errors } = await open(chromium, { viewport: { width: 400, height: 760 }, deviceScaleFactor: 2 });
  const shot = join(outDir, "desktop-panel.png");
  await page.screenshot({ path: shot, fullPage: true });
  report.shots.push(shot);
  const rows = await rowChecks(page);
  report.checks.desktopRows = rows;
  report.checks.desktopOrder = rows.map((r) => r.id);
  report.checks.desktopPageErrors = errors;
  if (errors.length) failed = true;
  // settings > panel pane, to show which theme / layout options are offered
  await page.click("#btn-settings").catch(() => {});
  await page.click('[data-tab="panel"], [data-pane-tab="panel"], [data-target="panel"]').catch(() => {});
  await page.waitForTimeout(300);
  const menu = await page.evaluate(() => {
    const vis = (el) => !!el && el.offsetParent !== null;
    const btns = (key) => Array.from(document.querySelectorAll(`.segmented[data-key="${key}"] .seg-btn`)).filter(vis).map((b) => b.dataset.value);
    return {
      themeRowVisible: vis(document.getElementById("row-panel-theme")),
      themeButtons: btns("panelTheme"),
      layoutRowVisible: vis(document.getElementById("row-panel-layout")),
      layoutButtons: btns("panelLayout"),
      frozenNoteVisible: !document.getElementById("note-frozen-look")?.classList.contains("hidden"),
      toolbarThemeButtonVisible: !document.getElementById("btn-layout")?.classList.contains("hidden"),
    };
  });
  report.checks.desktopSettingsMenu = menu;
  const shot2 = join(outDir, "desktop-settings.png");
  await page.screenshot({ path: shot2, fullPage: true });
  report.shots.push(shot2);
  await browser.close();
}

// ---- phone page (WebKit, iPhone 15)
{
  const { browser, page, errors } = await open(webkit, { ...devices["iPhone 15"] });
  const shot = join(outDir, "phone-iphone15.png");
  await page.screenshot({ path: shot, fullPage: true });
  report.shots.push(shot);
  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const overflowX = Math.max(0, de.scrollWidth - de.clientWidth);
    const inputs = Array.from(document.querySelectorAll("input:not([type=range]):not([type=checkbox]):not([type=radio]), select, textarea"))
      .filter((e) => e.offsetParent !== null)
      .map((e) => parseFloat(getComputedStyle(e).fontSize));
    const scrollers = [de, ...document.querySelectorAll("*")].filter((e) => {
      const oy = getComputedStyle(e).overflowY;
      return e.scrollHeight > e.clientHeight + 4 && (e === de || oy === "auto" || oy === "scroll");
    });
    let scrollOk = scrollers.length === 0 ? "nothing to scroll" : false;
    for (const s of scrollers) {
      const before = s.scrollTop;
      s.scrollTop = before + 200;
      if (s.scrollTop > before) { scrollOk = true; s.scrollTop = before; break; }
    }
    return { overflowX, minInputFontPx: inputs.length ? Math.min(...inputs) : null, visibleInputs: inputs.length, scrollOk };
  });
  report.checks.phone = { ...m, pageErrors: errors, rows: (await rowChecks(page)).map((r) => ({ id: r.id, cls: r.cls, opacity: r.opacity })) };
  if (errors.length || m.overflowX > 0 || (m.minInputFontPx != null && m.minInputFontPx < 16) || m.scrollOk === false) failed = true;
  await browser.close();
}

console.log(JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
