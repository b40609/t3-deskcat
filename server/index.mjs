// T3 DeskCat Web Edition — pure Node.js server using official signed node.exe.
// Serves the exact built panel/analytics frontend (dist/) on loopback (127.0.0.1)
// and this PC's Tailscale IPv4 (100.64.0.0/10), sharing %APPDATA%\t3-deskcat\ state.

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { arch, homedir, networkInterfaces, platform } from "node:os";
import { extname, join, resolve } from "node:path";
import QRCode from "qrcode";

import { credStamp, discoverAccounts, recentActivityTs } from "./discovery.mjs";
import {
  fetchAntigravityQuota,
  fetchClaudeQuota,
  fetchCodexQuota,
  readLocalClaudeQuota,
  readLocalCodexQuota,
} from "./providers.mjs";
import { setPriceOverrides, UsageLedger } from "./usage.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DIST_DIR = join(REPO_ROOT, "dist");
const ICON_PATH = join(REPO_ROOT, "src-tauri", "icons", "touch-icon.png");
const FALLBACK_MOBILE_HTML = join(REPO_ROOT, "src-tauri", "src", "mobile.html");
const CONFIG_DIR = join(process.env.APPDATA ?? join(homedir(), ".config"), "t3-deskcat");
const SETTINGS_PATH = join(CONFIG_DIR, "settings.json");
const CACHE_PATH = join(CONFIG_DIR, "quota_cache.json");
const HISTORY_PATH = join(CONFIG_DIR, "history.json");
const CONTRACT_PATH = join(CONFIG_DIR, "quota_v1.json");
const LEDGER_PATH = join(CONFIG_DIR, "usage-ledger.json");
const LOG_PATH = join(CONFIG_DIR, "deskcat-web.log");
const PID_PATH = join(CONFIG_DIR, "web-server.pid");

const MAX_BODY = 12 * 1024 * 1024;
const SCHEDULER_TICK_MS = 30_000;
const ACTIVE_WINDOW_SECS = 15 * 60;
const RATELIMIT_BASE_SECS = 120;
const RATELIMIT_MAX_SECS = 1800;
const ERROR_BASE_SECS = 60;
const ERROR_MAX_SECS = 300;
const BUCKET_SECS = 300;
const HISTORY_KEEP_SECS = 24 * 3600;
const RECENT_LOOKBACK = 90 * 60;
const RECENT_MIN_SPAN = 15 * 60;
const RECENT_MIN_DROP_PCT = 3;
const AVG_MIN_ELAPSED = 10 * 60;
const SHORT_AVG_MIN_USED_PCT = 5;
const LONG_WINDOW_SECS = 2 * 86400;
const LONG_MIN_ELAPSED = 12 * 3600;
const LONG_MIN_USED_PCT = 15;
const WEEKLY_IMMINENT_SECS = 48 * 3600;
const SHORT_IMMINENT_SECS = 90 * 60;
const WEEKLY_TIME_BUCKET_SECS = 12 * 3600;
const SHORT_TIME_BUCKET_SECS = 30 * 60;

const INTERVALS = {
  claude: { active: 300, idle: 900, triggered: 120, manual: 45 },
  antigravity: { active: 180, idle: 600, triggered: 90, manual: 45 },
  codex: { active: 120, idle: 600, triggered: 45, manual: 15 },
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const MANIFEST = JSON.stringify({
  name: "T3 DeskCat",
  short_name: "額度",
  start_url: "/",
  display: "standalone",
  background_color: "#0b0c10",
  theme_color: "#0b0c10",
  icons: [{ src: "/icon.png", sizes: "256x256", type: "image/png" }],
});

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function logLine(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
  const line = `[${ts}] [pid ${process.pid}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${line}\n`, "utf8");
  } catch {}
}

function writeJsonAtomic(filePath, obj, pretty = false) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj), "utf8");
    renameSync(tmp, filePath);
  } catch {}
}

// ============================================================================
// Network helpers
// ============================================================================

function isTailscaleIp(ip) {
  const clean = String(ip ?? "").replace(/^::ffff:/, "");
  const parts = clean.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] < 128;
}

function isLoopbackIp(ip) {
  const clean = String(ip ?? "").replace(/^::ffff:/, "");
  return clean === "::1" || clean.startsWith("127.");
}

