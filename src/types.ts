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
}

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
}

export interface DashboardSnapshot {
  accounts: AccountQuota[];
  picks: SmartPick[];
  overallScore: number;
  mood: CatMood;
  tooltipText: string;
  lastRefreshedAt: number;
  settings: AppSettings;
}
