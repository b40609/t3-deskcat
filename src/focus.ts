import { locale, t, weekday } from "./i18n";
import type {
  AccountQuota,
  AppSettings,
  DashboardSnapshot,
  Forecast,
  ProviderKind,
  QuotaWindow,
  RankStrategy,
} from "./types";

/**
 * Multi-dimensional account selector for the desktop HUD widget.
 * Mirrors the Rust ranking engine (`src-tauri/src/ranking.rs`) so HUD,
 * panel recommendations, and `quota_v1.json` follow one transparent model.
 */

export type Tone = "good" | "warn" | "bad";
export type HudTagKind = "live" | "good" | "waste" | "risk" | "reset" | "pin";

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

export interface HudItem {
  focus: Focus;
  /** Short badge key (localized via i18n in HUD). */
  tagKey: string;
  tagKind: HudTagKind;
  /** Human-readable explanation shown in hover bubble. */
  reason: string;
}

export function windowSeconds(label: string): number | null {
  if (/(^|\s)5h(\s|$)/.test(label)) return 5 * 3600;
  if (/(^|\s)(Wk|週)(\s|$)/.test(label)) return 7 * 86400;
  if (/(^|\s)Mo(\s|$)/.test(label)) return 30 * 86400;
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
  return (
    a.status === "ok" ||
    a.status === "stale" ||
    ((a.status === "expired" || a.status === "idle") && a.primaryWindows.length > 0)
  );
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

function buildFocus(acc: AccountQuota, s: AppSettings): Focus {
  const { short, long } = mainWindows(acc);
  const tight =
    short && long ? (long.remainingPercent < short.remainingPercent ? long : short) : (short ?? long);
  const ageSec = acc.updatedAt > 0 ? Math.floor(Date.now() / 1000) - acc.updatedAt : 0;
  const stale =
    acc.status === "expired" ||
    acc.status === "error" ||
    acc.status === "cooldown" ||
    (acc.status === "stale" && (!!acc.error || ageSec >= 15 * 60));
  return { acc, name: displayName(acc, s), short, long, tight, stale };
}

/** Normalize legacy strategy strings (`use_before_reset` -> `use_before_reset_weekly`). */
export function normalizeStrategy(raw: string | undefined): RankStrategy {
  if (raw === "use_before_reset") return "use_before_reset_weekly";
  if (
    raw === "most_left" ||
    raw === "use_before_reset_weekly" ||
    raw === "use_before_reset_5h" ||
    raw === "risk_first" ||
    raw === "soonest_reset" ||
    raw === "pinned"
  ) {
    return raw;
  }
  return "most_left";
}

/** Anti-waste pressure for a specific window kind (weekly or 5h), matching Rust `ranking::window_waste_pressure`. */
function windowWastePressure(
  acc: AccountQuota,
  isWeekly: boolean,
  nowSec: number,
): { score: number; resetAt: number | null; pct: number } {
  const eff = Math.max(0, Math.min(100, acc.effectiveRemaining));
  if (eff < 10) return { score: 0, resetAt: null, pct: eff };

  const { short, long } = mainWindows(acc);
  const w = isWeekly ? long : short;
  if (!w?.resetAt || w.resetAt <= nowSec) return { score: 0, resetAt: null, pct: eff };

  const dur = windowSeconds(w.label) ?? (isWeekly ? 7 * 86400 : 5 * 3600);
  const ratio = Math.max(0.01, Math.min(1, (w.resetAt - nowSec) / dur));
  const spendable = Math.min(w.remainingPercent, eff);
  if (spendable < 10) return { score: 0, resetAt: w.resetAt, pct: spendable };
  return { score: spendable / 100 / ratio, resetAt: w.resetAt, pct: spendable };
}

function soonestResetTs(acc: AccountQuota, nowSec: number): number | null {
  const times = acc.primaryWindows
    .filter((w) => !w.label.includes(" ") && w.resetAt != null && w.resetAt > nowSec)
    .map((w) => w.resetAt!);
  return times.length ? Math.min(...times) : null;
}

function riskTuple(acc: AccountQuota, forecasts: Record<string, Forecast> | undefined, nowSec: number): [number, number, number] {
  let tier = 0;
  if (acc.status === "cooldown" || acc.status === "error" || acc.effectiveRemaining === 0) tier = 4;
  else if (acc.status === "expired") tier = 3;
  else if (forecasts?.[acc.id]) tier = 2;
  else if (acc.status === "stale") tier = 1;
  const fc = forecasts?.[acc.id];
  const urgency = fc ? 1e12 - Math.max(0, fc.exhaustAt - nowSec) : 0;
  const low = 100 - Math.max(0, Math.min(100, acc.effectiveRemaining));
  return [tier, urgency, low];
}

function compareMostLeftDesc(a: AccountQuota, b: AccountQuota, nowSec: number): number {
  const aTight = mainWindows(a);
  const bTight = mainWindows(b);
  const aBind = aTight.short && aTight.long ? (aTight.long.remainingPercent < aTight.short.remainingPercent ? aTight.long : aTight.short) : (aTight.short ?? aTight.long);
  const bBind = bTight.short && bTight.long ? (bTight.long.remainingPercent < bTight.short.remainingPercent ? bTight.long : bTight.short) : (bTight.short ?? bTight.long);
  const aSoon = aBind?.resetAt != null && aBind.resetAt > nowSec && aBind.resetAt - nowSec <= 30 * 60 && a.effectiveRemaining >= 10 ? 1 : 0;
  const bSoon = bBind?.resetAt != null && bBind.resetAt > nowSec && bBind.resetAt - nowSec <= 30 * 60 && b.effectiveRemaining >= 10 ? 1 : 0;
  if (bSoon !== aSoon) return bSoon - aSoon;
  if (b.effectiveRemaining !== a.effectiveRemaining) return b.effectiveRemaining - a.effectiveRemaining;
  const a5 = aTight.short?.remainingPercent ?? a.effectiveRemaining;
  const b5 = bTight.short?.remainingPercent ?? b.effectiveRemaining;
  if (b5 !== a5) return b5 - a5;
  return a.name.localeCompare(b.name);
}

function sortByStrategy(
  pool: AccountQuota[],
  strategy: RankStrategy,
  forecasts: Record<string, Forecast> | undefined,
  nowSec: number,
): AccountQuota[] {
  const list = [...pool];
  if (strategy === "use_before_reset_weekly" || strategy === "use_before_reset_5h") {
    const isWeekly = strategy === "use_before_reset_weekly";
    list.sort((a, b) => {
      const wa = windowWastePressure(a, isWeekly, nowSec);
      const wb = windowWastePressure(b, isWeekly, nowSec);
      if (wb.score !== wa.score) return wb.score - wa.score;
      return compareMostLeftDesc(a, b, nowSec);
    });
  } else if (strategy === "risk_first") {
    list.sort((a, b) => {
      const ra = riskTuple(a, forecasts, nowSec);
      const rb = riskTuple(b, forecasts, nowSec);
      if (rb[0] !== ra[0]) return rb[0] - ra[0];
      if (rb[1] !== ra[1]) return rb[1] - ra[1];
      if (rb[2] !== ra[2]) return rb[2] - ra[2];
      return a.name.localeCompare(b.name);
    });
  } else if (strategy === "soonest_reset") {
    list.sort((a, b) => {
      const ra = soonestResetTs(a, nowSec) ?? Number.MAX_SAFE_INTEGER;
      const rb = soonestResetTs(b, nowSec) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return compareMostLeftDesc(a, b, nowSec);
    });
  } else {
    list.sort((a, b) => compareMostLeftDesc(a, b, nowSec));
  }
  return list;
}

function makeHudItem(
  acc: AccountQuota,
  s: AppSettings,
  strategy: RankStrategy,
  isActive: boolean,
  forecasts: Record<string, Forecast> | undefined,
  nowSec: number,
): HudItem {
  const focus = buildFocus(acc, s);
  if (isActive) {
    return { focus, tagKey: "使用中", tagKind: "live", reason: t("目前正在使用中的帳號") };
  }
  if (strategy === "pinned") {
    return { focus, tagKey: "固定", tagKind: "pin", reason: t("於設定中固定顯示") };
  }
  if (strategy === "use_before_reset_weekly") {
    const wp = windowWastePressure(acc, true, nowSec);
    if (wp.score > 0 && wp.resetAt) {
      return {
        focus,
        tagKey: "週將重設",
        tagKind: "waste",
        reason: t("週額度剩 {p}%，{when}重設", { p: wp.pct, when: whenText(wp.resetAt) }),
      };
    }
    return { focus, tagKey: "充裕", tagKind: "good", reason: t("目前剩餘額度最多") };
  }
  if (strategy === "use_before_reset_5h") {
    const wp = windowWastePressure(acc, false, nowSec);
    if (wp.score > 0 && wp.resetAt) {
      return {
        focus,
        tagKey: "5h 將重設",
        tagKind: "waste",
        reason: t("5 小時剩 {p}%，{when}重設", { p: wp.pct, when: whenText(wp.resetAt) }),
      };
    }
    return { focus, tagKey: "充裕", tagKind: "good", reason: t("目前剩餘額度最多") };
  }
  if (strategy === "risk_first") {
    const fc = forecasts?.[acc.id];
    if (acc.status === "cooldown") {
      return { focus, tagKey: "受限", tagKind: "risk", reason: t("目前限流冷卻中，建議改用其他帳號") };
    }
    if (acc.status === "expired") {
      return { focus, tagKey: "過期", tagKind: "risk", reason: t("憑證已過期，重新使用一次即自動更新") };
    }
    if (acc.effectiveRemaining === 0) {
      return { focus, tagKey: "用盡", tagKind: "risk", reason: t("額度已用盡，請改用其他帳號") };
    }
    if (fc) {
      return {
        focus,
        tagKey: "偏低",
        tagKind: "risk",
        reason: t("依目前消耗速度，預計 {when} 用完", { when: whenText(fc.exhaustAt) }),
      };
    }
    return {
      focus,
      tagKey: "偏低",
      tagKind: "risk",
      reason: t("僅剩 {p}%，建議改用其他帳號", { p: acc.effectiveRemaining }),
    };
  }
  if (strategy === "soonest_reset") {
    const r = soonestResetTs(acc, nowSec);
    return {
      focus,
      tagKey: "最快重設",
      tagKind: "reset",
      reason: r ? t("{when}重設", { when: whenText(r) }) : t("最快恢復額度"),
    };
  }
  // default "most_left"
  const bind = focus.tight;
  if (bind?.resetAt && bind.resetAt > nowSec && bind.resetAt - nowSec <= 30 * 60 && acc.effectiveRemaining >= 10) {
    const mins = Math.max(1, Math.ceil((bind.resetAt - nowSec) / 60));
    const isWeekly = (windowSeconds(bind.label) ?? 0) >= 2 * 86400;
    return {
      focus,
      tagKey: isWeekly ? "週將重設" : "5h 將重設",
      tagKind: "waste",
      reason: t("{n} 分鐘後重設，建議優先使用", { n: mins }),
    };
  }
  return { focus, tagKey: "充裕", tagKind: "good", reason: t("目前剩餘額度最多") };
}

export function selectHudItems(snap: DashboardSnapshot | null, activeId: string | null): HudItem[] {
  if (!snap) return [];
  const s = snap.settings;
  const visible = snap.accounts.filter((a) => !s.accountPrefs?.[a.id]?.hidden);
  if (visible.length === 0) return [];

  const count = Math.max(1, Math.min(4, s.hudCount ?? 1));
  const strategy: RankStrategy = normalizeStrategy(s.hudStrategy);
  const scope = s.hudScope === "per_provider" ? "per_provider" : "global";
  const pinActive = s.hudPinActive !== false;
  const pinnedIds = s.hudPinnedIds ?? [];
  const nowSec = Math.floor(Date.now() / 1000);

  const out: HudItem[] = [];
  const taken = new Set<string>();

  if (pinActive && activeId) {
    const activeAcc = visible.find((a) => a.id === activeId);
    if (activeAcc) {
      out.push(makeHudItem(activeAcc, s, strategy, true, snap.forecasts, nowSec));
      taken.add(activeAcc.id);
      if (out.length >= count) return out;
    }
  }

  if (strategy === "pinned") {
    for (const pid of pinnedIds) {
      if (taken.has(pid)) continue;
      const found = visible.find((a) => a.id === pid);
      if (found) {
        out.push(makeHudItem(found, s, "pinned", false, snap.forecasts, nowSec));
        taken.add(found.id);
        if (out.length >= count) return out;
      }
    }
    if (out.length > 0) return out;
  }

  const effStrategy: RankStrategy = strategy === "pinned" ? "most_left" : strategy;
  const eligible = (a: AccountQuota) => {
    if (taken.has(a.id)) return false;
    if (effStrategy === "risk_first") return true;
    if (effStrategy === "soonest_reset") return usable(a) || a.status === "cooldown";
    return usable(a) && a.effectiveRemaining > 0;
  };

  const preferLive = (list: AccountQuota[]) => {
    if (
      effStrategy === "most_left" ||
      effStrategy === "use_before_reset_weekly" ||
      effStrategy === "use_before_reset_5h"
    ) {
      const live = list.filter((a) => a.status !== "expired");
      return live.length ? live : list;
    }
    return list;
  };

  if (scope === "per_provider") {
    const providers: ProviderKind[] = ["claude", "antigravity", "codex"];
    // If slot 0 was taken by an active account, rotate other providers first so multi-HUD shows diverse providers.
    const activeProv = out[0]?.focus.acc.provider;
    const orderedProvs = activeProv
      ? [...providers.filter((p) => p !== activeProv), activeProv]
      : providers;
    const queues = orderedProvs
      .map((p) => sortByStrategy(preferLive(visible.filter((a) => a.provider === p && eligible(a))), effStrategy, snap.forecasts, nowSec))
      .filter((q) => q.length > 0);
    let idx = 0;
    while (out.length < count && queues.some((q) => q.length > 0)) {
      const q = queues[idx % queues.length];
      idx++;
      const next = q.shift();
      if (!next || taken.has(next.id)) continue;
      out.push(makeHudItem(next, s, effStrategy, false, snap.forecasts, nowSec));
      taken.add(next.id);
    }
  } else {
    const ranked = sortByStrategy(preferLive(visible.filter(eligible)), effStrategy, snap.forecasts, nowSec);
    for (const acc of ranked) {
      if (out.length >= count) break;
      out.push(makeHudItem(acc, s, effStrategy, false, snap.forecasts, nowSec));
      taken.add(acc.id);
    }
  }

  // Last-resort fallback if every account is exhausted/error under a positive strategy.
  if (out.length === 0) {
    const fallback = visible.find((a) => !taken.has(a.id));
    if (fallback) {
      out.push(makeHudItem(fallback, s, "risk_first", false, snap.forecasts, nowSec));
    }
  }

  return out;
}

export function focusOf(snap: DashboardSnapshot | null, activeId: string | null): Focus | null {
  return selectHudItems(snap, activeId)[0]?.focus ?? null;
}

/** Localized short time ("19:40", "明天 09:10", "週四 10:00", "11/28 09:10"). */
export function whenText(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  const tmr = new Date(now);
  tmr.setDate(now.getDate() + 1);
  if (d.toDateString() === tmr.toDateString()) return t("明天 {time}", { time: hm });
  if (d.getTime() - now.getTime() < 6.5 * 86400 * 1000) return `${weekday(d)} ${hm}`;
  const md = d.toLocaleDateString(locale(), { month: "short", day: "numeric" });
  return `${md} ${hm}`;
}

/** "5 小時" or "每週". */
export function windowWord(w: QuotaWindow): string {
  const len = windowSeconds(w.label);
  if (len == null) return w.label;
  return len >= 2 * 86400 ? t("每週") : t("{h} 小時", { h: Math.round(len / 3600) });
}
