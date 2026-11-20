export type ProviderKind = "claude" | "antigravity" | "codex";
export type ScoreMode = "max_avg" | "all_avg";
export type CatMood = "working" | "sweating" | "sleeping";

export interface QuotaWindow {
  label: string;
  remainingPercent: number;
  resetAt: number | null;
}

export interface AccountQuota {
  id: string;
  provider: ProviderKind;
  name: string;
  plan: string | null;
  effectiveRemaining: number;
  primaryWindows: QuotaWindow[];
  extraWindows: QuotaWindow[];
  status: "ok" | "error" | "expired" | string;
  error: string | null;
  updatedAt: number;
}

export interface SmartPick {
  provider: ProviderKind;
  accountId: string;
  accountName: string;
  effectiveRemaining: number;
  reason: string;
  /** Reset of the account's tightest limit. */
  resetAt?: number | null;
  /** Tightest limit resets soon with quota left: use it first. */
  useBeforeReset?: boolean;
  note?: string | null;
}

/** The limit runs out before it resets, at the current pace. */
export interface Forecast {
  label: string;
  exhaustAt: number;
  resetAt: number | null;
  ratePerHour: number;
}

export interface UsageToday {
  accountId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  requests: number;
  /** Equivalent API list price (Claude only). */
  costUsd: number | null;
}

export type TrayStyle = "number" | "ring" | "icon";

export interface AccountPref {
  alias?: string | null;
  hidden?: boolean;
  excludeScore?: boolean;
  /** Per-account low-quota alert line; null = use the global one. */
  notifyThreshold?: number | null;
  /** Custom avatar (data URL); null = provider letter. */
  avatar?: string | null;
}

export type PanelPosition = "pet" | "top_right" | "bottom_right" | "top_left" | "bottom_left" | "center";

export type PetTheme = "hud_gauge" | "desk_cat" | "custom";

export interface AppSettings {
  petSize: number;
  workingThreshold: number;
  sleepingThreshold: number;
  scoreMode: ScoreMode;
  refreshIntervalSecs: number;
  notifyEnabled: boolean;
  notifyLowThreshold: number;
  showAntigravityExtra: boolean;
  launchAtStartup: boolean;
  petX: number | null;
  petY: number | null;
  petTheme?: PetTheme;
  customImageWorking?: string | null;
  customImageSweating?: string | null;
  customImageSleeping?: string | null;
  uiScale?: number;
  appearance?: "system" | "light" | "dark";
  usageDisplay?: "used" | "remaining";
  resetFormat?: "absolute" | "relative";
  /** Time tick on the bars. */
  paceTick?: "on" | "ahead" | "off";
  /** UI language; "system" follows Windows. */
  language?: "system" | "en" | "zh-TW" | "zh-CN" | "ja" | "ko";
  showPicks?: boolean;
  petEffects?: boolean;
  // accounts
  accountPrefs?: Record<string, AccountPref>;
  accountOrder?: string[];
  // notifications
  notifyOnReset?: boolean;
  quietHoursEnabled?: boolean;
  quietStartMin?: number;
  quietEndMin?: number;
  // pet
  petAnimSpeed?: "slow" | "normal" | "fast";
  petOpacity?: number;
  petIdleFade?: boolean;
  petClickAction?: "single" | "double";
  petSnapEdge?: boolean;
  // panel
  panelPosition?: PanelPosition;
  hotkey?: string;
  compactAccounts?: boolean;
  showHistory?: boolean;
  // data
  claudeMinIntervalSecs?: number;
  // forecast / stats / tray
  showForecast?: boolean;
  showUsageStats?: boolean;
  trayStyle?: TrayStyle;
  // phone
  mobileEnabled?: boolean;
  mobilePort?: number;
  /** Extra folders scanned for accounts (CLAUDE_CONFIG_DIR / CODEX_HOME / Antigravity token). */
  extraAccountDirs?: string[];
}

export interface DashboardSnapshot {
  accounts: AccountQuota[];
  picks: SmartPick[];
  overallScore: number;
  mood: CatMood;
  tooltipText: string;
  lastRefreshedAt: number;
  settings: AppSettings;
  /** No visible account returned fresh data (network down / all expired). */
  offline?: boolean;
  forecasts?: Record<string, Forecast>;
  usageToday?: Record<string, UsageToday>;
  /** Current pace of each account's shortest window, % per hour. */
  burnRates?: Record<string, number>;
}

/** What the coding agents are doing, from their local session logs. */
export interface AgentActivity {
  state: "working" | "done" | "error" | "idle" | "unknown";
  accountId: string | null;
  lastWrite: number;
}
