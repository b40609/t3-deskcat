import { MUSE_ASSETS } from "./museAssets";
import type { CatMood } from "./types";

/**
 * Layered procedural animator for the Muse cat.
 *
 * The source art is three static 512×512 PNGs. At load time we analyse each
 * image, find the eyes (and the sweat drop) by colour, paint them out of the
 * base layer, and redraw them as separate layers. That lets the cat blink,
 * glance around and have its sweat drop actually slide down, on top of
 * body-level squash/stretch, sway, hops and particle effects.
 */

const S = 512; // art space
const PIVOT_X = 256;
const PIVOT_Y = 450; // where the cat "sits" (bottom of laptop / body)

interface Blob {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  area: number;
  r: number;
  g: number;
  b: number;
  spans: Map<number, [number, number]>;
}

interface EyeLayer {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DropInfo {
  cx: number;
  cy: number;
  w: number;
  h: number;
  color: string;
}

interface Prepared {
  base: HTMLCanvasElement;
  eyes: EyeLayer[];
  drop: DropInfo | null;
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export function blueWeight(r: number, g: number, b: number, a: number) {
  if (a < 100) return 0;
  const d = b - Math.max(r, g * 0.9);
  if (b < 120 || d < 40) return 0;
  return Math.min(1, (d - 40) / 70);
}

export function findBlobs(data: Uint8ClampedArray, W: number, H: number): Blob[] {
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (blueWeight(data[o], data[o + 1], data[o + 2], data[o + 3]) > 0.15) mask[i] = 1;
  }
  const seen = new Uint8Array(W * H);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || seen[start]) continue;
    const blob: Blob = {
      minX: W, maxX: 0, minY: H, maxY: 0, area: 0, r: 0, g: 0, b: 0, spans: new Map(),
    };
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % W;
      const y = (i / W) | 0;
      blob.area++;
      blob.r += data[i * 4];
      blob.g += data[i * 4 + 1];
      blob.b += data[i * 4 + 2];
      if (x < blob.minX) blob.minX = x;
      if (x > blob.maxX) blob.maxX = x;
      if (y < blob.minY) blob.minY = y;
      if (y > blob.maxY) blob.maxY = y;
      const span = blob.spans.get(y);
      if (!span) blob.spans.set(y, [x, x]);
      else {
        if (x < span[0]) span[0] = x;
        if (x > span[1]) span[1] = x;
      }
      const n = [i - 1, i + 1, i - W, i + W];
      for (const j of n) {
        if (j < 0 || j >= W * H || seen[j] || !mask[j]) continue;
        if (Math.abs((j % W) - x) > 1) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (blob.area >= 40) {
      blob.r /= blob.area;
      blob.g /= blob.area;
      blob.b /= blob.area;
      blobs.push(blob);
    }
  }
  return blobs;
}

/** Paint a blob out of the image by interpolating each row between its outside neighbours. */
function eraseBlob(data: Uint8ClampedArray, W: number, H: number, blob: Blob, pad: number) {
  const y0 = Math.max(0, blob.minY - pad);
  const y1 = Math.min(H - 1, blob.maxY + pad);
  for (let y = y0; y <= y1; y++) {
    const ref = blob.spans.get(Math.min(blob.maxY, Math.max(blob.minY, y)));
    if (!ref) continue;
    const x0 = Math.max(1, ref[0] - pad);
    const x1 = Math.min(W - 2, ref[1] + pad);
    const lo = (y * W + (x0 - 1)) * 4;
    const hi = (y * W + (x1 + 1)) * 4;
    const L = [data[lo], data[lo + 1], data[lo + 2], data[lo + 3]];
    const R = [data[hi], data[hi + 1], data[hi + 2], data[hi + 3]];
    for (let x = x0; x <= x1; x++) {
      const t = (x - x0 + 1) / (x1 - x0 + 2);
      const o = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) data[o + k] = Math.round(L[k] * (1 - t) + R[k] * t);
    }
  }
}

