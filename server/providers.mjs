// Quota providers — pure Node.js parity with src-tauri/src/providers/{claude,antigravity,codex}.rs.
// Strictly read-only: never writes credential files or refreshes idle T3 Antigravity tokens.

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, parse as parsePath } from "node:path";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_BETA_HEADER = "oauth-2025-04-20";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USER_AGENT = "t3-deskcat/0.2.0";
const FETCH_TIMEOUT_MS = 20_000;
const AGY_PROBE_TIMEOUT_MS = 30_000;
const AGY_VERSION_TIMEOUT_MS = 5_000;
const AGY_KILL_DRAIN_MS = 2_000;
const AGY_MAX_OUTPUT_BYTES = 512 * 1024;
// agy internally treats tokens within 5 min (300s) of expiry as expired (verified live on 1.5.18).
// Use 360s (300s + 60s startup/clock-skew margin) so probes never trip agy's expiryDelta.
const AGY_EXPIRY_GUARD_SECS = 360;
const AGY_MIN_VALID_RESET_TS = 946_684_800; // 2000-01-01T00:00:00Z
const AGY_MIN_ISOLATED_VERSION = [1, 5, 16];
const AGY_PROBE_DIR_PREFIX = "t3-deskcat-agy-";
const AGY_STALE_PROBE_AGE_MS = 5 * 60 * 1000;
const AGY_PRUNE_INTERVAL_SECS = 600;
const AGY_MAX_INSTALLATION_ID_BYTES = 256;
const LOG_TAIL_BYTES = 64 * 1024;

const agyVersionCache = new Map(); // fingerprint -> [maj, min, pat]
const agyLatchedModelTurn = new Set(); // fingerprint
const agyIsolationCanaryCache = new Map(); // fingerprint -> boolean (true = isolated, false = leaked)
let agyLastPruneTs = 0;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function parseRfc3339(str) {
  if (typeof str !== "string" || !str.trim()) return null;
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function parseRetryAfter(headers, now) {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const n = Number(raw.trim());
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  const dt = Date.parse(raw);
  if (Number.isFinite(dt)) return Math.max(0, Math.floor(dt / 1000) - now);
  return null;
}

function errorAccount(id, provider, name, now, status, msg, plan = null) {
  return {
    id,
    provider,
    name,
    plan,
    effectiveRemaining: 0,
    primaryWindows: [],
    extraWindows: [],
    status,
    error: msg,
    updatedAt: now,
  };
}

// ============================================================================
// Claude Code
// ============================================================================

function formatClaudePlan(raw) {
  switch (String(raw ?? "").trim().toLowerCase()) {
    case "max": return "Max";
    case "pro": return "Pro";
    case "team": return "Team";
    case "enterprise": return "Enterprise";
    default: return String(raw ?? "").trim() || null;
  }
}

function claudeWindowId(label) {
  if (label === "5h") return "5h";
  if (label === "Wk") return "weekly";
  if (label === "Wk Sonnet") return "weekly-sonnet";
  if (label === "Wk Opus") return "weekly-opus";
  return label.toLowerCase().replace(/\s+/g, "-");
}

function parseClaudeWindow(label, block) {
  if (!block || typeof block !== "object") return null;
  const used = Number(block.utilization);
  if (!Number.isFinite(used)) return null;
  const remaining = Math.max(0, Math.min(100, Math.round(100 - used)));
  return {
    id: claudeWindowId(label),
    label,
    remainingPercent: remaining,
    resetAt: parseRfc3339(block.resets_at),
  };
}

function scopedClaudeLimits(body, existing) {
  const out = [];
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  for (const l of limits) {
    const model = typeof l?.scope?.model?.display_name === "string" ? l.scope.model.display_name.trim() : "";
    if (!model) continue;
    const used = Number(l.percent);
    if (!Number.isFinite(used)) continue;
    const span = l.group === "session" ? "5h" : "Wk";
    const spanId = span === "5h" ? "5h" : "weekly";
    const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const label = `${span} ${model}`;
    if (existing.some((w) => w.label === label) || out.some((w) => w.label === label)) continue;
    out.push({
      id: `${spanId}-${slug}`,
      label,
      remainingPercent: Math.max(0, Math.min(100, Math.round(100 - used))),
      resetAt: parseRfc3339(l.resets_at),
    });
  }
  return out;
}

function buildClaudeQuota(id, name, plan, body, updatedAt) {
  const windows = [];
  const w5 = parseClaudeWindow("5h", body?.five_hour);
  if (w5) windows.push(w5);
  const wk = parseClaudeWindow("Wk", body?.seven_day);
  if (wk) windows.push(wk);
  const effective = windows.length ? Math.min(...windows.map((w) => w.remainingPercent)) : 0;

  const wSonnet = parseClaudeWindow("Wk Sonnet", body?.seven_day_sonnet);
  if (wSonnet) windows.push(wSonnet);
  const wOpus = parseClaudeWindow("Wk Opus", body?.seven_day_opus);
  if (wOpus) windows.push(wOpus);
  windows.push(...scopedClaudeLimits(body, windows));

  return {
    id,
    provider: "claude",
    name,
    plan,
    effectiveRemaining: effective,
    primaryWindows: windows,
    extraWindows: [],
    status: "ok",
    error: null,
    updatedAt,
  };
}

export function readLocalClaudeQuota(id, name, credentialsPath, minTimestamp, now) {
  const configDir = dirname(credentialsPath);
  const candidates = [join(configDir, ".claude.json")];
  if (basename(configDir) === ".claude") {
    candidates.push(join(dirname(configDir), ".claude.json"));
  }
  let plan = null;
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, "utf8"));
    if (parsed?.claudeAiOauth?.subscriptionType) {
      plan = formatClaudePlan(parsed.claudeAiOauth.subscriptionType);
    }
  } catch {}

  let best = null;
  for (const p of candidates) {
    let raw;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    if (!raw.includes("cachedUsageUtilization")) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const block = parsed?.cachedUsageUtilization;
    if (!block || typeof block !== "object") continue;
    let fetchedAt = null;
    if (typeof block.fetchedAtMs === "number") fetchedAt = Math.floor(block.fetchedAtMs / 1000);
    else if (typeof block.fetchedAt === "number") {
      fetchedAt = block.fetchedAt > 10_000_000_000 ? Math.floor(block.fetchedAt / 1000) : Math.floor(block.fetchedAt);
    } else if (typeof block.fetchedAt === "string") {
      fetchedAt = parseRfc3339(block.fetchedAt);
    }
    if (!fetchedAt || fetchedAt <= 0 || fetchedAt > now + 120) continue;
    const body = block.utilization && typeof block.utilization === "object" ? block.utilization : block;
    const q = buildClaudeQuota(id, name, plan, body, Math.min(fetchedAt, now));
    if (!q.primaryWindows.length) continue;

    let changed = false;
    for (const w of q.primaryWindows) {
      if (w.resetAt != null && w.resetAt <= now) {
        w.remainingPercent = 100;
        w.resetAt = null;
        changed = true;
      }
    }
    if (changed) {
      const main = q.primaryWindows.filter((w) => !w.label.includes(" "));
      if (main.length) q.effectiveRemaining = Math.min(...main.map((w) => w.remainingPercent));
    }
    if (q.updatedAt > minTimestamp && (!best || q.updatedAt > best.updatedAt)) {
      best = q;
    }
  }
  return best;
}

