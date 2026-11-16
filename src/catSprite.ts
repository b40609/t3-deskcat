import type { CatMood } from "./types";

const GRID = 32;

const C = {
  outline: "#1c1926",
  fur: "#fff8ec",
  furShade: "#eadbc5",
  earPink: "#f9a8d4",
  eye: "#1e2230",
  nose: "#f472b6",
  cheek: "#fecdd3",
  tie: "#ef4444",
  tieDark: "#b91c1c",
  collar: "#3b82f6",
  desk: "#475569",
  deskTop: "#64748b",
  kb: "#cbd5e1",
  kbKey: "#475569",
  monFrame: "#334155",
  monStand: "#1e293b",
  screenWork: "#38bdf8",
  screenWorkHi: "#a7f3d0",
  screenWarn: "#fbbf24",
  screenWarnHi: "#fef08a",
  screenSleep: "#1e293b",
  sweat: "#38bdf8",
  sweatHi: "#e0f2fe",
  mug: "#f8fafc",
  coffee: "#92400e",
  steam: "#e2e8f0",
  zzz: "#94a3b8",
  zzzHi: "#e2e8f0",
} as const;

function px(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  scale: number,
) {
  ctx.fillStyle = color;
  ctx.fillRect(
    Math.round(x * scale),
    Math.round(y * scale),
    Math.max(1, Math.round(w * scale)),
    Math.max(1, Math.round(h * scale)),
  );
}

/**
 * Renders a crisp 32x32 side-view "Salary Cat" (月薪貓) typing at a desk.
 * Scales cleanly at 48px..128px with pixel-exact edges.
 */
export function drawSalaryCat(
  ctx: CanvasRenderingContext2D,
  canvasSize: number,
  mood: CatMood,
  tick: number,
) {
  ctx.clearRect(0, 0, canvasSize, canvasSize);
  ctx.imageSmoothingEnabled = false;
  const s = canvasSize / GRID;

  // 1. Desk & Monitor (right side, side profile)
  // Desk top & legs
  px(ctx, 2, 26, 28, 2, C.deskTop, s);
  px(ctx, 2, 28, 28, 1, C.desk, s);
  px(ctx, 3, 29, 2, 2, C.outline, s);
  px(ctx, 27, 29, 2, 2, C.outline, s);

  // Monitor stand + bezel (side-angled)
  px(ctx, 25, 23, 3, 3, C.monStand, s);
  px(ctx, 23, 25, 6, 1, C.outline, s);
  px(ctx, 22, 12, 8, 11, C.outline, s);
  px(ctx, 23, 13, 6, 9, C.monFrame, s);

  const screenColor =
    mood === "working"
      ? C.screenWork
      : mood === "sweating"
        ? C.screenWarn
        : C.screenSleep;
  const hiColor =
    mood === "working"
      ? C.screenWorkHi
      : mood === "sweating"
        ? C.screenWarnHi
        : "#334155";
  px(ctx, 23, 14, 4, 7, screenColor, s);

  // Tiny animated code lines on screen when awake
  if (mood !== "sleeping") {
    const linePhase = Math.floor(tick / 4) % 3;
    px(ctx, 24, 15 + linePhase, 2, 1, hiColor, s);
    px(ctx, 24, 15 + ((linePhase + 1) % 3), 3, 1, hiColor, s);
  } else {
    px(ctx, 24, 17, 2, 1, hiColor, s);
  }

  // Keyboard on desk
  px(ctx, 16, 24, 6, 2, C.outline, s);
  px(ctx, 17, 24, 4, 1, C.kb, s);

  if (mood === "sleeping") {
    drawSleepingCat(ctx, s, tick);
    return;
  }

  const fast = mood === "sweating";
  const step = fast ? Math.floor(tick / 2) % 4 : Math.floor(tick / 4) % 4;
  const bob = step === 1 || step === 3 ? 0 : 0; // crisp silhouette
  const lean = mood === "sweating" ? 1 : 0;

  // Tail (left side, wagging gently)
  const tailY = step < 2 ? 18 : 17;
  px(ctx, 3, tailY + 2, 3, 2, C.outline, s);
  px(ctx, 2, tailY, 2, 3, C.outline, s);
  px(ctx, 3, tailY + 1, 2, 2, C.furShade, s);
  px(ctx, 4, tailY + 2, 2, 1, C.fur, s);

  // Body (side-view sitting upright)
  px(ctx, 6 + lean, 16, 9, 10, C.outline, s);
  px(ctx, 7 + lean, 17, 7, 8, C.fur, s);
  px(ctx, 7 + lean, 21, 3, 4, C.furShade, s);

  // Blue collar + Iconic Red Salary-Cat Necktie
  px(ctx, 11 + lean, 16, 4, 1, C.collar, s);
  px(ctx, 14 + lean, 17, 2, 3, C.tie, s);
  px(ctx, 15 + lean, 20, 1, 2, C.tieDark, s);

  // Head (side profile facing right)
  const hy = 6 + bob;
  const hx = 6 + lean;
  // Back ear
  px(ctx, hx + 1, hy - 2, 3, 3, C.outline, s);
  px(ctx, hx + 2, hy - 1, 1, 2, C.furShade, s);
  // Front ear
  px(ctx, hx + 5, hy - 3, 3, 4, C.outline, s);
  px(ctx, hx + 6, hy - 2, 1, 2, C.earPink, s);

  // Cranium + snout
  px(ctx, hx, hy, 10, 9, C.outline, s);
  px(ctx, hx + 1, hy + 1, 8, 7, C.fur, s);
  px(ctx, hx + 9, hy + 4, 2, 4, C.outline, s);
  px(ctx, hx + 8, hy + 4, 2, 3, C.fur, s);

  // Eye (blinks occasionally when working, wide focused when sweating)
  const blink = mood === "working" && tick % 44 >= 41;
  if (blink) {
    px(ctx, hx + 6, hy + 4, 2, 1, C.eye, s);
  } else {
    px(ctx, hx + 6, hy + 3, 2, 2, C.eye, s);
    px(ctx, hx + 6, hy + 3, 1, 1, "#ffffff", s);
  }

  // Pink nose & blush
  px(ctx, hx + 10, hy + 5, 1, 1, C.nose, s);
  px(ctx, hx + 5, hy + 6, 2, 1, C.cheek, s);

  // Typing paws (alternating on keyboard!)
  const pawA = step === 0 || step === 1 ? 23 : 22;
  const pawB = step === 2 || step === 3 ? 23 : 22;
  px(ctx, 14 + lean, pawA, 4, 2, C.outline, s);
  px(ctx, 14 + lean, pawA, 3, 1, C.fur, s);
  px(ctx, 15 + lean, pawB + 1, 4, 2, C.outline, s);
  px(ctx, 15 + lean, pawB + 1, 3, 1, C.furShade, s);

  // Key press flash
  px(ctx, step % 2 === 0 ? 18 : 19, 24, 1, 1, C.kbKey, s);

  // Sweating extras: coffee mug + dripping sweat bead
  if (mood === "sweating") {
    // Tiny coffee mug on desk
    px(ctx, 20, 22, 3, 4, C.outline, s);
    px(ctx, 20, 23, 2, 2, C.mug, s);
    px(ctx, 20, 22, 2, 1, C.coffee, s);
    const steamY = 20 - (Math.floor(tick / 4) % 2);
    px(ctx, 20, steamY, 1, 1, C.steam, s);

    // Animated sweat drop on temple
    const dropOffset = Math.floor(tick / 3) % 3;
    px(ctx, hx + 3, hy + 2 + dropOffset, 1, 2, C.sweat, s);
    px(ctx, hx + 3, hy + 2 + dropOffset, 1, 1, C.sweatHi, s);
  }
}