function getTailscaleIp() {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isTailscaleIp(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}

// ============================================================================
// Settings
// ============================================================================

const DEFAULT_SETTINGS = {
  petSize: 96,
  workingThreshold: 70,
  sleepingThreshold: 20,
  scoreMode: "all_avg",
  refreshIntervalSecs: 60,
  notifyEnabled: true,
  showAntigravityExtra: false,
  launchAtStartup: false,
  showPet: true,
  petX: null,
  petY: null,
  petTheme: "hud_gauge",
  uiScale: 100,
  appearance: "dark",
  usageDisplay: "remaining",
  resetFormat: "relative",
  paceTick: "off",
  language: "zh-TW",
  modelPrices: {},
  showPicks: true,
  picksStrategy: "use_before_reset_weekly",
  picksScope: "per_provider",
  picksCount: 1,
  picksPinActive: false,
  picksPinnedIds: [],
  hudCount: 2,
  hudLayout: "vertical",
  hudStrategy: "use_before_reset_weekly",
  hudScope: "per_provider",
  hudPinActive: true,
  hudPinnedIds: [],
  accountPrefs: {},
  accountOrder: [],
  panelLayout: "classic",
  panelTheme: "glass",
  panelOpacity: 100,
  compactAccounts: false,
  claudeMinIntervalSecs: 60,
  showForecast: true,
  showUsageStats: false,
  trayStyle: "icon",
  mobileEnabled: true,
  mobilePort: 8765,
  extraAccountDirs: [],
};

const DESKTOP_ONLY_KEYS = [
  "launchAtStartup", "showPet", "hotkey", "panelPosition", "panelPinned",
  "panelX", "panelY", "panelWidth", "panelHeight", "petX", "petY",
  "hudCount", "hudLayout", "hudStrategy", "hudScope", "hudPinActive", "hudPinnedIds",
  "extraAccountDirs", "mobileEnabled", "mobilePort",
  "customImageWorking", "customImageSweating", "customImageSleeping",
];

function loadSettings() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function isHidden(settings, id) {
  return Boolean(settings?.accountPrefs?.[id]?.hidden);
}

function displayName(settings, acc) {
  const alias = settings?.accountPrefs?.[acc.id]?.alias;
  return typeof alias === "string" && alias.trim() ? alias.trim() : acc.name;
}

// ============================================================================
// QuotaCache (JSON-compatible with quota_cache.json)
// ============================================================================

class QuotaCache {
  constructor() {
    this.last_good = {};
    this.backoff = {};
    this.last_attempt = {};
    this.last_error = {};
    this.last_expired = {};
    this.last_idle = new Set();
    this.idle_migrated = true;
    this.dirty = false;
    this._load();
  }

  _load() {
    if (!existsSync(CACHE_PATH)) return;
    try {
      const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      this.last_good = parsed.last_good ?? {};
      this.backoff = parsed.backoff ?? {};
      this.last_attempt = parsed.last_attempt ?? {};
      this.last_error = parsed.last_error ?? {};
      this.last_expired = parsed.last_expired ?? {};
      this.last_idle = new Set(Array.isArray(parsed.last_idle) ? parsed.last_idle : []);
      this.idle_migrated = parsed.idle_migrated ?? true;
    } catch {}
  }

  save() {
    if (!this.dirty) return;
    writeJsonAtomic(CACHE_PATH, {
      last_good: this.last_good,
      backoff: this.backoff,
      last_attempt: this.last_attempt,
      last_error: this.last_error,
      last_expired: this.last_expired,
      last_idle: Array.from(this.last_idle),
      idle_migrated: this.idle_migrated,
    });
    this.dirty = false;
  }

  lastGoodUpdatedAt(id) {
    return this.last_good[id]?.updatedAt ?? 0;
  }

  isKnownExpired(id) {
    return Object.prototype.hasOwnProperty.call(this.last_expired, id);
  }

  clearExpired(id) {
    const hadIdle = this.last_idle.delete(id);
    if (Object.prototype.hasOwnProperty.call(this.last_expired, id) || hadIdle) {
      delete this.last_expired[id];
      this.dirty = true;
    }
  }

  hasPassedReset(id, now) {
    const cached = this.last_good[id];
    if (!cached) return false;
    return [...(cached.primaryWindows ?? []), ...(cached.extraWindows ?? [])].some(
      (w) => w.remainingPercent < 100 && w.resetAt != null && w.resetAt <= now && w.resetAt > cached.updatedAt,
    );
  }

  mayFetch(id, now, minInterval, allowRetryErrors) {
    const b = this.backoff[id];
    if (b && now < b.next_allowed_at) {
      if (b.is_rate_limit || !allowRetryErrors) return false;
    }
    const last = this.last_attempt[id];
    return last == null ? true : now - last >= minInterval;
  }

  noteAttempt(id, now) {
    this.last_attempt[id] = now;
    this.dirty = true;
  }

  backoffRemaining(id, now) {
    const b = this.backoff[id];
    return b && b.next_allowed_at > now ? { rem: b.next_allowed_at - now, isRateLimit: Boolean(b.is_rate_limit) } : null;
  }

  _cachedView(current, now, status, note) {
    const cached = this.last_good[current.id];
    if (!cached) return null;
    const acc = structuredClone(cached);
    acc.name = current.name;
    if (current.plan) acc.plan = current.plan;
    acc.status = status;
    acc.error = note ?? null;

    let changed = false;
    for (const w of [...(acc.primaryWindows ?? []), ...(acc.extraWindows ?? [])]) {
      if (w.resetAt != null && w.resetAt <= now) {
        w.remainingPercent = 100;
        w.resetAt = null;
        changed = true;
      }
    }
    if (changed && acc.primaryWindows?.length) {
      const plain = acc.primaryWindows.filter((w) => !w.label.includes(" "));
      const pool = plain.length ? plain : acc.primaryWindows;
      acc.effectiveRemaining = Math.min(...pool.map((w) => w.remainingPercent));
    }
    return acc;
  }

  reconcile(fresh, retryAfterSecs, now) {
    this.dirty = true;
    if (fresh.status === "ok") {
      delete this.backoff[fresh.id];
      delete this.last_error[fresh.id];
      delete this.last_expired[fresh.id];
      this.last_idle.delete(fresh.id);
      if (fresh.updatedAt > 0) {
        this.last_attempt[fresh.id] = Math.max(this.last_attempt[fresh.id] ?? 0, fresh.updatedAt);
      }
      this.last_good[fresh.id] = structuredClone(fresh);
      return fresh;
    }
    if (fresh.status === "expired" || fresh.status === "idle") {
      const status = fresh.status;
      delete this.backoff[fresh.id];
      delete this.last_error[fresh.id];
      const note = fresh.error ?? "憑證已過期";
      this.last_expired[fresh.id] = note;
      if (status === "idle") this.last_idle.add(fresh.id);
      else this.last_idle.delete(fresh.id);
      return this._cachedView(fresh, now, status, note) ?? fresh;
    }
    if (fresh.status === "cooldown") {
      delete this.last_expired[fresh.id];
      this.last_idle.delete(fresh.id);
      const b = this.backoff[fresh.id] ?? { next_allowed_at: 0, strikes: 0, is_rate_limit: true };
      if (!b.is_rate_limit) { b.strikes = 0; b.is_rate_limit = true; }
      b.strikes = Math.min(10, (b.strikes ?? 0) + 1);
      const expWait = Math.min(RATELIMIT_MAX_SECS, RATELIMIT_BASE_SECS << Math.min(6, b.strikes - 1));
      const wait = retryAfterSecs != null && retryAfterSecs > 0
        ? Math.min(RATELIMIT_MAX_SECS, Math.max(retryAfterSecs, expWait))
        : expWait;
      b.next_allowed_at = now + wait;
      this.backoff[fresh.id] = b;
      const mins = Math.max(1, Math.ceil(wait / 60));
      const note = `429 請求受限冷卻中，約 ${mins} 分鐘後重試`;
      this.last_error[fresh.id] = note;
      return this._cachedView(fresh, now, "stale", note) ?? { ...fresh, error: note };
    }
    // Transient network / 5xx error
    delete this.last_expired[fresh.id];
    this.last_idle.delete(fresh.id);
    const b = this.backoff[fresh.id] ?? { next_allowed_at: 0, strikes: 0, is_rate_limit: false };
    if (b.is_rate_limit && b.next_allowed_at <= now) b.strikes = 0;
    b.is_rate_limit = false;
    b.strikes = Math.min(6, (b.strikes ?? 0) + 1);
    const wait = Math.min(ERROR_MAX_SECS, ERROR_BASE_SECS << Math.min(4, b.strikes - 1));
    b.next_allowed_at = now + wait;
    this.backoff[fresh.id] = b;
    const note = fresh.error ?? "暫時連線失敗";
    this.last_error[fresh.id] = note;
    return this._cachedView(fresh, now, "stale", note) ?? fresh;
  }

  skipped(id, fallback, now) {
    if (Object.prototype.hasOwnProperty.call(this.last_expired, id)) {
      const note = this.last_expired[id];
      const status = this.last_idle.has(id) ? "idle" : "expired";
      return this._cachedView(fallback, now, status, note) ?? { ...fallback, status, error: note };
    }
    const br = this.backoffRemaining(id, now);
    if (br) {
      const mins = Math.max(1, Math.ceil(br.rem / 60));
      const note = br.isRateLimit
        ? `429 請求受限冷卻中，約 ${mins} 分鐘後重試`
        : (this.last_error[id] ?? `暫時連線失敗，約 ${mins} 分鐘後重試`);
      return this._cachedView(fallback, now, "stale", note) ?? { ...fallback, status: br.isRateLimit ? "cooldown" : "error", error: note };
    }
    return this._cachedView(fallback, now, "ok", null) ?? fallback;
  }
}

// ============================================================================
// History + Forecast + Ranking
// ============================================================================

class HistoryStore {
  constructor() {
    this.samples = {};
    this.dirty = false;
    if (existsSync(HISTORY_PATH)) {
      try {
        const parsed = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
        this.samples = parsed?.samples ?? {};
      } catch {}
    }
  }
  record(key, ts, val) {
    const arr = (this.samples[key] ??= []);
    const last = arr[arr.length - 1];
    if (last && ts - last[0] < BUCKET_SECS) {
      if (last[1] !== val) { last[1] = val; this.dirty = true; }
    } else {
      arr.push([ts, val]);
      this.dirty = true;
    }
    const kept = arr.filter(([t]) => ts - t <= HISTORY_KEEP_SECS);
    if (kept.length !== arr.length) {
      this.samples[key] = kept;
      this.dirty = true;
    }
  }
  save() {
    if (!this.dirty) return;
    writeJsonAtomic(HISTORY_PATH, { samples: this.samples });
    this.dirty = false;
  }
}

function windowSecs(label) {
  if (label === "Wk" || label === "週") return 7 * 86400;
  if (label === "Mo") return 30 * 86400;
  if (/^\d+h$/.test(label)) return Number(label.slice(0, -1)) * 3600;
  if (/^\d+d$/.test(label)) return Number(label.slice(0, -1)) * 86400;
  return null;
}

function recentRateWithDrop(series, now, current) {
  if (!Array.isArray(series)) return null;
  const pts = series.filter(([t]) => t >= now - RECENT_LOOKBACK && t < now);
  pts.push([now, current]);
  let i = pts.length - 1;
  while (i > 0 && pts[i - 1][1] >= pts[i][1]) i--;
  const [t0, v0] = pts[i];
  const span = now - t0;
  if (span < RECENT_MIN_SPAN) return null;
  const drop = Math.max(0, v0 - current);
  return { rate: drop / span, drop };
}

function recentRate(series, now, current) {
  const res = recentRateWithDrop(series, now, current);
  return res ? res.rate : null;
}

function computeForecast(acc, history, now) {
  if (acc.status !== "ok" && acc.status !== "stale") return null;
  let best = null;
  for (const w of acc.primaryWindows ?? []) {
    if (w.label.includes(" ") || w.remainingPercent <= 0) continue;
    const len = windowSecs(w.label);
    if (!len) continue;
    if (w.resetAt != null && w.resetAt <= now) continue;
    const isLong = len >= LONG_WINDOW_SECS;
    const usedPct = Math.max(0, 100 - w.remainingPercent);
    let rate = null;
    if (isLong) {
      // Long windows (weekly/monthly) must NOT extrapolate a 15-90m burst across 7 days.
      if (usedPct >= LONG_MIN_USED_PCT && w.resetAt != null) {
        const elapsed = now - (w.resetAt - len);
        if (elapsed >= LONG_MIN_ELAPSED && elapsed < len) {
          rate = usedPct / elapsed;
        }
      }
    } else {
      const recent = recentRateWithDrop(history.samples[`${acc.id}|${w.label}`], now, w.remainingPercent);
      if (recent) {
        rate = recent.drop >= RECENT_MIN_DROP_PCT ? recent.rate : 0;
      } else if (usedPct >= SHORT_AVG_MIN_USED_PCT && w.resetAt != null) {
        const elapsed = now - (w.resetAt - len);
        if (elapsed >= AVG_MIN_ELAPSED && elapsed < len) {
          rate = usedPct / elapsed;
        }
      }
    }
    if (!rate || rate <= 0) continue;
    const exhaustAt = now + Math.round(w.remainingPercent / rate);
    const beforeReset = w.resetAt != null ? exhaustAt < w.resetAt : exhaustAt - now <= len;
    if (!beforeReset) continue;
    if (!best || exhaustAt < best.exhaustAt) {
      best = {
        label: w.label,
        exhaustAt,
        resetAt: w.resetAt ?? null,
        ratePerHour: Math.round(rate * 3600 * 10) / 10,
      };
    }
  }
  return best;
}

function computeBurnRate(acc, history, now) {
  if (acc.status !== "ok" && acc.status !== "stale") return null;
  const candidates = (acc.primaryWindows ?? [])
    .filter((w) => !w.label.includes(" "))
    .map((w) => ({ len: windowSecs(w.label), w }))
    .filter((x) => x.len != null)
    .sort((a, b) => a.len - b.len);
  if (!candidates.length) return null;
  const w = candidates[0].w;
  const rate = recentRate(history.samples[`${acc.id}|${w.label}`], now, w.remainingPercent);
  return rate != null ? Math.round(rate * 3600 * 10) / 10 : null;
}

function isUsable(a) {
  return a.status === "ok" || a.status === "stale" || ((a.status === "expired" || a.status === "idle") && (a.primaryWindows?.length ?? 0) > 0);
}

function bindingWindow(acc) {
  const plain = (acc.primaryWindows ?? []).filter((w) => !w.label.includes(" "));
  const pool = plain.length ? plain : (acc.primaryWindows ?? []);
  return pool.length ? pool.reduce((a, b) => (b.remainingPercent < a.remainingPercent ? b : a)) : null;
}

function formatCountdown(secs) {
  const s = Math.max(60, secs);
  if (s < 3600) return `${Math.ceil(s / 60)} 分鐘後`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} 小時後`;
  return `${Math.round(s / 86400)} 天後`;
}

function evalResetWindow(acc, isWeekly, now) {
  const eff = Math.max(0, Math.min(100, acc.effectiveRemaining));
  const w = (acc.primaryWindows ?? [])
    .filter((x) => !x.label.includes(" "))
    .find((x) => {
      const d = windowSecs(x.label);
      return d != null && (isWeekly ? d >= 2 * 86400 : d < 2 * 86400);
    });
  if (!w || !w.resetAt || w.resetAt <= now) {
    return { hasWindow: false, imminent: false, urgency: 0, resetAt: null, leftSecs: Number.MAX_SAFE_INTEGER, windowPct: eff, spendablePct: 0 };
  }
  const leftSecs = w.resetAt - now;
  const windowPct = Math.max(0, Math.min(100, w.remainingPercent));
  const spendablePct = Math.min(windowPct, eff);
  const imminentCap = isWeekly ? WEEKLY_IMMINENT_SECS : SHORT_IMMINENT_SECS;
  const imminent = spendablePct >= 10 && leftSecs <= imminentCap;
  const urgency = imminent ? spendablePct / Math.max(0.1, leftSecs / 3600) : 0;
  return { hasWindow: true, imminent, urgency, resetAt: w.resetAt, leftSecs, windowPct, spendablePct };
}

function compareResetStrategy(a, b, isWeekly, now) {
  const ea = evalResetWindow(a, isWeekly, now);
  const eb = evalResetWindow(b, isWeekly, now);
  const aOk = ea.hasWindow && ea.spendablePct >= 10 ? 1 : 0;
  const bOk = eb.hasWindow && eb.spendablePct >= 10 ? 1 : 0;
  if (bOk !== aOk) return bOk - aOk;
  const aImm = ea.imminent ? 1 : 0;
  const bImm = eb.imminent ? 1 : 0;
  if (bImm !== aImm) return bImm - aImm;
  if (ea.imminent && eb.imminent) {
    if (eb.urgency !== ea.urgency) return eb.urgency - ea.urgency;
  } else if (aOk && bOk) {
    const bucket = isWeekly ? WEEKLY_TIME_BUCKET_SECS : SHORT_TIME_BUCKET_SECS;
    const ba = Math.floor(ea.leftSecs / bucket);
    const bb = Math.floor(eb.leftSecs / bucket);
    if (ba !== bb) return ba - bb;
    if (eb.spendablePct !== ea.spendablePct) return eb.spendablePct - ea.spendablePct;
    if (ea.leftSecs !== eb.leftSecs) return ea.leftSecs - eb.leftSecs;
  }
  return 0;
}

function buildPick(acc, strategy, forecasts, now, isActive = false) {
  let resetAt = bindingWindow(acc)?.resetAt ?? null;
  if (resetAt != null && resetAt <= now) resetAt = null;
  let useBeforeReset = false;
  const note = acc.status === "expired"
    ? "最後已知額度（憑證已過期，重新使用一次即自動更新）"
    : null;
  const defaultReason = () => {
    const plain = (acc.primaryWindows ?? []).filter((w) => !w.label.includes(" "));
    return plain.length ? plain.map((w) => `${w.label} ${w.remainingPercent}%`).join(" / ") : `剩餘 ${acc.effectiveRemaining}%`;
  };
  let tag = "充裕";
  let reason = defaultReason();
  const s = strategy === "use_before_reset" ? "use_before_reset_weekly" : strategy;
  if (isActive) {
    tag = "使用中";
    reason = defaultReason();
  } else if (s === "use_before_reset_weekly") {
    const ev = evalResetWindow(acc, true, now);
    if (ev.hasWindow && ev.spendablePct >= 10) {
      resetAt = ev.resetAt;
      if (ev.imminent) {
        useBeforeReset = true;
        tag = "週將重設";
      } else {
        tag = "較早重設";
      }
      reason = `週額度剩 ${ev.windowPct}%，${formatCountdown(ev.resetAt - now)}重設`;
    }
  } else if (s === "use_before_reset_5h") {
    const ev = evalResetWindow(acc, false, now);
    if (ev.hasWindow && ev.spendablePct >= 10) {
      resetAt = ev.resetAt;
      if (ev.imminent) {
        useBeforeReset = true;
        tag = "5h 將重設";
      } else {
        tag = "較早重設";
      }
      reason = `5 小時剩 ${ev.windowPct}%，${formatCountdown(ev.resetAt - now)}重設`;
    }
  } else if (s === "soonest_reset") {
    const resets = (acc.primaryWindows ?? []).filter((w) => !w.label.includes(" ") && w.resetAt > now).map((w) => w.resetAt);
    const soon = resets.length ? Math.min(...resets) : null;
    resetAt = soon;
    tag = "最快重設";
    reason = soon ? `${formatCountdown(soon - now)}重設` : defaultReason();
  } else if (s === "risk_first") {
    if (acc.status === "cooldown") { tag = "受限"; reason = "目前限流冷卻中，建議改用其他帳號"; }
    else if (acc.status === "expired") { tag = "過期"; reason = "憑證已過期，重新使用一次即自動更新"; }
    else if (acc.effectiveRemaining === 0) { tag = "用盡"; reason = "額度已用盡，請改用其他帳號"; }
    else if (forecasts[acc.id]) { tag = "偏低"; reason = `依目前消耗速度，預計 ${formatCountdown(forecasts[acc.id].exhaustAt - now)} 用完`; }
    else { tag = "偏低"; reason = `僅剩 ${acc.effectiveRemaining}%，建議改用其他帳號`; }
  }
  return {
    provider: acc.provider,
    accountId: acc.id,
    accountName: acc.name,
    effectiveRemaining: acc.effectiveRemaining,
    reason,
    tag,
    resetAt,
    useBeforeReset,
    note,
  };
}

function detectActiveAccountId(discovered, now) {
  let bestId = null;
  let bestTs = 0;
  for (const acc of discovered) {
    const ts = recentActivityTs(acc);
    if (ts > bestTs && now - ts <= ACTIVE_WINDOW_SECS) {
      bestTs = ts;
      bestId = acc.id;
    }
  }
  return bestId;
}

function computeRankedPicks(accounts, settings, forecasts, now, opts) {
  const visible = accounts.filter((a) => !isHidden(settings, a.id));
  const strategy = opts.strategy ?? "use_before_reset_weekly";
  const scope = opts.scope ?? "per_provider";
  const limit = Math.max(1, Math.min(6, Number(opts.count ?? 1)));
  const pinActive = Boolean(opts.pinActive);
  const pinnedIds = Array.isArray(opts.pinnedIds) ? opts.pinnedIds : [];
  const activeId = opts.activeId ?? null;
  const out = [];
  const taken = new Set();

  if (strategy === "pinned") {
    const byId = new Map(visible.map((a) => [a.id, a]));
    for (const id of pinnedIds) {
      if (out.length >= limit) break;
      const acc = byId.get(id);
      if (!acc || taken.has(acc.id)) continue;
      const pk = buildPick({ ...acc, name: displayName(settings, acc) }, "most_left", forecasts, now);
      pk.tag = "已釘選";
      out.push(pk);
      taken.add(acc.id);
    }
    return out;
  }

  if (pinActive && activeId) {
    const activeAcc = visible.find((a) => a.id === activeId);
    if (activeAcc && isUsable(activeAcc)) {
      const pk = buildPick({ ...activeAcc, name: displayName(settings, activeAcc) }, strategy, forecasts, now, true);
      out.push(pk);
      taken.add(activeAcc.id);
    }
  }

  const rankList = (pool) => {
    const s = strategy === "use_before_reset" ? "use_before_reset_weekly" : strategy;
    const cmpMostLeft = (a, b) => b.effectiveRemaining - a.effectiveRemaining || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return [...pool].sort((a, b) => {
      if (s === "use_before_reset_weekly") {
        const d = compareResetStrategy(a, b, true, now);
        return d || cmpMostLeft(a, b);
      }
      if (s === "use_before_reset_5h") {
        const d = compareResetStrategy(a, b, false, now);
        return d || cmpMostLeft(a, b);
      }
      if (s === "soonest_reset") {
        const minR = (x) => {
          const rs = (x.primaryWindows ?? []).filter((w) => !w.label.includes(" ") && w.resetAt > now).map((w) => w.resetAt);
          return rs.length ? Math.min(...rs) : Number.MAX_SAFE_INTEGER;
        };
        return minR(a) - minR(b) || cmpMostLeft(a, b);
      }
      if (s === "risk_first") {
        return a.effectiveRemaining - b.effectiveRemaining;
      }
      return cmpMostLeft(a, b);
    });
  };

  const eligible = (a) => strategy === "risk_first" ? true : (isUsable(a) && a.effectiveRemaining > 0);
  const pickFrom = (pool, cap) => {
    const nonExp = pool.filter((a) => a.status !== "expired");
    const chosen = rankList(nonExp.length ? nonExp : pool).slice(0, cap);
    for (const acc of chosen) {
      out.push(buildPick({ ...acc, name: displayName(settings, acc) }, strategy, forecasts, now));
      taken.add(acc.id);
    }
  };

  if (scope === "per_provider") {
    for (const prov of ["claude", "antigravity", "codex"]) {
      const alreadyForProv = out.filter((p) => p.provider === prov).length;
      const need = Math.max(0, limit - alreadyForProv);
      if (need <= 0) continue;
      const pool = visible.filter((a) => a.provider === prov && !taken.has(a.id) && eligible(a));
      if (pool.length) pickFrom(pool, need);
    }
  } else {
    const need = Math.max(0, limit - out.length);
    if (need > 0) {
      const pool = visible.filter((a) => !taken.has(a.id) && eligible(a));
      if (pool.length) pickFrom(pool, need);
    }
  }
  return out;
}

function computePicks(accounts, settings, forecasts, now) {
  return computeRankedPicks(accounts, settings, forecasts, now, {
    strategy: settings.picksStrategy ?? "use_before_reset_weekly",
    scope: settings.picksScope ?? "per_provider",
    count: settings.picksCount ?? 1,
    pinActive: settings.picksPinActive === true,
    pinnedIds: settings.picksPinnedIds ?? [],
    activeId: state.activeAccountId,
  });
}

function computeHudPicks(accounts, settings, forecasts, now) {
  const hudCount = Math.max(1, Math.min(4, Number(settings.hudCount ?? 2)));
  const hudScope = hudCount < 2 ? "global" : (settings.hudScope ?? "per_provider");
  const countArg = hudScope === "per_provider" ? 1 : hudCount;
  const picks = computeRankedPicks(accounts, settings, forecasts, now, {
    strategy: settings.hudStrategy ?? "use_before_reset_weekly",
    scope: hudScope,
    count: countArg,
    pinActive: settings.hudPinActive !== false,
    pinnedIds: settings.hudPinnedIds ?? [],
    activeId: state.activeAccountId,
  });
  if (hudScope === "per_provider" && picks.length < hudCount) {
    // Top up remaining slots across all providers if fewer providers than hudCount
    const taken = new Set(picks.map((p) => p.accountId));
    const extra = computeRankedPicks(accounts, settings, forecasts, now, {
      strategy: settings.hudStrategy ?? "use_before_reset_weekly",
      scope: "global",
      count: hudCount,
      pinActive: false,
      pinnedIds: settings.hudPinnedIds ?? [],
      activeId: null,
    });
    for (const pk of extra) {
      if (picks.length >= hudCount) break;
      if (!taken.has(pk.accountId)) {
        picks.push(pk);
        taken.add(pk.accountId);
      }
    }
  }
  return picks.slice(0, hudCount);
}

function computeOverallScore(accounts, settings) {
  const included = accounts.filter(
    (a) => !isHidden(settings, a.id) && !settings?.accountPrefs?.[a.id]?.excludeScore && isUsable(a),
  );
  if (!included.length) return 0;
  if (settings.scoreMode === "max_avg") {
    const byProv = new Map();
    for (const a of included) {
      byProv.set(a.provider, Math.max(byProv.get(a.provider) ?? 0, a.effectiveRemaining));
    }
    const vals = Array.from(byProv.values());
    return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
  }
  return Math.round(included.reduce((s, a) => s + a.effectiveRemaining, 0) / included.length);
}

// ============================================================================
// quota_v1.json contract writer (keeps OmniKit dispatch fed with live data)
// ============================================================================

function writeQuotaContract(accounts, discoveredById, cache, now) {
  const inferSpan = (id, label) => {
    const il = String(id ?? "").toLowerCase();
    const ll = String(label ?? "").toLowerCase();
    if (il.includes("weekly") || ll.includes("wk")) return "weekly";
    if (il.includes("5h") || ll.includes("5h")) return "5h";
    if (il.includes("monthly") || ll.includes("mo")) return "monthly";
    return ll.replace(/\s+/g, "-");
  };
  const inferFamily = (provider, id, label) => {
    const il = String(id ?? "").toLowerCase();
    const ll = String(label ?? "").toLowerCase();
    if (provider === "antigravity") {
      if (il.includes("argon") || ll.includes("argon")) return "argon";
      if (il.includes("carbon") || ll.includes("carbon")) return "carbon";
      if (il.startsWith("3p") || ll.includes("3p")) return "3p";
      return "gemini";
    }
    if (provider === "claude" && label.includes(" ")) {
      return label.slice(label.indexOf(" ") + 1).trim().toLowerCase().replace(/\s+/g, "-") || "primary";
    }
    return "primary";
  };

  const items = accounts.map((acc) => {
    const meta = discoveredById.get(acc.id);
    const toWin = (w, isPrimary) => {
      const rem = Math.max(0, Math.min(100, w.remainingPercent));
      const span = inferSpan(w.id, w.label);
      const family = inferFamily(acc.provider, w.id, w.label);
      const obj = {
        id: w.id || `${family}-${span}`,
        family,
        span,
        label: w.label,
        remainingPercent: rem,
        usedPercent: 100 - rem,
        isPrimary,
      };
      if (w.resetAt != null) obj.resetsAt = w.resetAt;
      return obj;
    };
    const windows = [
      ...(acc.primaryWindows ?? []).map((w) => toWin(w, true)),
      ...(acc.extraWindows ?? []).map((w) => toWin(w, false)),
    ];
    const br = cache.backoffRemaining(acc.id, now);
    const out = {
      accountId: acc.id,
      canonicalId: meta?.canonicalId ?? acc.id,
      provider: acc.provider,
      displayName: acc.name,
      sourceKind: meta?.sourceKind ?? "unknown",
      bindings: meta
        ? {
            ...(meta.t3InstanceId ? { t3InstanceId: meta.t3InstanceId } : {}),
            ...(meta.configDir ? { configDir: meta.configDir } : {}),
            credentialKind: meta.credentialKind,
          }
        : {},
      status: acc.status,
      usable: windows.length > 0 && ["ok", "stale", "idle"].includes(acc.status),
      stale: acc.status !== "ok",
      effectiveRemaining: acc.effectiveRemaining,
      updatedAt: acc.updatedAt,
      ageSeconds: acc.updatedAt > 0 ? Math.max(0, now - acc.updatedAt) : 0,
      windows,
    };
    if (acc.plan) out.plan = acc.plan;
    if (br) out.backoffUntil = now + br.rem;
    if (acc.error) out.error = acc.error;
    return out;
  });

  writeJsonAtomic(
    CONTRACT_PATH,
    {
      schemaVersion: 1,
      producer: "deskcat-web",
      producerVersion: "0.2.0",
      generatedAt: now,
      accounts: items,
    },
    true,
  );
}

// ============================================================================
// App runtime & refresh engine
// ============================================================================

const state = {
  settings: loadSettings(),
  cache: new QuotaCache(),
  history: new HistoryStore(),
  ledger: new UsageLedger(LEDGER_PATH),
  credStamps: new Map(),
  discovered: [],
  activeAccountId: null,
  hotkeyError: null,
  lowAlerted: new Set(),
  lowWindows: new Set(),
  snapshot: null,
  usageToday: {},
  lastUsageScan: 0,
  refreshPromise: null,
  loggedIds: "",
};

// ============================================================================
// Desktop support helpers (loopback-only: notifications, autostart, Tailscale,
// folder picker, diagnostics, add-account terminal launcher)
// ============================================================================

function shortenHome(p) {
  const h = homedir();
  if (h && p.toLowerCase().startsWith(h.toLowerCase())) {
    return `~${p.slice(h.length)}`;
  }
  return p;
}

function findTailscaleGui() {
  for (const envVar of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
    const base = process.env[envVar];
    if (!base) continue;
    const candidate = join(base, "Tailscale", "tailscale-ipn.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function getTailscaleState() {
  const connected = Boolean(getTailscaleIp());
  return { installed: connected || Boolean(findTailscaleGui()), connected };
}

function inQuietHours(s) {
  if (!s.quietHoursEnabled) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = Number(s.quietStartMin ?? 23 * 60);
  const end = Number(s.quietEndMin ?? 9 * 60);
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

function sendDesktopNotification(title, body) {
  if (platform() !== "win32") return;
  const esc = (str) => String(str ?? "").replace(/'/g, "''");
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "$ni = New-Object System.Windows.Forms.NotifyIcon",
    `$ico = '${esc(join(REPO_ROOT, "src-tauri", "icons", "icon.ico"))}'`,
    "if (Test-Path $ico) { $ni.Icon = New-Object System.Drawing.Icon($ico) } else { $ni.Icon = [System.Drawing.SystemIcons]::Information }",
    "$ni.Visible = $true",
    `$ni.ShowBalloonTip(5000, '${esc(title)}', '${esc(body)}', [System.Windows.Forms.ToolTipIcon]::Info)`,
    "Start-Sleep -Seconds 6",
    "$ni.Visible = $false; $ni.Dispose()",
  ].join("; ");
  try {
    const conhost = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe");
    const child = spawn(conhost, ["--headless", "powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    logLine(`notification error: ${err.message}`);
  }
}

function evaluateNotifications(accounts) {
  const s = state.settings;
  if (inQuietHours(s)) return;
  for (const acc of accounts) {
    if (isHidden(s, acc.id) || acc.status !== "ok") continue;
    const name = displayName(s, acc);
    const danger = Number(s.accountPrefs?.[acc.id]?.notifyThreshold ?? s.sleepingThreshold ?? 20);
    if (s.notifyEnabled !== false) {
      if (acc.effectiveRemaining < danger) {
        if (!state.lowAlerted.has(acc.id)) {
          state.lowAlerted.add(acc.id);
          sendDesktopNotification("T3 DeskCat 額度偏低", `${name} 剩餘 ${acc.effectiveRemaining}%（低於危險線 ${danger}%）`);
        }
      } else if (acc.effectiveRemaining >= danger + 5) {
        state.lowAlerted.delete(acc.id);
      }
    }
    if (s.notifyOnReset === true) {
      for (const w of acc.primaryWindows ?? []) {
        if (w.label.includes(" ")) continue;
        const key = `${acc.id}|${w.label}`;
        if (w.remainingPercent < 50) {
          state.lowWindows.add(key);
        } else if (w.remainingPercent >= 95 && state.lowWindows.has(key)) {
          state.lowWindows.delete(key);
          const lbl = w.label === "Wk" ? "每週" : w.label;
          sendDesktopNotification("T3 DeskCat 額度已重設", `${name} 的 ${lbl} 額度已恢復至 ${w.remainingPercent}%`);
        }
      }
    }
  }
}

function syncAutostartShortcut(enabled) {
  if (platform() !== "win32") return;
  const startupDir = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const lnkPath = join(startupDir, "T3 DeskCat.lnk");
  try {
    if (!enabled) {
      if (existsSync(lnkPath)) unlinkSync(lnkPath);
      return;
    }
    mkdirSync(startupDir, { recursive: true });
    const conhost = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe");
    const hudScript = join(REPO_ROOT, "scripts", "deskcat-hud.ps1");
    const icon = join(REPO_ROOT, "src-tauri", "icons", "icon.ico");
    const esc = (v) => v.replace(/'/g, "''");
    const ps = [
      "$wsh = New-Object -ComObject WScript.Shell",
      `$sc = $wsh.CreateShortcut('${esc(lnkPath)}')`,
      `$sc.TargetPath = '${esc(conhost)}'`,
      `$sc.Arguments = '--headless powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File "${esc(hudScript)}"'`,
      `$sc.WorkingDirectory = '${esc(REPO_ROOT)}'`,
      `if (Test-Path '${esc(icon)}') { $sc.IconLocation = '${esc(icon)},0' }`,
      "$sc.Description = 'T3 DeskCat Floating HUD'",
      "$sc.Save()",
    ].join("; ");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 8000 });
  } catch (err) {
    logLine(`autostart sync error: ${err.message}`);
  }
}

function openDesktopTarget(target) {
  if (target === "logs") {
    mkdirSync(CONFIG_DIR, { recursive: true });
    spawn("explorer.exe", [CONFIG_DIR], { detached: true, stdio: "ignore" }).unref();
    return null;
  }
  if (target === "tailscale-download") {
    spawn("explorer.exe", ["https://tailscale.com/download/windows"], { detached: true, stdio: "ignore" }).unref();
    return null;
  }
  if (target === "tailscale-app") {
    const gui = findTailscaleGui();
    if (!gui) throw Object.assign(new Error("找不到 Tailscale"), { code: 400 });
    spawn(gui, [], { detached: true, stdio: "ignore" }).unref();
    return null;
  }
  throw Object.assign(new Error("unknown target"), { code: 400 });
}

function pickLocalFolder() {
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$d.Description = '選擇帳號設定資料夾'",
    "$d.ShowNewFolderButton = $false",
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $d.SelectedPath }",
  ].join("; ");
  const out = execFileSync("powershell.exe", ["-STA", "-NoProfile", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  }).trim();
  return out || null;
}

function launchAddAccountLogin(provider, name) {
  const home = homedir();
  const slug = String(name ?? "").trim().toLowerCase();
  const valid = slug.length > 0 && slug.length <= 24 && /^[a-z0-9_-]+$/.test(slug);
  let envVar = "";
  let dir = null;
  let cmd = "";
  let marker = "";
  if (provider === "claude") {
    envVar = "CLAUDE_CONFIG_DIR";
    dir = join(home, `.claude-${slug}`);
    cmd = "claude auth login";
    marker = ".credentials.json";
  } else if (provider === "codex") {
    envVar = "CODEX_HOME";
    dir = join(home, `.codex-${slug}`);
    cmd = "codex login";
    marker = "auth.json";
  } else if (provider === "antigravity") {
    cmd = "agy";
  } else {
    throw Object.assign(new Error("不支援的平台"), { code: 400 });
  }
  if (dir) {
    if (!valid) throw Object.assign(new Error("名稱只能用英文字母、數字、- 或 _"), { code: 400 });
    if (existsSync(join(dir, marker))) throw Object.assign(new Error("已經有叫這個名稱的帳號"), { code: 400 });
    mkdirSync(dir, { recursive: true });
  }
  const childEnv = { ...process.env };
  if (dir && envVar) childEnv[envVar] = dir;
  spawn("cmd.exe", ["/C", "start", "", "cmd.exe", "/K", cmd], {
    env: childEnv,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  return dir ?? home;
}

function buildDiagnosticsText() {
  const ts = getTailscaleState();
  const tsIp = getTailscaleIp();
  const port = state.settings.mobilePort || 8765;
  const mobileDesc = state.settings.mobileEnabled === false
    ? "off"
    : (tsIp ? `http://${tsIp}:${port}` : `http://127.0.0.1:${port} (no Tailscale)`);
  const lines = [
    `T3 DeskCat 0.2.0 (Web Edition · node ${process.version})`,
    `OS: ${platform()} ${arch()}`,
    `Phone page: ${mobileDesc}`,
    `Tailscale: installed=${ts.installed} connected=${ts.connected}`,
    "",
  ];
  const srcById = new Map(state.discovered.map((a) => [a.id, shortenHome(a.filePath)]));
  if (state.snapshot) {
    const now = nowSec();
    lines.push(`Accounts (${state.snapshot.accounts.length}):`);
    for (const a of state.snapshot.accounts) {
      const age = a.updatedAt > 0 ? ` age=${Math.max(0, now - a.updatedAt)}s` : "";
      const err = a.error ? ` (${a.error})` : "";
      lines.push(`  ${a.id} [${a.plan ?? ""}] status=${a.status}${age}${err} <- ${srcById.get(a.id) ?? "?"}`);
    }
    const extra = state.settings.extraAccountDirs ?? [];
    if (extra.length) lines.push(`Extra folders: ${extra.join("; ")}`);
  } else {
    lines.push("Accounts: no snapshot yet");
  }
  if (existsSync(LOG_PATH)) {
    try {
      const logLines = readFileSync(LOG_PATH, "utf8").split(/\r?\n/).filter(Boolean);
      lines.push("", "Log (last 40 lines):", ...logLines.slice(-40));
    } catch {}
  }
  return lines.join("\n");
}

