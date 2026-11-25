import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { animSpeedFactor, hudCardScale, normalizePetTheme, petLogicalSize, renderAvatar } from "./themeRenderer";
import {
  elapsedShare,
  providerShort,
  selectHudItems,
  toneOf,
  whenText,
  windowSeconds,
  windowWord,
  type Focus,
  type HudItem,
} from "./focus";
import { setLang, t } from "./i18n";
import type { AgentActivity, AppSettings, CatMood, DashboardSnapshot, QuotaWindow } from "./types";

const rootEl = document.getElementById("pet-root") as HTMLDivElement;
const canvas = document.getElementById("pet-canvas") as HTMLCanvasElement;
const hudCard = document.getElementById("hud-card") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;
const appWindow = getCurrentWindow();

let currentSnapshot: DashboardSnapshot | null = null;
let currentMood: CatMood = "working";
let previewMoodOverride: CatMood | null = null;
let previewTimeout: number | undefined;
let petSize = 64;
let tick = 0;
let activity: AgentActivity = { state: "unknown", accountId: null, lastWrite: 0 };
let hudItems: HudItem[] = [];
let focus: Focus | null = null;
let hoveredIdx = 0;

const defaultSettings: AppSettings = {
  petSize: 64,
  workingThreshold: 70,
  sleepingThreshold: 20,
  scoreMode: "max_avg",
  refreshIntervalSecs: 120,
  notifyEnabled: true,
  showAntigravityExtra: false,
  launchAtStartup: false,
  showPet: true,
  petX: null,
  petY: null,
  petTheme: "hud_gauge",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function shortWindowTag(w: QuotaWindow): string {
  const len = windowSeconds(w.label);
  if (len == null) return w.label.slice(0, 4);
  return len >= 2 * 86400 ? "Wk" : `${Math.round(len / 3600)}h`;
}

function applyAppearance(s: AppSettings) {
  const root = document.documentElement;
  const ap = s.appearance ?? "system";
  if (ap === "system") delete root.dataset.theme;
  else root.dataset.theme = ap;
}

function syncCanvasSize(logicalSize: number, theme?: AppSettings["petTheme"]) {
  petSize = logicalSize;
  const activeTheme = normalizePetTheme(theme ?? currentSnapshot?.settings.petTheme ?? defaultSettings.petTheme);
  const isHud = activeTheme === "hud_gauge";
  hudCard.classList.toggle("hidden", !isHud);
  canvas.classList.toggle("hidden", isHud);

  if (isHud) {
    hudCard.style.setProperty("--s", hudCardScale(logicalSize).toFixed(4));
    return;
  }

  const { width, height } = petLogicalSize(logicalSize, activeTheme);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const targetW = Math.round(width * dpr);
  const targetH = Math.round(height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
}

function renderSingleHudBody(
  item: HudItem,
  settings: AppSettings,
  offline: boolean,
  compactMulti: boolean,
): string {
  const f = item.focus;
  const stale = offline || f.stale;
  const activeWorking = activity.state === "working" && activity.accountId === f.acc.id;
  const showUsed = settings.usageDisplay === "used";
  const paceMode = settings.paceTick ?? "ahead";
  const avatar = settings.accountPrefs?.[f.acc.id]?.avatar ?? "";
  const prov = f.acc.provider;
  const symbolId = prov === "claude" ? "m-claude" : prov === "antigravity" ? "m-antigravity" : "m-codex";
  const tileHtml = avatar
    ? `<span class="hud-tile has-img"><img src="${escapeHtml(avatar)}" alt="" /></span>`
    : `<span class="hud-tile ${prov}"><svg><use href="#${symbolId}" /></svg></span>`;

  const pillText = t(item.tagKey);
  const badgeHtml = stale
    ? `<span class="hud-status-dot stale" aria-hidden="true"></span>`
    : activeWorking
      ? `<span class="hud-pill live"><i class="hud-pdot"></i>${escapeHtml(pillText)}</span>`
      : `<span class="hud-pill ${item.tagKind}">${escapeHtml(pillText)}</span>`;

  const windows: QuotaWindow[] = [];
  if (f.short) windows.push(f.short);
  if (f.long) windows.push(f.long);
  const shownWins = compactMulti && windows.length > 1 && f.tight ? [f.tight] : windows;

  const rowsHtml =
    shownWins.length > 0
      ? shownWins
          .map((w) => {
            const rem = Math.max(0, Math.min(100, w.remainingPercent));
            const disp = Math.round(showUsed ? 100 - rem : rem);
            const tone = toneOf(rem, settings, f.acc.id);
            const cls = tone === "good" ? "" : tone;
            let paceHtml = "";
            if (paceMode !== "off") {
              const el = elapsedShare(w);
              if (el != null) {
                const ahead = 100 - rem > el * 100;
                if (paceMode === "on" || ahead) {
                  const leftPct = Math.max(2, Math.min(98, Math.round((showUsed ? el : 1 - el) * 100)));
                  paceHtml = `<span class="hud-pace" style="left:${leftPct}%"></span>`;
                }
              }
            }
            return `
              <div class="hud-row">
                <span class="hud-tag">${escapeHtml(shortWindowTag(w))}</span>
                <div class="hud-bar"><i class="${cls}" style="width:${disp}%"></i>${paceHtml}</div>
                <span class="hud-val ${cls}">${disp}%</span>
              </div>`;
          })
          .join("")
      : `<div class="hud-empty">–</div>`;

  return `
    <div class="hud-head">
      ${tileHtml}
      <span class="hud-name">${escapeHtml(f.name)}</span>
      ${badgeHtml}
    </div>
    <div class="hud-rows">${rowsHtml}</div>`;
}

function renderHudCard() {
  const settings = currentSnapshot?.settings ?? defaultSettings;
  const offline = !!currentSnapshot?.offline;
  const hudCount = Math.max(1, Math.min(4, settings.hudCount ?? 1));
  const hudLayout = settings.hudLayout === "horizontal" ? "horizontal" : "vertical";
  const isMulti = hudCount >= 2 && hudItems.length >= 2;
  const compactMulti = hudLayout === "vertical" && hudItems.length >= 3;

  const winKey = (w: QuotaWindow | null) =>
    w ? `${Math.round(w.remainingPercent)}:${Math.round((elapsedShare(w) ?? -1) * 100)}` : "-";
  const itemsKey = hudItems
    .map((it) => {
      const f = it.focus;
      const av = settings.accountPrefs?.[f.acc.id]?.avatar?.length ?? 0;
      const working = activity.state === "working" && activity.accountId === f.acc.id;
      return `${f.acc.id}:${f.name}:${f.acc.provider}:${av}:${f.stale}:${working}:${it.tagKey}:${winKey(f.short)}:${winKey(f.long)}`;
    })
    .join(";");
  const key = [
    petSize,
    hudCount,
    hudLayout,
    offline,
    settings.language ?? "system",
    settings.workingThreshold,
    settings.sleepingThreshold,
    settings.usageDisplay,
    settings.paceTick,
    itemsKey,
  ].join("|");
  if (key === lastHudKey) return;
  lastHudKey = key;

  hudCard.classList.toggle("multi", isMulti);
  hudCard.classList.toggle("horizontal", isMulti && hudLayout === "horizontal");
  hudCard.classList.toggle("vertical", isMulti && hudLayout !== "horizontal");
  hudCard.classList.toggle("dense-multi", compactMulti);
  hudCard.classList.toggle("stale", !isMulti && (offline || !!focus?.stale));

  if (hudItems.length === 0) {
    hudCard.innerHTML = `
      <div class="hud-head">
        <span class="hud-tile claude"><svg><use href="#m-claude" /></svg></span>
        <span class="hud-name">T3 DeskCat</span>
      </div>
      <div class="hud-empty">${escapeHtml(t("尚未偵測到帳號"))}</div>
    `;
    return;
  }

  if (!isMulti) {
    hudCard.innerHTML = renderSingleHudBody(hudItems[0], settings, offline, false);
    return;
  }

  hudCard.innerHTML = hudItems
    .map((item, idx) => {
      const stale = offline || item.focus.stale;
      return `<div class="hud-item${stale ? " stale" : ""}" data-hud-idx="${idx}">${renderSingleHudBody(item, settings, offline, compactMulti)}</div>`;
    })
    .join("");
}

// ---- opacity / idle fade
let hovering = false;
let idle = false;
let idleTimer: number | undefined;

function applyOpacity() {
  const s = currentSnapshot?.settings ?? defaultSettings;
  const base = Math.max(0.3, Math.min(1, (s.petOpacity ?? 100) / 100));
  const faded = !!s.petIdleFade && idle && !hovering;
  rootEl.style.opacity = String(faded ? Math.max(0.45, base * 0.55) : base);
}

function scheduleIdle(ms: number) {
  if (idleTimer) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idle = true;
    applyOpacity();
  }, ms);
}

