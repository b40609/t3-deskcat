// Account discovery — pure Node.js parity with src-tauri/src/discovery.rs.
// Strictly read-only: discovers T3 Code, Claude Code, Codex, and extra folders.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const AGY_COEXIST_ACTIVITY_SECS = 7 * 24 * 3600;

export function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function expandTilde(home, raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(home, trimmed.slice(2));
  }
  return trimmed;
}

function canonicalReal(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function canonicalPathId(provider, filePath) {
  const dir = dirname(filePath);
  const norm = canonicalReal(dir).replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
  const key = process.platform === "win32" ? norm.toLowerCase() : norm;
  return `${provider}:path:${sha256Hex(key).slice(0, 12)}`;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function dirLabel(dir) {
  const b = basename(dir).replace(/^\.+/, "");
  return b || dir;
}

function idAndName(home, dir, kind, base, defaultName) {
  const normDir = resolve(dir);
  const normBase = resolve(join(home, base));
  const normCodexCfg = resolve(join(home, ".config", "codex"));
  if (normDir === normBase || (kind === "codex" && normDir === normCodexCfg)) {
    return [`${kind}:default`, defaultName];
  }
  const fileName = basename(normDir);
  if (resolve(dirname(normDir)) === resolve(home) && fileName.startsWith(base)) {
    const tail = fileName.slice(base.length);
    if (tail.length > 1 && ["-", "_", "."].includes(tail[0])) {
      const rest = tail.slice(1);
      return [`${kind}:${rest.toLowerCase()}`, rest];
    }
  }
  const label = dirLabel(normDir);
  return [`${kind}:dir:${label.toLowerCase()}`, label];
}

function siblingDirs(home, base) {
  let entries;
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith(base))
    .filter((e) => {
      const tail = e.name.slice(base.length);
      return tail.length > 1 && ["-", "_", "."].includes(tail[0]);
    })
    .map((e) => join(home, e.name))
    .sort();
}

function antigravityTokenIn(dir) {
  for (const name of ["antigravity-oauth-token", "acp_token.json"]) {
    const p = join(dir, name);
    if (isFile(p)) return p;
  }
  return null;
}

function defaultCodexAuth(home) {
  const candidates = [];
  const envHome = process.env.CODEX_HOME?.trim();
  if (envHome) candidates.push(join(envHome, "auth.json"));
  candidates.push(join(home, ".config", "codex", "auth.json"));
  candidates.push(join(home, ".codex", "auth.json"));
  return candidates.find((p) => existsSync(p)) ?? null;
}

class Seen {
  constructor() {
    this.paths = new Set();
    this.ids = new Set();
  }
  first(filePath, id) {
    if (this.ids.has(id)) return false;
    const key = canonicalReal(filePath);
    const normKey = process.platform === "win32" ? key.toLowerCase() : key;
    if (this.paths.has(normKey)) return false;
    this.paths.add(normKey);
    this.ids.add(id);
    return true;
  }
}

function discoverT3(home, seen, accounts) {
  const t3Env = process.env.T3CODE_HOME?.trim();
  const t3Userdata = t3Env ? join(expandTilde(home, t3Env), "userdata") : join(home, ".t3", "userdata");
  const settingsPath = join(t3Userdata, "settings.json");
  if (!existsSync(settingsPath)) return;
  let json;
  try {
    json = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return;
  }
  const instances = json?.providerInstances;
  if (!instances || typeof instances !== "object") return;

  for (const [instanceId, cfg] of Object.entries(instances)) {
    if (!cfg || typeof cfg !== "object") continue;
    const driver = typeof cfg.driver === "string" ? cfg.driver : "";
    const displayName =
      typeof cfg.displayName === "string" && cfg.displayName.trim() ? cfg.displayName.trim() : instanceId;
    const rawHome = cfg?.config?.homePath;
    const homePath = typeof rawHome === "string" && rawHome.trim() ? expandTilde(home, rawHome) : null;

    if (driver === "claudeAgent") {
      const dir = homePath ?? join(home, ".claude");
      const cred = join(dir, ".credentials.json");
      const id = `claude:${instanceId}`;
      if (existsSync(cred) && seen.first(cred, id)) {
        accounts.push({
          kind: "claude",
          provider: "claude",
          id,
          name: displayName,
          filePath: cred,
          configDir: dir,
          sourceKind: "t3",
          t3InstanceId: instanceId,
          credentialKind: "claude_credentials_json",
          canonicalId: canonicalPathId("claude", cred),
        });
      }
    } else if (driver === "antigravity") {
      const acpDir = join(t3Userdata, "providers", "antigravity", sha256Hex(instanceId), "antigravity-acp");
      const tokenPath = antigravityTokenIn(acpDir);
      const id = `ag:${instanceId}`;
      if (tokenPath && seen.first(tokenPath, id)) {
        accounts.push({
          kind: "antigravity",
          provider: "antigravity",
          id,
          name: displayName,
          filePath: tokenPath,
          configDir: acpDir,
          isLegacyGemini: false,
          sourceKind: "t3",
          t3InstanceId: instanceId,
          credentialKind: basename(tokenPath) === "acp_token.json" ? "antigravity_acp_token" : "antigravity_oauth_token",
          canonicalId: canonicalPathId("antigravity", tokenPath),
        });
      }
    } else if (driver === "codex") {
      const auth = (homePath && existsSync(join(homePath, "auth.json")) ? join(homePath, "auth.json") : null) ?? defaultCodexAuth(home);
      const id = `codex:${instanceId}`;
      const name = displayName === "codex" ? "Codex" : displayName;
      if (auth && seen.first(auth, id)) {
        accounts.push({
          kind: "codex",
          provider: "codex",
          id,
          name,
          filePath: auth,
          configDir: dirname(auth),
          sourceKind: "t3",
          t3InstanceId: instanceId,
          credentialKind: "codex_auth_json",
          canonicalId: canonicalPathId("codex", auth),
        });
      }
    }
  }
}

function addClaude(home, dir, sourceKind, seen, accounts) {
  const cred = join(dir, ".credentials.json");
  if (!existsSync(cred)) return;
  const [id, name] = idAndName(home, dir, "claude", ".claude", "Claude");
  if (seen.first(cred, id)) {
    accounts.push({
      kind: "claude",
      provider: "claude",
      id,
      name,
      filePath: cred,
      configDir: dir,
      sourceKind,
      t3InstanceId: null,
      credentialKind: "claude_credentials_json",
      canonicalId: canonicalPathId("claude", cred),
    });
  }
}

function addCodex(home, dir, sourceKind, seen, accounts) {
  const auth = join(dir, "auth.json");
  if (!existsSync(auth)) return;
  const [id, name] = idAndName(home, dir, "codex", ".codex", "Codex");
  if (seen.first(auth, id)) {
    accounts.push({
      kind: "codex",
      provider: "codex",
      id,
      name,
      filePath: auth,
      configDir: dir,
      sourceKind,
      t3InstanceId: null,
      credentialKind: "codex_auth_json",
      canonicalId: canonicalPathId("codex", auth),
    });
  }
}

function addAntigravityDir(dir, sourceKind, seen, accounts) {
  const tokenPath = antigravityTokenIn(dir) ?? antigravityTokenIn(join(dir, "antigravity-acp"));
  if (!tokenPath) return;
  const label = dirLabel(dir);
  const id = `ag:dir:${label.toLowerCase()}`;
  if (seen.first(tokenPath, id)) {
    accounts.push({
      kind: "antigravity",
      provider: "antigravity",
      id,
      name: label,
      filePath: tokenPath,
      configDir: dirname(tokenPath),
      isLegacyGemini: false,
      sourceKind,
      t3InstanceId: null,
      credentialKind: basename(tokenPath) === "acp_token.json" ? "antigravity_acp_token" : "antigravity_oauth_token",
      canonicalId: canonicalPathId("antigravity", tokenPath),
    });
  }
}

export function discoverAccounts(extraDirs = []) {
  const home = homedir();
  const seen = new Seen();
  const accounts = [];

  // 1. T3 Code instances first, so their display names win.
  discoverT3(home, seen, accounts);

  // 2. Claude Code profile dirs.
  const claudeDirs = [];
  if (process.env.CLAUDE_CONFIG_DIR?.trim()) claudeDirs.push(process.env.CLAUDE_CONFIG_DIR.trim());
  claudeDirs.push(join(home, ".claude"));
  claudeDirs.push(...siblingDirs(home, ".claude"));
  for (const dir of claudeDirs) addClaude(home, dir, "native_cli", seen, accounts);

  // 3. Codex homes.
  const codexDirs = [];
  if (process.env.CODEX_HOME?.trim()) codexDirs.push(process.env.CODEX_HOME.trim());
  codexDirs.push(join(home, ".config", "codex"));
  codexDirs.push(join(home, ".codex"));
  codexDirs.push(...siblingDirs(home, ".codex"));
  for (const dir of codexDirs) addCodex(home, dir, "native_cli", seen, accounts);

  // 4. User extra dirs.
  for (const raw of extraDirs ?? []) {
    if (!raw) continue;
    const dir = expandTilde(home, raw);
    if (!isDir(dir)) continue;
    addClaude(home, dir, "extra_dir", seen, accounts);
    addCodex(home, dir, "extra_dir", seen, accounts);
    addAntigravityDir(dir, "extra_dir", seen, accounts);
  }

  // 5. Legacy Gemini CLI fallback only if no Antigravity account exists.
  const hasAg = accounts.some((a) => a.provider === "antigravity");
  if (!hasAg) {
    const legacy = join(home, ".gemini", "oauth_creds.json");
    if (existsSync(legacy) && seen.first(legacy, "ag:default")) {
      accounts.push({
        kind: "antigravity",
        provider: "antigravity",
        id: "ag:default",
        name: "Gemini",
        filePath: legacy,
        configDir: dirname(legacy),
        isLegacyGemini: true,
        sourceKind: "legacy",
        t3InstanceId: null,
        credentialKind: "gemini_legacy_oauth",
        canonicalId: canonicalPathId("antigravity", legacy),
      });
    }
  }

  const order = { claude: 0, antigravity: 1, codex: 2 };
  accounts.sort((a, b) => {
    const p = (order[a.provider] ?? 9) - (order[b.provider] ?? 9);
    return p !== 0 ? p : a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return accounts;
}

export function credStamp(acc) {
  try {
    const st = statSync(acc.filePath);
    return `${Math.floor(st.mtimeMs / 1000)}:${st.size}`;
  } catch {
    return null;
  }
}

export function recentActivityTs(acc) {
  // Fast heuristic: check newest log mtime for active vs idle polling interval.
  try {
    if (acc.provider === "antigravity") {
      const brainDir = join(acc.configDir, "brain");
      if (!isDir(brainDir)) return 0;
      let latest = 0;
      for (const ent of readdirSync(brainDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const p = join(brainDir, ent.name, ".system_generated", "logs", "transcript.jsonl");
        try {
          const t = Math.floor(statSync(p).mtimeMs / 1000);
          if (t > latest) latest = t;
        } catch {}
      }
      return latest;
    }
    if (acc.provider === "claude") {
      const proj = join(acc.configDir, "projects");
      if (!isDir(proj)) return 0;
      let latest = 0;
      const walk = (dir, depth) => {
        if (depth <= 0) return;
        let ents;
        try {
          ents = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full, depth - 1);
          else if (e.name.endsWith(".jsonl")) {
            try {
              const t = Math.floor(statSync(full).mtimeMs / 1000);
              if (t > latest) latest = t;
            } catch {}
          }
        }
      };
      walk(proj, 3);
      return latest;
    }
  } catch {}
  return 0;
}

export { AGY_COEXIST_ACTIVITY_SECS };
