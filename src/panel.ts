import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { drawDeskCat } from "./catSprite";
import type {
  AccountQuota,
  AppSettings,
  CatMood,
  DashboardSnapshot,
  ProviderKind,
  ScoreMode,
} from "./types";

const miniCanvas = document.getElementById("mini-cat") as HTMLCanvasElement;
const miniCtx = miniCanvas.getContext("2d")!;
const moodBadge = document.getElementById("mood-badge")!;
const picksSection = document.getElementById("picks-section")!;
const accountsSection = document.getElementById("accounts-section")!;
const lastUpdatedEl = document.getElementById("last-updated")!;
const scoreHintEl = document.getElementById("score-hint")!;

const viewDashboard = document.getElementById("view-dashboard")!;
const viewSettings = document.getElementById("view-settings")!;
const btnRefresh = document.getElementById("btn-refresh")!;
const btnPin = document.getElementById("btn-pin")!;
const btnSettings = document.getElementById("btn-settings")!;

// Settings inputs
const inpPetSize = document.getElementById("inp-pet-size") as HTMLInputElement;
const valPetSize = document.getElementById("val-pet-size")!;
const inpWorkTh = document.getElementById("inp-work-th") as HTMLInputElement;
const valWorkTh = document.getElementById("val-work-th")!;
const inpSleepTh = document.getElementById("inp-sleep-th") as HTMLInputElement;
const valSleepTh = document.getElementById("val-sleep-th")!;
const valSweatRange = document.getElementById("val-sweat-range")!;
const inpNotify = document.getElementById("inp-notify") as HTMLInputElement;
const inpNotifyTh = document.getElementById("inp-notify-th") as HTMLInputElement;
const valNotifyTh = document.getElementById("val-notify-th")!;
const inpRefreshSec = document.getElementById("inp-refresh-sec") as HTMLInputElement;
const valRefreshSec = document.getElementById("val-refresh-sec")!;
const inpAgExtra = document.getElementById("inp-ag-extra") as HTMLInputElement;
const inpAutostart = document.getElementById("inp-autostart") as HTMLInputElement;
const segButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".seg-btn"));

let currentSnapshot: DashboardSnapshot | null = null;
let currentSettings: AppSettings | null = null;
let showingSettings = false;
let pinned = false;
let miniTick = 0;

setInterval(() => {
  miniTick = (miniTick + 1) % 10000;
  const mood: CatMood = currentSnapshot?.mood ?? "working";
  drawDeskCat(miniCtx, miniCanvas.width, mood, miniTick);
}, 140);

function providerLabel(p: ProviderKind): string {
  if (p === "claude") return "Claude";
  if (p === "antigravity") return "AG";
  return "ChatGPT";
}

function toneClass(pct: number): "good" | "warn" | "low" {
  const work = currentSettings?.workingThreshold ?? 70;
  const sleep = currentSettings?.sleepingThreshold ?? 20;
  if (pct > work) return "good";
  if (pct >= sleep && pct > 0) return "warn";
  return "low";
}

