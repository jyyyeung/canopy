/**
 * Typed wrapper around the VS Code webview's `acquireVsCodeApi()` global.
 *
 * `acquireVsCodeApi()` can only be called ONCE per webview instance — calling
 * it twice throws. We grab the handle at module load and re-export typed
 * `post` / `subscribe` helpers so components don't have to remember.
 */
import type { Inbound, Outbound } from "./protocol";

interface VsCodeApi {
  postMessage: (msg: unknown) => void;
  setState: (state: unknown) => void;
  getState: () => unknown;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi = acquireVsCodeApi();

export function post(msg: Inbound): void {
  api.postMessage(msg);
}

export function subscribe(handler: (msg: Outbound) => void): () => void {
  const listener = (event: MessageEvent) => {
    handler(event.data as Outbound);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