function buildEyeLayer(src: Uint8ClampedArray, W: number, blob: Blob): EyeLayer {
  const pad = 2;
  const x = blob.minX - pad;
  const y = blob.minY - pad;
  const w = blob.maxX - blob.minX + 1 + pad * 2;
  const h = blob.maxY - blob.minY + 1 + pad * 2;
  const c = makeCanvas(w, h);
  const cctx = c.getContext("2d")!;
  const out = cctx.createImageData(w, h);
  const r = Math.round(blob.r);
  const g = Math.round(blob.g);
  const b = Math.round(blob.b);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const o = ((y + yy) * W + (x + xx)) * 4;
      const wgt = blueWeight(src[o], src[o + 1], src[o + 2], src[o + 3]);
      const p = (yy * w + xx) * 4;
      out.data[p] = r;
      out.data[p + 1] = g;
      out.data[p + 2] = b;
      out.data[p + 3] = Math.round(Math.min(1, wgt * 1.3) * 255);
    }
  }
  cctx.putImageData(out, 0, 0);
  return { canvas: c, x, y, w, h };
}

function prepare(img: HTMLImageElement, mood: CatMood): Prepared {
  const base = makeCanvas(S, S);
  const bctx = base.getContext("2d", { willReadFrequently: true })!;
  bctx.drawImage(img, 0, 0, S, S);
  if (mood === "sleeping") return { base, eyes: [], drop: null };

  const imgData = bctx.getImageData(0, 0, S, S);
  const src = new Uint8ClampedArray(imgData.data);
  const blobs = findBlobs(src, S, S);

  // Eyes: the two biggest deep-blue blobs. Sweat drop: the biggest light-blue blob.
  const eyeCands = blobs
    .filter((b) => b.g < 112 && b.area > 120)
    .sort((a, b) => b.area - a.area)
    .slice(0, 2)
    .sort((a, b) => a.minX - b.minX);

  const dropBlob =
    mood === "sweating"
      ? blobs.filter((b) => b.g >= 112 && b.area > 100).sort((a, b) => b.area - a.area)[0] ?? null
      : null;

  const eyes = eyeCands.map((b) => buildEyeLayer(src, S, b));
  for (const b of eyeCands) eraseBlob(imgData.data, S, S, b, 3);

  let drop: DropInfo | null = null;
  if (dropBlob) {
    eraseBlob(imgData.data, S, S, dropBlob, 6);
    drop = {
      cx: (dropBlob.minX + dropBlob.maxX) / 2,
      cy: (dropBlob.minY + dropBlob.maxY) / 2,
      w: dropBlob.maxX - dropBlob.minX + 1,
      h: dropBlob.maxY - dropBlob.minY + 1,
      color: `rgb(${Math.round(dropBlob.r)},${Math.round(dropBlob.g)},${Math.round(dropBlob.b)})`,
    };
  }
  bctx.putImageData(imgData, 0, 0);
  return { base, eyes, drop };
}

// ---------------------------------------------------------------------------

const prepared: Partial<Record<CatMood, Prepared>> = {};
const loading: Partial<Record<CatMood, boolean>> = {};

function getPrepared(mood: CatMood): Prepared | null {
  if (prepared[mood]) return prepared[mood]!;
  if (!loading[mood]) {
    loading[mood] = true;
    const img = new Image();
    img.onload = () => {
      try {
        prepared[mood] = prepare(img, mood);
      } catch {
        const base = makeCanvas(S, S);
        base.getContext("2d")!.drawImage(img, 0, 0, S, S);
        prepared[mood] = { base, eyes: [], drop: null };
      }
    };
    img.src = MUSE_ASSETS[mood];
  }
  return null;
}

// Easing helpers
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
/** damped spring impulse: 0 at t=0, peaks, oscillates back to 0 */
const spring = (t: number, freq = 3, damp = 5) =>
  t <= 0 ? 0 : Math.sin(t * Math.PI * 2 * freq) * Math.exp(-t * damp);

type ActionKind = "hop" | "stretch" | "look" | "doubleBlink" | "panic" | "squish" | "twitch" | "pop";

interface Action {
  kind: ActionKind;
  start: number;
  dur: number;
  dir?: number;
}

interface Particle {
  kind: "note" | "z" | "spark" | "sweat" | "heart" | "pop" | "bang";
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  size: number;
  rot: number;
  hue: number;
  seed: number;
}

const NOTE_COLORS = ["#ff7eb6", "#6ec8ff", "#ffd166", "#9b8cff"];
const OUTLINE = "#3d2416";