setPriceOverrides(state.settings.modelPrices);

function buildSources(discovered) {
  return discovered.map((a) => {
    if (a.provider === "claude") return { kind: "claude", accountId: a.id, configDir: a.configDir };
    if (a.provider === "codex") return { kind: "codex", accountId: a.id, configDir: a.configDir };
    return {
      kind: "antigravity",
      accountId: a.id,
      brainDirs: a.isLegacyGemini
        ? [join(a.configDir, "antigravity-cli", "brain"), join(a.configDir, "antigravity", "brain")]
        : [join(a.configDir, "brain")],
    };
  });
}

function buildSnapshot(accounts, now) {
  const s = state.settings;
  const forecasts = {};
  const burnRates = {};
  for (const acc of accounts) {
    const fc = computeForecast(acc, state.history, now);
    if (fc) forecasts[acc.id] = fc;
    const br = computeBurnRate(acc, state.history, now);
    if (br != null) burnRates[acc.id] = br;
  }
  const picks = s.showPicks === false ? [] : computePicks(accounts, s, forecasts, now);
  const overallScore = computeOverallScore(accounts, s);
  const mood = overallScore >= s.workingThreshold ? "working" : overallScore >= s.sleepingThreshold ? "sweating" : "sleeping";
  const visible = accounts.filter((a) => !isHidden(s, a.id));
  const offline = visible.length > 0 && visible.every((a) => a.status !== "ok" && a.status !== "idle");

  return {
    accounts,
    picks,
    overallScore,
    mood,
    tooltipText: `T3 DeskCat Web · ${overallScore}%`,
    lastRefreshedAt: now,
    settings: s,
    offline,
    forecasts,
    usageToday: state.usageToday,
    burnRates,
  };
}