/** Who the pet talks about right now. */
function updateFocus() {
  const snap = currentSnapshot;
  const live = activity.state === "working" || activity.state === "done" || activity.state === "error";
  hudItems = selectHudItems(snap, live ? activity.accountId : null);
  focus = hudItems[0]?.focus ?? null;
  if (hoveredIdx >= hudItems.length) hoveredIdx = 0;
}

function applySnapshot(snap: DashboardSnapshot) {
  currentSnapshot = snap;
  currentMood = snap.mood;
  setLang(snap.settings.language);
  applyAppearance(snap.settings);
  updateFocus();
  if (bubbleShown) showBubble();
  const activeTheme = normalizePetTheme(snap.settings.petTheme);
  syncCanvasSize(snap.settings.petSize || 64, activeTheme);
  // Greyed out while no account returns fresh data (for canvas custom theme).
  canvas.style.filter = snap.offline ? "grayscale(1) brightness(0.9)" : "";
  if (activeTheme === "hud_gauge") {
    renderHudCard();
  }
  applyOpacity();
}

// Animation loop: capped at ~24 fps, paused while dragging or when using the static DOM HUD card.
const FRAME_MS = 1000 / 24;
let lastFrame = 0;
let moving = false;
let lastHudKey = "";
function frame(now: number) {
  requestAnimationFrame(frame);
  if (moving || document.hidden || now - lastFrame < FRAME_MS) return;
  lastFrame = now;
  const settings = currentSnapshot?.settings ?? defaultSettings;
  const theme = normalizePetTheme(settings.petTheme);
  if (theme === "hud_gauge") {
    renderHudCard();
    return;
  }
  lastHudKey = "";
  // Keep animation speed the same as the old 50 fps loop.
  tick = (tick + animSpeedFactor(settings) * (50 / 24)) % 10000;
  const effectiveMood = previewMoodOverride ?? currentMood;
  const dpr = canvas.height / petSize;
  renderAvatar(ctx, canvas.width, canvas.height, theme, focus, effectiveMood, tick, settings, dpr, false);
}
requestAnimationFrame(frame);

