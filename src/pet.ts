import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { animSpeedFactor, renderAvatar } from "./themeRenderer";
import { getAnimator } from "./museAnimator";
import type { AppSettings, CatMood, DashboardSnapshot } from "./types";

const canvas = document.getElementById("pet-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const appWindow = getCurrentWindow();

let currentSnapshot: DashboardSnapshot | null = null;
let currentMood: CatMood = "working";
let previewMoodOverride: CatMood | null = null;
let previewTimeout: number | undefined;
let petSize = 64;
let tick = 0;

const defaultSettings: AppSettings = {
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

function syncCanvasSize(logicalSize: number) {
  petSize = logicalSize;
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const targetPx = Math.round(logicalSize * dpr);
  if (canvas.width !== targetPx || canvas.height !== targetPx) {
    canvas.width = targetPx;
    canvas.height = targetPx;
  }
}

// ---- opacity / idle fade
let hovering = false;
let idle = false;
let idleTimer: number | undefined;

function applyOpacity() {
  const s = currentSnapshot?.settings ?? defaultSettings;
  const base = Math.max(0.3, Math.min(1, (s.petOpacity ?? 100) / 100));
  const faded = !!s.petIdleFade && idle && !hovering;
  canvas.style.opacity = String(faded ? base * 0.3 : base);
}

function scheduleIdle(ms: number) {
  if (idleTimer) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idle = true;
    applyOpacity();
  }, ms);
}

function applySnapshot(snap: DashboardSnapshot) {
  currentSnapshot = snap;
  currentMood = snap.mood;
  if (snap.tooltipText) {
    canvas.title = snap.tooltipText;
  }
  syncCanvasSize(snap.settings.petSize || 64);
  // Greyed out while no account returns fresh data, so it never looks happy offline.
  canvas.style.filter = snap.offline ? "grayscale(1) brightness(0.9)" : "";
  applyOpacity();
}

// Animation loop: capped at ~24 fps, and paused while the window is being dragged
// (repainting a transparent window during the native move loop makes dragging stutter).
const FRAME_MS = 1000 / 24;
let lastFrame = 0;
let moving = false;
function frame(now: number) {
  requestAnimationFrame(frame);
  if (moving || document.hidden || now - lastFrame < FRAME_MS) return;
  lastFrame = now;
  const settings = currentSnapshot?.settings ?? defaultSettings;
  // Keep animation speed the same as the old 50 fps loop.
  tick = (tick + animSpeedFactor(settings) * (50 / 24)) % 10000;
  const effectiveMood = previewMoodOverride ?? currentMood;
  const theme = settings.petTheme ?? "hud_gauge";
  const score = currentSnapshot?.overallScore ?? 100;

  renderAvatar(ctx, canvas.width, theme, score, effectiveMood, tick, settings);
}
requestAnimationFrame(frame);

// Hover: the cat notices you and hops
let lastHover = 0;
canvas.addEventListener("pointerenter", () => {
  hovering = true;
  idle = false;
  if (idleTimer) window.clearTimeout(idleTimer);
  applyOpacity();
  const now = performance.now();
  if (now - lastHover < 2500) return;
  lastHover = now;
  getAnimator(ctx).poke("hop");
});

canvas.addEventListener("pointerleave", () => {
  hovering = false;
  scheduleIdle(2500);
});

// Distinguish click (toggle panel) vs drag (>4px native window move)
let downX = 0;
let downY = 0;
let dragging = false;
let pointerActive = false;
let lastClickAt = 0;

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  pointerActive = true;
  dragging = false;
  downX = e.screenX;
  downY = e.screenY;
});

canvas.addEventListener("pointermove", async (e) => {
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

canvas.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  const wasClick = pointerActive && !dragging;
  pointerActive = false;
  dragging = false;
  if (wasClick) {
    getAnimator(ctx).poke("squish");
    const mode = (currentSnapshot?.settings ?? defaultSettings).petClickAction ?? "single";
    const now = performance.now();
    if (mode === "double") {
      if (now - lastClickAt > 380) {
        lastClickAt = now;
        return;
      }
      lastClickAt = 0;
    }
    invoke("toggle_panel").catch(() => {});
  }
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  invoke("toggle_panel").catch(() => {});
});

window.addEventListener("resize", () => {
  syncCanvasSize(petSize);
});

async function init() {
  canvas.style.transition = "opacity 0.45s ease, filter 0.45s ease";
  scheduleIdle(4000);
  syncCanvasSize(petSize);
  renderAvatar(ctx, canvas.width, "hud_gauge", 100, currentMood, tick, defaultSettings);

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