async function runRefresh(reason = "scheduled") {
  if (state.refreshPromise) {
    if (reason === "scheduled" && state.snapshot) return state.snapshot;
    return state.refreshPromise;
  }
  const p = _doRefresh(reason).finally(() => {
    state.refreshPromise = null;
  });
  state.refreshPromise = p;
  return p;
}

async function _doRefresh(reason) {
  const now = nowSec();
  // Reload settings if edited externally while running.
  state.settings = loadSettings();
  setPriceOverrides(state.settings.modelPrices);

  const discovered = discoverAccounts(state.settings.extraAccountDirs);
  state.discovered = discovered;
  const discoveredById = new Map(discovered.map((a) => [a.id, a]));

  const idKey = discovered.map((a) => a.id).join(",");
  if (idKey !== state.loggedIds) {
    state.loggedIds = idKey;
    logLine(`discovered ${discovered.length} account(s): ${discovered.map((a) => a.id).join(", ")}`);
  }

  // Incremental token usage scan (at most every 20s unless startup/manual).
  if (reason === "startup" || reason === "manual" || now - state.lastUsageScan >= 20) {
    try {
      state.usageToday = state.ledger.computeToday(buildSources(discovered));
      state.lastUsageScan = now;
    } catch (err) {
      logLine(`usage scan error: ${err.message}`);
    }
  }

  const credChanged = new Set();
  for (const acc of discovered) {
    const stamp = credStamp(acc);
    if (stamp) {
      const prev = state.credStamps.get(acc.id);
      state.credStamps.set(acc.id, stamp);
      const credMtime = Number(stamp.split(":")[0]) || 0;
      const lastAttempt = state.cache.last_attempt[acc.id] ?? 0;
      const refreshedOffline = !prev && state.cache.isKnownExpired(acc.id) && credMtime > lastAttempt;
      if ((prev && prev !== stamp) || refreshedOffline) {
        credChanged.add(acc.id);
        state.cache.clearExpired(acc.id);
      }
    }
  }

  const results = new Map();
  const claudeDue = [];
  const otherDue = [];

  for (const acc of discovered) {
    const placeholder = {
      id: acc.id,
      provider: acc.provider,
      name: acc.name,
      plan: null,
      effectiveRemaining: 0,
      primaryWindows: [],
      extraWindows: [],
      status: "error",
      error: "尚未更新",
      updatedAt: now,
    };

    if (isHidden(state.settings, acc.id)) {
      results.set(acc.id, state.cache.skipped(acc.id, placeholder, now));
      continue;
    }

    // Zero-network local cache checks for Claude & Codex.
    if (acc.provider === "claude") {
      const localQ = readLocalClaudeQuota(acc.id, acc.name, acc.filePath, state.cache.lastGoodUpdatedAt(acc.id), now);
      if (localQ) {
        results.set(acc.id, state.cache.reconcile(localQ, null, now));
        continue;
      }
    } else if (acc.provider === "codex") {
      const localQ = readLocalCodexQuota(acc.id, acc.name, acc.configDir, state.cache.lastGoodUpdatedAt(acc.id), now);
      if (localQ) {
        results.set(acc.id, state.cache.reconcile(localQ, null, now));
        continue;
      }
    }

    const isChanged = credChanged.has(acc.id);
    if (reason === "discover" && !isChanged && (state.cache.last_good[acc.id] || state.cache.isKnownExpired(acc.id))) {
      results.set(acc.id, state.cache.skipped(acc.id, placeholder, now));
      continue;
    }

    if (state.cache.isKnownExpired(acc.id) && !isChanged && reason !== "manual" && reason !== "startup") {
      results.set(acc.id, state.cache.skipped(acc.id, placeholder, now));
      continue;
    }

    const active = now - recentActivityTs(acc) <= ACTIVE_WINDOW_SECS;
    const resetPassed = state.cache.hasPassedReset(acc.id, now);
    const cfgInt = INTERVALS[acc.provider] ?? INTERVALS.codex;
    let minInterval;
    if (isChanged) {
      minInterval = 0;
    } else if (reason === "manual") {
      minInterval = cfgInt.manual;
    } else if (resetPassed) {
      minInterval = cfgInt.triggered ?? cfgInt.active;
    } else {
      minInterval = active ? cfgInt.active : cfgInt.idle;
    }
    if (!isChanged && acc.provider === "claude" && state.settings.claudeMinIntervalSecs) {
      minInterval = Math.max(minInterval, Number(state.settings.claudeMinIntervalSecs));
    }
    // Always route through mayFetch so rate-limit/error backoff and minInterval are respected
    // (matches Rust account_min_interval + may_fetch).
    const allowRetryErrors = reason === "manual" || reason === "startup" || isChanged;
    const shouldFetch = state.cache.mayFetch(acc.id, now, minInterval, allowRetryErrors);

    if (!shouldFetch) {
      results.set(acc.id, state.cache.skipped(acc.id, placeholder, now));
      continue;
    }

    if (acc.provider === "claude") claudeDue.push(acc);
    else otherDue.push(acc);
  }

  // Run Claude sequentially (gentle spacing to avoid 429).
  for (let i = 0; i < claudeDue.length; i++) {
    const acc = claudeDue[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 400));
    const ts = nowSec();
    const out = await fetchClaudeQuota(acc);
    if (out.networkHit) state.cache.noteAttempt(acc.id, ts);
    if (out.quota.status === "cooldown") {
      logLine(`quota rate-limited id=${acc.id} retry_after=${out.retryAfterSecs}`);
    }
    results.set(acc.id, state.cache.reconcile(out.quota, out.retryAfterSecs, ts));
  }

  // Split non-Claude into Antigravity (cold-start CLI probes: strictly sequential with
  // 1.2-2.5s jitter only after real CLI hits) and Codex (lightweight HTTP: max 2 concurrent).
  const agDue = otherDue.filter((a) => a.provider === "antigravity");
  const codexDue = otherDue.filter((a) => a.provider !== "antigravity");

  const runAgSequential = async () => {
    let prevNetworkHit = false;
    for (const acc of agDue) {
      if (prevNetworkHit) {
        const jitterMs = 1200 + Math.floor(Math.random() * 1301);
        await new Promise((r) => setTimeout(r, jitterMs));
      }
      const ts = nowSec();
      const out = await fetchAntigravityQuota(acc);
      if (out.networkHit) state.cache.noteAttempt(acc.id, ts);
      prevNetworkHit = Boolean(out.networkHit);
      results.set(acc.id, state.cache.reconcile(out.quota, out.retryAfterSecs, ts));
    }
  };

  const runCodexPool = async () => {
    let nextIdx = 0;
    const workerCount = Math.min(2, codexDue.length);
    await Promise.all(
      Array.from({ length: workerCount }, async (_, workerIdx) => {
        if (workerIdx > 0) await new Promise((r) => setTimeout(r, 200));
        while (nextIdx < codexDue.length) {
          const acc = codexDue[nextIdx++];
          const ts = nowSec();
          const out = await fetchCodexQuota(acc);
          if (out.networkHit) state.cache.noteAttempt(acc.id, ts);
          results.set(acc.id, state.cache.reconcile(out.quota, out.retryAfterSecs, ts));
        }
      }),
    );
  };

  await Promise.all([runAgSequential(), runCodexPool()]);

  const accounts = discovered.map((acc) => results.get(acc.id)).filter(Boolean);
  const doneTs = nowSec();
  for (const acc of accounts) {
    if (acc.status === "ok") {
      state.history.record(acc.id, doneTs, acc.effectiveRemaining);
      for (const w of acc.primaryWindows ?? []) {
        if (!w.label.includes(" ")) state.history.record(`${acc.id}|${w.label}`, doneTs, w.remainingPercent);
      }
    }
  }

  state.cache.save();
  state.history.save();
  writeQuotaContract(accounts, discoveredById, state.cache, doneTs);
  state.activeAccountId = detectActiveAccountId(discovered, doneTs);
  evaluateNotifications(accounts);

  state.snapshot = buildSnapshot(accounts, doneTs);
  return state.snapshot;
}

