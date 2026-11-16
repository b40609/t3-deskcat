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
const themeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".theme-btn"));
const customCard = document.getElementById("custom-images-card")!;
const prevSlotWorking = document.getElementById("prev-slot-working")!;
const prevSlotSweating = document.getElementById("prev-slot-sweating")!;
const prevSlotSleeping = document.getElementById("prev-slot-sleeping")!;
const fileWorking = document.getElementById("file-working") as HTMLInputElement;
const fileSweating = document.getElementById("file-sweating") as HTMLInputElement;
const fileSleeping = document.getElementById("file-sleeping") as HTMLInputElement;
const btnClearCustom = document.getElementById("btn-clear-custom")!;

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
  petTheme: "hud_gauge",
};

// Topbar mini animation loop
setInterval(() => {
  miniTick = (miniTick + 1) % 10000;
  const mood: CatMood = currentSnapshot?.mood ?? "working";
  const settings = currentSettings ?? fallbackSettings;
  const theme = settings.petTheme ?? "hud_gauge";
  const score = currentSnapshot?.overallScore ?? 100;
  renderAvatar(miniCtx, miniCanvas.width, theme, score, mood, miniTick, settings);
}, 100);

function providerLabel(p: ProviderKind): string {
  if (p === "claude") return "Claude";
  if (p === "antigravity") return "AG";
  return "ChatGPT";
}

function moodLabel(m: CatMood): string {
  if (m === "working") return "元氣工作";
  if (m === "sweating") return "緊張趕工";
  return "額度用盡";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderDashboard(snap: DashboardSnapshot) {
  currentSnapshot = snap;
  currentSettings = snap.settings;
  syncSettingsForm(snap.settings);

  // Topbar
  moodBadge.textContent = moodLabel(snap.mood);
  moodBadge.className = `mood-badge ${snap.mood}`;

  // Smart Picks
  if (snap.picks.length === 0) {
    picksSection.innerHTML = `
      <div class="empty-hint">尚未抓取到可用帳號</div>
    `;
  } else {
    picksSection.innerHTML = snap.picks
      .map(
        (pick) => `
        <div class="pick-item">
          <div class="pick-header">
            <span class="provider-pill ${pick.provider}">${providerLabel(pick.provider)}</span>
            <span class="pick-name">${escapeHtml(pick.accountName)}</span>
            <span class="pick-pct tone-${getTone(pick.effectiveRemaining)}">${pick.effectiveRemaining}%</span>
          </div>
          <div class="pick-reason">${escapeHtml(pick.reason)}</div>
        </div>
      `,
      )
      .join("");
  }

  // Account list
  if (snap.accounts.length === 0) {
    accountsSection.innerHTML = `
      <div class="empty-hint">未發現支援之 AI 憑證（Claude / Antigravity / Codex）</div>
    `;
  } else {
    accountsSection.innerHTML = snap.accounts
      .map((acc) => renderAccountCard(acc, snap.settings.showAntigravityExtra))
      .join("");
  }

  // Footer
  const date = new Date(snap.lastRefreshedAt * 1000);
  const timeStr = date.toLocaleTimeString("zh-TW", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  lastUpdatedEl.textContent = `最後更新 ${timeStr}`;

  const modeHint =
    snap.settings.scoreMode === "max_avg" ? "各家最高平均" : "全部帳號平均";
  scoreHintEl.textContent = `總分 ${snap.overallScore}%（${modeHint}）`;
}

function getTone(pct: number): "good" | "warn" | "bad" {
  if (pct > 70) return "good";
  if (pct >= 20) return "warn";
  return "bad";
}

function formatResetAt(resetAt: number | null): string {
  if (!resetAt) return "";
  const now = Math.floor(Date.now() / 1000);
  const diffSec = resetAt - now;
  if (diffSec <= 0) return "即將重置";
  const hours = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}天${remHours}時後重置`;
  }
  if (hours > 0) {
    return `${hours}時${mins}分後重置`;
  }
  return `${mins}分後重置`;
}

function renderAccountCard(acc: AccountQuota, showExtra: boolean): string {
  const isErr = acc.status !== "ok";
  const tone = isErr ? "bad" : getTone(acc.effectiveRemaining);

  const planBadge = acc.plan
    ? `<span class="acc-plan">${escapeHtml(acc.plan)}</span>`
    : "";

  let windowsHtml = "";
  if (acc.primaryWindows.length > 0) {
    windowsHtml = acc.primaryWindows
      .map((w) => {
        const timeStr = formatResetAt(w.resetAt);
        const timeSpan = timeStr ? ` · <span class="reset-time">${timeStr}</span>` : "";
        return `
          <span class="window-pill">
            <span class="win-label">${w.label}</span>
            <span class="win-val tone-${getTone(w.remainingPercent)}">${w.remainingPercent}%</span>
            ${timeSpan}
          </span>
        `;
      })
      .join("");
  } else if (acc.error) {
    windowsHtml = `<span class="acc-err-msg">${escapeHtml(acc.error)}</span>`;
  }

  let extraHtml = "";
  if (showExtra && acc.extraWindows.length > 0) {
    extraHtml = `
      <div class="extra-windows">
        <span class="extra-title">次要用量池:</span>
        ${acc.extraWindows
          .map(
            (w) =>
              `<span class="window-pill extra"><span class="win-label">${w.label}</span> <span class="win-val">${w.remainingPercent}%</span></span>`,
          )
          .join("")}
      </div>
    `;
  }

  return `
    <div class="acc-card ${isErr ? "err-card" : ""}">
      <div class="acc-top">
        <div class="acc-title-group">
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
  // Theme selector
  const activeTheme = s.petTheme ?? "hud_gauge";
  themeButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === activeTheme);
  });
  customCard.classList.toggle("hidden", activeTheme !== "custom");

  // Custom image preview slots
  prevSlotWorking.innerHTML = s.customImageWorking
    ? `<img src="${s.customImageWorking}" alt="Working" />`
    : `💻`;
  prevSlotSweating.innerHTML = s.customImageSweating
    ? `<img src="${s.customImageSweating}" alt="Sweating" />`
    : `💦`;
  prevSlotSleeping.innerHTML = s.customImageSleeping
    ? `<img src="${s.customImageSleeping}" alt="Sleeping" />`
    : `😴`;

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

// Theme selection
themeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const theme = btn.dataset.theme as PetTheme;
    commitSettings({ petTheme: theme }, true);
  });
});

// File upload helper
function handleImageUpload(input: HTMLInputElement, key: "customImageWorking" | "customImageSweating" | "customImageSleeping") {
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      commitSettings({ [key]: dataUrl }, true);
    };
    reader.readAsDataURL(file);
    input.value = "";
  });
}

handleImageUpload(fileWorking, "customImageWorking");
handleImageUpload(fileSweating, "customImageSweating");
handleImageUpload(fileSleeping, "customImageSleeping");

btnClearCustom.addEventListener("click", async () => {
  try {
    const updated = await invoke<DashboardSnapshot>("clear_custom_images");
    renderDashboard(updated);
  } catch {
    // fallback
    commitSettings(
      {
        customImageWorking: null,
        customImageSweating: null,
        customImageSleeping: null,
      },
      true,
    );
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
  const defaultTheme = "hud_gauge";
  renderAvatar(miniCtx, miniCanvas.width, defaultTheme, 100, "working", 0, fallbackSettings);

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
