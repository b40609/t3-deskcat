import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { renderAvatar } from "./themeRenderer";
import type {
  AccountQuota,
  AppSettings,
  CatMood,
  DashboardSnapshot,
  PetTheme,
  ProviderKind,
  ScoreMode,
} from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const shell = $("app");
const miniCanvas = $<HTMLCanvasElement>("mini-cat");
const miniCtx = miniCanvas.getContext("2d")!;
const moodBadge = $("mood-badge");
const heroScoreEl = $("hero-score");
const scoreHintEl = $("score-hint");
const ringsEl = $("rings");
const legendEl = $("legend");
const picksSection = $("picks-section");
const accountsSection = $("accounts-section");
const lastUpdatedEl = $("last-updated");

const btnRefresh = $("btn-refresh");
const btnPin = $("btn-pin");
const btnSettings = $("btn-settings");
const btnBack = $("btn-back");

const themeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".theme-btn"));
const customCard = $("custom-images-card");
const prevSlotWorking = $("prev-slot-working");
const prevSlotSweating = $("prev-slot-sweating");
const prevSlotSleeping = $("prev-slot-sleeping");
const fileWorking = $<HTMLInputElement>("file-working");
const fileSweating = $<HTMLInputElement>("file-sweating");
const fileSleeping = $<HTMLInputElement>("file-sleeping");
const btnClearCustom = $("btn-clear-custom");

const inpPetSize = $<HTMLInputElement>("inp-pet-size");
const valPetSize = $("val-pet-size");
const inpWorkTh = $<HTMLInputElement>("inp-work-th");
const valWorkTh = $("val-work-th");
const inpSleepTh = $<HTMLInputElement>("inp-sleep-th");
const valSleepTh = $("val-sleep-th");
const valSweatRange = $("val-sweat-range");
const inpNotify = $<HTMLInputElement>("inp-notify");
const inpNotifyTh = $<HTMLInputElement>("inp-notify-th");
const valNotifyTh = $("val-notify-th");
const inpRefreshSec = $<HTMLInputElement>("inp-refresh-sec");
const valRefreshSec = $("val-refresh-sec");
const inpAgExtra = $<HTMLInputElement>("inp-ag-extra");
const inpAutostart = $<HTMLInputElement>("inp-autostart");
const segControl = $("seg-score-mode");
const segButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".seg-btn"));

let currentSnapshot: DashboardSnapshot | null = null;
let currentSettings: AppSettings | null = null;
let showingSettings = false;
let pinned = false;
let miniTick = 0;

const fallbackSettings: AppSettings = {
  petSize: 64,
  workingThreshold: 70,
  sleepingThreshold: 20,
  scoreMode: "max_avg",
  refreshIntervalSecs: 120,
  notifyEnabled: true,
  notifyLowThreshold: 20,
  showAntigravityExtra: false,
  launchAtStartup: false,
  petX: null,
  petY: null,
  petTheme: "desk_cat",
};

// Header avatar: animated, but only while the panel is visible
function miniFrame() {
  requestAnimationFrame(miniFrame);
  if (document.hidden) return;
  miniTick = (miniTick + 1) % 10000;
  const mood: CatMood = currentSnapshot?.mood ?? "working";
  const settings = currentSettings ?? fallbackSettings;
  const theme = settings.petTheme ?? "hud_gauge";
  const score = currentSnapshot?.overallScore ?? 100;
  renderAvatar(miniCtx, miniCanvas.width, theme, score, mood, miniTick, settings);
}
requestAnimationFrame(miniFrame);

// ------------------------------------------------------------------ helpers

const PROVIDERS: { kind: ProviderKind; label: string; color: string }[] = [
  { kind: "claude", label: "Claude", color: "var(--claude)" },
  { kind: "antigravity", label: "Antigravity", color: "var(--ag)" },
  { kind: "codex", label: "ChatGPT", color: "var(--codex)" },
];

function providerLabel(p: ProviderKind): string {
  return PROVIDERS.find((x) => x.kind === p)?.label ?? p;
}

function providerGlyph(p: ProviderKind): string {
  if (p === "claude") return "C";
  if (p === "antigravity") return "A";
  return "G";
}