// ============================================================================
// HTTP server (exact route parity with src-tauri/src/mobile.rs)
// ============================================================================

function legacyMobileView(snap) {
  const s = snap.settings;
  const order = s.accountOrder ?? [];
  const visible = snap.accounts
    .map((a, i) => ({ a, r: order.includes(a.id) ? order.indexOf(a.id) : order.length + i }))
    .filter(({ a }) => !isHidden(s, a.id))
    .sort((x, y) => x.r - y.r)
    .map(({ a }) => a);
  const accounts = visible.map((a) => ({
    id: a.id,
    provider: a.provider,
    name: displayName(s, a),
    plan: a.plan,
    status: a.status,
    error: a.error,
    updatedAt: a.updatedAt,
    windows: (a.primaryWindows ?? []).map((w) => ({ label: w.label, remainingPercent: w.remainingPercent, resetAt: w.resetAt })),
    extraWindows: (a.extraWindows ?? []).map((w) => ({ label: w.label, remainingPercent: w.remainingPercent, resetAt: w.resetAt })),
    forecast: s.showForecast ? (snap.forecasts?.[a.id] ?? null) : null,
    usage: s.showUsageStats ? (snap.usageToday?.[a.id] ?? null) : null,
  }));
  const avatars = {};
  for (const [id, pref] of Object.entries(s.accountPrefs ?? {})) {
    if (!isHidden(s, id) && pref?.avatar) avatars[id] = pref.avatar;
  }
  return {
    updatedAt: snap.lastRefreshedAt,
    offline: snap.offline,
    overallScore: snap.overallScore,
    usageDisplay: s.usageDisplay ?? "remaining",
    resetFormat: s.resetFormat ?? "relative",
    refreshIntervalSecs: s.refreshIntervalSecs ?? 60,
    workingThreshold: s.workingThreshold ?? 70,
    sleepingThreshold: s.sleepingThreshold ?? 20,
    picks: s.showPicks ? snap.picks : [],
    accounts,
    totalCostUsd: s.showUsageStats ? accounts.reduce((sum, a) => sum + (a.usage?.costUsd ?? 0), 0) : null,
    hidden: snap.accounts.length - visible.length,
    avatars,
  };
}