function formatReset(ts: number | null): string {
  if (!ts) return "";
  const diff = ts - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "即將重置";
  const mins = Math.floor(diff / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDashboard(snap: DashboardSnapshot) {
  currentSnapshot = snap;
  currentSettings = snap.settings;

  // Mood badge
  const moodLabel =
    snap.mood === "working"
      ? `元氣上班 ${snap.overallScore}%`
      : snap.mood === "sweating"
        ? `趕工冒汗 ${snap.overallScore}%`
        : `見底趴睡 ${snap.overallScore}%`;
  moodBadge.textContent = moodLabel;
  moodBadge.className = `mood-badge ${snap.mood}`;

  // Smart recommendations
  const recommendedIds = new Set(snap.picks.map((p) => p.accountId));
  if (snap.picks.length === 0) {
    picksSection.innerHTML = "";
  } else {
    picksSection.innerHTML = snap.picks
      .map((pick) => {
        const tone = toneClass(pick.effectiveRemaining);
        return `
          <div class="pick-card">
            <div class="pick-top">
              <span>${providerLabel(pick.provider)} 優先使用</span>
              <span class="pick-tag">智慧推薦</span>
            </div>
            <div class="pick-main">
              <span class="pick-name">${escapeHtml(pick.accountName)}</span>
              <span class="pick-pct tone-${tone}">${pick.effectiveRemaining}%</span>
            </div>
            <div class="pick-reason">${escapeHtml(pick.reason)}</div>
          </div>
        `;
      })
      .join("");
  }

  // Accounts list
  if (snap.accounts.length === 0) {
    accountsSection.innerHTML = `<div class="acc-row"><span class="err-text">未偵測到 T3 Code 或本機 CLI 登入帳號</span></div>`;
  } else {
    accountsSection.innerHTML = snap.accounts
      .map((acc) => renderAccountRow(acc, recommendedIds.has(acc.id), snap.settings.showAntigravityExtra))
      .join("");
  }

  // Footer
  const dt = new Date(snap.lastRefreshedAt * 1000);
  lastUpdatedEl.textContent = `更新於 ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  scoreHintEl.textContent =
    snap.settings.scoreMode === "max_avg" ? "計算：各家最高平均" : "計算：全部帳號平均";

  syncSettingsForm(snap.settings);
}

function renderAccountRow(
  acc: AccountQuota,
  isRecommended: boolean,
  showAgExtra: boolean,
): string {
  const planBadge = acc.plan ? `<span class="acc-plan">${escapeHtml(acc.plan)}</span>` : "";
  const recClass = isRecommended ? "recommended" : "";

  if (acc.status !== "ok") {
    return `
      <div class="acc-row ${recClass}">
        <div class="acc-head">
          <div class="acc-id">
            <span class="provider-pill ${acc.provider}">${providerLabel(acc.provider)}</span>
            <span class="acc-name">${escapeHtml(acc.name)}</span>
            ${planBadge}
          </div>
          <span class="acc-pct tone-low">--%</span>
        </div>
        <div class="err-text">${escapeHtml(acc.error || "無法取得額度")}</div>
      </div>
    `;
  }

  const tone = toneClass(acc.effectiveRemaining);
  const windowsHtml = acc.primaryWindows
    .map((w) => {
      const rst = formatReset(w.resetAt);
      return `<span class="win-item">${escapeHtml(w.label)} <strong>${w.remainingPercent}%</strong>${rst ? ` (${rst})` : ""}</span>`;
    })
    .join("");

  const extraHtml =
    showAgExtra && acc.extraWindows.length > 0
      ? `<div class="extra-line">${acc.extraWindows
          .map((w) => `<span>${escapeHtml(w.label)} ${w.remainingPercent}%</span>`)
          .join("")}</div>`
      : "";

  return `
    <div class="acc-row ${recClass}">
      <div class="acc-head">
        <div class="acc-id">
          <span class="provider-pill ${acc.provider}">${providerLabel(acc.provider)}</span>
          <span class="acc-name">${escapeHtml(acc.name)}</span>
          ${planBadge}
        </div>
        <span class="acc-pct tone-${tone}">${acc.effectiveRemaining}%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill fill-${tone}" style="width: ${acc.effectiveRemaining}%"></div>
      </div>
      <div class="windows-line">${windowsHtml}</div>
      ${extraHtml}
    </div>
  `;
}

function setRangeIfIdle(inp: HTMLInputElement, value: number) {
  if (document.activeElement !== inp) {
    inp.value = String(value);
  }
}

function syncSettingsForm(s: AppSettings) {
  setRangeIfIdle(inpPetSize, s.petSize);
  valPetSize.textContent = `${s.petSize} px`;

  setRangeIfIdle(inpWorkTh, s.workingThreshold);
  valWorkTh.textContent = `${s.workingThreshold}%`;

  setRangeIfIdle(inpSleepTh, s.sleepingThreshold);
  valSleepTh.textContent = `${s.sleepingThreshold}%`;
  valSweatRange.textContent = `趕工冒汗區間：${s.sleepingThreshold}% ~ ${s.workingThreshold}%`;

  inpNotify.checked = s.notifyEnabled;
  setRangeIfIdle(inpNotifyTh, s.notifyLowThreshold);
  valNotifyTh.textContent = `${s.notifyLowThreshold}%`;

  setRangeIfIdle(inpRefreshSec, s.refreshIntervalSecs);
  valRefreshSec.textContent = `${s.refreshIntervalSecs} 秒`;

  inpAgExtra.checked = s.showAntigravityExtra;
  inpAutostart.checked = s.launchAtStartup;

  segButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === s.scoreMode);
  });
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
      const updated = await invoke<DashboardSnapshot>("update_settings", {
        newSettings: next,
      });
      renderDashboard(updated);
    } catch {
      // ignore if snapshot not ready yet
    }
  };

  if (saveTimer) window.clearTimeout(saveTimer);
  if (immediate) {
    void send();
  } else {
    saveTimer = window.setTimeout(() => void send(), 120);
  }
}

// UI event bindings
btnSettings.addEventListener("click", () => {
  showingSettings = !showingSettings;
  btnSettings.classList.toggle("active", showingSettings);
  viewDashboard.classList.toggle("hidden", showingSettings);
  viewSettings.classList.toggle("hidden", !showingSettings);
});

btnPin.addEventListener("click", async () => {
  pinned = !pinned;
  btnPin.classList.toggle("active", pinned);
  await invoke("set_panel_pinned", { pinned });
});

btnRefresh.addEventListener("click", async () => {
  btnRefresh.classList.add("spinning");
  try {
    const snap = await invoke<DashboardSnapshot>("refresh_now");
    renderDashboard(snap);
  } finally {
    btnRefresh.classList.remove("spinning");
  }
});

inpPetSize.addEventListener("input", () => {
  commitSettings({ petSize: Number(inpPetSize.value) });
});

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
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode as ScoreMode;
    commitSettings({ scoreMode: mode }, true);
  });
});

inpNotify.addEventListener("change", () => {
  commitSettings({ notifyEnabled: inpNotify.checked }, true);
});

inpNotifyTh.addEventListener("input", () => {
  commitSettings({ notifyLowThreshold: Number(inpNotifyTh.value) });
});

inpRefreshSec.addEventListener("input", () => {
  commitSettings({ refreshIntervalSecs: Number(inpRefreshSec.value) });
});

inpAgExtra.addEventListener("change", () => {
  commitSettings({ showAntigravityExtra: inpAgExtra.checked }, true);
});

inpAutostart.addEventListener("change", () => {
  commitSettings({ launchAtStartup: inpAutostart.checked }, true);
});

document.querySelectorAll<HTMLButtonElement>("[data-preview]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mood = btn.dataset.preview as CatMood;
    invoke("preview_mood", { mood }).catch(() => {});
  });
});

document.getElementById("btn-test-notify")!.addEventListener("click", () => {
  invoke("test_notification").catch(() => {});
});

document.getElementById("btn-quit")!.addEventListener("click", () => {
  invoke("quit_app").catch(() => {});
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    invoke("hide_panel").catch(() => {});
  }
});

async function init() {
  drawDeskCat(miniCtx, miniCanvas.width, "working", 0);

  await listen<DashboardSnapshot>("snapshot-updated", (event) => {
    renderDashboard(event.payload);
  });

  const existing = await invoke<DashboardSnapshot | null>("get_snapshot");
  if (existing) {
    renderDashboard(existing);
  } else {
    const settings = await invoke<AppSettings>("get_settings");
    currentSettings = settings;
    syncSettingsForm(settings);
  }
}

init().catch(() => {});
