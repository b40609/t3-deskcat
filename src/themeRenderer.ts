import { drawDeskCat } from "./catSprite";
import { MUSE_ASSETS } from "./museAssets";
import { getAnimator } from "./museAnimator";
import { elapsedShare, toneOf, windowWord, type Focus, type Tone } from "./focus";
import type { AppSettings, CatMood, PetTheme, QuotaWindow } from "./types";

const imageCache: Record<string, HTMLImageElement> = {};
const museImages: Partial<Record<CatMood, HTMLImageElement>> = {};

function getCachedImage(src: string | null | undefined): HTMLImageElement | null {
  if (!src) return null;
  if (!imageCache[src]) {
    const img = new Image();
    img.src = src;
    imageCache[src] = img;
  }
  const cached = imageCache[src];
  return cached.complete && cached.naturalWidth > 0 ? cached : null;
}

export function getMuseImage(mood: CatMood): HTMLImageElement | null {
  if (!museImages[mood]) {
    const img = new Image();
    img.src = MUSE_ASSETS[mood] || MUSE_ASSETS.working;
    museImages[mood] = img;
  }
  const img = museImages[mood]!;
  return img.complete && img.naturalWidth > 0 ? img : null;
}

export function animSpeedFactor(_s: AppSettings): number {
  return 1;
}

/** Muse cat: layered procedural animation (see museAnimator.ts). */
export function drawMuseCat(
  ctx: CanvasRenderingContext2D,
  size: number,
  mood: CatMood,
  _tick: number,
  effects = true,
  speed = 1,
) {
  const anim = getAnimator(ctx);
  anim.effects = effects;
  anim.speed = speed;
  anim.render(ctx, size, mood);
}

const RING_INK: Record<Tone, string> = {
  good: "rgba(255, 255, 255, 0.86)",
  warn: "#e3b341",
  bad: "#ff6b7a",
};

/**
 * Ring gauge: outer ring = 5-hour window, inner ring = weekly window, of the
 * focus account (the one an agent is using, else the best next pick). Each ring
 * fills with what is left; the small tick marks how much of the window's time
 * is left, so a fill shorter than the tick means it is being used faster than
 * time passes. Centre: the lower of the two. No glow, no decorative motion.
 */
