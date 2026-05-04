/**
 * Shared message + payload contract for the dashboard webview.
 *
 * Lives in its own file so the React bundle (browser target) and the
 * DashboardPanel controller (node target) can both depend on it without
 * crossing into each other's runtime modules. All imports here are
 * `import type` so esbuild erases them when bundling for the browser.
 *
 * Two modes share the same panel:
 *   - global  → `GlobalDashboardPayload`  (workspace-wide canonical/warm/cold)
 *   - feature → `FeaturePayload`          (per-feature drill-in)
 * The webview switches by reading `payload.mode`.
 */
import type {
  BotStatusResult,
  FeatureDiffResult,
  FeatureState,
  FeatureStatus,
  IssueResult,
  PreflightResult,
  ReviewCommentsResult,
  TriageResult,
} from "../../canopyCli";
import type { FeatureEntry, PreflightEntry } from "../../stateReader";

export interface GlobalDashboardPayload {
  mode: "global";
  workspaceName: string;
  workspaceRoot: string;
  canonicalFeature: string | null;
  warmFeatures: string[];
  coldFeatures: string[];
  maxWorktrees: number;
  states: Record<string, FeatureState>;
  entries: Record<string, FeatureEntry>;
  triage: TriageResult | null;
  fetchedAt: number;
  error: string | null;
}

export interface FeaturePayload {
  mode: "feature";
  feature: string;
  workspaceName: string;
  workspaceRoot: string;
  canonicalFeature: string | null;
  /** features.json entry for the focused feature; null if missing. */
  entry: FeatureEntry | null;
  /** Cross-feature state — drives the focus-mode "needs work" badge. */
  state: FeatureState | null;
  /** Per-repo branch + dirty + ahead/behind. */
  status: FeatureStatus | null;
  /** Aggregated diff payload. */
  diff: FeatureDiffResult | null;
  /** Temporally classified PR review threads. */
  comments: ReviewCommentsResult | null;
  /** Per-feature bot rollup. */
  botStatus: BotStatusResult | null;
  /** Issue body + meta (Linear / GH issues). */
  issue: IssueResult | null;
  /** Last preflight result for this feature, if any. */
  preflight: PreflightResult | null;
  /**
   * Per-feature preflight history from `.canopy/state/preflight.json` —
   * lets the repo cards render a stale/passed indicator without a
   * fresh CLI fetch.
   */
  preflightHistory: PreflightEntry | null;
  /** Resolved per-repo target branch from canopy.toml augments. */
  targetBranches: Record<string, string>;
  fetchedAt: number;
  error: string | null;
}

export type Outbound =
  /** Replace the whole payload — first frame after mode change. */
  | { type: "data"; payload: GlobalDashboardPayload | FeaturePayload }
  /**
   * Section update — merges into the *current* payload. Sent by the
   * controller as each per-section CLI call resolves, so the webview
   * fills in piece by piece instead of waiting for the slowest fetch.
   *
   * `target` carries the mode the patch belongs to:
   *   - `"global"`           → patch the GlobalDashboardPayload
   *   - `"feature:<name>"`   → patch the FeaturePayload for that feature
   * Mismatched targets are dropped (user moved on already).
   */
  | { type: "patch"; target: string; patch: Partial<GlobalDashboardPayload> & Partial<FeaturePayload> }
  | { type: "fetching"; mode: "global" | "feature"; feature?: string }
  | { type: "action-result"; label: string; ok: boolean; detail?: string };

/**
 * Inbound messages — webview → controller. The webview only emits user
 * intent; the controller decides how to fulfill each (CLI call, file
 * write, follow-up refresh).
 */
export type Inbound =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "back-to-global" }
  | { type: "open-feature"; feature: string }
  | { type: "switch"; feature: string; evict?: string; releaseCurrent?: boolean }
  | { type: "raise-cap"; value: number }
  | { type: "open-link"; url: string }
  | { type: "open-ide"; feature: string }
  | { type: "open-file"; repo: string; path: string }
  | { type: "preflight"; feature: string }
  | { type: "stage"; feature: string; repo: string }
  | { type: "commit"; feature: string; repo?: string; message?: string }
  | { type: "push"; feature: string; repo?: string }
  | { type: "open-pr"; feature: string; repo: string; url?: string }
  | { type: "stash-save"; feature: string }
  | { type: "stash-pop"; feature: string }
  | { type: "address-thread"; feature: string; repo: string; thread: ReviewThreadIntent }
  | { type: "reply-thread"; feature: string; repo: string; thread: ReviewThreadIntent }
  | { type: "mark-addressed"; feature: string; repo: string; thread: ReviewThreadIntent }
  | { type: "ship"; feature: string; draft?: boolean; dryRun?: boolean }
  | { type: "draft-replies"; feature: string }
  | { type: "bootstrap"; feature: string; force?: boolean }
  | { type: "conflicts"; feature?: string };

export interface ReviewThreadIntent {
  id?: string;
  author?: string;
  body?: string;
  path?: string;
  line?: number;
  url?: string;
}