export async function fetchClaudeQuota(acc) {
  const now = nowSec();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(acc.filePath, "utf8"));
  } catch (err) {
    return { quota: errorAccount(acc.id, "claude", acc.name, now, "error", `無法讀取憑證: ${err.message}`), networkHit: false, retryAfterSecs: null };
  }
  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    return { quota: errorAccount(acc.id, "claude", acc.name, now, "expired", "尚未登入 Claude Code"), networkHit: false, retryAfterSecs: null };
  }
  const accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
  if (!accessToken) {
    return { quota: errorAccount(acc.id, "claude", acc.name, now, "expired", "缺少 Access Token"), networkHit: false, retryAfterSecs: null };
  }
  const plan = oauth.subscriptionType ? formatClaudePlan(oauth.subscriptionType) : null;
  const expiresAt = Number(oauth.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now * 1000) {
    return {
      quota: errorAccount(acc.id, "claude", acc.name, now, "expired", "憑證已過期：用這個帳號跑一次 Claude Code 就會自動更新", plan),
      networkHit: false,
      retryAfterSecs: null,
    };
  }

  let resp;
  try {
    resp = await fetch(CLAUDE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": CLAUDE_BETA_HEADER,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { quota: errorAccount(acc.id, "claude", acc.name, now, "error", `連線失敗: ${err.message}`, plan), networkHit: true, retryAfterSecs: null };
  }

  const retryAfter = parseRetryAfter(resp.headers, now);
  if (resp.status === 401 || resp.status === 403) {
    return { quota: errorAccount(acc.id, "claude", acc.name, now, "expired", "授權已過期，請在 Claude Code 重新登入", plan), networkHit: true, retryAfterSecs: null };
  }
  if (resp.status === 429 || resp.status === 503) {
    return { quota: errorAccount(acc.id, "claude", acc.name, now, "cooldown", "429 請求頻繁冷卻中", plan), networkHit: true, retryAfterSecs: retryAfter };
  }
  if (!resp.ok) {
    return { quota: errorAccount(acc.id, "claude", acc.name, now, "error", `HTTP ${resp.status}`, plan), networkHit: true, retryAfterSecs: null };
  }
  let body;
  try {
    body = await resp.json();
  } catch (err) {
    return { quota: errorAccount(acc.id, "claude", acc.name, now, "error", `解析回應失敗: ${err.message}`, plan), networkHit: true, retryAfterSecs: null };
  }
  return { quota: buildClaudeQuota(acc.id, acc.name, plan, body, now), networkHit: true, retryAfterSecs: null };
}

// ============================================================================
// Antigravity (via official `agy -p /usage` CLI inside an isolated fake home)
// Zero direct HTTP calls to Google's internal APIs and zero background refresh.
// ============================================================================

const AGY_ISOLATED_STRIPPED_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "GEMINI_HOME",
  "BROWSER",
  "ELECTRON_RUN_AS_NODE",
  "CHROME_CRASHPAD_PIPE_NAME",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY",
  "SSH_AUTH_SOCK",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
]);

const AGY_INTERACTIVE_MARKERS = [
  "authentication required",
  "please visit the url",
  "accounts.google.com/o/oauth2",
];

