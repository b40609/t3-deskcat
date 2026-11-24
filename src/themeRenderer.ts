import { elapsedShare, toneOf, windowSeconds, type Focus, type Tone } from "./focus";
import type { AppSettings, CatMood, PetTheme, ProviderKind, QuotaWindow } from "./types";

export const HUD_CARD_BASE_W = 178;
export const HUD_CARD_BASE_H = 64;

export function normalizePetTheme(theme?: string | null): PetTheme {
  return theme === "custom" ? "custom" : "hud_gauge";
}

/** Smooth, compact scale factor for the horizontal HUD card (petSize 48..128 -> 0.88..1.22). */
export function hudCardScale(petSize: number): number {
  const clamped = Math.max(48, Math.min(128, petSize));
  if (clamped <= 64) {
    return 0.88 + ((clamped - 48) / 16) * 0.12;
  }
  return 1 + ((clamped - 64) / 64) * 0.22;
}

export function petLogicalSize(petSize: number, theme?: string | null): { width: number; height: number } {
  if (normalizePetTheme(theme) === "hud_gauge") {
    const s = hudCardScale(petSize);
    return {
      width: Math.round(HUD_CARD_BASE_W * s),
      height: Math.round(HUD_CARD_BASE_H * s),
    };
  }
  return { width: petSize, height: petSize };
}

const imageCache: Record<string, HTMLImageElement> = {};

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

export function animSpeedFactor(_s: AppSettings): number {
  return 1;
}

interface GaugePalette {
  surface: string;
  border: string;
  highlight: string;
  track: string;
  text: string;
  textMuted: string;
  sep: string;
  tickFill: string;
  tickStroke: string;
  tone: Record<Tone, string>;
  provider: Record<ProviderKind, string>;
}

const DARK_PALETTE: GaugePalette = {
  surface: "rgba(28, 28, 30, 0.94)",
  border: "rgba(255, 255, 255, 0.13)",
  highlight: "rgba(255, 255, 255, 0.06)",
  track: "rgba(255, 255, 255, 0.11)",
  text: "#ffffff",
  textMuted: "rgba(255, 255, 255, 0.54)",
  sep: "rgba(255, 255, 255, 0.24)",
  tickFill: "#ffffff",
  tickStroke: "rgb(28, 28, 30)",
  tone: {
    good: "#6ccb5f",
    warn: "#e3b341",
    bad: "#ff6b7a",
  },
  provider: {
    claude: "#e08a6a",
    antigravity: "#7aa7ff",
    codex: "#4cc79a",
  },
};

const LIGHT_PALETTE: GaugePalette = {
  surface: "rgba(250, 250, 250, 0.96)",
  border: "rgba(0, 0, 0, 0.12)",
  highlight: "rgba(255, 255, 255, 0.85)",
  track: "rgba(0, 0, 0, 0.09)",
  text: "#1b1b1b",
  textMuted: "rgba(0, 0, 0, 0.54)",
  sep: "rgba(0, 0, 0, 0.22)",
  tickFill: "#1b1b1b",
  tickStroke: "rgb(250, 250, 250)",
  tone: {
    good: "#0f7b0f",
    warn: "#a25e00",
    bad: "#c42b1c",
  },
  provider: {
    claude: "#c96442",
    antigravity: "#3367d6",
    codex: "#10865f",
  },
};

export function resolveGaugeDark(settings: AppSettings): boolean {
  if (settings.appearance === "light") return false;
  if (settings.appearance === "dark") return true;
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "…";
  const ellW = ctx.measureText(ellipsis).width;
  if (ellW >= maxWidth) return "";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid)).width + ellW <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : ellipsis;
}

function shortWindowTag(w: QuotaWindow): string {
  const len = windowSeconds(w.label);
  if (len == null) return w.label.slice(0, 4);
  return len >= 2 * 86400 ? "Wk" : `${Math.round(len / 3600)}h`;
}

/**
 * Horizontal pill HUD gauge: concentric dual rings on the left (outer = 5h,
 * inner = weekly) with semantic colors (green/amber/red), paired with account
 * identity (provider dot + name) and clear window percentages on the right.
 */
