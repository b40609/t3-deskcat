import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * One way to talk to the app from any page, whether it runs inside the desktop
 * app (Tauri IPC) or in a phone browser over Tailscale (HTTP to the built-in
 * server, which allows only the commands in `mobile.rs`).
 */

export const isRemote = !(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

export class RemoteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isRemote) return invoke<T>(cmd, args);
  const r = await fetch(`/api/invoke/${encodeURIComponent(cmd)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
    cache: "no-store",
  });
  if (!r.ok) throw new RemoteError((await r.text().catch(() => "")) || `HTTP ${r.status}`, r.status);
  return (await r.json()) as T;
}

/**
 * Desktop: a Tauri event. Phone: polls `pollCmd` every `everyMs` while the page
 * is visible and passes the result on, so callers handle both the same way.
 */
export async function subscribe<T>(
  event: string,
  cb: (payload: T) => void,
  poll?: { cmd: string; everyMs: number },
): Promise<() => void> {
  if (!isRemote) return listen<T>(event, (e) => cb(e.payload));
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
