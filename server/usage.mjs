// Token usage ledger & analytics report — compatible with %APPDATA%\t3-deskcat\usage-ledger.json.

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KEEP_DAYS = 92;
const HOUR = 3600;
const SEP = "\u001f";
const VERSION = 1;

const claudeP = (i, o, r) => ({ input: i, output: o, cacheRead: r, cacheWrite: i * 1.25 });
const openaiP = (i, o, r) => ({ input: i, output: o, cacheRead: r, cacheWrite: i });
const geminiP = (i, o, r) => ({ input: i, output: o, cacheRead: r, cacheWrite: i });

const PRICES = [
  ["fable-5-2", claudeP(8.0, 40.0, 0.2)],
  ["mythos-5-2", claudeP(8.0, 40.0, 0.2)],
  ["fable-5", claudeP(10.0, 50.0, 1.0)],
  ["mythos", claudeP(10.0, 50.0, 1.0)],
  ["opus-5-5", claudeP(4.0, 20.0, 0.2)],
  ["opus-5", claudeP(5.0, 25.0, 0.5)],
  ["opus-4-8", claudeP(5.0, 25.0, 0.5)],
  ["opus-4-7", claudeP(5.0, 25.0, 0.5)],
  ["opus-4-6", claudeP(5.0, 25.0, 0.5)],
  ["opus-4-5", claudeP(5.0, 25.0, 0.5)],
  ["opus", claudeP(15.0, 75.0, 1.5)],
  ["sonnet-5-5", claudeP(2.0, 10.0, 0.1)],
  ["sonnet-5", claudeP(2.0, 10.0, 0.2)],
  ["sonnet", claudeP(3.0, 15.0, 0.3)],
  ["haiku-5-5", claudeP(0.1, 0.5, 0.01)],
  ["haiku-4-5", claudeP(1.0, 5.0, 0.1)],
  ["haiku", claudeP(0.8, 4.0, 0.08)],
  ["gemini-4-neon", geminiP(3.0, 15.0, 0.15)],
  ["orchestrator-neon", geminiP(3.0, 15.0, 0.15)],
  ["gemini-4-argon", geminiP(2.0, 10.0, 0.1)],
  ["orchestrator-argon", geminiP(2.0, 10.0, 0.1)],
  ["gemini-pro-orchestrator", geminiP(3.0, 15.0, 0.15)],
  ["gemini-4-carbon", geminiP(2.0, 10.0, 0.1)],
  ["gemini-4-hydrogen", geminiP(1.5, 7.5, 0.075)],
  ["gemini-3.8-flash", geminiP(0.75, 3.75, 0.075)],
  ["gemini-flash-worker", geminiP(0.75, 3.75, 0.075)],
  ["gemini-3-pro", geminiP(2.0, 12.0, 0.2)],
  ["gemini-3-flash", geminiP(0.5, 3.0, 0.05)],
  ["gemini-2.5-pro", geminiP(1.25, 10.0, 0.125)],
  ["gemini-2.5-flash-lite", geminiP(0.1, 0.4, 0.01)],
  ["gemini-2.5-flash", geminiP(0.3, 2.5, 0.03)],
  ["gpt-5.6-terra", openaiP(2.0, 12.0, 0.2)],
];

let priceOverrides = new Map();

export function setPriceOverrides(map) {
  const next = new Map();
  if (map && typeof map === "object") {
    for (const [k, v] of Object.entries(map)) {
      if (v && typeof v === "object") {
        next.set(k.toLowerCase(), {
          input: Number(v.input ?? 0),
          output: Number(v.output ?? 0),
          cacheRead: Number(v.cacheRead ?? 0),
          cacheWrite: Number(v.cacheWrite ?? 0),
        });
      }
    }
  }
  priceOverrides = next;
}

export function priceOf(model) {
  const m = String(model ?? "").toLowerCase();
  if (priceOverrides.has(m)) return { price: priceOverrides.get(m), custom: true };
  if (!m) return null;
  if (m.includes("claude") || ["opus", "sonnet", "haiku", "fable", "mythos"].some((k) => m.includes(k))) {
    const hit = PRICES.find(([k]) => m.includes(k));
    return { price: hit ? hit[1] : claudeP(4.0, 20.0, 0.2), custom: false };
  }
  const hit = PRICES.find(([k]) => m.includes(k));
  return hit ? { price: hit[1], custom: false } : null;
}