function send(res, status, contentType, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_BODY) {
        rejectBody(Object.assign(new Error("too large"), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

async function handleInvoke(cmd, args, ctx = {}) {
  const isLoopback = Boolean(ctx.isLoopback);
  const requireLoopback = () => {
    if (!isLoopback) throw Object.assign(new Error("desktop only"), { code: 403 });
  };

  if (cmd === "get_snapshot") {
    return state.snapshot ?? (await runRefresh("startup"));
  }
  if (cmd === "get_settings") {
    return state.settings;
  }
  if (cmd === "refresh_now") {
    return await runRefresh("manual");
  }
  if (cmd === "rescan_accounts") {
    return await runRefresh("discover");
  }
  if (cmd === "usage_report") {
    const period = typeof args?.period === "string" ? args.period : "week";
    return state.ledger.report(period);
  }
  if (cmd === "account_sources") {
    const out = {};
    for (const a of state.discovered) out[a.id] = shortenHome(a.filePath);
    return out;
  }
  if (cmd === "mobile_status") {
    if (state.settings.mobileEnabled === false) {
      return { url: null, error: null };
    }
    const ts = getTailscaleIp();
    const port = state.settings.mobilePort || 8765;
    return {
      url: ts ? `http://${ts}:${port}` : null,
      error: ts ? null : "找不到 Tailscale：請確認已安裝並登入 Tailscale",
    };
  }
  if (cmd === "tailscale_ip") {
    return getTailscaleIp();
  }
  if (cmd === "tailscale_state") {
    requireLoopback();
    return getTailscaleState();
  }
  if (cmd === "qr_svg") {
    requireLoopback();
    const text = String(args?.text ?? "").trim();
    if (!text) throw Object.assign(new Error("missing text"), { code: 400 });
    return await QRCode.toString(text, {
      type: "svg",
      margin: 2,
      width: 168,
      color: { dark: "#000000", light: "#ffffff" },
    });
  }
  if (cmd === "diagnostics") {
    requireLoopback();
    return buildDiagnosticsText();
  }
  if (cmd === "open_target") {
    requireLoopback();
    return openDesktopTarget(String(args?.target ?? ""));
  }
  if (cmd === "pick_folder") {
    requireLoopback();
    return pickLocalFolder();
  }
  if (cmd === "add_account_login") {
    requireLoopback();
    return launchAddAccountLogin(String(args?.provider ?? ""), String(args?.name ?? ""));
  }
  if (cmd === "test_notification") {
    requireLoopback();
    sendDesktopNotification("T3 DeskCat 測試通知", "通知功能正常運作，達到門檻時會在這裡提醒你。");
    return null;
  }
  if (cmd === "hotkey_status") {
    requireLoopback();
    return state.hotkeyError;
  }
  if (cmd === "report_hotkey_status") {
    requireLoopback();
    state.hotkeyError = typeof args?.error === "string" && args.error.trim() ? args.error.trim() : null;
    return null;
  }
  if (cmd === "set_panel_pinned") {
    requireLoopback();
    const pinned = Boolean(args?.pinned);
    state.settings = { ...state.settings, panelPinned: pinned };
    writeJsonAtomic(SETTINGS_PATH, state.settings, true);
    if (state.snapshot) state.snapshot = buildSnapshot(state.snapshot.accounts, nowSec());
    return null;
  }
  if (cmd === "hide_panel") {
    requireLoopback();
    return null;
  }
  if (cmd === "clear_custom_images") {
    requireLoopback();
    state.settings = {
      ...state.settings,
      customImageWorking: null,
      customImageSweating: null,
      customImageSleeping: null,
    };
    writeJsonAtomic(SETTINGS_PATH, state.settings, true);
    if (state.snapshot) state.snapshot = buildSnapshot(state.snapshot.accounts, nowSec());
    return state.snapshot ?? (await runRefresh("startup"));
  }
  if (cmd === "get_activity") {
    requireLoopback();
    return { activeAccountId: state.activeAccountId };
  }
  if (cmd === "get_hud_data") {
    requireLoopback();
    const snap = state.snapshot ?? (await runRefresh("startup"));
    const now = nowSec();
    const hudPicks = computeHudPicks(snap.accounts, state.settings, snap.forecasts ?? {}, now);
    const byId = new Map(snap.accounts.map((a) => [a.id, a]));
    const items = hudPicks.map((pk) => {
      const acc = byId.get(pk.accountId);
      const plainWins = (acc?.primaryWindows ?? []).filter((w) => !w.label.includes(" ")).slice(0, 2);
      return {
        accountId: pk.accountId,
        provider: pk.provider,
        name: pk.accountName,
        effectiveRemaining: pk.effectiveRemaining,
        tag: pk.tag,
        windows: plainWins.map((w) => ({ label: w.label, remainingPercent: w.remainingPercent, resetAt: w.resetAt })),
      };
    });
    return {
      settings: state.settings,
      overallScore: snap.overallScore,
      mood: snap.mood,
      activeAccountId: state.activeAccountId,
      items,
    };
  }
  if (cmd === "update_settings") {
    const next = args?.newSettings;
    if (!next || typeof next !== "object") {
      throw Object.assign(new Error("missing newSettings"), { code: 400 });
    }
    const prevAutostart = Boolean(state.settings.launchAtStartup);
    const prevMobile = state.settings.mobileEnabled !== false;
    const merged = { ...state.settings, ...next };
    if (!isLoopback) {
      for (const k of DESKTOP_ONLY_KEYS) {
        if (Object.prototype.hasOwnProperty.call(state.settings, k)) {
          merged[k] = state.settings[k];
        }
      }
    }
    state.settings = merged;
    setPriceOverrides(merged.modelPrices);
    writeJsonAtomic(SETTINGS_PATH, merged, true);
    if (isLoopback) {
      if (Boolean(merged.launchAtStartup) !== prevAutostart) {
        syncAutostartShortcut(Boolean(merged.launchAtStartup));
      }
      if ((merged.mobileEnabled !== false) !== prevMobile) {
        syncTailscaleListener();
      }
    }
    if (state.snapshot) {
      state.snapshot = buildSnapshot(state.snapshot.accounts, nowSec());
    }
    return state.snapshot ?? (await runRefresh("startup"));
  }
  throw Object.assign(new Error("not allowed from web"), { code: 403 });
}

async function handleRequest(req, res) {
  const peer = req.socket?.remoteAddress ?? "";
  if (!isLoopbackIp(peer) && !isTailscaleIp(peer)) {
    return send(res, 403, "text/plain", "forbidden");
  }

  const pathname = (req.url ?? "/").split("?")[0];

  if (req.method === "POST") {
    if (!pathname.startsWith("/api/invoke/")) {
      return send(res, 404, "text/plain", "not found");
    }
    const cmd = decodeURIComponent(pathname.slice("/api/invoke/".length));
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return send(res, err.code === 413 ? 413 : 400, "text/plain", err.message);
    }
    let args = {};
    try {
      args = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      args = {};
    }
    try {
      const out = await handleInvoke(cmd, args, { isLoopback: isLoopbackIp(peer) });
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(out));
    } catch (err) {
      const code = [400, 403, 503].includes(err.code) ? err.code : 500;
      return send(res, code, "text/plain; charset=utf-8", err.message || "internal error");
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "text/plain", "GET or POST");
  }

  if (pathname === "/api/snapshot") {
    if (!state.snapshot) return send(res, 503, "application/json", '{"loading":true}');
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(legacyMobileView(state.snapshot)));
  }
  if (pathname === "/manifest.webmanifest") {
    return send(res, 200, "application/manifest+json", MANIFEST);
  }
  if (pathname === "/icon.png" || pathname === "/apple-touch-icon.png") {
    if (existsSync(ICON_PATH)) return send(res, 200, "image/png", readFileSync(ICON_PATH));
    return send(res, 404, "text/plain", "not found");
  }

  if (pathname === "/" || pathname === "/index.html" || pathname === "/panel.html") {
    const panelFile = join(DIST_DIR, "panel.html");
    if (existsSync(panelFile)) return send(res, 200, "text/html; charset=utf-8", readFileSync(panelFile));
    if (existsSync(FALLBACK_MOBILE_HTML)) return send(res, 200, "text/html; charset=utf-8", readFileSync(FALLBACK_MOBILE_HTML));
    return send(res, 503, "text/plain; charset=utf-8", "Run `npm run build` first.");
  }

  if (pathname === "/analytics.html" || pathname.startsWith("/assets/")) {
    const rel = pathname.replace(/^\/+/, "");
    if (rel.includes("..")) return send(res, 404, "text/plain", "not found");
    const full = resolve(DIST_DIR, rel);
    if (!full.startsWith(DIST_DIR) || !existsSync(full)) return send(res, 404, "text/plain", "not found");
    return send(res, 200, MIME[extname(full)] ?? "application/octet-stream", readFileSync(full));
  }

  return send(res, 404, "text/plain", "not found");
}