function drawSleepingCat(
  ctx: CanvasRenderingContext2D,
  s: number,
  tick: number,
) {
  const breathe = Math.floor(tick / 10) % 2;

  // Tail curled behind
  px(ctx, 2, 24, 4, 2, C.outline, s);
  px(ctx, 3, 24, 3, 1, C.furShade, s);

  // Body slumped flat on desk
  px(ctx, 5, 19 + breathe, 10, 7 - breathe, C.outline, s);
  px(ctx, 6, 20 + breathe, 8, 5 - breathe, C.fur, s);
  px(ctx, 6, 23, 4, 2, C.furShade, s);

  // Tie tucked on desk
  px(ctx, 13, 24, 2, 2, C.tie, s);

  // Head resting on keyboard!
  px(ctx, 11, 15, 9, 9, C.outline, s);
  px(ctx, 12, 16, 7, 7, C.fur, s);
  // Droopy ears
  px(ctx, 12, 13, 2, 2, C.outline, s);
  px(ctx, 16, 13, 2, 2, C.outline, s);
  px(ctx, 16, 14, 1, 1, C.earPink, s);

  // Closed sleepy eye & tiny nose
  px(ctx, 16, 19, 2, 1, C.eye, s);
  px(ctx, 19, 20, 1, 1, C.nose, s);

  // Floating Zzz
  const zPhase = Math.floor(tick / 8) % 3;
  const zy1 = 11 - zPhase;
  px(ctx, 15, zy1, 3, 1, C.zzz, s);
  px(ctx, 16, zy1 + 1, 1, 1, C.zzz, s);
  px(ctx, 15, zy1 + 2, 3, 1, C.zzz, s);

  if (zPhase >= 1) {
    px(ctx, 19, 7 - zPhase, 2, 1, C.zzzHi, s);
    px(ctx, 19, 8 - zPhase, 2, 1, C.zzzHi, s);
  }
}
