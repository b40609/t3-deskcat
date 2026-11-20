import { listen } from "@tauri-apps/api/event";

/** Hover bubble next to the pet. Lines come from pet.ts; a leading "!" marks a
 * red line and "?" an amber one. */
interface BubbleContent {
  lines: string[];
  above: boolean;
  tailX: number;
}

const bubble = document.getElementById("bubble")!;
const linesEl = document.getElementById("lines")!;
const tail = document.getElementById("tail") as HTMLElement;

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function render(c: BubbleContent) {
  document.body.classList.toggle("below", !c.above);
  linesEl.innerHTML = c.lines
    .map((raw, i) => {
      const tone = raw.startsWith("!") ? "bad" : raw.startsWith("?") ? "warn" : "";
      const text = tone ? raw.slice(1) : raw;
      return `<div class="${i === 0 ? "l1" : "l2"} ${tone}">${esc(text)}</div>`;
    })
    .join("");
  bubble.classList.remove("on");
  requestAnimationFrame(() => {
    // Point the tail at the pet's centre, kept inside the bubble's rounded corners.
    const r = bubble.getBoundingClientRect();
    const x = Math.max(12, Math.min(r.width - 12, c.tailX - r.left));
    tail.style.left = `${x}px`;
    bubble.classList.add("on");
  });
}

void listen<BubbleContent>("bubble-content", (e) => render(e.payload));