function moodLabel(m: CatMood): string {
  if (m === "working") return "元氣工作中";
  if (m === "sweating") return "緊張趕工中";
  return "額度見底，趴睡中";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getTone(pct: number): "good" | "warn" | "bad" {
  const s = currentSettings ?? fallbackSettings;
  if (pct > s.workingThreshold) return "good";
  if (pct >= s.sleepingThreshold) return "warn";
  return "bad";
}

function formatResetAt(resetAt: number | null): string {
  if (!resetAt) return "";
  const diffSec = resetAt - Math.floor(Date.now() / 1000);
  if (diffSec <= 0) return "即將重置";
  const hours = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}天${hours % 24}時後重置`;
  if (hours > 0) return `${hours}時${mins}分後重置`;
  return `${mins}分後重置`;
}

function ageLabel(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (mins < 1) return "剛剛";
  if (mins < 60) return `${mins} 分鐘前`;
  return `${Math.floor(mins / 60)} 小時前`;
}

function bestByProvider(accounts: AccountQuota[]) {
  return PROVIDERS.map((p) => {
    const accs = accounts.filter((a) => a.provider === p.kind);
    const ok = accs.filter((a) => a.status === "ok" || a.status === "stale");
    const best = ok.length ? Math.max(...ok.map((a) => a.effectiveRemaining)) : null;
    return { ...p, best, count: accs.length };
  }).filter((p) => p.count > 0);
}

// ------------------------------------------------------------------ rendering

function renderRings(accounts: AccountQuota[]) {
  const data = bestByProvider(accounts);
  const width = 11;
  const gap = 2.5;
  let html = "";
  data.forEach((p, i) => {
    const r = 60 - width / 2 - 1 - i * (width + gap);
    const c = 2 * Math.PI * r;
    const pct = Math.max(0, Math.min(100, p.best ?? 0));
    const off = pct <= 0 ? c : c * (1 - pct / 100);
    html += `<circle class="track" cx="60" cy="60" r="${r}" stroke="${p.color}" stroke-width="${width}" />`;
    html += `<circle class="arc" cx="60" cy="60" r="${r}" stroke="${p.color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" />`;
  });
  ringsEl.innerHTML = html;
  legendEl.innerHTML = data
    .map(
      (p) => `
      <div class="legend-item">
        <span class="legend-name"><i style="background:${p.color}"></i>${p.label}</span>
        <span class="legend-val">${p.best ?? "—"}${p.best !== null ? "<small>%</small>" : ""}</span>
      </div>`,
    )
    .join("");
}

function renderAccountRow(acc: AccountQuota, showExtra: boolean): string {
  const isStale = acc.status === "stale";
  const isCooldown = acc.status === "cooldown";
  const isExpired = acc.status === "expired";
  const isErr = acc.status !== "ok" && !isStale && !isCooldown;
  const tone = isErr ? "bad" : isCooldown ? "warn" : getTone(acc.effectiveRemaining);
  const plan = acc.plan ? `<span class="plan">${escapeHtml(acc.plan)}</span>` : "";

  let detail: string;
  if (isExpired) {
    detail = `<span class="status expired">授權已過期，請在 T3 重新登入</span>`;
  } else if (isErr) {
    detail = `<span class="status error">${escapeHtml(acc.error ?? "讀取失敗")}</span>`;
  } else {
    const wins = acc.primaryWindows
      .map((w) => {
        const reset = formatResetAt(w.resetAt);
        return `<span>${escapeHtml(w.label)} <b class="tone-${getTone(w.remainingPercent)}">${w.remainingPercent}%</b>${reset ? ` · ${reset}` : ""}</span>`;
      })
      .join("");
    const extra =
      showExtra && acc.extraWindows.length
        ? acc.extraWindows.map((w) => `<span>${escapeHtml(w.label)} <b>${w.remainingPercent}%</b></span>`).join("")
        : "";
    const cd = isStale
      ? `<span class="status stale">${ageLabel(acc.updatedAt)}的資料${acc.error ? ` · ${escapeHtml(acc.error)}` : ""}</span>`
      : isCooldown
        ? `<span class="status cooldown">${escapeHtml(acc.error ?? "查詢受限，稍後自動重試")}</span>`
        : "";
    detail = `<div class="windows">${wins}${extra}${cd}</div>`;
  }

  const bar = isErr || isCooldown
    ? ""
    : `<div class="bar"><span class="${tone}" style="width:${Math.max(0, Math.min(100, acc.effectiveRemaining))}%"></span></div>`;

  return `
    <div class="row acc ${isErr ? "dim" : ""}">
      <span class="p-icon ${acc.provider}">${providerGlyph(acc.provider)}</span>
      <div class="row-main">
        <div class="row-title"><span class="name" title="${escapeHtml(acc.name)}">${escapeHtml(acc.name)}</span>${plan}</div>
        ${bar}
        ${detail}
      </div>
      <span class="pct tone-${tone}">${isErr || isCooldown ? "—" : `${acc.effectiveRemaining}<small>%</small>`}</span>
    </div>`;
}

function renderDashboard(snap: DashboardSnapshot) {
  currentSnapshot = snap;
  currentSettings = snap.settings;
  syncSettingsForm(snap.settings);

  moodBadge.textContent = moodLabel(snap.mood);
  moodBadge.className = `mood-pill ${snap.mood}`;
  heroScoreEl.textContent = String(snap.overallScore);
  const modeHint = snap.settings.scoreMode === "max_avg" ? "各家最高平均" : "全部帳號平均";
  scoreHintEl.textContent = `總體剩餘 · ${modeHint}`;
  renderRings(snap.accounts);

  const secPicks = $("sec-picks");
  secPicks.classList.toggle("hidden", snap.picks.length === 0);
  picksSection.innerHTML = snap.picks
    .map(
      (pick) => `
      <div class="row">
        <span class="p-icon ${pick.provider}">${providerGlyph(pick.provider)}</span>
        <div class="row-main">
          <div class="row-title"><span class="name" title="${escapeHtml(pick.accountName)}">${escapeHtml(pick.accountName)}</span></div>
          <span class="row-sub">${providerLabel(pick.provider)} · ${escapeHtml(pick.reason)}</span>
        </div>
        <span class="pct tone-${getTone(pick.effectiveRemaining)}">${pick.effectiveRemaining}<small>%</small></span>
      </div>`,
    )
    .join("");

  const okCount = snap.accounts.filter((a) => a.status === "ok" || a.status === "stale").length;
  $("accounts-count").textContent = `${okCount}/${snap.accounts.length} 在線`;

  accountsSection.innerHTML =
    snap.accounts.length === 0
      ? `<div class="empty">尚未找到 Claude / Antigravity / ChatGPT 的登入憑證</div>`
      : snap.accounts.map((acc) => renderAccountRow(acc, snap.settings.showAntigravityExtra)).join("");

  const timeStr = new Date(snap.lastRefreshedAt * 1000).toLocaleTimeString("zh-TW", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  lastUpdatedEl.textContent = `更新於 ${timeStr} · 每 ${snap.settings.refreshIntervalSecs} 秒自動刷新`;
}

// ------------------------------------------------------------------ settings form

function paintSlider(inp: HTMLInputElement) {
  const min = Number(inp.min);
  const max = Number(inp.max);
  const pct = ((Number(inp.value) - min) / (max - min)) * 100;
  inp.style.setProperty("--p", `${pct}%`);
}

function setRangeIfIdle(inp: HTMLInputElement, value: number) {
  if (document.activeElement !== inp) inp.value = String(value);
  paintSlider(inp);
}

function slotHtml(src: string | null | undefined, fallback: string, alt: string) {
  return src ? `<img src="${src}" alt="${alt}" />` : fallback;
}

function syncSettingsForm(s: AppSettings) {
  const activeTheme = s.petTheme ?? "hud_gauge";
  themeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === activeTheme));
  customCard.classList.toggle("hidden", activeTheme !== "custom");

  prevSlotWorking.innerHTML = slotHtml(s.customImageWorking, "💻", "Working");
  prevSlotSweating.innerHTML = slotHtml(s.customImageSweating, "💦", "Sweating");
  prevSlotSleeping.innerHTML = slotHtml(s.customImageSleeping, "😴", "Sleeping");

  setRangeIfIdle(inpPetSize, s.petSize);
  valPetSize.textContent = `${s.petSize} px`;
  setRangeIfIdle(inpWorkTh, s.workingThreshold);
  valWorkTh.textContent = `${s.workingThreshold}%`;
  setRangeIfIdle(inpSleepTh, s.sleepingThreshold);
  valSleepTh.textContent = `${s.sleepingThreshold}%`;
  valSweatRange.textContent = `介於 ${s.sleepingThreshold}% ~ ${s.workingThreshold}% 時，貓會冒汗趕工。`;

  inpNotify.checked = s.notifyEnabled;
  setRangeIfIdle(inpNotifyTh, s.notifyLowThreshold);
  valNotifyTh.textContent = `${s.notifyLowThreshold}%`;
  setRangeIfIdle(inpRefreshSec, s.refreshIntervalSecs);
  valRefreshSec.textContent = `${s.refreshIntervalSecs} 秒`;

  inpAgExtra.checked = s.showAntigravityExtra;
  inpAutostart.checked = s.launchAtStartup;

  segButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === s.scoreMode));
  segControl.classList.toggle("second", s.scoreMode === "all_avg");
}

let saveTimer: number | undefined;
function commitSettings(patch: Partial<AppSettings>, immediate = false) {
  if (!currentSettings) return;
  const next: AppSettings = { ...currentSettings, ...patch };
  if (next.workingThreshold <= next.sleepingThreshold) {
    next.workingThreshold = Math.min(99, next.sleepingThreshold + 5);
  }
  currentSettings = next;
  syncSettingsForm(next);

  const send = async () => {
    try {
      const updated = await invoke<DashboardSnapshot>("update_settings", { newSettings: next });
      renderDashboard(updated);
    } catch {
      // snapshot not ready yet
    }
  };

  if (saveTimer) window.clearTimeout(saveTimer);
  if (immediate) void send();
  else saveTimer = window.setTimeout(() => void send(), 120);
}

// ------------------------------------------------------------------ events

function setSettingsVisible(show: boolean) {
  showingSettings = show;
  shell.classList.toggle("show-settings", show);
}
btnSettings.addEventListener("click", () => setSettingsVisible(!showingSettings));
btnBack.addEventListener("click", () => setSettingsVisible(false));

document.querySelectorAll<HTMLInputElement>(".slider").forEach((inp) => {
  paintSlider(inp);
  inp.addEventListener("input", () => paintSlider(inp));
});

btnPin.addEventListener("click", async () => {
  pinned = !pinned;
  btnPin.classList.toggle("active", pinned);
  await invoke("set_panel_pinned", { pinned });
});

btnRefresh.addEventListener("click", async () => {
  btnRefresh.classList.add("spinning");
  try {
    renderDashboard(await invoke<DashboardSnapshot>("refresh_now"));
  } finally {
    btnRefresh.classList.remove("spinning");
  }
});

themeButtons.forEach((btn) => {
  btn.addEventListener("click", () => commitSettings({ petTheme: btn.dataset.theme as PetTheme }, true));
});

function handleImageUpload(
  input: HTMLInputElement,
  key: "customImageWorking" | "customImageSweating" | "customImageSleeping",
) {
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => commitSettings({ [key]: reader.result as string }, true);
    reader.readAsDataURL(file);
    input.value = "";
  });
}
handleImageUpload(fileWorking, "customImageWorking");
handleImageUpload(fileSweating, "customImageSweating");
handleImageUpload(fileSleeping, "customImageSleeping");

btnClearCustom.addEventListener("click", async () => {
  try {
    renderDashboard(await invoke<DashboardSnapshot>("clear_custom_images"));
  } catch {
    commitSettings({ customImageWorking: null, customImageSweating: null, customImageSleeping: null }, true);
  }
});

inpPetSize.addEventListener("input", () => commitSettings({ petSize: Number(inpPetSize.value) }));

inpWorkTh.addEventListener("input", () => {
  const work = Number(inpWorkTh.value);
  const sleep = Math.min(Number(inpSleepTh.value), work - 5);
  commitSettings({ workingThreshold: work, sleepingThreshold: Math.max(0, sleep) });
});

inpSleepTh.addEventListener("input", () => {
  const sleep = Number(inpSleepTh.value);
  const work = Math.max(Number(inpWorkTh.value), sleep + 5);
  commitSettings({ sleepingThreshold: sleep, workingThreshold: Math.min(99, work) });
});

segButtons.forEach((btn) => {
  btn.addEventListener("click", () => commitSettings({ scoreMode: btn.dataset.mode as ScoreMode }, true));
});

inpNotify.addEventListener("change", () => commitSettings({ notifyEnabled: inpNotify.checked }, true));
inpNotifyTh.addEventListener("input", () => commitSettings({ notifyLowThreshold: Number(inpNotifyTh.value) }));
inpRefreshSec.addEventListener("input", () => commitSettings({ refreshIntervalSecs: Number(inpRefreshSec.value) }));
inpAgExtra.addEventListener("change", () => commitSettings({ showAntigravityExtra: inpAgExtra.checked }, true));
inpAutostart.addEventListener("change", () => commitSettings({ launchAtStartup: inpAutostart.checked }, true));

document.querySelectorAll<HTMLButtonElement>("[data-preview]").forEach((btn) => {
  btn.addEventListener("click", () => {
    invoke("preview_mood", { mood: btn.dataset.preview as CatMood }).catch(() => {});
  });
});

$("btn-test-notify").addEventListener("click", () => {
  invoke("test_notification").catch(() => {});
});

$("btn-quit").addEventListener("click", () => {
  invoke("quit_app").catch(() => {});
});

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (showingSettings) setSettingsVisible(false);
  else invoke("hide_panel").catch(() => {});
});

async function init() {
  await listen<DashboardSnapshot>("snapshot-updated", (event) => renderDashboard(event.payload));

  const existing = await invoke<DashboardSnapshot | null>("get_snapshot");
  if (existing) {
    renderDashboard(existing);
  } else {
    currentSettings = await invoke<AppSettings>("get_settings");
    syncSettingsForm(currentSettings);
  }
}

init().catch(() => {});
