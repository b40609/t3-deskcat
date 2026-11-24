import type { ProviderKind } from "./types";

function cap(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : "";
}

function titleWords(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (/^g\d+$/i.test(w) || /^v\d+$/i.test(w) ? w.toUpperCase() : cap(w)))
    .join(" ");
}

/**
 * Turns internal model identifiers (e.g. `gemini-4-neon-xhigh`,
 * `gemini-pro-orchestrator-g1-pro`, `claude-opus-5-5-medium`) into concise,
 * human-readable display labels while keeping the raw ID in `title` attributes.
 */
export function prettyModelName(raw: string): string {
  const s = (raw || "").trim();
  if (!s || s === "?") return "?";
  const lower = s.toLowerCase().replace(/-\d{8}$/, "");

  // Antigravity internal orchestrator & worker models
  const orch = lower.match(/^gemini-(?:pro-)?orchestrator-(.+)$/);
  if (orch) {
    return `Orchestrator · ${titleWords(orch[1])}`;
  }
  if (/^gemini-flash-worker(?:-|$)/.test(lower)) {
    return "Gemini Flash Worker";
  }

  // Gemini 4 family (including `-tiered-` variant)
  const g4 = lower.match(/^gemini-4-(neon|argon|carbon|hydrogen)(?:-tiered)?(?:-(xhigh|high|medium|low))?$/);
  if (g4) {
    return `Gemini 4 ${cap(g4[1])}${g4[2] ? ` (${g4[2]})` : ""}`;
  }

  // Gemini 3.x / 2.5 family
  const gVer = lower.match(/^gemini-(\d+(?:\.\d+)?)-(pro|flash-lite|flash)(?:-(xhigh|high|medium|low))?$/);
  if (gVer) {
    const tier = gVer[2]
      .split("-")
      .map(cap)
      .join(" ");
    return `Gemini ${gVer[1]} ${tier}${gVer[3] ? ` (${gVer[3]})` : ""}`;
  }

  // Claude family
  const claude = lower.match(
    /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?(?:-(xhigh|high|medium|low))?$/,
  );
  if (claude) {
    const ver = claude[3] ? `${claude[2]}.${claude[3]}` : claude[2];
    return `Claude ${cap(claude[1])} ${ver}${claude[4] ? ` (${claude[4]})` : ""}`;
  }

  // OpenAI / Codex
  if (lower.startsWith("gpt-")) {
    const parts = lower.split("-");
    if (parts.length >= 2) {
      const rest = parts.slice(2).map(cap).join(" ");
      return `GPT-${parts[1]}${rest ? ` ${rest}` : ""}`;
    }
  }

  return s;
}

export function providerBadgeLabel(p: ProviderKind): string {
  return p === "claude" ? "Claude" : p === "antigravity" ? "AG" : "ChatGPT";
}

/**
 * Computes account labels for analytics lists/dropdowns; adds a provider prefix
 * (`Claude · Ryan`, `AG · Ryan`) whenever two or more accounts share a name.
 */
export function buildAccountLabelMap(
  entries: Record<string, { name: string; provider: ProviderKind }>,
): Record<string, string> {
  const counts = new Map<string, number>();
  for (const info of Object.values(entries)) {
    const key = info.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: Record<string, string> = {};
  for (const [id, info] of Object.entries(entries)) {
    const dup = (counts.get(info.name.trim().toLowerCase()) ?? 0) > 1;
    out[id] = dup ? `${providerBadgeLabel(info.provider)} · ${info.name}` : info.name;
  }
  return out;
}