const AGY_SIGNED_OUT_PHRASES = [
  "not logged into antigravity",
  "not logged in",
  "not signed in",
  "not authenticated",
  "not-authenticated",
  "unauthenticated",
  "run agy login",
  "please sign in",
  "please log in",
  "sign in to antigravity",
  "no credentials",
  "authentication required",
];

function isFileSafe(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function expandTildePath(home, raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(home, trimmed.slice(2));
  return trimmed;
}

function t3PlatformDir() {
  const plat = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${plat}-${arch}`;
}

export function findAgyForT3() {
  // Match Rust: an explicit ANTIGRAVITY_CLI_PATH env var (even empty) is authoritative.
  if (Object.prototype.hasOwnProperty.call(process.env, "ANTIGRAVITY_CLI_PATH")) {
    const override = String(process.env.ANTIGRAVITY_CLI_PATH ?? "").trim();
    return override && isFileSafe(override) ? override : null;
  }
  const exeName = process.platform === "win32" ? "agy.exe" : "agy";
  const home = homedir();
  const t3Home = process.env.T3CODE_HOME?.trim()
    ? expandTildePath(home, process.env.T3CODE_HOME)
    : join(home, ".t3");

  // 1. T3 Code managed runtime
  const base = join(t3Home, "tools", "antigravity-acp", t3PlatformDir());
  const versionsDir = join(base, "versions");
  try {
    const active = JSON.parse(readFileSync(join(base, "active.json"), "utf8"));
    const rel = typeof active?.releaseId === "string" ? active.releaseId.trim() : "";
    if (rel && !rel.includes("/") && !rel.includes("\\") && rel !== "." && rel !== "..") {
      const candidate = join(versionsDir, rel, exeName);
      if (isFileSafe(candidate)) return candidate;
    }
  } catch {}
  try {
    let best = null;
    for (const ent of readdirSync(versionsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = join(versionsDir, ent.name);
      if (!isFileSafe(join(dir, ".install-complete.json"))) continue;
      const cand = join(dir, exeName);
      if (!isFileSafe(cand)) continue;
      const mtime = statSync(cand).mtimeMs;
      if (!best || mtime > best.mtime) best = { mtime, path: cand };
    }
    if (best) return best.path;
  } catch {}

  // 2. Custom binaryPath from T3 settings.json
  try {
    const settings = JSON.parse(readFileSync(join(t3Home, "userdata", "settings.json"), "utf8"));
    for (const cfg of Object.values(settings?.providerInstances ?? {})) {
      if (cfg?.driver !== "antigravity") continue;
      const bin = typeof cfg?.config?.binaryPath === "string" ? cfg.config.binaryPath.trim() : "";
      if (bin) {
        const p = expandTildePath(home, bin);
        if (isFileSafe(p)) return p;
      }
    }
  } catch {}

  // 3. Default standalone install folder
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const p = join(process.env.LOCALAPPDATA, "agy", "bin", exeName);
    if (isFileSafe(p)) return p;
  }

  // 4. PATH
  for (const dir of String(process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, exeName);
    if (isFileSafe(p)) return p;
  }
  return null;
}

function exeFingerprint(exe) {
  try {
    const st = statSync(exe);
    return `${exe}|${Math.floor(st.mtimeMs)}|${st.size}`;
  } catch {
    return exe;
  }
}

function parseSemver(raw) {
  const m = String(raw ?? "").match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function semverGte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function objectHasRefreshKey(val) {
  if (!val || typeof val !== "object") return false;
  if (Array.isArray(val)) return val.some(objectHasRefreshKey);
  for (const [k, v] of Object.entries(val)) {
    if (k.toLowerCase().includes("refresh") || objectHasRefreshKey(v)) return true;
  }
  return false;
}

/**
 * Strict allowlist reconstruction of a T3 Antigravity token JSON for read-only CLI probing.
 * Drops refresh_token, refreshToken, client_id, client_secret, and any unknown fields.
 */
export function buildReadonlyAntigravityTokenJson(parsed) {
  const srcTok = parsed?.token;
  if (!srcTok || typeof srcTok !== "object" || Array.isArray(srcTok)) {
    throw new Error("憑證 JSON 錯誤: missing token object");
  }
  const token = {};
  for (const k of ["access_token", "token_type", "expiry", "expires_in"]) {
    if (srcTok[k] !== undefined) token[k] = srcTok[k];
  }
  const out = { token };
  for (const k of ["auth_method", "id_token_email"]) {
    if (parsed[k] !== undefined) out[k] = parsed[k];
  }
  if (objectHasRefreshKey(out)) {
    throw new Error("隔離憑證安全檢查失敗：偵測到殘留 refresh 欄位");
  }
  return JSON.stringify(out);
}

// Keep alias exported for backwards compatibility with earlier test imports.
export function stripAntigravityRefreshSecrets(parsed) {
  return JSON.parse(buildReadonlyAntigravityTokenJson(parsed));
}

export function buildIsolatedAgyEnv(fakeHome, baseEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (AGY_ISOLATED_STRIPPED_KEYS.has(upper) || upper.startsWith("ANTIGRAVITY_") || upper.startsWith("AGY_")) {
      continue;
    }
    env[k] = v;
  }
  const cleanHome = fakeHome.replace(/^\\\\\?\\/, "");
  env.USERPROFILE = cleanHome;
  env.HOME = cleanHome;
  env.XDG_CONFIG_HOME = join(cleanHome, ".config");
  env.XDG_DATA_HOME = join(cleanHome, ".local", "share");
  env.XDG_CACHE_HOME = join(cleanHome, ".cache");
  env.XDG_STATE_HOME = join(cleanHome, ".local", "state");
  env.APPDATA = join(cleanHome, "AppData", "Roaming");
  env.LOCALAPPDATA = join(cleanHome, "AppData", "Local");
  if (process.platform === "win32") {
    const root = parsePath(cleanHome).root;
    if (root.length >= 2 && root[1] === ":") {
      env.HOMEDRIVE = root.slice(0, 2);
      env.HOMEPATH = cleanHome.slice(2);
    }
  }
  env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE = "1";
  env.SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return env;
}

function maybePruneStaleAgyProbeDirs(now) {
  if (now - agyLastPruneTs < AGY_PRUNE_INTERVAL_SECS) return;
  agyLastPruneTs = now;
  const base = tmpdir();
  const cutoff = Date.now() - AGY_STALE_PROBE_AGE_MS;
  try {
    for (const ent of readdirSync(base, { withFileTypes: true })) {
      if (!ent.name.startsWith(AGY_PROBE_DIR_PREFIX)) continue;
      const full = join(base, ent.name);
      try {
        if (statSync(full).mtimeMs < cutoff) {
          rmSync(full, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

function killProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    // Run taskkill /T synchronously BEFORE killing the parent so the tree PID still exists.
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 2_000,
      });
    } catch {}
  }
  try {
    child.kill("SIGKILL");
  } catch {
    try { child.kill(); } catch {}
  }
}

function createIsolatedProbeDir(tokenJson, installationIdSrc = null) {
  const root = mkdtempSync(join(tmpdir(), `${AGY_PROBE_DIR_PREFIX}${process.pid}-`));
  const homeDir = join(root, "home");
  const cliDir = join(homeDir, ".gemini", "antigravity-cli");
  const workDir = join(root, "work");
  const tokenDst = join(cliDir, "antigravity-oauth-token");
  try {
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(homeDir, "AppData", "Roaming"), { recursive: true });
    mkdirSync(join(homeDir, "AppData", "Local"), { recursive: true });
    writeFileSync(tokenDst, tokenJson, { mode: 0o600 });
    if (installationIdSrc) {
      try {
        const st = lstatSync(installationIdSrc);
        if (st.isFile() && st.size > 0 && st.size <= AGY_MAX_INSTALLATION_ID_BYTES) {
          copyFileSync(installationIdSrc, join(cliDir, "installation_id"));
        }
      } catch {}
    }
    return { root, homeDir, workDir, tokenDst };
  } catch (err) {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

function checkAgyVersion(exe, fp, env, cwd) {
  if (agyVersionCache.has(fp)) return Promise.resolve({ ok: agyVersionCache.get(fp) });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    let drainTimer = null;
    let child = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      resolve(res);
    };
    try {
      child = spawn(exe, ["--version"], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return finish({ err: `無法執行 agy：${err.message}` });
    }
    timer = setTimeout(() => {
      killProcessTree(child);
      drainTimer = setTimeout(() => {
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        finish({ err: "無法確認 agy CLI 版本，請稍後重試" });
      }, AGY_KILL_DRAIN_MS);
    }, AGY_VERSION_TIMEOUT_MS);
    child.stdout.on("data", (d) => { if (stdout.length < 4096) stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { if (stderr.length < 4096) stderr += d.toString("utf8"); });
    child.on("error", (err) => finish({ err: `無法執行 agy：${err.message}` }));
    child.on("close", (code) => {
      if (code !== 0) return finish({ err: "無法確認 agy CLI 版本，請稍後重試" });
      const ver = parseSemver(`${stdout}\n${stderr}`);
      if (!ver) return finish({ err: "無法確認 agy CLI 版本，請稍後重試" });
      agyVersionCache.set(fp, ver);
      finish({ ok: ver });
    });
  });
}

function extractJsonObjects(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj);
    } catch {}
  }
  if (!out.length) {
    const start = stdout.indexOf("{");
    if (start >= 0) {
      try {
        const obj = JSON.parse(stdout.slice(start).trim());
        if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj);
      } catch {}
    }
  }
  return out;
}

function outputShowsModelTurn(stdout) {
  for (const obj of extractJsonObjects(stdout)) {
    if (typeof obj.num_turns === "number" && obj.num_turns > 0) return true;
    if (typeof obj.conversation_id === "string" && obj.conversation_id.trim().length > 0) return true;
  }
  return false;
}

function outputLooksSignedOut(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (AGY_SIGNED_OUT_PHRASES.some((p) => lower.includes(p))) return true;
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf("AGY_ERROR:");
    if (idx < 0) continue;
    try {
      const obj = JSON.parse(line.slice(idx + "AGY_ERROR:".length).trim());
      if (String(obj?.status ?? "").toUpperCase() === "UNAUTHENTICATED" || obj?.error_code === 401) {
        return true;
      }
    } catch {}
  }
  return false;
}

function runAgyUsageSubprocess(exe, env, cwd) {
  return new Promise((resolve) => {
    const nullDev = process.platform === "win32" ? "NUL" : "/dev/null";
    let child;
    try {
      child = spawn(
        exe,
        ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s", "--log-file", nullDev],
        { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } catch (err) {
      return resolve({ spawnErr: err.message });
    }
    let stdout = "";
    let stderr = "";
    let authHit = false;
    let timedOut = false;
    let settled = false;
    let timer = null;
    let drainTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      resolve({ stdout, stderr, authHit, timedOut });
    };
    const abortWithDrain = () => {
      killProcessTree(child);
      if (!drainTimer) {
        drainTimer = setTimeout(() => {
          try { child.stdout?.destroy(); } catch {}
          try { child.stderr?.destroy(); } catch {}
          finish();
        }, AGY_KILL_DRAIN_MS);
      }
    };
    timer = setTimeout(() => {
      timedOut = true;
      abortWithDrain();
    }, AGY_PROBE_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      if (stdout.length < AGY_MAX_OUTPUT_BYTES) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < AGY_MAX_OUTPUT_BYTES) stderr += d.toString("utf8");
      if (!authHit) {
        const lower = stderr.toLowerCase();
        if (AGY_INTERACTIVE_MARKERS.some((m) => lower.includes(m))) {
          authHit = true;
          abortWithDrain();
        }
      }
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      if (!settled) {
        settled = true;
        resolve({ spawnErr: err.message });
      }
    });
    child.on("close", finish);
  });
}

function parseAntigravityGroups(raw, now = null) {
  let gemini5h = null;
  let geminiWk = null;
  const extras = [];
  const groups = Array.isArray(raw?.groups) ? raw.groups : [];
  for (const grp of groups) {
    const groupName = String(grp?.displayName ?? grp?.name ?? "").toLowerCase();
    const buckets = Array.isArray(grp?.buckets) ? grp.buckets : [];
    for (const bucket of buckets) {
      const bucketId = String(bucket?.bucketId ?? bucket?.id ?? "").toLowerCase();
      const win = String(bucket?.window ?? "");
      const isWeekly = win === "weekly" || bucketId.endsWith("weekly");
      const is5h = win === "5h" || bucketId.endsWith("5h");
      if (!isWeekly && !is5h) continue;

      let remaining = 0;
      if (!bucket.disabled) {
        const rawFrac = bucket.remainingFraction ?? bucket.remaining_fraction;
        const f = Number(rawFrac);
        if (Number.isFinite(f)) remaining = Math.max(0, Math.min(100, Math.round(f * 100)));
      }
      const windowSecs = isWeekly ? 7 * 86400 : 5 * 3600;
      let resetAt = parseRfc3339(bucket.resetTime ?? bucket.reset_time);
      if (resetAt != null && resetAt < AGY_MIN_VALID_RESET_TS) resetAt = null;
      if (resetAt != null && remaining === 100 && now != null && Math.abs(resetAt - now - windowSecs) <= 60) {
        resetAt = null;
      }
      const winTag = isWeekly ? "Wk" : "5h";
      const spanSlug = isWeekly ? "weekly" : "5h";
      const rawId = String(bucket.bucketId ?? bucket.id ?? "").trim() || null;

      if (groupName.includes("argon") || bucketId.includes("argon")) {
        extras.push({ id: rawId ?? `gemini-argon-${spanSlug}`, label: `Argon ${winTag}`, remainingPercent: remaining, resetAt });
      } else if (groupName.includes("claude") || groupName.includes("gpt") || bucketId.startsWith("3p")) {
        extras.push({ id: rawId ?? `3p-${spanSlug}`, label: `3P ${winTag}`, remainingPercent: remaining, resetAt });
      } else if (groupName.includes("gemini") || bucketId.startsWith("gemini")) {
        const w = { id: rawId ?? `gemini-${spanSlug}`, label: winTag, remainingPercent: remaining, resetAt };
        if (isWeekly) {
          if (!geminiWk) geminiWk = w;
        } else if (!gemini5h) {
          gemini5h = w;
        }
      }
    }
  }
  const primary = [];
  if (gemini5h) primary.push(gemini5h);
  if (geminiWk) primary.push(geminiWk);
  return { primary, extras };
}

function parseAgyUsageReport(stdout, now = null) {
  const objs = extractJsonObjects(stdout);
  let lastErr = stdout.includes("{") ? "agy 用量報告格式無法解析" : "agy 沒有輸出用量報告";
  for (const v of objs) {
    if (v.status === "SUCCESS") {
      const data = v?.command?.data;
      if (!data) {
        lastErr = "agy 用量報告缺少資料";
        continue;
      }
      const { primary, extras } = parseAntigravityGroups(data, now);
      if (!primary.length && !extras.length) {
        lastErr = "agy 用量報告沒有可用的額度";
        continue;
      }
      return { ok: { primary, extras } };
    }
    lastErr = String(v.error ?? v.response ?? "agy 回報失敗，請在終端機執行 agy 確認已登入").slice(0, 200);
  }
  return { err: lastErr };
}

async function cleanupProbeDir(root, tokenDst) {
  try { unlinkSync(tokenDst); } catch {}
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(root, { recursive: true, force: true });
      if (!existsSync(root)) return;
    } catch {}
    if (i < 4) await new Promise((r) => setTimeout(r, 120));
  }
}

/**
 * Pre-flight checks executed BEFORE staging any real account token:
 * 1. Model-turn billing latch check.
 * 2. Version check (>= 1.5.16).
 * 3. One-time fail-closed isolation canary check per binary fingerprint.
 */
async function ensureIsolatedAgyReady(exe, fp) {
  if (agyLatchedModelTurn.has(fp)) {
    return { err: "agy CLI 未將 /usage 視為額度查詢，已停用背景輪詢以避免扣費" };
  }
  if (agyIsolationCanaryCache.has(fp)) {
    return agyIsolationCanaryCache.get(fp)
      ? { ok: true }
      : { err: "agy 隔離自檢失敗：可能讀到系統金鑰圈，已停用隔離探測" };
  }

  const canaryJson = JSON.stringify({
    token: { access_token: "deskcat-isolation-canary", token_type: "Bearer", expiry: "2020-01-01T00:00:00Z" },
    auth_method: "oauth-personal",
  });
  let canaryDir;
  try {
    canaryDir = createIsolatedProbeDir(canaryJson, null);
  } catch (err) {
    return { err: `無法建立隔離暫存目錄：${err.message}` };
  }

  const env = buildIsolatedAgyEnv(canaryDir.homeDir);
  try {
    const verRes = await checkAgyVersion(exe, fp, env, canaryDir.workDir);
    if (verRes.err) return { err: verRes.err };
    if (!semverGte(verRes.ok, AGY_MIN_ISOLATED_VERSION)) {
      return {
        err: `agy CLI 版本過舊（需要 ${AGY_MIN_ISOLATED_VERSION.join(".")} 以上），無法安全讀取額度`,
      };
    }
    const run = await runAgyUsageSubprocess(exe, env, canaryDir.workDir);
    if (run.spawnErr) return { err: `無法執行 agy：${run.spawnErr}` };
    if (outputShowsModelTurn(run.stdout)) {
      agyLatchedModelTurn.add(fp);
      return { err: "agy CLI 未將 /usage 視為額度查詢，已停用背景輪詢以避免扣費" };
    }
    // Strict 3-state fail-closed verdict:
    // 1. Canary unexpectedly produced SUCCESS -> leaked OS keyring / external creds -> lock out permanently.
    // 2. Canary produced explicit auth rejection (not timeout) -> isolation verified -> cache true.
    // 3. Anything else (timeout, silent exit, transient error) -> do NOT cache; fail closed and retry later.
    if (parseAgyUsageReport(run.stdout, null).ok) {
      agyIsolationCanaryCache.set(fp, false);
      return { err: "agy 隔離自檢失敗：可能讀到系統金鑰圈，已停用隔離探測" };
    }
    const explicitlyRejected =
      !run.timedOut &&
      (run.authHit || outputLooksSignedOut(run.stdout) || outputLooksSignedOut(run.stderr));
    if (!explicitlyRejected) {
      return { err: "agy 隔離自檢未確認拒絕（可能逾時或無回應），稍後重試" };
    }
    agyIsolationCanaryCache.set(fp, true);
    return { ok: true };
  } finally {
    await cleanupProbeDir(canaryDir.root, canaryDir.tokenDst);
  }
}

export async function fetchAntigravityQuota(acc, exeOverride = null) {
  const now = nowSec();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(acc.filePath, "utf8"));
  } catch (err) {
    return { quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", `無法讀取憑證: ${err.message}`), networkHit: false, retryAfterSecs: null };
  }

  const t3Token = !acc.isLegacyGemini && parsed?.token && typeof parsed.token === "object" ? parsed.token : null;
  if (!t3Token) {
    return {
      quota: errorAccount(acc.id, "antigravity", acc.name, now, "expired", "舊版憑證格式已停用直連查詢，請改用新版 T3 Code 或 agy CLI 登入"),
      networkHit: false,
      retryAfterSecs: null,
    };
  }

  const refreshToken = typeof t3Token.refresh_token === "string" ? t3Token.refresh_token.trim() : "";
  const hasRefreshToken = Boolean(refreshToken);
  const accessToken = typeof t3Token.access_token === "string" ? t3Token.access_token.trim() : "";
  const exp = parseRfc3339(t3Token.expiry) ?? 0;

  // Guardrail 1: active-only expiry gate (6-minute safety buffer over agy's 5-min expiryDelta). Never refresh lapsed tokens.
  if (!accessToken || exp <= now + AGY_EXPIRY_GUARD_SECS) {
    const status = hasRefreshToken ? "idle" : "expired";
    const msg = hasRefreshToken
      ? "閒置超過 1 小時：用這個帳號跑一次對話就會恢復即時額度"
      : "缺少 Refresh Token";
    return { quota: errorAccount(acc.id, "antigravity", acc.name, now, status, msg), networkHit: false, retryAfterSecs: null };
  }

  const exe = exeOverride ?? findAgyForT3();
  if (!exe) {
    return {
      quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", "找不到 agy CLI，無法透過官方 CLI 讀取 Antigravity 額度"),
      networkHit: false,
      retryAfterSecs: null,
    };
  }

  const fp = exeFingerprint(exe);
  maybePruneStaleAgyProbeDirs(now);

  // Pre-flight BEFORE staging any real account token: latch, version >= 1.5.16, fail-closed canary.
  const ready = await ensureIsolatedAgyReady(exe, fp);
  if (ready.err) {
    return { quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", ready.err), networkHit: false, retryAfterSecs: null };
  }

  // Guardrail 1b: strict allowlist reconstruction so refresh_token can never be written.
  let sanitizedJson;
  try {
    sanitizedJson = buildReadonlyAntigravityTokenJson(parsed);
  } catch (err) {
    return { quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", err.message), networkHit: false, retryAfterSecs: null };
  }

  // Guardrail 2: stage into a clean disposable fake home directory, keeping installation_id.
  let probeDir;
  try {
    const instIdSrc = join(dirname(acc.filePath), "installation_id");
    probeDir = createIsolatedProbeDir(sanitizedJson, instIdSrc);
  } catch (err) {
    return {
      quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", `無法建立隔離暫存目錄：${err.message}`),
      networkHit: false,
      retryAfterSecs: null,
    };
  }

  const env = buildIsolatedAgyEnv(probeDir.homeDir);
  try {
    const res = await runAgyUsageSubprocess(exe, env, probeDir.workDir);
    if (res.spawnErr) {
      return { quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", `無法執行 agy：${res.spawnErr}`), networkHit: true, retryAfterSecs: null };
    }
    if (outputShowsModelTurn(res.stdout)) {
      agyLatchedModelTurn.add(fp);
      return {
        quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", "agy CLI 未將 /usage 視為額度查詢，已停用背景輪詢以避免扣費"),
        networkHit: true,
        retryAfterSecs: null,
      };
    }
    // Never mask auth rejection of a non-expired (>360s) staged token as "idle": surface as "error".
    if (res.authHit) {
      return {
        quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", "憑證未過期但 agy 未接受暫存憑證（可能為格式或隔離變更）"),
        networkHit: true,
        retryAfterSecs: null,
      };
    }
    if (res.timedOut) {
      return { quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", "agy 回應逾時"), networkHit: true, retryAfterSecs: null };
    }

    // Parse SUCCESS first so benign stderr warnings never override a valid report.
    const report = parseAgyUsageReport(res.stdout, now);
    if (report.ok) {
      const { primary, extras } = report.ok;
      const effective = primary.length ? Math.min(...primary.map((w) => w.remainingPercent)) : 0;
      return {
        quota: {
          id: acc.id,
          provider: "antigravity",
          name: acc.name,
          plan: null,
          effectiveRemaining: effective,
          primaryWindows: primary,
          extraWindows: extras,
          status: "ok",
          error: null,
          updatedAt: now,
        },
        networkHit: true,
        retryAfterSecs: null,
      };
    }

    if (outputLooksSignedOut(report.err) || outputLooksSignedOut(res.stdout) || outputLooksSignedOut(res.stderr)) {
      return {
        quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", "憑證未過期但 agy 未接受暫存憑證（可能為格式或隔離變更）"),
        networkHit: true,
        retryAfterSecs: null,
      };
    }
    const lowerErr = report.err.toLowerCase();
    if (lowerErr.includes("429") || lowerErr.includes("rate limit") || lowerErr.includes("resource_exhausted")) {
      return { quota: errorAccount(acc.id, "antigravity", acc.name, now, "cooldown", report.err), networkHit: true, retryAfterSecs: null };
    }
    return { quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", report.err), networkHit: true, retryAfterSecs: null };
  } finally {
    await cleanupProbeDir(probeDir.root, probeDir.tokenDst);
  }
}

// ============================================================================
// Codex / ChatGPT
// ============================================================================

function formatCodexPlan(raw) {
  switch (String(raw ?? "").trim().toLowerCase()) {
    case "free": return "Free";
    case "plus": return "Plus";
    case "pro": return "Pro";
    case "team": return "Team";
    default: return String(raw ?? "").trim() || null;
  }
}

function codexWindowId(label) {
  if (label === "Wk") return "weekly";
  if (label === "Mo") return "monthly";
  return label.toLowerCase();
}

function jwtExpired(token, now) {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof json?.exp === "number" && json.exp > 0 && json.exp <= now;
  } catch {
    return false;
  }
}

function parseCodexWindow(block, fallbackLabel, now, isLocal = false) {
  if (!block || typeof block !== "object") return null;
  const used = Number(block.used_percent);
  if (!Number.isFinite(used)) return null;
  let remaining = Math.max(0, Math.min(100, Math.round(100 - used)));

  let label = fallbackLabel;
  if (isLocal) {
    const mins = Number(block.window_minutes);
    if (Number.isFinite(mins) && mins > 0) {
      if (mins % 1440 === 0) {
        const d = mins / 1440;
        label = d === 7 ? "Wk" : d === 30 ? "Mo" : `${d}d`;
      } else if (mins % 60 === 0) {
        label = `${mins / 60}h`;
      }
    }
  } else {
    const secs = Number(block.limit_window_seconds);
    if (Number.isFinite(secs) && secs > 0) {
      const mins = Math.floor((secs + 59) / 60);
      if (mins % 1440 === 0) {
        const d = mins / 1440;
        label = d === 7 ? "Wk" : d === 30 ? "Mo" : `${d}d`;
      } else if (mins % 60 === 0) {
        label = `${mins / 60}h`;
      }
    }
  }

  let resetAt = null;
  const ra = Number(block.resets_at ?? block.reset_at);
  if (Number.isFinite(ra) && ra > 0) resetAt = Math.floor(ra);
  else if (!isLocal && typeof block.reset_after_seconds === "number" && block.reset_after_seconds >= 0) {
    resetAt = now + Math.floor(block.reset_after_seconds);
  }

  if (isLocal && resetAt != null && resetAt <= now) {
    remaining = 100;
    resetAt = null;
  }
  return { id: codexWindowId(label), label, remainingPercent: remaining, resetAt };
}

function readTail(filePath, maxBytes) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const size = statSync(filePath).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const str = buf.toString("utf8");
    if (start > 0) {
      const nl = str.indexOf("\n");
      return nl >= 0 ? str.slice(nl + 1) : "";
    }
    return str;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function readLocalCodexQuota(id, name, codexHome, minTimestamp, now) {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400 * 1000);
  const candidates = [];
  for (const d of [today, yesterday]) {
    const dir = join(
      codexHome,
      "sessions",
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (!ent.name.endsWith(".jsonl")) continue;
      const p = join(dir, ent.name);
      try {
        candidates.push({ mtime: statSync(p).mtimeMs, p });
      } catch {}
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  let best = null;
  for (const { p } of candidates.slice(0, 3)) {
    const lines = readTail(p, LOG_TAIL_BYTES).split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line.includes("rate_limits") || !line.includes("token_count")) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o?.type !== "event_msg" || o?.payload?.type !== "token_count") continue;
      const rl = o.payload.rate_limits;
      if (!rl || typeof rl !== "object") continue;
      const ts = parseRfc3339(o.timestamp) ?? now;
      const plan = rl.plan_type ? formatCodexPlan(rl.plan_type) : null;
      const windows = [];
      const w1 = parseCodexWindow(rl.primary, "5h", now, true);
      if (w1) windows.push(w1);
      const w2 = parseCodexWindow(rl.secondary, "Wk", now, true);
      if (w2) windows.push(w2);
      if (!windows.length) continue;
      const q = {
        id,
        provider: "codex",
        name,
        plan,
        effectiveRemaining: Math.min(...windows.map((w) => w.remainingPercent)),
        primaryWindows: windows,
        extraWindows: [],
        status: "ok",
        error: null,
        updatedAt: Math.min(ts, now),
      };
      if (q.updatedAt > minTimestamp && (!best || q.updatedAt > best.updatedAt)) {
        best = q;
      }
      break;
    }
  }
  return best;
}

export async function fetchCodexQuota(acc) {
  const now = nowSec();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(acc.filePath, "utf8"));
  } catch (err) {
    return { quota: errorAccount(acc.id, "codex", acc.name, now, "error", `無法讀取憑證: ${err.message}`), networkHit: false, retryAfterSecs: null };
  }
  const tokens = parsed?.tokens;
  if (!tokens || typeof tokens !== "object") {
    return { quota: errorAccount(acc.id, "codex", acc.name, now, "expired", "尚未登入 Codex / ChatGPT"), networkHit: false, retryAfterSecs: null };
  }
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
  if (!accessToken) {
    return { quota: errorAccount(acc.id, "codex", acc.name, now, "expired", "缺少 Access Token"), networkHit: false, retryAfterSecs: null };
  }
  if (jwtExpired(accessToken, now)) {
    return { quota: errorAccount(acc.id, "codex", acc.name, now, "expired", "授權已過期，請在 Codex 重新登入"), networkHit: false, retryAfterSecs: null };
  }
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": USER_AGENT,
  };
  if (typeof tokens.account_id === "string" && tokens.account_id.trim()) {
    headers["ChatGPT-Account-Id"] = tokens.account_id.trim();
  }

  let resp;
  try {
    resp = await fetch(CODEX_USAGE_URL, { method: "GET", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { quota: errorAccount(acc.id, "codex", acc.name, now, "error", `連線失敗: ${err.message}`), networkHit: true, retryAfterSecs: null };
  }
  const retryAfter = parseRetryAfter(resp.headers, now);
  if (resp.status === 401 || resp.status === 403) {
    return { quota: errorAccount(acc.id, "codex", acc.name, now, "expired", "授權已過期，請在 Codex 重新登入"), networkHit: true, retryAfterSecs: null };
  }
  if (resp.status === 429 || resp.status === 503) {
    return { quota: errorAccount(acc.id, "codex", acc.name, now, "cooldown", `HTTP ${resp.status}`), networkHit: true, retryAfterSecs: retryAfter };
  }
  if (!resp.ok) {
    return { quota: errorAccount(acc.id, "codex", acc.name, now, "error", `HTTP ${resp.status}`), networkHit: true, retryAfterSecs: null };
  }
  let body;
  try {
    body = await resp.json();
  } catch (err) {
    return { quota: errorAccount(acc.id, "codex", acc.name, now, "error", `解析回應失敗: ${err.message}`), networkHit: true, retryAfterSecs: null };
  }

  const plan = body?.plan_type ? formatCodexPlan(body.plan_type) : null;
  const rl = body?.rate_limit;
  const windows = [];
  const w1 = parseCodexWindow(rl?.primary_window, "5h", now, false);
  if (w1) windows.push(w1);
  const w2 = parseCodexWindow(rl?.secondary_window, "Wk", now, false);
  if (w2) windows.push(w2);
  const effective = windows.length ? Math.min(...windows.map((w) => w.remainingPercent)) : 0;
  return {
    quota: {
      id: acc.id,
      provider: "codex",
      name: acc.name,
      plan,
      effectiveRemaining: effective,
      primaryWindows: windows,
      extraWindows: [],
      status: "ok",
      error: null,
      updatedAt: now,
    },
    networkHit: true,
    retryAfterSecs: null,
  };
}
