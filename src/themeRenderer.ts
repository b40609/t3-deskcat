import { drawDeskCat } from "./catSprite";
import { MUSE_ASSETS } from "./museAssets";
import { getAnimator } from "./museAnimator";
import type { AppSettings, CatMood, PetTheme } from "./types";

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

/** Muse cat: layered procedural animation (see museAnimator.ts). */
export function drawMuseCat(
  ctx: CanvasRenderingContext2D,
  size: number,
  mood: CatMood,
  _tick: number,
  effects = true,
) {
  const anim = getAnimator(ctx);
  anim.effects = effects;
  anim.render(ctx, size, mood);
}

/**
 * 1. Professional HUD Radial Gauge
 * Clean, distraction-free, high-precision developer aesthetic.
 */
export function drawHudGauge(
  ctx: CanvasRenderingContext2D,
  size: number,
  score: number,
  mood: CatMood,
  tick: number,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;

  const center = size / 2;
  const radius = size * 0.38;
  const strokeWidth = Math.max(3, Math.round(size * 0.085));

  ctx.save();

  // Dark glassy background disc
  ctx.beginPath();
  ctx.arc(center, center, radius + strokeWidth * 0.9, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(11, 15, 25, 0.88)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Outer track ring
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = "round";
  ctx.stroke();

  // Mood color schemes
  let primaryColor = "#00f0ff";
  let glowColor = "rgba(0, 240, 255, 0.5)";
  let labelText = "NOMINAL";

  if (mood === "sweating") {
    primaryColor = "#ffb020";
    glowColor = "rgba(255, 176, 32, 0.5)";
    labelText = "ALERT";
  } else if (mood === "sleeping") {
    primaryColor = "#ff3366";
    glowColor = "rgba(255, 51, 102, 0.55)";
    labelText = "DRAINED";
  }

  // Active progress arc (from -90° clockwise)
  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  const startAngle = -Math.PI / 2;
  const arcLength = (clampedScore / 100) * (Math.PI * 2);
  const endAngle = startAngle + arcLength;

  if (clampedScore > 0) {
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = Math.round(size * 0.1);

    ctx.beginPath();
    ctx.arc(center, center, radius, startAngle, endAngle);
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = "round";
    ctx.stroke();

    ctx.shadowBlur = 0;
  }

  // Subtle rotating scanner tick on outer rim
  const scanAngle = (tick % 100) / 100 * (Math.PI * 2) - Math.PI / 2;
  const scanX = center + Math.cos(scanAngle) * radius;
  const scanY = center + Math.sin(scanAngle) * radius;
  ctx.beginPath();
  ctx.arc(scanX, scanY, Math.max(1, size * 0.02), 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.fill();

  // Inner subtle concentric radar line
  ctx.beginPath();
  ctx.arc(center, center, radius * 0.62, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Center Score Number
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const numFontSize = Math.round(size * 0.29);
  ctx.font = `700 ${numFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;
  ctx.fillStyle = "#ffffff";
  const numY = size >= 58 ? center - Math.round(size * 0.05) : center;
  ctx.fillText(`${clampedScore}%`, center, numY);

  // Status subtext when space allows
  if (size >= 58) {
    const subFontSize = Math.max(8, Math.round(size * 0.11));
    ctx.font = `600 ${subFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillStyle = primaryColor;
    ctx.fillText(labelText, center, center + Math.round(size * 0.22));
  }

  // Blinking health pulse indicator at top
  const pulseBlink = Math.sin((tick % 24) / 24 * Math.PI * 2) > -0.2;
  ctx.beginPath();
  ctx.arc(center, center - radius - strokeWidth * 0.85, Math.max(1.5, size * 0.03), 0, Math.PI * 2);
  ctx.fillStyle = pulseBlink ? primaryColor : "rgba(255, 255, 255, 0.15)";
  ctx.fill();

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
      ctx.fillText("點擊設定", center, center + Math.round(size * 0.25));
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
  score: number,
  mood: CatMood,
  tick: number,
  settings: AppSettings,
) {
  if (theme === "desk_cat") {
    drawMuseCat(ctx, size, mood, tick, settings.petEffects !== false);
  } else if (theme === "custom") {
    drawCustomAvatar(ctx, size, mood, tick, settings);
  } else {
    // Default to HUD Gauge (Professional & practical)
    drawHudGauge(ctx, size, score, mood, tick);
  }
}
