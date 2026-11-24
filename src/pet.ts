import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { animSpeedFactor, hudCardScale, normalizePetTheme, petLogicalSize, renderAvatar } from "./themeRenderer";
import {
  elapsedShare,
  focusOf,
  providerShort,
  toneOf,
  whenText,
  windowSeconds,
  windowWord,
  type Focus,
} from "./focus";
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
let focus: Focus | null = null;

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

function renderHudCard() {
  const settings = currentSnapshot?.settings ?? defaultSettings;
  const offline = !!currentSnapshot?.offline;
  const stale = offline || !!focus?.stale;
  const activeWorking = activity.state === "working" && activity.accountId === focus?.acc.id;
  const showUsed = settings.usageDisplay === "used";
  const paceMode = settings.paceTick ?? "ahead";

  const winKey = (w: QuotaWindow | null) =>
    w ? `${Math.round(w.remainingPercent)}:${Math.round((elapsedShare(w) ?? -1) * 100)}` : "-";
  const avatar = focus ? settings.accountPrefs?.[focus.acc.id]?.avatar ?? "" : "";
  const key = [
    petSize,
    focus?.acc.id ?? "",
    focus?.name ?? "",
    focus?.acc.provider ?? "",
    avatar.length,
    stale,
    activeWorking,
    winKey(focus?.short ?? null),
    winKey(focus?.long ?? null),
    settings.workingThreshold,
    settings.sleepingThreshold,
    settings.usageDisplay,
    settings.paceTick,
  ].join("|");
  if (key === lastHudKey) return;
  lastHudKey = key;

  hudCard.classList.toggle("stale", stale);

  if (!focus) {
    hudCard.innerHTML = `
      <div class="hud-head">
        <span class="hud-tile claude"><svg><use href="#m-claude" /></svg></span>
        <span class="hud-name">T3 DeskCat</span>
      </div>
      <div class="hud-empty">No accounts</div>
    `;
    return;
  }

  const prov = focus.acc.provider;
  const symbolId = prov === "claude" ? "m-claude" : prov === "antigravity" ? "m-antigravity" : "m-codex";
  const tileHtml = avatar
    ? `<span class="hud-tile has-img"><img src="${escapeHtml(avatar)}" alt="" /></span>`
    : `<span class="hud-tile ${prov}"><svg><use href="#${symbolId}" /></svg></span>`;

  const statusHtml = stale
    ? `<span class="hud-status-dot stale" aria-hidden="true"></span>`
    : activeWorking
      ? `<span class="hud-status-dot live" aria-hidden="true"></span>`
      : "";

  const windows: QuotaWindow[] = [];
  if (focus.short) windows.push(focus.short);
  if (focus.long) windows.push(focus.long);

  const rowsHtml =
    windows.length > 0
      ? windows
          .map((w) => {
            const rem = Math.max(0, Math.min(100, w.remainingPercent));
            const disp = Math.round(showUsed ? 100 - rem : rem);
            const tone = toneOf(rem, settings, focus!.acc.id);
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

  hudCard.innerHTML = `
    <div class="hud-head">
      ${tileHtml}
      <span class="hud-name">${escapeHtml(focus.name)}</span>
      ${statusHtml}
    </div>
    <div class="hud-rows">${rowsHtml}</div>
  `;
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
  focus = focusOf(snap, live ? activity.accountId : null);
}

function applySnapshot(snap: DashboardSnapshot) {
  currentSnapshot = snap;
  currentMood = snap.mood;
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
  const f = focus;
  if (!snap || !f) return ["No accounts found yet", "Click to open the panel"];
  const s = snap.settings;
  const who = `${providerShort(f.acc.provider)} · ${f.name}`;
  const lines: string[] = [];
  const t = f.tight;
  if (t) {
    const pct = Math.max(0, Math.round(t.remainingPercent));
    const tone = toneOf(pct, s, f.acc.id);
    lines.push(`${tone === "bad" ? "!" : tone === "warn" ? "?" : ""}${who} · ${windowWord(t)} ${pct}% left`);
  } else {
    lines.push(who);
  }
  const fc = snap.forecasts?.[f.acc.id];
  if (snap.offline || f.stale) lines.push("?Data may be out of date");
  else if (fc) lines.push(`?Runs out ${whenText(fc.exhaustAt)} at this pace${fc.resetAt ? ` · resets ${whenText(fc.resetAt)}` : ""}`);
  else if (t?.resetAt) lines.push(`Resets ${whenText(t.resetAt)}`);
  if (activity.accountId === f.acc.id) {
    if (activity.state === "working") lines.push("Working");
    else if (activity.state === "done") lines.push("Done, waiting for you");
    else if (activity.state === "error") lines.push("!Hit an error");
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
