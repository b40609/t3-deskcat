import type { AccountQuota, AppSettings, DashboardSnapshot, ProviderKind, QuotaWindow } from "./types";

/**
 * The one account the pet talks about: the account an agent is working in right
 * now, otherwise the best account to use next, otherwise the tightest one.
 */

export type Tone = "good" | "warn" | "bad";

export interface Focus {
  acc: AccountQuota;
  name: string;
  /** Session window (5h). */
  short: QuotaWindow | null;
  /** Weekly window. */
  long: QuotaWindow | null;
  /** The tighter of the two. */
  tight: QuotaWindow | null;
  stale: boolean;
}

export function windowSeconds(label: string): number | null {
  if (/(^|\s)5h(\s|$)/.test(label)) return 5 * 3600;
  if (/(^|\s)(Wk|週)(\s|$)/.test(label)) return 7 * 86400;
  const m = label.match(/(^|\s)(\d+)([hd])(\s|$)/);
  if (m) return Number(m[2]) * (m[3] === "h" ? 3600 : 86400);
  return null;
}

/** Share of the window's time already gone (0–1), or null when unknown. */
export function elapsedShare(w: QuotaWindow): number | null {
  const len = windowSeconds(w.label);
  if (!len || !w.resetAt) return null;
  const left = w.resetAt - Date.now() / 1000;
  if (left <= 0 || left > len) return null;
  return 1 - left / len;
}

export function displayName(acc: AccountQuota, s: AppSettings): string {
  return s.accountPrefs?.[acc.id]?.alias?.trim() || acc.name;
}

export function providerShort(p: ProviderKind): string {
  return p === "claude" ? "Claude" : p === "antigravity" ? "AG" : "ChatGPT";
}

export function toneOf(pct: number, s: AppSettings, accId?: string): Tone {
  const danger = (accId && s.accountPrefs?.[accId]?.notifyThreshold) || s.sleepingThreshold;
  if (pct < danger) return "bad";
  if (pct < s.workingThreshold) return "warn";
  return "good";
}

function usable(a: AccountQuota) {
  return a.status === "ok" || a.status === "stale" || a.status === "cooldown";
}

/** Session and weekly windows. Model- or pool-specific windows ("Wk Sonnet",
 * "Argon 5h") count only when the account has no plain one of that length; then
 * the lowest of them is used. */
export function mainWindows(acc: AccountQuota): { short: QuotaWindow | null; long: QuotaWindow | null } {
  const pick = (test: (len: number) => boolean) => {
    const ws = acc.primaryWindows.filter((w) => {
      const len = windowSeconds(w.label);
      return len != null && test(len);
    });
    const plain = ws.filter((w) => !w.label.includes(" "));
    const pool = plain.length ? plain : ws;
    return pool.length ? pool.reduce((a, b) => (b.remainingPercent < a.remainingPercent ? b : a)) : null;
  };
  return { short: pick((l) => l < 2 * 86400), long: pick((l) => l >= 2 * 86400) };
}

export function focusOf(snap: DashboardSnapshot | null, activeId: string | null): Focus | null {
  if (!snap) return null;
  const s = snap.settings;
  const visible = snap.accounts.filter((a) => !s.accountPrefs?.[a.id]?.hidden);
  const byId = (id: string | null | undefined) => (id ? visible.find((a) => a.id === id) : undefined);
  const acc =
    byId(activeId) ??
    byId(snap.picks[0]?.accountId) ??
    visible.filter(usable).sort((a, b) => a.effectiveRemaining - b.effectiveRemaining)[0] ??
    visible[0];
  if (!acc) return null;
  const { short, long } = mainWindows(acc);
  const tight =
    short && long ? (long.remainingPercent < short.remainingPercent ? long : short) : (short ?? long);
  // Only flag stale on real fetch errors/cooldown/expired or genuinely old cache (>= 15 min),
  // never on healthy throttled snapshots that have no error.
  const ageSec = acc.updatedAt > 0 ? Math.floor(Date.now() / 1000) - acc.updatedAt : 0;
  const stale =
    acc.status === "expired" ||
    acc.status === "error" ||
    acc.status === "cooldown" ||
    (acc.status === "stale" && (!!acc.error || ageSec >= 15 * 60));
  return { acc, name: displayName(acc, s), short, long, tight, stale };
}

/** "19:40", "Tomorrow 09:10", "Thu 10:00", "Nov 28 09:10". */
export function whenText(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  const tmr = new Date(now);
  tmr.setDate(now.getDate() + 1);
  if (d.toDateString() === tmr.toDateString()) return `tomorrow ${hm}`;
  if (d.getTime() - now.getTime() < 6.5 * 86400 * 1000) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}

/** "5h" or "Week". */
export function windowWord(w: QuotaWindow): string {
  const len = windowSeconds(w.label);
  if (len == null) return w.label;
  return len >= 2 * 86400 ? "Week" : `${Math.round(len / 3600)}h`;
}