export function drawRingGauge(
  ctx: CanvasRenderingContext2D,
  size: number,
  focus: Focus | null,
  settings: AppSettings,
  dpr = 1,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  const c = size / 2;
  const outerW = Math.max(3, size * 0.085);
  const innerW = Math.max(2, size * 0.055);
  const gap = Math.max(1.5, size * 0.03);
  const r1 = size * 0.46 - outerW / 2;
  const r2 = r1 - outerW / 2 - gap - innerW / 2;

  ctx.save();
  // Disc: a quiet graphite surface so the rings read on any wallpaper.
  ctx.beginPath();
  ctx.arc(c, c, size * 0.48, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(32, 32, 32, 0.92)";
  ctx.fill();
  ctx.lineWidth = Math.max(1, size / 64);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.stroke();
  // Old or missing data: everything on the disc fades.
  ctx.globalAlpha = focus && !focus.stale ? 1 : 0.4;

  const ring = (w: QuotaWindow | null, r: number, lw: number) => {
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = lw;
    ctx.stroke();
    if (!w || !focus) return;
    const pct = Math.max(0, Math.min(100, w.remainingPercent));
    const top = -Math.PI / 2;
    if (pct > 0) {
      ctx.beginPath();
      ctx.arc(c, c, r, top, top + (pct / 100) * Math.PI * 2);
      ctx.strokeStyle = RING_INK[toneOf(pct, settings, focus.acc.id)];
      ctx.lineWidth = lw;
      ctx.lineCap = "butt";
      ctx.stroke();
    }
    const el = elapsedShare(w);
    if (el != null) {
      // A notch cut through the ring: dark on the fill, light on the empty track.
      const ang = top + (1 - el) * Math.PI * 2;
      const notch = Math.max(1.5, size / 36) / r;
      ctx.beginPath();
      ctx.arc(c, c, r, ang - notch / 2, ang + notch / 2);
      ctx.strokeStyle = pct / 100 > 1 - el ? "rgb(32, 32, 32)" : "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth = lw + 1;
      ctx.stroke();
    }
  };
  ring(focus?.short ?? null, r1, outerW);
  ring(focus?.long ?? null, r2, innerW);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const tight = focus?.tight;
  const value = tight ? `${Math.max(0, Math.round(tight.remainingPercent))}` : "–";
  const showLabel = size / dpr >= 88 && !!tight;
  const numSize = Math.round(size * (value.length >= 3 ? 0.22 : 0.27));
  ctx.font = `600 ${numSize}px "Segoe UI Variable Display", "Segoe UI", sans-serif`;
  ctx.fillStyle = tight && focus ? RING_INK[toneOf(tight.remainingPercent, settings, focus.acc.id)] : "rgba(255,255,255,0.6)";
  if (tight && toneOf(tight.remainingPercent, settings, focus!.acc.id) === "good") ctx.fillStyle = "#ffffff";
  ctx.fillText(value, c, showLabel ? c - size * 0.04 : c + size * 0.01);
  if (showLabel) {
    ctx.font = `500 ${Math.round(size * 0.1)}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.fillText(windowWord(tight), c, c + size * 0.15);
  }
  ctx.restore();
}

/**
 * 2. Custom User Avatar / Virtual Pet
 * Renders user-supplied images with dynamic state-based physics & badges.
 */
export function drawCustomAvatar(
  ctx: CanvasRenderingContext2D,
  size: number,
  mood: CatMood,
  tick: number,
  settings: AppSettings,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);

  // Priority: state-specific image -> any available custom image
  const imgWorking = getCachedImage(settings.customImageWorking);
  const imgSweating = getCachedImage(settings.customImageSweating);
  const imgSleeping = getCachedImage(settings.customImageSleeping);

  let activeImg: HTMLImageElement | null = null;
  if (mood === "sleeping") {
    activeImg = imgSleeping || imgWorking || imgSweating;
  } else if (mood === "sweating") {
    activeImg = imgSweating || imgWorking || imgSleeping;
  } else {
    activeImg = imgWorking || imgSweating || imgSleeping;
  }

  // Placeholder if user hasn't chosen an image yet
  if (!activeImg) {
    ctx.save();
    const center = size / 2;
    const r = size * 0.42;

    ctx.beginPath();
    ctx.arc(center, center, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(20, 24, 38, 0.85)";
    ctx.fill();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(96, 165, 250, 0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(size * 0.32)}px sans-serif`;
    ctx.fillText("🖼️", center, center - 2);

    if (size >= 64) {
      ctx.font = `600 ${Math.max(9, Math.round(size * 0.12))}px "Segoe UI", sans-serif`;
      ctx.fillStyle = "#939bb0";
      ctx.fillText("Set image", center, center + Math.round(size * 0.25));
    }
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.imageSmoothingEnabled = true;

  // State-specific animation transformations
  let offsetX = 0;
  let offsetY = 0;
  let alpha = 1.0;

  if (mood === "working") {
    // Gentle breathing bob
    offsetY = Math.sin((tick % 40) / 40 * Math.PI * 2) * (size * 0.02);
  } else if (mood === "sweating") {
    // Anxious rapid tremor
    offsetX = Math.sin(tick * 1.8) * (size * 0.03);
  } else if (mood === "sleeping") {
    // Dimmed resting state
    alpha = 0.72;
    offsetY = size * 0.04;
  }

  ctx.globalAlpha = alpha;

  // Fit image inside bounding box (preserving aspect ratio)
  const pad = Math.round(size * 0.08);
  const maxW = size - pad * 2;
  const maxH = size - pad * 2;
  const nw = activeImg.naturalWidth;
  const nh = activeImg.naturalHeight;
  const aspect = nw / nh;

  let drawW = maxW;
  let drawH = maxW / aspect;
  if (drawH > maxH) {
    drawH = maxH;
    drawW = maxH * aspect;
  }

  const posX = (size - drawW) / 2 + offsetX;
  const posY = (size - drawH) / 2 + offsetY;

  ctx.drawImage(activeImg, posX, posY, drawW, drawH);

  // Overlay state badges if using a single fallback image
  if (mood === "sweating" && !settings.customImageSweating) {
    // Sweat drop badge
    ctx.font = `${Math.round(size * 0.28)}px sans-serif`;
    ctx.fillText("💦", size - Math.round(size * 0.26), Math.round(size * 0.28));
  } else if (mood === "sleeping" && !settings.customImageSleeping) {
    // Floating Zzz
    const zPhase = (tick % 30) / 30;
    const zX = size - Math.round(size * 0.32);
    const zY = Math.round(size * 0.32) - zPhase * 8;
    ctx.font = `bold ${Math.round(size * 0.2)}px sans-serif`;
    ctx.fillStyle = `rgba(147, 197, 253, ${1 - zPhase * 0.6})`;
    ctx.fillText("Zzz", zX, zY);
  }

  ctx.restore();
}

/**
 * Universal Avatar Renderer
 * Dispatches to HUD gauge, DeskCat, or Custom avatar based on user settings.
 */
export function renderAvatar(
  ctx: CanvasRenderingContext2D,
  size: number,
  theme: PetTheme,
  focus: Focus | null,
  mood: CatMood,
  tick: number,
  settings: AppSettings,
  dpr = 1,
) {
  if (theme === "desk_cat") {
    drawMuseCat(ctx, size, mood, tick, settings.petEffects !== false, animSpeedFactor(settings));
  } else if (theme === "custom") {
    drawCustomAvatar(ctx, size, mood, tick, settings);
  } else {
    drawRingGauge(ctx, size, focus, settings, dpr);
  }
}
