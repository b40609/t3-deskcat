import { call, isRemote } from "./bridge";
import { applyI18n, locale, setLang, t } from "./i18n";
import { buildAccountLabelMap, prettyModelName } from "./modelFormat";
import type { AppSettings, Cost, DashboardSnapshot, Price, ProviderKind, ReportRow, UsageReport } from "./types";

/**
 * Usage analytics: equivalent API cost and tokens over 24 h / 7 / 30 / 90 days,
 * stacked by account (or by model when one account is picked), split by token
 * type and by model, with editable model prices. Runs in the desktop analytics
 * window and on the phone page.
 */

type Metric = "cost" | "tokens";
type Period = UsageReport["period"];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let metric: Metric = "cost";
let period: Period = "week";
let account = ""; // "" = all
let report: UsageReport | null = null;
let settings: AppSettings | null = null;
let names: Record<string, { name: string; provider: ProviderKind }> = {};
let accountLabels: Record<string, string> = {};

// ------------------------------------------------------------------ format

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function money(v: number): string {
  const digits = v >= 1000 ? 0 : v >= 100 ? 1 : 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}

function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

const fmt = (v: number) => (metric === "cost" ? money(v) : tokens(v));
const pct = (v: number) => `${(v * 100).toFixed(v >= 0.1 ? 0 : 1)}%`;