export function drawRingGauge(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  focus: Focus | null,
  settings: AppSettings,
  dpr = 1,
  activeWorking = false,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;

  const pal = resolveGaugeDark(settings) ? DARK_PALETTE : LIGHT_PALETTE;
  const showUsed = settings.usageDisplay === "used";
  const paceMode = settings.paceTick ?? "ahead";
  const isPill = width >= height * 1.4;

  const pad = Math.max(1.5 * dpr, height * 0.045);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const pillR = innerH / 2;
  const cx = isPill ? pad + pillR : width / 2;
  const cy = height / 2;

  ctx.save();

  // Pill (or disc fallback) surface with hairline border + subtle top sheen.
  roundedRectPath(ctx, pad, pad, innerW, innerH, pillR);
  ctx.fillStyle = pal.surface;
  ctx.fill();
  ctx.lineWidth = Math.max(1, dpr);
  ctx.strokeStyle = pal.border;
  ctx.stroke();

  if (innerH >= 36 * dpr) {
    ctx.save();
    roundedRectPath(ctx, pad + dpr * 0.5, pad + dpr * 0.5, innerW - dpr, innerH - dpr, pillR);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(pad + pillR * 0.6, pad + dpr);
    ctx.lineTo(pad + innerW - pillR * 0.6, pad + dpr);
    ctx.strokeStyle = pal.highlight;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.stroke();
    ctx.restore();
  }

  // Concentric rings: outer = session (5h) or single window, inner = weekly.
  const hasBoth = !!(focus?.short && focus?.long);
  const outerWin = focus?.short ?? focus?.long ?? null;
  const innerWin = hasBoth ? focus!.long : null;

  const outerLw = Math.max(2.2 * dpr, innerH * 0.088);
  const innerLw = Math.max(1.6 * dpr, outerLw * 0.62);
  const ringGap = Math.max(1.5 * dpr, innerH * 0.05);
  const r1 = innerH * 0.345;
  const r2 = r1 - outerLw / 2 - ringGap - innerLw / 2;

  const drawArcRing = (w: QuotaWindow | null, r: number, lw: number, secondary: boolean) => {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = pal.track;
    ctx.lineWidth = lw;
    ctx.stroke();

    if (!w || !focus) {
      ctx.restore();
      return;
    }

    const rem = Math.max(0, Math.min(100, w.remainingPercent));
    const fillPct = showUsed ? 100 - rem : rem;
    const tone = toneOf(rem, settings, focus.acc.id);
    const color = pal.tone[tone];
    const top = -Math.PI / 2;

    if (fillPct > 0.4) {
      ctx.beginPath();
      if (fillPct >= 99.6) {
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      } else {
        ctx.arc(cx, cy, r, top, top + (fillPct / 100) * Math.PI * 2);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      if (focus.stale) {
        ctx.globalAlpha = secondary && tone === "good" ? 0.45 : 0.72;
      } else if (secondary && tone === "good") {
        ctx.globalAlpha = 0.62;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Pace dot: sits smoothly on the ring without cutting a notch into the arc.
    if (paceMode !== "off") {
      const el = elapsedShare(w);
      if (el != null) {
        const ahead = 100 - rem > el * 100;
        if (paceMode === "on" || ahead) {
          const share = showUsed ? el : 1 - el;
          const ang = top + share * Math.PI * 2;
          const px = cx + Math.cos(ang) * r;
          const py = cy + Math.sin(ang) * r;
          const dotR = Math.max(1.5 * dpr, lw * 0.42);
          ctx.beginPath();
          ctx.arc(px, py, dotR, 0, Math.PI * 2);
          ctx.fillStyle = pal.tickFill;
          ctx.fill();
          ctx.lineWidth = Math.max(1, dpr * 0.9);
          ctx.strokeStyle = pal.tickStroke;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  };

  drawArcRing(outerWin, r1, outerLw, false);
  if (hasBoth) {
    drawArcRing(innerWin, r2, innerLw, true);
  }

  // Centre readout: tightest window integer, crisp and optically centred.
  const tight = focus?.tight ?? null;
  const tightRem = tight ? Math.max(0, Math.min(100, tight.remainingPercent)) : null;
  const tightDisp = tightRem != null ? Math.round(showUsed ? 100 - tightRem : tightRem) : null;
  const centerVal = tightDisp != null ? `${tightDisp}` : "–";
  const tightTone: Tone = tightRem != null && focus ? toneOf(tightRem, settings, focus.acc.id) : "good";

  const baseNumScale = hasBoth ? (centerVal.length >= 3 ? 0.195 : 0.235) : centerVal.length >= 3 ? 0.23 : 0.275;
  const numSize = Math.round(innerH * baseNumScale);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${numSize}px "Segoe UI Variable Display", "Segoe UI", sans-serif`;
  ctx.fillStyle = tightDisp == null ? pal.textMuted : tightTone === "good" ? pal.text : pal.tone[tightTone];
  if (focus?.stale) ctx.globalAlpha = 0.78;
  ctx.fillText(centerVal, cx, cy + numSize * 0.04);
  ctx.globalAlpha = 1;

  if (!isPill) {
    ctx.restore();
    return;
  }

  // Right info block: Row 1 = provider dot + account name (+ stale mark),
  // Row 2 = window tags with semantic colored percentages.
  const textLeft = pad + innerH - innerH * 0.03;
  const textRight = width - pad - Math.max(8 * dpr, innerH * 0.22);
  const availW = Math.max(0, textRight - textLeft);

  if (availW <= 12 * dpr) {
    ctx.restore();
    return;
  }

  const row1Y = cy - innerH * 0.165;
  const row2Y = cy + innerH * 0.195;

  if (!focus) {
    const titleSize = Math.round(innerH * 0.22);
    const subSize = Math.round(innerH * 0.175);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${titleSize}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
    ctx.fillStyle = pal.text;
    ctx.fillText(truncateText(ctx, "DeskCat", availW), textLeft, row1Y);
    ctx.font = `400 ${subSize}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
    ctx.fillStyle = pal.textMuted;
    ctx.fillText(truncateText(ctx, "No accounts", availW), textLeft, row2Y);
    ctx.restore();
    return;
  }

  // Row 1: Provider dot + optional working halo + Account Name + optional stale badge
  const dotR = Math.max(2.6 * dpr, innerH * 0.068);
  const dotCx = textLeft + dotR;
  const provColor = pal.provider[focus.acc.provider] ?? pal.textMuted;

  if (activeWorking) {
    ctx.beginPath();
    ctx.arc(dotCx, row1Y, dotR * 1.9, 0, Math.PI * 2);
    ctx.fillStyle = provColor;
    ctx.globalAlpha = 0.24;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.beginPath();
  ctx.arc(dotCx, row1Y, dotR, 0, Math.PI * 2);
  ctx.fillStyle = provColor;
  ctx.fill();

  const staleSpace = focus.stale ? dotR * 2.6 + 4 * dpr : 0;
  const nameX = dotCx + dotR + Math.max(4 * dpr, innerH * 0.09);
  const nameMaxW = Math.max(0, textRight - nameX - staleSpace);
  const nameSize = Math.round(innerH * 0.235);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${nameSize}px "Segoe UI Variable Text", "Segoe UI", "Microsoft JhengHei UI", "PingFang TC", sans-serif`;
  ctx.fillStyle = pal.text;
  if (focus.stale) ctx.globalAlpha = 0.8;
  ctx.fillText(truncateText(ctx, focus.name, nameMaxW), nameX, row1Y);
  ctx.globalAlpha = 1;

  if (focus.stale) {
    const sx = textRight - dotR;
    ctx.beginPath();
    ctx.arc(sx, row1Y, dotR * 0.85, 0, Math.PI * 2);
    ctx.strokeStyle = pal.tone.warn;
    ctx.lineWidth = Math.max(1.2 * dpr, innerH * 0.025);
    ctx.stroke();
  }

  // Row 2: Window metrics — e.g. "5h 98% · Wk 89%" with adaptive fit.
  interface MetricPart {
    tag: string;
    val: string;
    tone: Tone;
  }
  const makePart = (w: QuotaWindow): MetricPart => {
    const rem = Math.max(0, Math.min(100, w.remainingPercent));
    const disp = Math.round(showUsed ? 100 - rem : rem);
    return {
      tag: shortWindowTag(w),
      val: `${disp}%`,
      tone: toneOf(rem, settings, focus.acc.id),
    };
  };

  const parts: MetricPart[] = [];
  if (focus.short) parts.push(makePart(focus.short));
  if (focus.long) parts.push(makePart(focus.long));

  if (parts.length > 0) {
    const drawParts = (list: MetricPart[], fontSize: number, sepText: string, measureOnly: boolean): number => {
      const tagFont = `500 ${fontSize}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
      const valFont = `600 ${fontSize}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
      const gapTagVal = Math.max(2 * dpr, fontSize * 0.24);
      let x = textLeft;

      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (i > 0) {
          ctx.font = tagFont;
          const sw = ctx.measureText(sepText).width;
          if (!measureOnly) {
            ctx.fillStyle = pal.sep;
            ctx.fillText(sepText, x, row2Y);
          }
          x += sw;
        }
        ctx.font = tagFont;
        const tw = ctx.measureText(p.tag).width;
        if (!measureOnly) {
          ctx.fillStyle = pal.textMuted;
          ctx.fillText(p.tag, x, row2Y);
        }
        x += tw + gapTagVal;

        ctx.font = valFont;
        const vw = ctx.measureText(p.val).width;
        if (!measureOnly) {
          ctx.fillStyle = p.tone === "good" ? pal.tone.good : pal.tone[p.tone];
          if (focus.stale) ctx.globalAlpha = 0.78;
          ctx.fillText(p.val, x, row2Y);
          ctx.globalAlpha = 1;
        }
        x += vw;
      }
      return x - textLeft;
    };

    const baseSub = Math.round(innerH * 0.195);
    const compactSub = Math.max(Math.round(9 * dpr), Math.round(innerH * 0.175));

    if (parts.length === 2) {
      if (drawParts(parts, baseSub, " · ", true) <= availW) {
        drawParts(parts, baseSub, " · ", false);
      } else if (drawParts(parts, compactSub, " · ", true) <= availW) {
        drawParts(parts, compactSub, " · ", false);
      } else if (drawParts(parts, compactSub, " ", true) <= availW) {
        drawParts(parts, compactSub, " ", false);
      } else if (tight) {
        drawParts([makePart(tight)], baseSub, "", false);
      }
    } else {
      drawParts(parts, baseSub, "", false);
    }
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
 * Dispatches to HUD gauge or Custom avatar based on user settings.
 */
export function renderAvatar(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: PetTheme | string | null | undefined,
  focus: Focus | null,
  mood: CatMood,
  tick: number,
  settings: AppSettings,
  dpr = 1,
  activeWorking = false,
) {
  const size = Math.min(width, height);
  if (normalizePetTheme(theme) === "custom") {
    drawCustomAvatar(ctx, size, mood, tick, settings);
  } else {
    drawRingGauge(ctx, width, height, focus, settings, dpr, activeWorking);
  }
}