// ---- hover bubble: the one limit that matters right now
let bubbleShown = false;
let bubbleTimer: number | undefined;

function bubbleLines(): string[] {
  const snap = currentSnapshot;
  const item = hudItems[hoveredIdx] ?? hudItems[0];
  const f = item?.focus ?? focus;
  if (!snap || !f) return [t("尚未偵測到帳號"), t("點擊開啟面板")];
  const s = snap.settings;
  const who = `${providerShort(f.acc.provider)} · ${f.name}`;
  const lines: string[] = [];
  const tWin = f.tight;
  if (tWin) {
    const pct = Math.max(0, Math.round(tWin.remainingPercent));
    const tone = toneOf(pct, s, f.acc.id);
    lines.push(`${tone === "bad" ? "!" : tone === "warn" ? "?" : ""}${who} · ${windowWord(tWin)} ${t("剩 {p}%", { p: pct })}`);
  } else {
    lines.push(who);
  }
  if (item) {
    lines.push(`[${t(item.tagKey)}] ${item.reason}`);
  }
  const fc = snap.forecasts?.[f.acc.id];
  if (snap.offline || f.stale) lines.push(`?${t("資料可能非最新")}`);
  else if (fc) {
    const base = t("依目前消耗速度，預計 {when} 用完", { when: whenText(fc.exhaustAt) });
    lines.push(`?${base}${fc.resetAt ? ` · ${t("{when}重設", { when: whenText(fc.resetAt) })}` : ""}`);
  } else if (tWin?.resetAt) lines.push(t("{when}重設", { when: whenText(tWin.resetAt) }));
  if (activity.accountId === f.acc.id) {
    if (activity.state === "working") lines.push(t("執行中"));
    else if (activity.state === "done") lines.push(t("已完成，等待下一步"));
    else if (activity.state === "error") lines.push(`!${t("發生錯誤")}`);
  }
  return lines;
}

