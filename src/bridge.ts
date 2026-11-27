import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * One way to talk to the app from any page, whether it runs inside:
 * 1. Tauri desktop app (native Tauri IPC),
 * 2. Signed local desktop HUD WebView2 host (`127.0.0.1` + `chrome.webview.postMessage`),
 * 3. Local desktop browser (`127.0.0.1` / `localhost` -> full desktop settings), or
 * 4. Remote phone browser over Tailscale (`100.64.0.0/10` -> `isRemote = true`).
 */

type HostWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
  __DESKCAT_DESKTOP__?: unknown;
  chrome?: { webview?: { postMessage?: (msg: unknown) => void } };
};

const win = window as unknown as HostWindow;

export const isTauri = Boolean(win.__TAURI_INTERNALS__);
export const hasWebViewHost = !isTauri && Boolean(win.chrome?.webview?.postMessage);
const isLoopbackHost =
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "localhost" ||
  window.location.hostname === "[::1]";
const desktopQuery = new URLSearchParams(window.location.search).get("host") === "desktop";

/** True when running on the user's own PC (Tauri, local WebView2 HUD host, or loopback browser). */
export const isDesktop = isTauri || hasWebViewHost || Boolean(win.__DESKCAT_DESKTOP__) || desktopQuery || isLoopbackHost;

/** True only when viewed remotely (e.g. phone over Tailscale or fixture phone test). */
export const isRemote = !isDesktop;

export function postHostMessage(msg: Record<string, unknown>): boolean {
  if (!hasWebViewHost) return false;
  try {
    win.chrome!.webview!.postMessage!(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

export class RemoteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return invoke<T>(cmd, args);
  if (cmd === "hide_panel") {
    postHostMessage({ type: "hide_panel" });
    return null as T;
  }
  if (cmd === "set_panel_pinned") {
    postHostMessage({ type: "set_panel_pinned", pinned: Boolean(args?.pinned) });
  }
  const r = await fetch(`/api/invoke/${encodeURIComponent(cmd)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
    cache: "no-store",
  });
  if (!r.ok) throw new RemoteError((await r.text().catch(() => "")) || `HTTP ${r.status}`, r.status);
  const data = (await r.json()) as T;
  if (
    hasWebViewHost &&
    (cmd === "update_settings" || cmd === "clear_custom_images" || cmd === "refresh_now" || cmd === "rescan_accounts")
  ) {
    postHostMessage({ type: "settings_updated" });
  }
  return data;
}

/**
 * Tauri: a Tauri event. Web/WebView2 host: polls `pollCmd` every `everyMs` while
 * visible so callers handle both identically.
 */
export async function subscribe<T>(
  event: string,
  cb: (payload: T) => void,
  poll?: { cmd: string; everyMs: number },
): Promise<() => void> {
  if (isTauri) return listen<T>(event, (e) => cb(e.payload));
  if (!poll) return () => {};
  const tick = () => {
    if (document.hidden) return;
    call<T>(poll.cmd).then((v) => v != null && cb(v)).catch(() => {});
  };
  const id = window.setInterval(tick, poll.everyMs);
  const onVis = () => !document.hidden && tick();
  document.addEventListener("visibilitychange", onVis);
  return () => {
    window.clearInterval(id);
    document.removeEventListener("visibilitychange", onVis);
  };
}
