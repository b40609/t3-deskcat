// Quota providers — pure Node.js parity with src-tauri/src/providers/{claude,antigravity,codex}.rs.
// Strictly read-only: never writes credential files or refreshes idle T3 Antigravity tokens.

import { openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_BETA_HEADER = "oauth-2025-04-20";
const CODE_ASSIST_BASE = "https://daily-cloudcode-pa.googleapis.com";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USER_AGENT = "t3-deskcat/0.2.0";
const FETCH_TIMEOUT_MS = 20_000;
const META_CACHE_TTL_SECS = 6 * 3600;
const LOG_TAIL_BYTES = 64 * 1024;

const agMetaCache = new Map(); // id -> { projectId, plan, fetchedAt }

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
// Antigravity
// ============================================================================

async function postCodeAssist(accessToken, endpoint, payload, userAgent, now) {
  let resp;
  try {
    resp = await fetch(`${CODE_ASSIST_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "*/*",
        "User-Agent": userAgent,
        "x-goog-api-client": "gl-node/22.21.1",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { err: { kind: "other", msg: `請求 ${endpoint} 失敗: ${err.message}` } };
  }
  const retryAfter = parseRetryAfter(resp.headers, now);
  if (resp.status === 401 || resp.status === 403) {
    return { err: { kind: "auth", msg: `授權被拒絕 (HTTP ${resp.status})` } };
  }
  if (resp.status === 429 || resp.status === 503) {
    return { err: { kind: "rate_limit", retryAfter, msg: `${endpoint} HTTP ${resp.status}` } };
  }
  if (!resp.ok) {
    return { err: { kind: "other", msg: `${endpoint} HTTP ${resp.status}` } };
  }
  const text = await resp.text();
  if (!text.trim()) return { ok: {} };
  try {
    return { ok: JSON.parse(text) };
  } catch (err) {
    return { err: { kind: "other", msg: `解析 ${endpoint} JSON 失敗: ${err.message}` } };
  }
}

function extractProject(load) {
  const f = load?.cloudaicompanionProject;
  if (typeof f === "string" && f.trim()) return f.trim();
  if (f && typeof f === "object") {
    const id = (typeof f.id === "string" && f.id.trim()) || (typeof f.projectId === "string" && f.projectId.trim());
    if (id) return id;
  }
  return null;
}

function extractTier(load) {
  for (const k of ["paidTier", "currentTier"]) {
    const name = load?.[k]?.name;
    if (typeof name === "string" && name.trim()) {
      const trimmed = name.trim();
      return trimmed.startsWith("Google AI ") ? trimmed.slice("Google AI ".length) : trimmed;
    }
  }
  return null;
}

function parseAntigravityGroups(raw) {
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
      const resetAt = parseRfc3339(bucket.resetTime ?? bucket.reset_time);
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

function apiErrToOutcome(err, acc, now) {
  if (err.kind === "auth") {
    agMetaCache.delete(acc.id);
    return { quota: errorAccount(acc.id, "antigravity", acc.name, now, "expired", err.msg), networkHit: true, retryAfterSecs: null };
  }
  if (err.kind === "rate_limit") {
    return { quota: errorAccount(acc.id, "antigravity", acc.name, now, "cooldown", err.msg), networkHit: true, retryAfterSecs: err.retryAfter };
  }
  return { quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", err.msg), networkHit: true, retryAfterSecs: null };
}

export async function fetchAntigravityQuota(acc) {
  const now = nowSec();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(acc.filePath, "utf8"));
  } catch (err) {
    return { quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", `無法讀取憑證: ${err.message}`), networkHit: false, retryAfterSecs: null };
  }

  const t3Token = parsed?.token && typeof parsed.token === "object" ? parsed.token : null;
  const tokenObj = t3Token ?? parsed;
  const refreshToken = typeof tokenObj?.refresh_token === "string" ? tokenObj.refresh_token.trim() : "";

  let accessToken = null;
  if (t3Token) {
    const exp = parseRfc3339(t3Token.expiry) ?? 0;
    const at = typeof t3Token.access_token === "string" ? t3Token.access_token : "";
    if (at && exp > now + 60) accessToken = at;
  } else if (acc.isLegacyGemini) {
    const exp = Number(parsed?.expiry_date ?? 0);
    const at = typeof parsed?.access_token === "string" ? parsed.access_token : "";
    if (at && exp > now * 1000 + 60_000) accessToken = at;
  }

  // Strictly match 4e9d336: never refresh lapsed T3 Antigravity tokens in background.
  if (!accessToken && t3Token) {
    const status = refreshToken ? "idle" : "expired";
    const msg = refreshToken
      ? "閒置超過 1 小時：用這個帳號跑一次對話就會恢復即時額度"
      : "缺少 Refresh Token";
    return { quota: errorAccount(acc.id, "antigravity", acc.name, now, status, msg), networkHit: false, retryAfterSecs: null };
  }

  if (!accessToken) {
    return {
      quota: errorAccount(acc.id, "antigravity", acc.name, now, "expired", "憑證已過期：請用該帳號跑一次對話自動更新"),
      networkHit: false,
      retryAfterSecs: null,
    };
  }

  let plan = null;
  let projectId = null;
  const cachedMeta = agMetaCache.get(acc.id);
  if (cachedMeta && now - cachedMeta.fetchedAt < META_CACHE_TTL_SECS) {
    plan = cachedMeta.plan;
    projectId = cachedMeta.projectId;
  } else {
    const loadRes = await postCodeAssist(
      accessToken,
      "v1internal:loadCodeAssist",
      {
        mode: "FULL_ELIGIBILITY_CHECK",
        metadata: {
          ideName: "antigravity",
          ideType: "ANTIGRAVITY",
          ideVersion: "1.20.5",
          pluginVersion: "t3-deskcat",
          platform: "WINDOWS_AMD64",
          updateChannel: "stable",
          pluginType: "GEMINI",
        },
      },
      "antigravity/1.20.5 windows/amd64 google-api-nodejs-client/10.3.0",
      now,
    );
    let loadErr = null;
    if (loadRes.err) {
      if (loadRes.err.kind === "auth" || loadRes.err.kind === "rate_limit") {
        return apiErrToOutcome(loadRes.err, acc, now);
      }
      loadErr = loadRes.err.msg;
    } else {
      plan = extractTier(loadRes.ok);
      projectId = extractProject(loadRes.ok);
    }
    if (!projectId && typeof parsed?.project_id === "string" && parsed.project_id.trim()) {
      projectId = parsed.project_id.trim();
    }
    if (!projectId) {
      return {
        quota: errorAccount(acc.id, "antigravity", acc.name, now, "error", loadErr ?? "無法取得 Antigravity Project ID"),
        networkHit: true,
        retryAfterSecs: null,
      };
    }
    agMetaCache.set(acc.id, { projectId, plan, fetchedAt: now });
  }

  const projectPayload = { project: projectId };
  const availRes = await postCodeAssist(
    accessToken,
    "v1internal:fetchAvailableModels",
    projectPayload,
    "antigravity/1.20.5 windows/amd64",
    now,
  );
  if (availRes.err) {
    if (availRes.err.kind === "other") agMetaCache.delete(acc.id);
    return apiErrToOutcome(availRes.err, acc, now);
  }

  const quotaRes = await postCodeAssist(
    accessToken,
    "v1internal:retrieveUserQuotaSummary",
    projectPayload,
    "antigravity/cli/1.4.10 windows/amd64",
    now,
  );
  if (quotaRes.err) {
    if (quotaRes.err.kind === "other") agMetaCache.delete(acc.id);
    return apiErrToOutcome(quotaRes.err, acc, now);
  }

  const { primary, extras } = parseAntigravityGroups(quotaRes.ok);
  const effective = primary.length ? Math.min(...primary.map((w) => w.remainingPercent)) : 0;
  return {
    quota: {
      id: acc.id,
      provider: "antigravity",
      name: acc.name,
      plan,
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