export class MuseAnimator {
  private mood: CatMood = "working";
  private prevMood: CatMood = "working";
  private moodChangedAt = -1e9;
  private actions: Action[] = [];
  private particles: Particle[] = [];
  private nextIdleAt = 0;
  private nextBlinkAt = 0;
  private blinkStart = -1e9;
  private gaze = 0;
  private gazeTarget = 0;
  private nextGazeAt = 0;
  private lastSpawn: Record<string, number> = {};
  private lastT = 0;
  private bubbleCycleStart = 0;
  /** Particle effects (notes, Zzz, sweat, sparks, hearts). */
  effects = true;
  /** Animation speed multiplier (0.6 slow / 1 normal / 1.6 fast). */
  speed = 1;
  /** Typing tempo in beats per minute; follows how fast quota is being used. */
  tempo = 100;
  /** false = nobody is working: the cat stops typing and rests its paws. */
  busy = true;
  /** Typing phase (0–1 per beat), advanced by tempo so tempo changes stay smooth. */
  private beatPhase = 0;
  /** Virtual clock (ms) advanced by real time * speed. */
  private clock = performance.now();
  private lastReal = 0;

  /** Called on hover / click from the host window. */
  poke(kind: "hop" | "squish" = "hop") {
    const t = this.clock;
    if (this.actions.some((a) => a.kind === kind && t - a.start < a.dur)) return;
    this.actions.push({ kind, start: t, dur: kind === "hop" ? 650 : 380 });
    if (kind === "hop" && this.mood !== "sleeping") {
      for (let i = 0; i < 2; i++) this.spawn("heart", 300 + rand(-40, 40), 150, t, { vx: rand(-20, 30), vy: -90 - i * 25 });
    }
    if (this.mood === "sleeping") this.actions.push({ kind: "twitch", start: t, dur: 420 });
  }

  /** An agent finished its turn: lean back and stretch. */
  finish() {
    const t = this.clock;
    if (this.mood === "sleeping") return;
    this.actions = this.actions.filter((a) => a.kind === "pop");
    this.actions.push({ kind: "stretch", start: t, dur: 1400, dir: 1 });
    this.spawn("note", 330, 170, t, { vx: 30, vy: -70 });
  }

  /** An agent hit an error: startled jolt with a "!". */
  oops() {
    const t = this.clock;
    if (this.mood === "sleeping") {
      this.actions.push({ kind: "twitch", start: t, dur: 420 });
      return;
    }
    this.actions.push({ kind: "panic", start: t, dur: 600, dir: 1 });
    this.spawn("bang", 360, 120, t, { vx: 0, vy: -20 });
  }

  /** A limit reset: a happy hop with hearts and sparkles. */
  celebrate() {
    const t = this.clock;
    this.actions = this.actions.filter((a) => a.kind !== "hop");
    this.actions.push({ kind: "hop", start: t, dur: 650, dir: 1 });
    for (let i = 0; i < 3; i++) this.spawn("heart", 220 + i * 60, 160, t, { vx: rand(-30, 30), vy: -90 - i * 20 });
    for (let i = 0; i < 6; i++) this.spawn("spark", rand(150, 360), rand(200, 320), t, { vx: rand(-40, 40), vy: -60 });
  }

