/**
 * Dashboard — root React component for the pastel dashboard.
 *
 * Routes between two modes based on `payload.mode`:
 *   - global  → GlobalView (workspace canonical/warm/cold)
 *   - feature → FeatureView (per-feature drill-in)
 *
 * Tracks a `fetching` flag so the controller can flash a stale-data
 * indicator without blanking the UI between renders.
 */
import { useEffect, useState } from "react";
import type { FeaturePayload, GlobalDashboardPayload } from "./protocol";
import { post, subscribe } from "./vscode";
import { GlobalView } from "./GlobalView";
import { FeatureView } from "./FeatureView";

type AnyPayload = GlobalDashboardPayload | FeaturePayload;

/**
 * Compute the panel's current target string from a payload. Mirrors the
 * controller's `targetForMode`. Used to drop patch messages whose
 * target doesn't match what the user is now viewing (race after a
 * mode switch).
 */
function targetForPayload(p: AnyPayload | null): string | null {
  if (!p) return null;
  return p.mode === "global" ? "global" : `feature:${p.feature}`;
}

/**
 * Merge a `patch` message into the current payload.
 * - Drops the patch when target doesn't match (stale).
 * - Shallow-merges the `states` map so per-feature state patches don't
 *   wipe other features' cached states.
 * - Replaces every other field wholesale.
 */
function mergePatch(
  prev: AnyPayload | null,
  target: string,
  patch: Partial<GlobalDashboardPayload> & Partial<FeaturePayload>,
): AnyPayload | null {
  if (!prev) return prev;
  if (target !== targetForPayload(prev)) return prev;
  const next = { ...prev } as AnyPayload;
  for (const [key, val] of Object.entries(patch)) {
    if (key === "states" && val && typeof val === "object" && !Array.isArray(val)) {
      // Per-feature `states` is a partial map: merge into existing rather
      // than replace, so consecutive `fetchFeatureState` patches each
      // contribute their slot without erasing siblings.
      const cur = (prev as GlobalDashboardPayload).states ?? {};
      (next as GlobalDashboardPayload).states = { ...cur, ...(val as Record<string, unknown>) } as typeof cur;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (next as any)[key] = val;
    }
  }
  return next;
}

export function Dashboard() {
  const [payload, setPayload] = useState<AnyPayload | null>(null);
  const [fetching, setFetching] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribe((msg) => {
      if (msg.type === "data") {
        setPayload(msg.payload);
        setFetching(false);
      } else if (msg.type === "patch") {
        // Section update — merge into current payload. Drop if the
        // patch's target doesn't match what we're currently rendering
        // (controller already filters, but defense in depth).
        setPayload((prev) => mergePatch(prev, msg.target, msg.patch));
      } else if (msg.type === "fetching") {
        setFetching(true);
      } else if (msg.type === "action-result") {
        setActionResult(`${msg.label}: ${msg.ok ? "ok" : "failed"}${msg.detail ? ` — ${msg.detail}` : ""}`);
        // Clear the toast after a few seconds.
        setTimeout(() => setActionResult(null), 4000);
      }
    });
    post({ type: "ready" });
    return unsubscribe;
  }, []);

  if (!payload) {
    // Final fallback — only visible for the few hundred ms between
    // webview boot and the first `data` post from the controller. The
    // controller posts a skeleton-shaped payload as soon as `ready`
    // fires, so most users won't see this at all.
    return (
      <>
        <header className="topbar">
          <span className="logo">canopy</span>
          <span className="spacer" />
        </header>
        <div className="layout">
          <main className="main">
            <div className="section-head">
              <span className="loading-hint">setting up…</span>
            </div>
          </main>
        </div>
      </>
    );
  }

  return (
    <>
      {payload.mode === "global" ? (
        <GlobalView payload={payload} />
      ) : (
        <FeatureView payload={payload} />
      )}
      {(fetching || actionResult) && (
        <div
          style={{
            position: "fixed",
            bottom: 12,
            right: 16,
            background: "var(--surface)",
            border: "1px solid var(--rule)",
            borderRadius: 8,
            padding: "6px 12px",
            fontSize: 11,
            color: "var(--ink-soft)",
            boxShadow: "var(--shadow-md)",
            zIndex: 100,
          }}
        >
          {fetching ? "Refreshing…" : actionResult}
        </div>
      )}
    </>
  );
}