function slotLabel(ts: number, long = false): string {
  const d = new Date(ts * 1000);
  if (report?.slot === "hour") {
    return long
      ? d.toLocaleString(locale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : `${d.getHours()}`;
  }
  return d.toLocaleDateString(locale(), long ? { month: "short", day: "numeric", weekday: "short" } : { month: "numeric", day: "numeric" });
}

// ------------------------------------------------------------------ data

const costTotal = (c: Cost | null) => (c ? c.input + c.output + c.cacheRead + c.cacheWrite : 0);
const tokTotal = (r: ReportRow) => r.input + r.output + r.cacheRead + r.cacheWrite;
const value = (r: ReportRow) => (metric === "cost" ? costTotal(r.cost) : tokTotal(r));

function rows(): ReportRow[] {
  return (report?.rows ?? []).filter((r) => !account || r.accountId === account);
}

function nameOf(id: string): string {
  return accountLabels[id] ?? names[id]?.name ?? id.replace(/^[a-z]+:/, "");
}

function slots(): number[] {
  if (!report) return [];
  const out: number[] = [];
  if (report.slot === "hour") {
    for (let t = report.from; t <= report.to; t += 3600) out.push(t);
  } else {
    const d = new Date(report.from * 1000);
    while (d.getTime() / 1000 <= report.to) {
      out.push(Math.floor(d.getTime() / 1000));
      d.setDate(d.getDate() + 1); // local days, DST-safe
    }
  }
  return out;
}

/** Series to stack: accounts, or models when a single account is shown. */
function seriesKey(r: ReportRow): string {
  return account ? r.model || "?" : r.accountId;
}

function seriesLabel(k: string): string {
  return account ? prettyModelName(k) : nameOf(k);
}

// Colours: each provider keeps its own hue; accounts of one provider step in
// lightness so they read as one family. Models get neutral-to-accent steps.
const FAMILY: Record<ProviderKind, [number, number]> = { claude: [18, 62], codex: [158, 48], antigravity: [220, 62] };

function colours(keys: string[]): Record<string, string> {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light"
    || document.documentElement.dataset.theme === "dark";
  const out: Record<string, string> = {};
  if (account) {
    keys.forEach((k, i) => {
      const l = dark ? 72 - i * 11 : 38 + i * 11;
      out[k] = i === 0 ? "var(--accent)" : `hsl(210 12% ${Math.max(18, Math.min(82, l))}%)`;
    });
    return out;
  }
  const seen: Record<string, number> = {};
  for (const k of keys) {
    const p = names[k]?.provider ?? (k.startsWith("codex") ? "codex" : k.startsWith("ag:") || k.startsWith("antigravity") ? "antigravity" : "claude");
    const i = (seen[p] = (seen[p] ?? -1) + 1);
    const [h, s] = FAMILY[p];
    const l = dark ? 68 - i * 16 : 40 + i * 16;
    out[k] = `hsl(${h + i * 8} ${s - i * 6}% ${Math.max(24, Math.min(84, l))}%)`;
  }
  return out;
}

// ------------------------------------------------------------------ render

function renderKpis(list: ReportRow[]) {
  const cost = list.reduce((a, r) => a + costTotal(r.cost), 0);
  const tok = list.reduce((a, r) => a + tokTotal(r), 0);
  const req = list.reduce((a, r) => a + r.requests, 0);
  const read = list.reduce((a, r) => a + r.cacheRead, 0);
  const inputSide = list.reduce((a, r) => a + r.input + r.cacheRead + r.cacheWrite, 0);
  const saved = list.reduce((a, r) => a + (r.cost?.cacheSavings ?? 0), 0);
  const days = Math.max(1, slots().length / (report?.slot === "hour" ? 24 : 1));
  const items =
    metric === "cost"
      ? [
          [t("費用"), money(cost), report?.slot === "hour" ? t("過去 24 小時") : t("平均每天 {v}", { v: money(cost / days) })],
          [t("Token"), tokens(tok), t("{n} 次請求", { n: req.toLocaleString(locale()) })],
          [t("快取命中率"), inputSide ? pct(read / inputSide) : "—", t("輸入中由快取讀取的比例")],
          [t("快取省下"), money(saved), t("和全部當一般輸入相比")],
        ]
      : [
          [t("Token"), tokens(tok), report?.slot === "hour" ? t("過去 24 小時") : t("平均每天 {v}", { v: tokens(tok / days) })],
          [t("請求"), req.toLocaleString(locale()), t("平均每次 {v}", { v: tokens(req ? tok / req : 0) })],
          [t("快取命中率"), inputSide ? pct(read / inputSide) : "—", t("輸入中由快取讀取的比例")],
          [t("輸出"), tokens(list.reduce((a, r) => a + r.output, 0)), t("模型產生的 Token")],
        ];
  $("kpis").innerHTML = items
    .map(([l, v, s]) => `<div class="kpi"><span class="kpi-l">${esc(l)}</span><b class="kpi-v">${esc(v)}</b><span class="kpi-s">${esc(s)}</span></div>`)
    .join("");
}

interface Stacked {
  slots: number[];
  keys: string[];
  grid: number[][]; // [slot][key]
  totals: number[];
  colour: Record<string, string>;
}

function stacked(list: ReportRow[]): Stacked {
  const ss = slots();
  const index = new Map(ss.map((s, i) => [s, i]));
  const byKey: Record<string, number> = {};
  for (const r of list) byKey[seriesKey(r)] = (byKey[seriesKey(r)] ?? 0) + value(r);
  const keys = Object.keys(byKey).filter((k) => byKey[k] > 0).sort((a, b) => byKey[b] - byKey[a]);
  const grid = ss.map(() => keys.map(() => 0));
  for (const r of list) {
    const i = index.get(r.t) ?? nearest(ss, r.t);
    const k = keys.indexOf(seriesKey(r));
    if (i >= 0 && k >= 0) grid[i][k] += value(r);
  }
  return { slots: ss, keys, grid, totals: grid.map((g) => g.reduce((a, b) => a + b, 0)), colour: colours(keys) };
}

function nearest(ss: number[], ts: number): number {
  for (let i = ss.length - 1; i >= 0; i--) if (ss[i] <= ts) return i;
  return -1;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

let current: Stacked | null = null;

function renderChart(list: ReportRow[]) {
  const st = (current = stacked(list));
  const el = $("chart");
  const W = Math.max(280, el.clientWidth);
  const H = W < 560 ? 200 : 260;
  const padL = 52, padR = 8, padT = 10, padB = 24;
  const max = niceMax(Math.max(...st.totals, 0));
  const n = st.slots.length || 1;
  const bw = (W - padL - padR) / n;
  const gap = Math.min(6, bw * 0.28);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = Math.round(y(v)) + 0.5;
    svg += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/>`;
    svg += `<text class="axis" x="${padL - 8}" y="${yy + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  const every = Math.ceil(n / Math.max(4, Math.floor((W - padL) / 56)));
  st.slots.forEach((s, i) => {
    const x = padL + i * bw + gap / 2;
    let base = 0;
    st.keys.forEach((k, j) => {
      const v = st.grid[i][j];
      if (v <= 0) return;
      const y0 = y(base), y1 = y(base + v);
      svg += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${Math.max(1, bw - gap).toFixed(1)}" height="${Math.max(0.5, y0 - y1).toFixed(1)}" fill="${st.colour[k]}"/>`;
      base += v;
    });
    if (i % every === 0 || i === n - 1 && n <= 8) {
      svg += `<text class="axis" x="${(x + (bw - gap) / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(slotLabel(s))}</text>`;
    }
  });
  svg += `<rect id="hover-band" class="band" x="0" y="${padT}" width="0" height="${H - padT - padB}"/>`;
  svg += `</svg>`;
  el.innerHTML = svg;
  el.dataset.padl = String(padL);
  el.dataset.bw = String(bw);

  const total = st.totals.reduce((a, b) => a + b, 0);
  const hourly = report?.slot === "hour";
  $("chart-title").textContent =
    metric === "cost" ? (hourly ? t("每小時費用") : t("每天費用")) : hourly ? t("每小時 Token") : t("每天 Token");
  const unpriced = (report?.models ?? []).filter((m) => !m.price && list.some((r) => r.model === m.model)).length;
  $("chart-note").textContent = report?.backfilling
    ? t("正在讀取較早的紀錄，數字會再增加")
    : metric === "cost" && unpriced
      ? t("{n} 個模型未定價，費用不含它們", { n: unpriced })
      : "";
  $("legend").innerHTML = st.keys
    .map((k, j) => {
      const v = st.grid.reduce((a, g) => a + g[j], 0);
      return `<li><i style="background:${st.colour[k]}"></i><span class="lg-n">${esc(seriesLabel(k))}</span><span class="lg-v">${esc(fmt(v))}</span><span class="lg-p">${total ? pct(v / total) : ""}</span></li>`;
    })
    .join("") || `<li class="empty">${esc(t("這段時間沒有用量"))}</li>`;
}

function onHover(ev: PointerEvent) {
  const st = current;
  const el = $("chart");
  const tip = $("tip");
  if (!st || !st.slots.length) return;
  const rect = el.getBoundingClientRect();
  const padL = Number(el.dataset.padl), bw = Number(el.dataset.bw);
  const i = Math.floor((ev.clientX - rect.left - padL) / bw);
  if (i < 0 || i >= st.slots.length) return hideTip();
  const band = el.querySelector<SVGRectElement>("#hover-band");
  band?.setAttribute("x", String(padL + i * bw));
  band?.setAttribute("width", String(bw));
  const lines = st.keys
    .map((k, j) => [k, st.grid[i][j]] as const)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `<div class="tip-row"><i style="background:${st.colour[k]}"></i><span>${esc(seriesLabel(k))}</span><b>${esc(fmt(v))}</b></div>`)
    .join("");
  tip.innerHTML = `<div class="tip-h">${esc(slotLabel(st.slots[i], true))}<b>${esc(fmt(st.totals[i]))}</b></div>${lines || `<div class="muted">${esc(t("沒有用量"))}</div>`}`;
  tip.hidden = false;
  const card = el.parentElement!.getBoundingClientRect();
  const x = rect.left - card.left + padL + (i + 0.5) * bw;
  const w = tip.offsetWidth;
  tip.style.left = `${Math.max(8, Math.min(card.width - w - 8, x + 12 > card.width - w - 8 ? x - w - 12 : x + 12))}px`;
  tip.style.top = `${rect.top - card.top + 8}px`;
}

function hideTip() {
  $("tip").hidden = true;
  $("chart").querySelector("#hover-band")?.setAttribute("width", "0");
}

function renderTypes(list: ReportRow[]) {
  const sum = (f: (r: ReportRow) => number) => list.reduce((a, r) => a + f(r), 0);
  const parts =
    metric === "cost"
      ? [
          [t("輸入"), sum((r) => r.cost?.input ?? 0)],
          [t("輸出"), sum((r) => r.cost?.output ?? 0)],
          [t("快取讀取"), sum((r) => r.cost?.cacheRead ?? 0)],
          [t("快取寫入"), sum((r) => r.cost?.cacheWrite ?? 0)],
        ]
      : [
          [t("輸入"), sum((r) => r.input)],
          [t("輸出"), sum((r) => r.output)],
          [t("快取讀取"), sum((r) => r.cacheRead)],
          [t("快取寫入"), sum((r) => r.cacheWrite)],
        ];
  const total = parts.reduce((a, [, v]) => a + (v as number), 0);
  const shade = ["var(--accent)", "var(--ink)", "var(--label-3)", "var(--track-strong)"];
  $("type-stack").innerHTML = total
    ? parts.map(([, v], i) => `<span style="width:${((v as number) / total) * 100}%;background:${shade[i]}"></span>`).join("")
    : "";
  $("by-type").innerHTML = parts
    .map(([l, v], i) => `<li><i style="background:${shade[i]}"></i><span class="rk-n">${esc(l as string)}</span><span class="rk-v">${esc(fmt(v as number))}</span><span class="rk-p">${total ? pct((v as number) / total) : ""}</span></li>`)
    .join("");
}

function renderModels(list: ReportRow[]) {
  const by: Record<string, number> = {};
  for (const r of list) by[r.model || "?"] = (by[r.model || "?"] ?? 0) + value(r);
  const entries = Object.entries(by).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const top = entries[0]?.[1] ?? 0;
  $("by-model").innerHTML = entries.length
    ? entries
        .map(([m, v], i) => `<li class="bar-row"><span class="rk-n" title="${esc(m)}">${esc(prettyModelName(m))}</span><span class="rk-v">${esc(fmt(v))}</span><span class="rk-bar"><span style="width:${(v / top) * 100}%" class="${i === 0 ? "lead" : ""}"></span></span></li>`)
        .join("")
    : `<li class="empty">${esc(t("這段時間沒有用量"))}</li>`;
}

function renderPrices() {
  const models = report?.models ?? [];
  if (!models.length) {
    $("prices").innerHTML = `<p class="empty">${esc(t("還沒有用到任何模型"))}</p>`;
    return;
  }
  const head = [t("模型"), t("輸入"), t("輸出"), t("快取讀取"), t("快取寫入"), ""];
  const num = (v: number | undefined) => (v == null ? "" : String(+v.toFixed(4)));
  $("prices").innerHTML =
    `<div class="price-row head">${head.map((h) => `<span>${esc(h)}</span>`).join("")}</div>` +
    models
      .map((m) => {
        const p = m.price;
        const state = m.custom ? t("自訂") : p ? t("牌價") : t("未定價");
        return `<div class="price-row${p ? "" : " unpriced"}" data-model="${esc(m.model)}">
          <span class="pm" title="${esc(m.model || "?")}">${esc(prettyModelName(m.model || "?"))}</span>
          ${(["input", "output", "cacheRead", "cacheWrite"] as (keyof Price)[])
            .map((k) => `<input class="num" inputmode="decimal" data-k="${k}" value="${num(p?.[k])}" placeholder="${esc(head[["input", "output", "cacheRead", "cacheWrite"].indexOf(k) + 1])}" aria-label="${esc(head[["input", "output", "cacheRead", "cacheWrite"].indexOf(k) + 1])}">`)
            .join("")}
          <span class="pstate">${m.custom ? `<button class="link" data-reset>${esc(t("還原"))}</button>` : esc(state)}</span>
        </div>`;
      })
      .join("");
}

async function savePrice(row: HTMLElement) {
  if (!settings) settings = await call<AppSettings>("get_settings");
  const model = row.dataset.model!;
  const vals = Object.fromEntries(
    Array.from(row.querySelectorAll<HTMLInputElement>("input[data-k]")).map((i) => [i.dataset.k!, parseFloat(i.value)]),
  ) as unknown as Price;
  if (![vals.input, vals.output].every((v) => Number.isFinite(v) && v >= 0)) return;
  if (!Number.isFinite(vals.cacheRead) || vals.cacheRead < 0) vals.cacheRead = vals.input * 0.1;
  if (!Number.isFinite(vals.cacheWrite) || vals.cacheWrite < 0) vals.cacheWrite = vals.input * 1.25;
  await commitPrices({ ...(settings.modelPrices ?? {}), [model]: vals });
}

async function commitPrices(modelPrices: Record<string, Price>) {
  const latest = await call<AppSettings>("get_settings").catch(() => settings);
  if (!latest) return;
  settings = { ...latest, modelPrices };
  await call("update_settings", { newSettings: settings });
  await load();
}

function render() {
  const list = rows();
  renderKpis(list);
  renderChart(list);
  renderTypes(list);
  renderModels(list);
  renderPrices();
  const upd = new Date().toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  $("status").textContent = t("更新 {time}", { time: upd });
}

function fillAccounts() {
  const sel = $<HTMLSelectElement>("sel-account");
  const ids = Array.from(new Set((report?.rows ?? []).map((r) => r.accountId)));
  sel.innerHTML =
    `<option value="">${esc(t("所有帳號"))}</option>` +
    ids.map((id) => `<option value="${esc(id)}">${esc(nameOf(id))}</option>`).join("");
  if (account && !ids.includes(account)) account = "";
  sel.value = account;
}

async function load() {
  try {
    report = await call<UsageReport>("usage_report", { period });
    fillAccounts();
    render();
  } catch (e) {
    $("status").textContent = t("讀不到用量：{err}", { err: String((e as Error)?.message ?? e) });
  }
}

function applyTheme(s: AppSettings) {
  const root = document.documentElement;
  if (!s.appearance || s.appearance === "system") delete root.dataset.theme;
  else root.dataset.theme = s.appearance;
}

function bindSegmented(id: string, onPick: (v: string) => void) {
  const seg = $(id);
  const btns = Array.from(seg.querySelectorAll<HTMLButtonElement>(".seg-btn"));
  const mark = (b: HTMLButtonElement) => {
    btns.forEach((x) => x.classList.toggle("active", x === b));
    seg.style.setProperty("--i", String(btns.indexOf(b)));
  };
  mark(btns.find((b) => b.classList.contains("active")) ?? btns[0]);
  btns.forEach((b) => b.addEventListener("click", () => { mark(b); onPick(b.dataset.v!); }));
}

async function init() {
  setLang(null);
  try {
    settings = await call<AppSettings>("get_settings");
    setLang(settings.language);
    applyTheme(settings);
    const snap = await call<DashboardSnapshot | null>("get_snapshot");
    for (const a of snap?.accounts ?? []) {
      names[a.id] = { name: settings.accountPrefs?.[a.id]?.alias?.trim() || a.name, provider: a.provider };
    }
    accountLabels = buildAccountLabelMap(names);
  } catch {
    /* show what we can */
  }
  applyI18n();
  document.title = t("用量分析");
  $("lnk-back").hidden = !isRemote;
  bindSegmented("seg-metric", (v) => { metric = v as Metric; render(); });
  bindSegmented("seg-period", (v) => { period = v as Period; load(); });
  $<HTMLSelectElement>("sel-account").addEventListener("change", (e) => {
    account = (e.target as HTMLSelectElement).value;
    render();
  });
  const chart = $("chart");
  chart.addEventListener("pointermove", onHover);
  chart.addEventListener("pointerleave", hideTip);
  $("prices").addEventListener("change", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".price-row");
    if (row) savePrice(row).catch(() => {});
  });
  $("prices").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-reset]");
    const row = btn?.closest<HTMLElement>(".price-row");
    if (!row || !settings) return;
    const next = { ...(settings.modelPrices ?? {}) };
    delete next[row.dataset.model!];
    commitPrices(next).catch(() => {});
  });
  let rt = 0;
  new ResizeObserver(() => {
    clearTimeout(rt);
    rt = window.setTimeout(() => report && renderChart(rows()), 60);
  }).observe(chart);
  await load();
  // Keep fresh; faster while older logs are still being read.
  const tick = () => {
    if (!document.hidden) load();
    window.setTimeout(tick, report?.backfilling ? 4000 : 60000);
  };
  window.setTimeout(tick, report?.backfilling ? 4000 : 60000);
}

init();
