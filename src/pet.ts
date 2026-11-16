import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { drawDeskCat } from "./catSprite";
import type { CatMood, DashboardSnapshot } from "./types";

const canvas = document.getElementById("pet-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const appWindow = getCurrentWindow();

let currentMood: CatMood = "working";
let previewMoodOverride: CatMood | null = null;
let previewTimeout: number | undefined;
let petSize = 64;
let tick = 0;

function syncCanvasSize(logicalSize: number) {
  petSize = logicalSize;
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const targetPx = Math.round(logicalSize * dpr);
  if (canvas.width !== targetPx || canvas.height !== targetPx) {
    canvas.width = targetPx;
    canvas.height = targetPx;
  }
}

function applySnapshot(snap: DashboardSnapshot) {
  currentMood = snap.mood;
  if (snap.tooltipText) {
    canvas.title = snap.tooltipText;
  }
  syncCanvasSize(snap.settings.petSize || 64);
}

// Animation loop (~10 fps for crisp pixel motion with near-zero CPU)
setInterval(() => {
  tick = (tick + 1) % 10000;
  const effectiveMood = previewMoodOverride ?? currentMood;
  drawDeskCat(ctx, canvas.width, effectiveMood, tick);
}, 100);

// Distinguish click (toggle panel) vs drag (>4px native window move)
let downX = 0;
let downY = 0;
let dragging = false;
let pointerActive = false;

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
  if (moveSaveTimer) window.clearTimeout(moveSaveTimer);
  moveSaveTimer = window.setTimeout(() => {
    invoke("save_pet_position").catch(() => {});
  }, 300);
});

canvas.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  const wasClick = pointerActive && !dragging;
  pointerActive = false;
  dragging = false;
  if (wasClick) {
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
  syncCanvasSize(petSize);
  drawDeskCat(ctx, canvas.width, currentMood, tick);

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