  render(ctx: CanvasRenderingContext2D, size: number, mood: CatMood) {
    const real = performance.now();
    this.clock += this.lastReal ? Math.min(100, real - this.lastReal) * this.speed : 16;
    this.lastReal = real;
    const t = this.clock;
    const dt = Math.min(0.1, this.lastT ? (t - this.lastT) / 1000 : 0.016);
    this.lastT = t;
    this.beatPhase = (this.beatPhase + dt * (this.tempo / 60)) % 1;

    if (mood !== this.mood) {
      this.prevMood = this.mood;
      this.mood = mood;
      this.moodChangedAt = t;
      this.actions = [{ kind: "pop", start: t, dur: 700 }];
      this.nextIdleAt = t + rand(2500, 4500);
      if (mood === "sweating") this.spawn("bang", 360, 120, t, { vx: 0, vy: -20 });
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const cur = getPrepared(mood);
    // Warm up the other moods in the background so transitions are instant.
    getPrepared("working");
    getPrepared("sweating");
    getPrepared("sleeping");
    if (!cur) return;

    this.scheduleIdle(t);
    this.updateGaze(t, dt);
    this.spawnAmbient(t);

    // Fit art into the canvas, leaving headroom for hops and particles.
    const k = (size / S) * 0.9;
    ctx.setTransform(k, 0, 0, k, size / 2 - PIVOT_X * k, size * 0.965 - PIVOT_Y * k);

    // Glow pad under the cat
    this.drawShadow(ctx, t);

    const fade = clamp01((t - this.moodChangedAt) / 260);
    if (fade < 1) {
      const prev = getPrepared(this.prevMood);
      if (prev && this.prevMood !== mood) {
        ctx.save();
        ctx.globalAlpha = 1 - fade;
        this.drawCat(ctx, prev, this.prevMood, t, false);
        ctx.restore();
      }
    }
    ctx.save();
    ctx.globalAlpha = fade;
    this.drawCat(ctx, cur, mood, t, true);
    ctx.restore();

    this.drawParticles(ctx, t, dt);
    this.actions = this.actions.filter((a) => t - a.start < a.dur);
  }

  // ---------------------------------------------------------------- timing

  private scheduleIdle(t: number) {
    if (this.nextIdleAt === 0) this.nextIdleAt = t + rand(3000, 5000);
    if (t < this.nextIdleAt) return;
    const busy = this.actions.length > 0;
    if (!busy) {
      const pool: ActionKind[] =
        this.mood !== "sleeping" && !this.busy
          ? ["look", "doubleBlink", "look", "look"]
          : this.mood === "working"
          ? ["stretch", "look", "doubleBlink", "look"]
          : this.mood === "sweating"
            ? ["panic", "look", "panic", "doubleBlink"]
            : ["twitch", "twitch"];
      const kind = pool[Math.floor(Math.random() * pool.length)];
      const dur = { hop: 650, stretch: 1400, look: 1800, doubleBlink: 500, panic: 600, squish: 380, twitch: 420, pop: 700 }[kind];
      this.actions.push({ kind, start: t, dur, dir: Math.random() < 0.5 ? -1 : 1 });
      if (kind === "doubleBlink") {
        this.blinkStart = t;
        this.nextBlinkAt = t + 260;
      }
    }
    this.nextIdleAt = t + (this.mood === "sleeping" ? rand(5000, 10000) : rand(2500, 5000));
  }

  private updateGaze(t: number, dt: number) {
    const look = this.actions.find((a) => a.kind === "look");
    if (look) {
      const p = (t - look.start) / look.dur;
      const d = look.dir ?? 1;
      this.gazeTarget = p < 0.45 ? d : p < 0.85 ? -d : 0;
    } else if (t > this.nextGazeAt) {
      // Small glances: mostly at the screen (slightly right), sometimes at the viewer.
      this.gazeTarget = this.mood === "sweating" ? rand(0.1, 0.6) : Math.random() < 0.6 ? rand(0, 0.35) : rand(-0.5, 0);
      this.nextGazeAt = t + rand(1200, 3200);
    }
    const speed = this.mood === "sweating" ? 22 : 12;
    this.gaze += (this.gazeTarget - this.gaze) * Math.min(1, dt * speed);

    if (t > this.nextBlinkAt) {
      this.blinkStart = t;
      this.nextBlinkAt = t + (this.mood === "sweating" ? rand(900, 2200) : rand(2200, 5200));
    }
  }

  private blinkAmount(t: number) {
    const e = t - this.blinkStart;
    const D = 150;
    if (e < 0 || e > D) return 0;
    const p = e / D;
    return p < 0.4 ? p / 0.4 : 1 - (p - 0.4) / 0.6;
  }

  // ---------------------------------------------------------------- body

  private bodyTransform(mood: CatMood, t: number) {
    let sx = 1;
    let sy = 1;
    let rot = 0;
    let dx = 0;
    let dy = 0;
    const sec = t / 1000;

    if (mood !== "sleeping" && !this.busy) {
      // Paws off the keyboard: slow breathing and a little sway.
      const br = (Math.sin((sec / 3) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
      sy += 0.02 * br;
      sx += 0.006 * br;
      rot = Math.sin(sec * 0.5) * 0.012;
      if (mood === "sweating") dx = Math.sin(sec * 23) * 0.6;
    } else if (mood === "working") {
      // Typing on the beat; the tempo follows the burn rate.
      const beat = this.beatPhase;
      const pulse = Math.exp(-beat * 7);
      const k = Math.min(1.4, Math.max(0.7, this.tempo / 100));
      sy -= 0.03 * pulse * k;
      sx += 0.018 * pulse * k;
      rot = Math.sin(sec * Math.PI * (this.tempo / 60) * 0.5) * 0.035; // sway every 2 beats
      dy = -Math.sin(beat * Math.PI) * 3 * k;
    } else if (mood === "sweating") {
      // Frantic typing + nervous tremble
      const fast = Math.sin(this.beatPhase * Math.PI * 2 * 4);
      sy -= 0.012 * (fast * 0.5 + 0.5);
      sx += 0.008 * (fast * 0.5 + 0.5);
      dx = Math.sin(sec * 53) * 1.4 + Math.sin(sec * 31) * 0.8;
      rot = Math.sin(sec * 41) * 0.006;
    } else {
      // Slow breathing, 3.6s cycle
      const br = (Math.sin((sec / 3.6) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
      sy += 0.035 * br;
      sx += 0.012 * br;
      rot = Math.sin(sec * 0.35) * 0.008;
    }

    for (const a of this.actions) {
      const p = clamp01((t - a.start) / a.dur);
      const e = (t - a.start) / 1000;
      switch (a.kind) {
        case "pop": {
          const s = spring(e, 2.6, 6);
          sy += s * 0.12;
          sx -= s * 0.08;
          break;
        }
        case "hop": {
          // anticipation squash -> jump -> land squash
          if (p < 0.18) {
            const q = p / 0.18;
            sy -= 0.1 * q;
            sx += 0.07 * q;
          } else if (p < 0.72) {
            const q = (p - 0.18) / 0.54;
            dy -= Math.sin(q * Math.PI) * 70;
            sy += 0.08 * Math.sin(q * Math.PI);
            sx -= 0.05 * Math.sin(q * Math.PI);
            rot += Math.sin(q * Math.PI * 2) * 0.06 * (a.dir ?? 1);
          } else {
            const q = (p - 0.72) / 0.28;
            const s = Math.sin(q * Math.PI) * (1 - q * 0.5);
            sy -= 0.09 * s;
            sx += 0.06 * s;
          }
          break;
        }
        case "stretch": {
          // big lean back & stretch, then settle with a wobble
          if (p < 0.5) {
            const q = easeOut(p / 0.5);
            sy += 0.1 * q;
            sx -= 0.05 * q;
            rot -= 0.08 * q * (a.dir ?? 1);
          } else {
            const q = (p - 0.5) / 0.5;
            const s = spring(q * 0.7, 2.2, 4);
            sy += 0.1 * (1 - easeOut(q)) + s * 0.04;
            sx -= 0.05 * (1 - easeOut(q));
            rot -= 0.08 * (1 - easeOut(q)) * (a.dir ?? 1);
          }
          break;
        }
        case "panic": {
          const s = Math.sin(e * Math.PI * 2 * 14) * (1 - p);
          dx += s * 9;
          rot += s * 0.025;
          sy += Math.sin(p * Math.PI) * 0.05;
          break;
        }
        case "squish": {
          const s = spring(e, 3.2, 7);
          sy -= Math.abs(s) * 0.14 + (p < 0.15 ? 0.1 * (1 - p / 0.15) : 0);
          sx += Math.abs(s) * 0.1;
          break;
        }
        case "twitch": {
          const s = Math.sin(e * Math.PI * 2 * 9) * (1 - p);
          dx += s * 3;
          sy -= Math.abs(s) * 0.03;
          break;
        }
        default:
          break;
      }
    }
    return { sx, sy, rot, dx, dy };
  }

  private drawShadow(ctx: CanvasRenderingContext2D, t: number) {
    const hop = this.actions.find((a) => a.kind === "hop");
    let shrink = 1;
    if (hop) {
      const p = clamp01((t - hop.start) / hop.dur);
      if (p > 0.18 && p < 0.72) shrink = 1 - Math.sin(((p - 0.18) / 0.54) * Math.PI) * 0.35;
    }
    ctx.save();
    ctx.translate(PIVOT_X, PIVOT_Y + 8);
    ctx.scale(shrink, shrink);
    const g = ctx.createRadialGradient(0, 0, 10, 0, 0, 210);
    g.addColorStop(0, "rgba(0,0,0,0.22)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, 210, 34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawCat(ctx: CanvasRenderingContext2D, prep: Prepared, mood: CatMood, t: number, primary: boolean) {
    const b = primary ? this.bodyTransform(mood, t) : { sx: 1, sy: 1, rot: 0, dx: 0, dy: 0 };
    ctx.save();
    ctx.translate(PIVOT_X + b.dx, PIVOT_Y + b.dy);
    ctx.rotate(b.rot);
    ctx.scale(b.sx, b.sy);
    ctx.translate(-PIVOT_X, -PIVOT_Y);
    ctx.drawImage(prep.base, 0, 0);

    // Eyes: separate layer with gaze offset + blink squash
    if (prep.eyes.length) {
      const blink = primary ? this.blinkAmount(t) : 0;
      const gx = (primary ? this.gaze : 0) * 7;
      const gy = primary ? Math.abs(this.gaze) * 1.5 : 0;
      for (const eye of prep.eyes) {
        const open = 1 - blink;
        if (open > 0.22) {
          const h = eye.h * open;
          const top = eye.y + gy + (eye.h - h) * 0.55;
          ctx.drawImage(eye.canvas, eye.x + gx, top, eye.w, h);
        } else {
          // closed: little curved lid
          const cx = eye.x + eye.w / 2 + gx;
          const cy = eye.y + eye.h * 0.6 + gy;
          ctx.save();
          ctx.strokeStyle = OUTLINE;
          ctx.lineCap = "round";
          ctx.lineWidth = Math.max(5, eye.w * 0.45);
          ctx.beginPath();
          ctx.moveTo(cx - eye.w * 0.9, cy - 2);
          ctx.quadraticCurveTo(cx, cy + eye.w * 0.55, cx + eye.w * 0.9, cy - 2);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    if (mood === "sweating" && prep.drop) this.drawSlidingDrop(ctx, prep.drop, t, primary);
    if (mood === "sleeping") this.drawBubble(ctx, t);
    ctx.restore();
  }

  private drawSlidingDrop(ctx: CanvasRenderingContext2D, d: DropInfo, t: number, primary: boolean) {
    const cycle = 1700;
    const p = primary ? (t % cycle) / cycle : 0.2;
    // grow in (0-0.2), slide down (0.2-0.75), fall away & fade (0.75-1)
    let sc = 1;
    let oy = 0;
    let ox = 0;
    let alpha = 1;
    if (p < 0.2) {
      sc = easeOut(p / 0.2);
    } else if (p < 0.75) {
      const q = (p - 0.2) / 0.55;
      oy = q * q * 46;
      ox = q * 6;
      sc = 1 + q * 0.12;
    } else {
      const q = (p - 0.75) / 0.25;
      oy = 46 + q * q * 90;
      ox = 6 + q * 20;
      alpha = 1 - q;
      sc = 1.12 - q * 0.3;
    }
    if (primary && p > 0.74 && t - (this.lastSpawn.dropFall ?? 0) > cycle * 0.8) {
      this.lastSpawn.dropFall = t;
    }
    drawTeardrop(ctx, d.cx + ox, d.cy + oy, d.w * sc, d.h * sc, d.color, alpha);
  }

  private drawBubble(ctx: CanvasRenderingContext2D, t: number) {
    // Snot bubble that inflates with each breath and pops every few cycles.
    const breath = 3600;
    if (this.bubbleCycleStart === 0) this.bubbleCycleStart = t;
    const e = t - this.bubbleCycleStart;
    const cycleLen = breath * 3;
    const p = (e % cycleLen) / cycleLen;
    const breathP = (e % breath) / breath;
    const grow = p * 0.85 + 0.15;
    const r = (14 + 30 * grow) * (0.85 + 0.15 * Math.sin(breathP * Math.PI * 2 - Math.PI / 2));
    const x = 200;
    const y = 318;
    if (p > 0.97) {
      if (t - (this.lastSpawn.pop ?? 0) > 1000) {
        this.lastSpawn.pop = t;
        this.spawn("pop", x + 24, y, t, { vx: 0, vy: 0 });
      }
      return;
    }
    ctx.save();
    ctx.globalAlpha *= 0.85;
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.6, "rgba(190,230,255,0.55)");
    g.addColorStop(1, "rgba(140,200,255,0.7)");
    ctx.fillStyle = g;
    ctx.strokeStyle = "rgba(70,120,170,0.9)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x + r * 0.55, y + 2, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.ellipse(x + r * 0.3, y - r * 0.35, r * 0.22, r * 0.12, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- particles

  private spawn(kind: Particle["kind"], x: number, y: number, t: number, v: { vx: number; vy: number }) {
    if (!this.effects) return;
    const life = { note: 2200, z: 2600, spark: 260, sweat: 700, heart: 1100, pop: 380, bang: 900 }[kind];
    this.particles.push({
      kind, x, y, vx: v.vx, vy: v.vy, born: t, life,
      size: kind === "z" ? rand(30, 38) : kind === "note" ? rand(26, 34) : 1,
      rot: rand(-0.3, 0.3), hue: Math.floor(Math.random() * NOTE_COLORS.length), seed: Math.random() * 10,
    });
    if (this.particles.length > 40) this.particles.shift();
  }

  private every(key: string, t: number, ms: number) {
    if (t - (this.lastSpawn[key] ?? 0) < ms) return false;
    this.lastSpawn[key] = t;
    return true;
  }

  private spawnAmbient(t: number) {
    if (t - this.moodChangedAt < 300) return;
    if (this.mood !== "sleeping" && !this.busy) return;
    if (this.mood === "working") {
      if (this.every("note", t, 1150 * (100 / this.tempo))) {
        const left = Math.random() < 0.6;
        this.spawn("note", left ? 95 : 380, 190, t, { vx: left ? rand(-45, -20) : rand(20, 45), vy: rand(-80, -60) });
      }
      if (this.every("spark", t, 180 * (100 / this.tempo))) {
        this.spawn("spark", rand(185, 265), rand(395, 420), t, { vx: 0, vy: -30 });
      }
    } else if (this.mood === "sweating") {
      if (this.every("sweat", t, 420)) {
        const left = Math.random() < 0.5;
        this.spawn("sweat", left ? 120 : 395, rand(150, 200), t, { vx: left ? rand(-160, -110) : rand(110, 160), vy: rand(-170, -120) });
      }
      if (this.every("spark", t, 90)) {
        this.spawn("spark", rand(170, 280), rand(385, 420), t, { vx: rand(-40, 40), vy: -60 });
      }
    } else if (this.every("z", t, 1200)) {
      this.spawn("z", 330, 130, t, { vx: rand(25, 45), vy: -55 });
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D, t: number, dt: number) {
    const alive: Particle[] = [];
    for (const p of this.particles) {
      const age = t - p.born;
      if (age > p.life) continue;
      alive.push(p);
      const q = age / p.life;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === "sweat") p.vy += 520 * dt;
      if (p.kind === "heart") p.vy *= 0.985;
      ctx.save();
      switch (p.kind) {
        case "note": {
          const a = q < 0.15 ? q / 0.15 : q > 0.7 ? 1 - (q - 0.7) / 0.3 : 1;
          ctx.globalAlpha = a;
          const wob = Math.sin(age / 220 + p.seed) * 10;
          drawNote(ctx, p.x + wob, p.y, p.size * (0.7 + 0.3 * easeOut(Math.min(1, q * 4))), NOTE_COLORS[p.hue], p.rot + Math.sin(age / 300) * 0.2, p.hue % 2 === 0);
          break;
        }
        case "z": {
          const a = q < 0.2 ? q / 0.2 : q > 0.65 ? 1 - (q - 0.65) / 0.35 : 1;
          ctx.globalAlpha = a;
          const wob = Math.sin(age / 400 + p.seed) * 12;
          const sz = p.size * (0.6 + q * 0.8);
          ctx.translate(p.x + wob, p.y);
          ctx.rotate(-0.25 + Math.sin(age / 500) * 0.15);
          ctx.font = `900 ${sz}px "Segoe UI Black", "Arial Black", sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineJoin = "round";
          ctx.lineWidth = sz * 0.22;
          ctx.strokeStyle = "#ffffff";
          ctx.strokeText("Z", 0, 0);
          ctx.fillStyle = "#6b7cff";
          ctx.fillText("Z", 0, 0);
          break;
        }
        case "spark": {
          ctx.globalAlpha = 1 - q;
          ctx.strokeStyle = this.mood === "sweating" ? "#ffd166" : "#ffffff";
          ctx.lineWidth = 5;
          ctx.lineCap = "round";
          const r = 6 + q * 14;
          for (let i = 0; i < 3; i++) {
            const ang = -Math.PI / 2 + (i - 1) * 0.7;
            ctx.beginPath();
            ctx.moveTo(p.x + Math.cos(ang) * r * 0.4, p.y + Math.sin(ang) * r * 0.4);
            ctx.lineTo(p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r);
            ctx.stroke();
          }
          break;
        }
        case "sweat": {
          const ang = Math.atan2(p.vy, p.vx) - Math.PI / 2;
          ctx.translate(p.x, p.y);
          ctx.rotate(ang + Math.PI);
          drawTeardrop(ctx, 0, 0, 22, 32, "#5ab4ff", 1 - q * q);
          break;
        }
        case "heart": {
          ctx.globalAlpha = q > 0.6 ? 1 - (q - 0.6) / 0.4 : 1;
          const s = 0.6 + easeOut(Math.min(1, q * 5)) * 0.5;
          drawHeart(ctx, p.x + Math.sin(age / 150) * 6, p.y, 34 * s);
          break;
        }
        case "pop": {
          ctx.globalAlpha = 1 - q;
          ctx.strokeStyle = "rgba(90,150,210,0.95)";
          ctx.lineWidth = 5;
          ctx.lineCap = "round";
          const r = 20 + q * 30;
          for (let i = 0; i < 6; i++) {
            const ang = (i / 6) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(p.x + Math.cos(ang) * r * 0.6, p.y + Math.sin(ang) * r * 0.6);
            ctx.lineTo(p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r);
            ctx.stroke();
          }
          break;
        }
        case "bang": {
          const s = q < 0.2 ? easeOut(q / 0.2) * 1.2 : 1.2 - Math.min(0.2, (q - 0.2) * 0.6);
          ctx.globalAlpha = q > 0.7 ? 1 - (q - 0.7) / 0.3 : 1;
          ctx.translate(p.x, p.y);
          ctx.scale(s, s);
          ctx.font = `900 70px "Segoe UI Black", "Arial Black", sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineWidth = 14;
          ctx.lineJoin = "round";
          ctx.strokeStyle = "#ffffff";
          ctx.strokeText("!", 0, 0);
          ctx.fillStyle = "#ff3b30";
          ctx.fillText("!", 0, 0);
          break;
        }
      }
      ctx.restore();
    }
    this.particles = alive;
  }
}

function drawTeardrop(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, color: string, alpha: number,
) {
  if (alpha <= 0 || w <= 1) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  const r = w / 2;
  const top = cy - h / 2;
  const bcy = cy + h / 2 - r;
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.bezierCurveTo(cx + r * 0.35, top + h * 0.3, cx + r, bcy - r * 0.5, cx + r, bcy);
  ctx.arc(cx, bcy, r, 0, Math.PI);
  ctx.bezierCurveTo(cx - r, bcy - r * 0.5, cx - r * 0.35, top + h * 0.3, cx, top);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(3, w * 0.12);
  ctx.strokeStyle = "#1f4f8f";
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.35, bcy - r * 0.15, r * 0.18, r * 0.32, 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawNote(
  ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string, rot: number, double: boolean,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  const path = new Path2D();
  const head = (hx: number, hy: number) => {
    path.ellipse(hx, hy, s * 0.32, s * 0.24, -0.4, 0, Math.PI * 2);
  };
  if (double) {
    head(-s * 0.35, s * 0.5);
    head(s * 0.45, s * 0.35);
    path.rect(-s * 0.1, -s * 0.55, s * 0.12, s * 1.05);
    path.rect(s * 0.7, -s * 0.7, s * 0.12, s * 1.05);
    path.moveTo(-s * 0.1, -s * 0.55);
    path.lineTo(s * 0.82, -s * 0.7);
    path.lineTo(s * 0.82, -s * 0.48);
    path.lineTo(-s * 0.1, -s * 0.33);
    path.closePath();
  } else {
    head(0, s * 0.45);
    path.rect(s * 0.2, -s * 0.6, s * 0.12, s * 1.05);
    path.moveTo(s * 0.32, -s * 0.6);
    path.quadraticCurveTo(s * 0.75, -s * 0.35, s * 0.6, s * 0.05);
    path.quadraticCurveTo(s * 0.62, -s * 0.25, s * 0.32, -s * 0.3);
    path.closePath();
  }
  ctx.lineJoin = "round";
  ctx.lineWidth = s * 0.22;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke(path);
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.restore();
}

function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save();
  ctx.translate(x, y);
  const p = new Path2D();
  p.moveTo(0, s * 0.35);
  p.bezierCurveTo(-s * 0.9, -s * 0.2, -s * 0.45, -s * 0.85, 0, -s * 0.35);
  p.bezierCurveTo(s * 0.45, -s * 0.85, s * 0.9, -s * 0.2, 0, s * 0.35);
  ctx.lineWidth = s * 0.2;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#ffffff";
  ctx.stroke(p);
  ctx.fillStyle = "#ff4d79";
  ctx.fill(p);
  ctx.restore();
}

const animators = new WeakMap<CanvasRenderingContext2D, MuseAnimator>();

export function getAnimator(ctx: CanvasRenderingContext2D): MuseAnimator {
  let a = animators.get(ctx);
  if (!a) {
    a = new MuseAnimator();
    animators.set(ctx, a);
  }
  return a;
}