// ============================================================================
// Multi-interface listener supervisor (127.0.0.1 + Tailscale IP)
// ============================================================================

const port = Number(process.env.DESKCAT_PORT || state.settings.mobilePort || 8765);
const localServer = createServer(handleRequest);
let tsServer = null;
let boundTsIp = null;

function syncTailscaleListener() {
  const wantIp = state.settings.mobileEnabled === false ? null : getTailscaleIp();
  if (wantIp === boundTsIp) return;
  if (tsServer) {
    try { tsServer.close(); } catch {}
    tsServer = null;
    boundTsIp = null;
  }
  if (!wantIp) return;
  const srv = createServer(handleRequest);
  srv.on("error", (err) => {
    logLine(`tailscale listener (${wantIp}:${port}) error: ${err.message}`);
    if (tsServer === srv) { tsServer = null; boundTsIp = null; }
  });
  srv.listen(port, wantIp, () => {
    tsServer = srv;
    boundTsIp = wantIp;
    logLine(`listening on http://${wantIp}:${port} (Tailscale)`);
  });
}

async function main() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PID_PATH, String(process.pid), "utf8");
  logLine(`start deskcat-web v0.2.0 node=${process.version} port=${port}`);

  await new Promise((resolveListen, rejectListen) => {
    localServer.on("error", rejectListen);
    localServer.listen(port, "127.0.0.1", () => {
      logLine(`listening on http://127.0.0.1:${port} (loopback)`);
      resolveListen();
    });
  });

  syncTailscaleListener();
  await runRefresh("startup");
  logLine(`initial refresh complete: ${state.snapshot?.accounts?.length ?? 0} account(s)`);

  setInterval(() => {
    syncTailscaleListener();
    void runRefresh("scheduled").catch((e) => logLine(`scheduled refresh error: ${e.message}`));
  }, SCHEDULER_TICK_MS);
}

main().catch((err) => {
  logLine(`fatal startup error: ${err.message}`);
  process.exit(1);
});
