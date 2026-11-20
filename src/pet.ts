import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { animSpeedFactor, renderAvatar } from "./themeRenderer";
import { getAnimator } from "./museAnimator";
import { elapsedShare, focusOf, providerShort, toneOf, whenText, windowWord, type Focus } from "./focus";
import type { AgentActivity, AppSettings, CatMood, DashboardSnapshot } from "./types";

const canvas = document.getElementById("pet-canvas") as HTMLCanvasElement;
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
/** Last remaining % per account window, to spot resets. */
let lastWindows: Map<string, number> | null = null;

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

/** Who the pet talks about, how fast the cat types and whether it types at all. */
function updateDrive() {
  const snap = currentSnapshot;
  const live = activity.state === "working" || activity.state === "done" || activity.state === "error";
  focus = focusOf(snap, live ? activity.accountId : null);
  const anim = getAnimator(ctx);
  const rates = snap?.burnRates ?? {};
  const rateOf = (id: string | undefined) => (id != null ? rates[id] : undefined);
  const focusRate = rateOf(focus?.acc.id);
  // 80 BPM idle pace up to 160 BPM at 40 %/h and above.
  anim.tempo = 80 + (Math.min(40, Math.max(0, focusRate ?? 15)) / 40) * 80;
  if (activity.state === "working") {
    anim.busy = true;
  } else if (activity.state === "unknown") {
    // No Claude Code / Codex logs to watch: go by the burn rate alone.
    const all = Object.values(rates);
    anim.busy = all.length === 0 || Math.max(...all) > 0.5;
  } else {
    // Logs say nobody is working; Antigravity has no logs, so its burn rate still counts.
    const ag = (snap?.accounts ?? []).filter((a) => a.provider === "antigravity").map((a) => rates[a.id] ?? 0);
    anim.busy = ag.some((r) => r > 1);
    if (anim.busy) anim.tempo = 80 + (Math.min(40, Math.max(...ag)) / 40) * 80;
  }
}

/** A window going from mostly used to (nearly) full means it just reset. */
function detectReset(snap: DashboardSnapshot) {
  const now = new Map<string, number>();
  for (const a of snap.accounts) {
    if (a.status !== "ok" || snap.settings.accountPrefs?.[a.id]?.hidden) continue;
    for (const w of a.primaryWindows) now.set(`${a.id}|${w.label}`, w.remainingPercent);
  }
  if (lastWindows) {
    for (const [k, v] of now) {
      const before = lastWindows.get(k);
      if (before != null && before < 50 && v >= 95) {
        getAnimator(ctx).celebrate();
        break;
      }
    }
  }
  lastWindows = now;
}

function applySnapshot(snap: DashboardSnapshot) {
  currentSnapshot = snap;
  currentMood = snap.mood;
  detectReset(snap);
  updateDrive();
  if (bubbleShown) showBubble();
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
  if (theme === "hud_gauge") {
    // The gauge is static: repaint only when what it shows changes.
    const ring = (w: Focus["short"]) => (w ? `${w.remainingPercent}:${Math.round((elapsedShare(w) ?? -1) * 360)}` : "-");
    const key = [canvas.width, focus?.acc.id, focus?.stale, ring(focus?.short ?? null), ring(focus?.long ?? null),
      settings.workingThreshold, settings.sleepingThreshold].join("|");
    if (key === lastGaugeKey) return;
    lastGaugeKey = key;
  } else {
    lastGaugeKey = "";
  }
  renderAvatar(ctx, canvas.width, theme, focus, effectiveMood, tick, settings, canvas.width / petSize);
}
let lastGaugeKey = "";
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
  const prev = activity.state;
  activity = next;
  if (prev === "working" && next.state === "done") getAnimator(ctx).finish();
  if (next.state === "error" && prev !== "error") getAnimator(ctx).oops();
  updateDrive();
  if (bubbleShown) showBubble();
}

// Hover: the cat notices you and hops
let lastHover = 0;
canvas.addEventListener("pointerenter", () => {
  hovering = true;
  if (bubbleTimer) window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(showBubble, 350);
  idle = false;
  if (idleTimer) window.clearTimeout(idleTimer);
  applyOpacity();
  const now = performance.now();
  if (now - lastHover < 2500) return;
  lastHover = now;
  getAnimator(ctx).poke("squish");
});

canvas.addEventListener("pointerleave", () => {
  hovering = false;
  hideBubble();
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
  hideBubble();
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
  canvas.removeAttribute("title");

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
