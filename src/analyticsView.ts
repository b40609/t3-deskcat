import { call } from "./bridge";
import { locale, t } from "./i18n";
import type { AppSettings, Cost, DashboardSnapshot, Price, ProviderKind, ReportRow, UsageReport } from "./types";

/**
 * Embedded usage analytics controller inside the main panel's "Usage" tab.
 * Works identically on desktop (Tauri IPC) and phone (HTTP bridge).
 */

type Metric = "cost" | "tokens";
type Period = UsageReport["period"];

export interface AnalyticsViewOptions {
  onSettingsSaved?: (snap: DashboardSnapshot) => void;
}

export interface AnalyticsViewController {
  activate(): void;
  deactivate(): void;
  refresh(): Promise<void>;
  syncContext(snap: DashboardSnapshot | null, settings: AppSettings | null): void;
  retranslate(): void;
}

const FAMILY: Record<ProviderKind, [number, number]> = {
  claude: [18, 62],
  codex: [158, 48],
  antigravity: [220, 62],
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function money(v: number): string {
  const digits = v >= 1000 ? 0 : v >= 100 ? 1 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

const pct = (v: number) => `${(v * 100).toFixed(v >= 0.1 ? 0 : 1)}%`;
const costTotal = (c: Cost | null) => (c ? c.input + c.output + c.cacheRead + c.cacheWrite : 0);
const tokTotal = (r: ReportRow) => r.input + r.output + r.cacheRead + r.cacheWrite;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

function nearest(ss: number[], ts: number): number {
  for (let i = ss.length - 1; i >= 0; i--) if (ss[i] <= ts) return i;
  return -1;
}

interface Stacked {
  slots: number[];
  keys: string[];
  grid: number[][];
  totals: number[];
  colour: Record<string, string>;
}

export function createAnalyticsView(opts: AnalyticsViewOptions = {}): AnalyticsViewController {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

  const segMetric = $("an-seg-metric");
  const segPeriod = $("an-seg-period");
  const selAccount = $<HTMLSelectElement>("an-sel-account");
  const kpisEl = $("an-kpis");
  const chartTitleEl = $("an-chart-title");
  const chartNoteEl = $("an-chart-note");
  const chartEl = $("an-chart");
  const tipEl = $("an-tip");
  const legendEl = $("an-legend");
  const typeStackEl = $("an-type-stack");
  const byTypeEl = $("an-by-type");
  const byModelEl = $("an-by-model");
  const pricesMetaEl = $("an-prices-meta");
  const pricesEl = $("an-prices");

  let active = false;
  let metric: Metric = "cost";
  let period: Period = "week";
  let account = "";
  let report: UsageReport | null = null;
  let settings: AppSettings | null = null;
  let names: Record<string, { name: string; provider: ProviderKind }> = {};
  let current: Stacked | null = null;
  let pollTimer: number | undefined;
  let loadSeq = 0;

  const fmt = (v: number) => (metric === "cost" ? money(v) : tokens(v));
  const value = (r: ReportRow) => (metric === "cost" ? costTotal(r.cost) : tokTotal(r));

  function rows(): ReportRow[] {
    return (report?.rows ?? []).filter((r) => !account || r.accountId === account);
  }

  function nameOf(id: string): string {
    return names[id]?.name ?? id.replace(/^[a-z]+:/, "");
  }

  function slotLabel(ts: number, long = false): string {
    const d = new Date(ts * 1000);
    if (report?.slot === "hour") {
      return long
        ? d.toLocaleString(locale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : `${d.getHours()}`;
    }
    return d.toLocaleDateString(
      locale(),
      long ? { month: "short", day: "numeric", weekday: "short" } : { month: "numeric", day: "numeric" },
    );
  }

  function slots(): number[] {
    if (!report) return [];
    const out: number[] = [];
    if (report.slot === "hour") {
      for (let ts = report.from; ts <= report.to; ts += 3600) out.push(ts);
    } else {
      const d = new Date(report.from * 1000);
      while (d.getTime() / 1000 <= report.to) {
        out.push(Math.floor(d.getTime() / 1000));
        d.setDate(d.getDate() + 1);
      }
    }
    return out;
  }

  function seriesKey(r: ReportRow): string {
    return account ? r.model || "?" : r.accountId;
  }

  function seriesLabel(k: string): string {
    return account ? k.replace(/^claude-/, "") : nameOf(k);
  }

  function colours(keys: string[]): Record<string, string> {
    const dark =
      (matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light") ||
      document.documentElement.dataset.theme === "dark";
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
      const p =
        names[k]?.provider ??
        (k.startsWith("codex") ? "codex" : k.startsWith("ag:") || k.startsWith("antigravity") ? "antigravity" : "claude");
      const i = (seen[p] = (seen[p] ?? -1) + 1);
      const [h, s] = FAMILY[p];
      const l = dark ? 68 - i * 16 : 40 + i * 16;
      out[k] = `hsl(${h + i * 8} ${s - i * 6}% ${Math.max(24, Math.min(84, l))}%)`;
    }
    return out;
  }

  function stacked(list: ReportRow[]): Stacked {
    const ss = slots();
    const index = new Map(ss.map((s, i) => [s, i]));
    const byKey: Record<string, number> = {};
    for (const r of list) byKey[seriesKey(r)] = (byKey[seriesKey(r)] ?? 0) + value(r);
    const keys = Object.keys(byKey)
      .filter((k) => byKey[k] > 0)
      .sort((a, b) => byKey[b] - byKey[a]);
    const grid = ss.map(() => keys.map(() => 0));
    for (const r of list) {
      const i = index.get(r.t) ?? nearest(ss, r.t);
      const k = keys.indexOf(seriesKey(r));
      if (i >= 0 && k >= 0) grid[i][k] += value(r);
    }
    return { slots: ss, keys, grid, totals: grid.map((g) => g.reduce((a, b) => a + b, 0)), colour: colours(keys) };
  }

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
    kpisEl.innerHTML = items
      .map(
        ([l, v, s]) =>
          `<div class="an-kpi"><span class="an-kpi-l">${esc(l)}</span><b class="an-kpi-v">${esc(v)}</b><span class="an-kpi-s" title="${esc(s)}">${esc(s)}</span></div>`,
      )
      .join("");
  }

  function renderChart(list: ReportRow[]) {
    const st = (current = stacked(list));
    const W = Math.max(260, chartEl.clientWidth || 320);
    const H = 176;
    const padL = 46;
    const padR = 6;
    const padT = 8;
    const padB = 22;
    const max = niceMax(Math.max(...st.totals, 0));
    const n = st.slots.length || 1;
    const bw = (W - padL - padR) / n;
    const gap = Math.min(5, bw * 0.28);
    const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      const yy = Math.round(y(v)) + 0.5;
      svg += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/>`;
      svg += `<text class="axis" x="${padL - 6}" y="${yy + 3.5}" text-anchor="end">${esc(fmt(v))}</text>`;
    }
    const every = Math.ceil(n / Math.max(4, Math.floor((W - padL) / 52)));
    st.slots.forEach((s, i) => {
      const x = padL + i * bw + gap / 2;
      let base = 0;
      st.keys.forEach((k, j) => {
        const v = st.grid[i][j];
        if (v <= 0) return;
        const y0 = y(base);
        const y1 = y(base + v);
        svg += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${Math.max(1, bw - gap).toFixed(1)}" height="${Math.max(0.5, y0 - y1).toFixed(1)}" fill="${st.colour[k]}"/>`;
        base += v;
      });
      if (i % every === 0 || (i === n - 1 && n <= 8)) {
        svg += `<text class="axis" x="${(x + (bw - gap) / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(slotLabel(s))}</text>`;
      }
    });
    svg += `<rect id="an-hover-band" class="band" x="0" y="${padT}" width="0" height="${H - padT - padB}"/>`;
    svg += `</svg>`;
    chartEl.innerHTML = svg;
    chartEl.dataset.w = String(W);
    chartEl.dataset.padl = String(padL);
    chartEl.dataset.bw = String(bw);

    const total = st.totals.reduce((a, b) => a + b, 0);
    const hourly = report?.slot === "hour";
    chartTitleEl.textContent =
      metric === "cost" ? (hourly ? t("每小時費用") : t("每天費用")) : hourly ? t("每小時 Token") : t("每天 Token");
    const unpriced = (report?.models ?? []).filter((m) => !m.price && list.some((r) => r.model === m.model)).length;
    chartNoteEl.textContent = report?.backfilling
      ? t("正在讀取較早的紀錄，數字會再增加")
      : metric === "cost" && unpriced
        ? t("{n} 個未定價", { n: unpriced })
        : "";
    legendEl.innerHTML =
      st.keys
        .map((k, j) => {
          const v = st.grid.reduce((a, g) => a + g[j], 0);
          return `<li><i style="background:${st.colour[k]}"></i><span class="an-lg-n">${esc(seriesLabel(k))}</span><span class="an-lg-v">${esc(fmt(v))}</span><span class="an-lg-p">${total ? pct(v / total) : ""}</span></li>`;
        })
        .join("") || `<li class="an-empty">${esc(t("這段時間沒有用量"))}</li>`;
  }

  function hideTip() {
    tipEl.hidden = true;
    chartEl.querySelector("#an-hover-band")?.setAttribute("width", "0");
  }

  function onHover(ev: PointerEvent) {
    const st = current;
    if (!st || !st.slots.length) return;
    const rect = chartEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const W = Number(chartEl.dataset.w) || rect.width;
    const scale = W / rect.width; // Compensates for CSS zoom on `.scroll`
    const padL = Number(chartEl.dataset.padl);
    const bw = Number(chartEl.dataset.bw);
    const localX = (ev.clientX - rect.left) * scale;
    const i = Math.floor((localX - padL) / bw);
    if (i < 0 || i >= st.slots.length) return hideTip();
    const band = chartEl.querySelector<SVGRectElement>("#an-hover-band");
    band?.setAttribute("x", String(padL + i * bw));
    band?.setAttribute("width", String(bw));
    const lines = st.keys
      .map((k, j) => [k, st.grid[i][j]] as const)
      .filter(([, v]) => v > 0)
      .map(
        ([k, v]) =>
          `<div class="an-tip-row"><i style="background:${st.colour[k]}"></i><span>${esc(seriesLabel(k))}</span><b>${esc(fmt(v))}</b></div>`,
      )
      .join("");
    tipEl.innerHTML = `<div class="an-tip-h">${esc(slotLabel(st.slots[i], true))}<b>${esc(fmt(st.totals[i]))}</b></div>${lines || `<div class="an-muted">${esc(t("沒有用量"))}</div>`}`;
    tipEl.hidden = false;
    const card = chartEl.parentElement!;
    const cardW = card.clientWidth;
    const barCenterX = chartEl.offsetLeft + padL + (i + 0.5) * bw;
    const tipW = tipEl.offsetWidth;
    const left =
      barCenterX + 10 + tipW <= cardW - 6
        ? barCenterX + 10
        : Math.max(6, barCenterX - tipW - 10);
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${chartEl.offsetTop + 6}px`;
  }

  function renderTypes(list: ReportRow[]) {
    const sum = (f: (r: ReportRow) => number) => list.reduce((a, r) => a + f(r), 0);
    const parts: [string, number][] =
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
    const total = parts.reduce((a, [, v]) => a + v, 0);
    const shade = ["var(--accent)", "var(--ink)", "var(--label-3)", "var(--track-strong)"];
    typeStackEl.innerHTML = total
      ? parts.map(([, v], i) => `<span style="width:${(v / total) * 100}%;background:${shade[i]}"></span>`).join("")
      : "";
    byTypeEl.innerHTML = parts
      .map(
        ([l, v], i) =>
          `<li><i style="background:${shade[i]}"></i><span class="an-rk-n">${esc(l)}</span><span class="an-rk-v">${esc(fmt(v))}</span><span class="an-rk-p">${total ? pct(v / total) : ""}</span></li>`,
      )
      .join("");
  }

  function renderModels(list: ReportRow[]) {
    const by: Record<string, number> = {};
    for (const r of list) by[r.model || "?"] = (by[r.model || "?"] ?? 0) + value(r);
    const entries = Object.entries(by)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    const top = entries[0]?.[1] ?? 0;
    byModelEl.innerHTML = entries.length
      ? entries
          .map(
            ([m, v], i) =>
              `<li class="bar-row"><span class="an-rk-n an-mono">${esc(m)}</span><span class="an-rk-v">${esc(fmt(v))}</span><span class="an-rk-bar"><span style="width:${(v / top) * 100}%" class="${i === 0 ? "lead" : ""}"></span></span></li>`,
          )
          .join("")
      : `<li class="an-empty">${esc(t("這段時間沒有用量"))}</li>`;
  }

  function renderPrices() {
    const models = report?.models ?? [];
    const unpricedCount = models.filter((m) => !m.price).length;
    pricesMetaEl.textContent = unpricedCount > 0 ? t("{n} 個未定價", { n: unpricedCount }) : "";
    pricesMetaEl.classList.toggle("warn", unpricedCount > 0);

    if (!models.length) {
      pricesEl.innerHTML = `<p class="an-empty">${esc(t("還沒有用到任何模型"))}</p>`;
      return;
    }
    const labels: Record<keyof Price, string> = {
      input: t("輸入"),
      output: t("輸出"),
      cacheRead: t("快取讀取"),
      cacheWrite: t("快取寫入"),
    };
    const keys: (keyof Price)[] = ["input", "output", "cacheRead", "cacheWrite"];
    const num = (v: number | undefined) => (v == null ? "" : String(+v.toFixed(4)));
    pricesEl.innerHTML =
      `<p class="an-prices-hint">${esc(t("每百萬 Token 的美元價格，費用照這裡估算"))}</p>` +
      models
        .map((m) => {
          const p = m.price;
          const state = m.custom ? t("自訂") : p ? t("牌價") : t("未定價");
          return `<div class="an-price-item${p ? "" : " unpriced"}" data-model="${esc(m.model)}">
            <div class="an-price-head">
              <span class="an-mono an-pm" title="${esc(m.model || "?")}">${esc(m.model || "?")}</span>
              <span class="an-pstate">${m.custom ? `<button class="link-btn" data-reset>${esc(t("還原"))}</button>` : esc(state)}</span>
            </div>
            <div class="an-price-grid">
              ${keys
                .map(
                  (k) =>
                    `<label class="an-price-cell"><span>${esc(labels[k])}</span><input class="an-num" inputmode="decimal" data-k="${k}" value="${num(p?.[k])}" placeholder="—" /></label>`,
                )
                .join("")}
            </div>
          </div>`;
        })
        .join("");
  }

  function fillAccounts() {
    const ids = Array.from(new Set((report?.rows ?? []).map((r) => r.accountId)));
    selAccount.innerHTML =
      `<option value="">${esc(t("所有帳號"))}</option>` +
      ids.map((id) => `<option value="${esc(id)}">${esc(nameOf(id))}</option>`).join("");
    if (account && !ids.includes(account)) account = "";
    selAccount.value = account;
  }

  function render() {
    if (!report) return;
    const list = rows();
    renderKpis(list);
    renderChart(list);
    renderTypes(list);
    renderModels(list);
    renderPrices();
  }

  async function commitPrices(modelPrices: Record<string, Price>) {
    const latest = await call<AppSettings>("get_settings").catch(() => settings);
    if (!latest) return;
    settings = { ...latest, modelPrices };
    const snap = await call<DashboardSnapshot>("update_settings", { newSettings: settings });
    opts.onSettingsSaved?.(snap);
    await load();
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

  function schedulePoll() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = undefined;
    if (!active) return;
    const delay = report?.backfilling ? 4000 : 60000;
    pollTimer = window.setTimeout(() => {
      if (!active) return;
      if (!document.hidden) void load();
      else schedulePoll();
    }, delay);
  }

  async function load() {
    const seq = ++loadSeq;
    try {
      const next = await call<UsageReport>("usage_report", { period });
      if (seq !== loadSeq) return;
      report = next;
      fillAccounts();
      render();
    } catch (e) {
      if (seq !== loadSeq) return;
      chartNoteEl.textContent = t("讀不到用量：{err}", { err: String((e as Error)?.message ?? e) });
    } finally {
      schedulePoll();
    }
  }

  function bindSegmented(seg: HTMLElement, onPick: (v: string) => void) {
    const btns = Array.from(seg.querySelectorAll<HTMLButtonElement>(".seg-btn"));
    const mark = (b: HTMLButtonElement) => {
      btns.forEach((x) => x.classList.toggle("active", x === b));
      seg.style.setProperty("--n", String(btns.length));
      seg.style.setProperty("--i", String(Math.max(0, btns.indexOf(b))));
    };
    mark(btns.find((b) => b.classList.contains("active")) ?? btns[0]);
    btns.forEach((b) =>
      b.addEventListener("click", () => {
        mark(b);
        onPick(b.dataset.v!);
      }),
    );
  }

  bindSegmented(segMetric, (v) => {
    metric = v as Metric;
    render();
  });
  bindSegmented(segPeriod, (v) => {
    period = v as Period;
    void load();
  });
  selAccount.addEventListener("change", () => {
    account = selAccount.value;
    render();
  });
  chartEl.addEventListener("pointermove", onHover);
  chartEl.addEventListener("pointerleave", hideTip);
  pricesEl.addEventListener("change", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".an-price-item");
    if (row) void savePrice(row).catch(() => {});
  });
  pricesEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-reset]");
    const row = btn?.closest<HTMLElement>(".an-price-item");
    if (!row || !settings) return;
    const next = { ...(settings.modelPrices ?? {}) };
    delete next[row.dataset.model!];
    void commitPrices(next).catch(() => {});
  });

  let resizeTimer = 0;
  new ResizeObserver(() => {
    if (!active || !report) return;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => report && renderChart(rows()), 60);
  }).observe(chartEl);

  return {
    activate() {
      active = true;
      if (report) render();
      void load();
    },
    deactivate() {
      active = false;
      hideTip();
      if (pollTimer) {
        window.clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    },
    async refresh() {
      await load();
    },
    syncContext(snap, nextSettings) {
      if (nextSettings) settings = nextSettings;
      if (snap) {
        const nextNames: Record<string, { name: string; provider: ProviderKind }> = {};
        for (const a of snap.accounts) {
          nextNames[a.id] = {
            name: (settings?.accountPrefs?.[a.id]?.alias?.trim() || a.name),
            provider: a.provider,
          };
        }
        names = nextNames;
        if (active && report) {
          fillAccounts();
          render();
        }
      }
    },
    retranslate() {
      if (report) {
        fillAccounts();
        render();
      }
    },
  };
}