export function costOf(model, agg) {
  const found = priceOf(model);
  if (!found) return null;
  const p = found.price;
  const M = 1_000_000;
  const i = agg.i ?? 0;
  const o = agg.o ?? 0;
  const r = agg.r ?? 0;
  const w5 = agg.w ?? 0;
  const w1 = agg.W ?? 0;
  return {
    input: (i * p.input) / M,
    output: (o * p.output) / M,
    cacheRead: (r * p.cacheRead) / M,
    cacheWrite: (w5 * p.cacheWrite + w1 * p.input * 2) / M,
    cacheSavings: (r * Math.max(0, p.input - p.cacheRead)) / M,
  };
}

function hourOf(ts) {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  const s = Math.floor(ms / 1000);
  return s - ((s % HOUR) + HOUR) % HOUR;
}

function localDayStart(tsSec) {
  const d = new Date(tsSec * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function num(obj, key) {
  const v = obj?.[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function parseClaudeLine(line) {
  if (!line.includes('"usage"')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (o?.type !== "assistant") return null;
  const hour = hourOf(o.timestamp);
  if (hour == null) return null;
  const msg = o.message;
  const usage = msg?.usage;
  if (!usage || typeof usage !== "object") return null;
  const model = typeof msg.model === "string" ? msg.model : "";
  if (model === "<synthetic>") return null;
  const id = typeof msg.id === "string" ? msg.id : "";
  const req = typeof o.requestId === "string" ? o.requestId : "";
  const key = id || req ? `${id}|${req}` : (typeof o.uuid === "string" ? o.uuid : "");
  const cwTotal = num(usage, "cache_creation_input_tokens");
  let cw5 = cwTotal;
  let cw1 = 0;
  if (usage.cache_creation && typeof usage.cache_creation === "object") {
    const e5 = num(usage.cache_creation, "ephemeral_5m_input_tokens");
    const e1 = num(usage.cache_creation, "ephemeral_1h_input_tokens");
    if (e5 + e1 > 0) { cw5 = e5; cw1 = e1; }
  }
  return {
    hour,
    model,
    dedupKey: key || null,
    agg: {
      i: num(usage, "input_tokens"),
      o: num(usage, "output_tokens"),
      r: num(usage, "cache_read_input_tokens"),
      w: cw5,
      W: cw1,
      n: 1,
    },
  };
}

function parseCodexLine(line, st) {
  if (line.includes('"turn_context"')) {
    try {
      const o = JSON.parse(line);
      if (typeof o?.payload?.model === "string") st.m = o.payload.model;
    } catch {}
    return null;
  }
  if (!line.includes("token_count")) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  const p = o?.payload;
  if (p?.type !== "token_count") return null;
  const info = p.info;
  if (!info || typeof info !== "object") return null;
  const total = num(info.total_token_usage, "total_tokens");
  if (total !== 0 && total === (st.t ?? 0)) return null;
  st.t = total;
  const hour = hourOf(o.timestamp);
  if (hour == null) return null;
  const last = info.last_token_usage;
  if (!last || typeof last !== "object") return null;
  const input = num(last, "input_tokens");
  const cached = num(last, "cached_input_tokens");
  return {
    hour,
    model: st.m ?? "",
    dedupKey: null,
    agg: {
      i: Math.max(0, input - cached),
      o: num(last, "output_tokens"),
      r: cached,
      w: num(last, "cache_write_input_tokens"),
      W: 0,
      n: 1,
    },
  };
}

function parseAntigravityLine(line, st) {
  if (!line.includes('"input_tokens"') && !line.includes('"output_tokens"')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (typeof o?.model === "string" && o.model) st.m = o.model;
  const i = num(o, "input_tokens");
  const out = num(o, "output_tokens");
  const r = num(o, "cache_read_tokens");
  const w = num(o, "cache_write_tokens");
  if (i + out + r + w === 0) return null;
  const hour = hourOf(o.created_at);
  if (hour == null) return null;
  return {
    hour,
    model: (typeof o.model === "string" && o.model) ? o.model : (st.m ?? ""),
    dedupKey: null,
    agg: { i, o: out, r, w, W: 0, n: 1 },
  };
}

function collectJsonl(dir, sinceMs, depth, out) {
  if (depth <= 0) return;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectJsonl(p, sinceMs, depth - 1, out);
    else if (e.name.endsWith(".jsonl")) {
      try {
        if (statSync(p).mtimeMs >= sinceMs) out.push(p);
      } catch {}
    }
  }
}

function collectAgTranscripts(brainDir, sinceMs, out) {
  let ents;
  try { ents = readdirSync(brainDir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const p = join(brainDir, e.name, ".system_generated", "logs", "transcript.jsonl");
    try {
      if (statSync(p).mtimeMs >= sinceMs) out.push(p);
    } catch {}
  }
}

function filesOf(src, sinceMs) {
  const out = [];
  if (src.kind === "claude") collectJsonl(join(src.configDir, "projects"), sinceMs, 6, out);
  else if (src.kind === "codex") collectJsonl(join(src.configDir, "sessions"), sinceMs, 4, out);
  else if (src.kind === "antigravity") {
    for (const bd of src.brainDirs) collectAgTranscripts(bd, sinceMs, out);
  }
  return out;
}

export class UsageLedger {
  constructor(ledgerPath) {
    this.path = ledgerPath;
    this.data = this._load();
    this.dirty = false;
    this.knownIds = [];
  }

  _load() {
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, "utf8"));
        if (parsed && parsed.version === VERSION) {
          return {
            version: VERSION,
            buckets: parsed.buckets ?? {},
            files: parsed.files ?? {},
            seen: parsed.seen ?? {},
            backfilled: Boolean(parsed.backfilled),
          };
        }
      } catch {}
    }
    return { version: VERSION, buckets: {}, files: {}, seen: {}, backfilled: true };
  }

  _save() {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), "utf8");
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch {}
  }

  _scanFile(src, filePath) {
    let size;
    try { size = statSync(filePath).size; } catch { return; }
    const existing = this.data.files[filePath];
    let st;
    if (existing && existing.a === src.accountId && existing.o === size) return;
    if (existing && existing.a === src.accountId && existing.o < size) {
      st = { a: existing.a, o: existing.o, t: existing.t ?? 0, m: existing.m ?? "" };
    } else {
      st = { a: src.accountId, o: 0, t: 0, m: "" };
    }

    const toRead = size - st.o;
    if (toRead <= 0) return;
    let chunk;
    let fd;
    try {
      fd = openSync(filePath, "r");
      const buf = Buffer.alloc(toRead);
      const bytesRead = readSync(fd, buf, 0, toRead, st.o);
      // Only consume up to the last newline so partial lines wait for next scan.
      let lastNl = buf.lastIndexOf(0x0a, bytesRead - 1);
      if (lastNl < 0) return;
      chunk = buf.subarray(0, lastNl + 1).toString("utf8");
      st.o += lastNl + 1;
    } catch {
      return;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }

    const cut = Math.floor(Date.now() / 1000) - KEEP_DAYS * 24 * HOUR;
    for (const line of chunk.split("\n")) {
      if (!line) continue;
      let rec = null;
      if (src.kind === "claude") rec = parseClaudeLine(line);
      else if (src.kind === "codex") rec = parseCodexLine(line, st);
      else if (src.kind === "antigravity") rec = parseAntigravityLine(line, st);
      if (!rec || rec.hour < cut) continue;
      if (rec.dedupKey) {
        // Stable deterministic hash key (kept as numeric string to match JSON object keys).
        const digest = createHash("sha256").update(`${src.accountId}|${rec.dedupKey}`).digest();
        const dk = String(digest.readBigUInt64BE(0));
        if (Object.prototype.hasOwnProperty.call(this.data.seen, dk)) continue;
        this.data.seen[dk] = rec.hour;
      }
      const bk = `${src.accountId}${SEP}${rec.hour}${SEP}${rec.model}`;
      const cur = this.data.buckets[bk] ?? { i: 0, o: 0, r: 0, w: 0, W: 0, n: 0 };
      cur.i += rec.agg.i;
      cur.o += rec.agg.o;
      cur.r += rec.agg.r;
      cur.w += rec.agg.w;
      cur.W = (cur.W ?? 0) + rec.agg.W;
      cur.n += rec.agg.n;
      this.data.buckets[bk] = cur;
    }
    this.data.files[filePath] = st;
    this.dirty = true;
  }

  computeToday(sources) {
    const nowSec = Math.floor(Date.now() / 1000);
    const midnightTs = localDayStart(nowSec);
    const sinceMs = Date.now() - 2 * 24 * HOUR * 1000;

    for (const src of sources) {
      for (const f of filesOf(src, sinceMs)) {
        this._scanFile(src, f);
      }
    }
    this.knownIds = sources.map((s) => s.accountId);

    const cut = nowSec - KEEP_DAYS * 24 * HOUR;
    for (const k of Object.keys(this.data.buckets)) {
      const parts = k.split(SEP);
      if (Number(parts[1]) < cut) { delete this.data.buckets[k]; this.dirty = true; }
    }
    for (const k of Object.keys(this.data.seen)) {
      if (Number(this.data.seen[k]) < cut) { delete this.data.seen[k]; this.dirty = true; }
    }
    this._save();

    const idSet = new Set(this.knownIds);
    const byAcc = new Map();
    for (const [k, a] of Object.entries(this.data.buckets)) {
      const i1 = k.indexOf(SEP);
      const i2 = k.indexOf(SEP, i1 + 1);
      if (i1 < 0 || i2 < 0) continue;
      const acc = k.slice(0, i1);
      const h = Number(k.slice(i1 + 1, i2));
      const model = k.slice(i2 + 1);
      if (h + HOUR <= midnightTs || !idSet.has(acc)) continue;
      let t = byAcc.get(acc);
      if (!t) {
        t = {
          accountId: acc,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          requests: 0,
          costUsd: null,
        };
        byAcc.set(acc, t);
      }
      const w = (a.w ?? 0) + (a.W ?? 0);
      t.inputTokens += a.i ?? 0;
      t.outputTokens += a.o ?? 0;
      t.cacheReadTokens += a.r ?? 0;
      t.cacheWriteTokens += w;
      t.totalTokens += (a.i ?? 0) + (a.o ?? 0) + (a.r ?? 0) + w;
      t.requests += a.n ?? 0;
      const c = costOf(model, a);
      if (c) t.costUsd = (t.costUsd ?? 0) + c.input + c.output + c.cacheRead + c.cacheWrite;
    }

    const result = {};
    for (const id of this.knownIds) {
      const entry = byAcc.get(id);
      if (entry && entry.requests > 0) result[id] = entry;
    }
    return result;
  }

  report(period = "week") {
    const nowSec = Math.floor(Date.now() / 1000);
    const nowDate = new Date(nowSec * 1000);
    let from;
    let slot;
    if (period === "day") {
      const cur = nowSec - (nowDate.getMinutes() * 60 + nowDate.getSeconds());
      from = cur - 23 * HOUR;
      slot = "hour";
    } else if (period === "month") {
      from = localDayStart(nowSec - 29 * 24 * HOUR);
      slot = "day";
    } else if (period === "quarter") {
      from = localDayStart(nowSec - 89 * 24 * HOUR);
      slot = "day";
    } else {
      from = localDayStart(nowSec - 6 * 24 * HOUR);
      slot = "day";
    }

    const idSet = this.knownIds.length ? new Set(this.knownIds) : null;
    const agg = new Map();
    const modelSet = new Set();

    for (const [k, a] of Object.entries(this.data.buckets)) {
      const i1 = k.indexOf(SEP);
      const i2 = k.indexOf(SEP, i1 + 1);
      if (i1 < 0 || i2 < 0) continue;
      const acc = k.slice(0, i1);
      const h = Number(k.slice(i1 + 1, i2));
      const model = k.slice(i2 + 1);
      if (h < from || (idSet && !idSet.has(acc))) continue;
      const t = slot === "hour" ? h : localDayStart(h);
      const rk = `${t}${SEP}${acc}${SEP}${model}`;
      const cur = agg.get(rk) ?? { t, accountId: acc, model, i: 0, o: 0, r: 0, w: 0, W: 0, n: 0 };
      cur.i += a.i ?? 0;
      cur.o += a.o ?? 0;
      cur.r += a.r ?? 0;
      cur.w += a.w ?? 0;
      cur.W += a.W ?? 0;
      cur.n += a.n ?? 0;
      agg.set(rk, cur);
      modelSet.add(model);
    }

    const rows = Array.from(agg.values())
      .map((a) => ({
        t: a.t,
        accountId: a.accountId,
        model: a.model,
        input: a.i,
        output: a.o,
        cacheRead: a.r,
        cacheWrite: a.w + a.W,
        requests: a.n,
        cost: costOf(a.model, a),
      }))
      .sort((a, b) => a.t - b.t || a.accountId.localeCompare(b.accountId));

    const models = Array.from(modelSet)
      .sort()
      .map((model) => {
        const p = priceOf(model);
        return { model, price: p ? p.price : null, custom: p ? p.custom : false };
      });

    return {
      period,
      from,
      to: nowSec,
      slot,
      rows,
      models,
      backfilling: false,
    };
  }
}