function showBubble() {
  bubbleShown = true;
  invoke("show_bubble", { lines: bubbleLines() }).catch(() => {});
}

function hideBubble() {
  if (bubbleTimer) window.clearTimeout(bubbleTimer);
  if (!bubbleShown) return;
  bubbleShown = false;
  invoke("hide_bubble").catch(() => {});
}

function applyActivity(next: AgentActivity) {
  activity = next;
  updateFocus();
  if (normalizePetTheme(currentSnapshot?.settings.petTheme) === "hud_gauge") {
    renderHudCard();
  }
  if (bubbleShown) showBubble();
}

rootEl.addEventListener("pointermove", (e) => {
  const itemEl = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-hud-idx]");
  if (itemEl) {
    const idx = Number(itemEl.dataset.hudIdx ?? 0);
    if (!Number.isNaN(idx) && idx !== hoveredIdx) {
      hoveredIdx = idx;
      if (bubbleShown) showBubble();
    }
  }
});

// Hover: show detailed bubble
rootEl.addEventListener("pointerenter", () => {
  hovering = true;
  if (bubbleTimer) window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(showBubble, 350);
  idle = false;
  if (idleTimer) window.clearTimeout(idleTimer);
  applyOpacity();
});

rootEl.addEventListener("pointerleave", () => {
  hovering = false;
  hideBubble();
  scheduleIdle(2500);
});

// Distinguish click (toggle panel) vs drag (>4px native window move)
let downX = 0;
let downY = 0;
let dragging = false;
let pointerActive = false;

rootEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  pointerActive = true;
  dragging = false;
  hideBubble();
  downX = e.screenX;
  downY = e.screenY;
});

rootEl.addEventListener("pointermove", async (e) => {
  if (!pointerActive || dragging) return;
  const dx = Math.abs(e.screenX - downX);
  const dy = Math.abs(e.screenY - downY);
  if (dx > 4 || dy > 4) {
    dragging = true;
    pointerActive = false;
    try {
      await appWindow.startDragging();
    } catch {
      // ignore drag errors
    }
  }
});

let moveSaveTimer: number | undefined;
void appWindow.onMoved(() => {
  moving = true;
  if (moveSaveTimer) window.clearTimeout(moveSaveTimer);
  moveSaveTimer = window.setTimeout(() => {
    moving = false;
    invoke("save_pet_position").catch(() => {});
  }, 300);
});

rootEl.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  const wasClick = pointerActive && !dragging;
  pointerActive = false;
  dragging = false;
  if (wasClick) {
    invoke("toggle_panel").catch(() => {});
  }
});

rootEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  invoke("toggle_panel").catch(() => {});
});

window.addEventListener("resize", () => {
  syncCanvasSize(petSize);
});

async function init() {
  scheduleIdle(4000);
  applyAppearance(defaultSettings);
  syncCanvasSize(petSize);
  rootEl.removeAttribute("title");
  renderHudCard();

  await listen<AgentActivity>("agent-activity", (event) => applyActivity(event.payload));
  invoke<AgentActivity>("get_activity").then(applyActivity).catch(() => {});

  await listen<DashboardSnapshot>("snapshot-updated", (event) => {
    applySnapshot(event.payload);
  });

  await listen<CatMood>("preview-mood", (event) => {
    previewMoodOverride = event.payload;
    if (previewTimeout) window.clearTimeout(previewTimeout);
    previewTimeout = window.setTimeout(() => {
      previewMoodOverride = null;
    }, 3000);
  });

  const existing = await invoke<DashboardSnapshot | null>("get_snapshot");
  if (existing) {
    applySnapshot(existing);
  }
}

init().catch(() => {});
