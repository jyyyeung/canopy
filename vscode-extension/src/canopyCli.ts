/**
 * CanopyCli — async subprocess wrapper around the `canopy` CLI.
 *
 * Replaces the per-call MCP-stdio roundtrip used by `canopyClient.ts` with
 * direct CLI invocation. The CLI is the single source of truth (the MCP
 * server is just another consumer of the same Python action layer); calling
 * it directly removes a layer of indirection and a lot of message-pump
 * overhead, particularly for read paths that the dashboard renders dozens
 * of times per session.
 *
 * Key responsibilities:
 *
 * - **Subprocess invocation** with the right cwd (CLI looks for `canopy.toml`
 *   relative to cwd, not via env var) and a fully-resolved PATH (so tools like
 *   `git` and `gh` are findable when VSCode was launched from Dock/Spotlight).
 * - **Mixed stdout handling.** Some CLI commands print human-readable Rich
 *   output before JSON, especially on error paths that exit-1. We extract
 *   the first `{` or `[` and JSON-parse from there.
 * - **BlockerError as a typed throw.** The CLI returns `{status: "blocked",
 *   code, what, fix_actions, …}` on structured failure. We throw a
 *   `CanopyBlockerError` carrying those fields so callers can `try/catch`
 *   against them naturally.
 * - **TTL cache for read paths.** Callers opt in via `cacheTtlMs`. Write
 *   operations never cache.
 *
 * This module exposes only the core `exec()` primitive plus a couple of
 * typed wrappers (`state`, `triage`) as proof-of-pattern. New panels add
 * their own wrappers as needed during the UI redesign.
 *
 * Design source: matches the pattern in
 * `AgathaCrystal/canopy@extension-rewrite:vscode-extension/src/canopyCli.ts`,
 * rewritten minimally — Phil's version ships ~30 typed methods; we'll grow
 * ours alongside the redesigned panels.
 */
import { execFile } from "node:child_process";

/** A blocker JSON returned by canopy CLI on a structured failure. */
export interface CanopyBlocker {
  status: "blocked" | "failed";
  code: string;
  what: string;
  expected?: unknown;
  actual?: unknown;
  fix_actions?: Array<{
    action: string;
    args?: Record<string, unknown>;
    safe?: boolean;
    preview?: string | null;
  }>;
  details?: Record<string, unknown>;
}

export class CanopyBlockerError extends Error {
  readonly status: CanopyBlocker["status"];
  readonly code: string;
  readonly what: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly fix_actions: NonNullable<CanopyBlocker["fix_actions"]>;
  readonly details?: Record<string, unknown>;

  constructor(payload: CanopyBlocker) {
    super(`${payload.code}: ${payload.what}`);
    this.name = "CanopyBlockerError";
    this.status = payload.status;
    this.code = payload.code;
    this.what = payload.what;
    this.expected = payload.expected;
    this.actual = payload.actual;
    this.fix_actions = payload.fix_actions ?? [];
    this.details = payload.details;
  }
}

export interface ExecOptions {
  /**
   * Cache successful results for this many ms. Read-only commands only —
   * write commands MUST omit this. Cache key is the joined args. Default:
   * no caching.
   */
  cacheTtlMs?: number;
  /** Override the per-process default (60 s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;   // 8 MB — plenty for any --json payload

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

export class CanopyCli {
  private cache = new Map<string, CacheEntry>();
  private resolvedShellPath: string | null = null;

  constructor(
    private readonly cliPath: string,
    private readonly workspaceRoot: string,
  ) {}

  /**
   * Run `canopy <args…>` in the workspace and return the parsed JSON output.
   *
   * Throws `CanopyBlockerError` if the CLI returned a structured blocker.
   * Throws `Error` for non-blocker subprocess failures (spawn, timeout,
   * malformed JSON).
   */
  async exec<T = unknown>(args: string[], opts: ExecOptions = {}): Promise<T> {
    const { cacheTtlMs, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
    const cacheKey = args.join("\0");

    if (cacheTtlMs && cacheTtlMs > 0) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) {
        return hit.value as T;
      }
    }

    const env = await this.subprocessEnv();
    const { stdout, exitCode } = await this.spawn(args, env, timeoutMs);
    const parsed = parseCanopyJson(stdout);

    if (isBlocker(parsed)) {
      throw new CanopyBlockerError(parsed);
    }
    if (exitCode !== 0) {
      // Exit non-zero with no blocker JSON — shouldn't happen in normal use,
      // but if the CLI ever fails to render a structured error, surface what
      // we got rather than swallowing it.
      throw new Error(
        `canopy ${args.join(" ")} exited ${exitCode} without a blocker payload`,
      );
    }

    if (cacheTtlMs && cacheTtlMs > 0) {
      this.cache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, value: parsed });
    }
    return parsed as T;
  }

  /** Drop the cache. Call after any write op or on file-watcher invalidation. */
  invalidateCache(): void {
    this.cache.clear();
  }

  // ── Typed wrappers (grow as panels need them) ──────────────────────────

  /** `canopy state <feature> --json` — feature_state dashboard backend. */
  state(feature: string, opts: ExecOptions = {}): Promise<FeatureState> {
    return this.exec<FeatureState>(["state", feature, "--json"], { cacheTtlMs: 15_000, ...opts });
  }

  /** `canopy triage --json` — cross-repo PR enumeration grouped by feature. */
  triage(opts: ExecOptions = {}): Promise<TriageResult> {
    return this.exec<TriageResult>(["triage", "--json"], { cacheTtlMs: 60_000, ...opts });
  }

  /** `canopy feature list --json`. */
  featureList(opts: ExecOptions = {}): Promise<FeatureListEntry[]> {
    return this.exec<FeatureListEntry[]>(["feature", "list", "--json"], {
      cacheTtlMs: 30_000, ...opts,
    });
  }

  /** `canopy status --json` — workspace-wide cross-repo status. */
  workspaceStatus(opts: ExecOptions = {}): Promise<WorkspaceStatus> {
    return this.exec<WorkspaceStatus>(["status", "--json"], {
      cacheTtlMs: 15_000, ...opts,
    });
  }

  /** `canopy feature status <name> --json` — per-repo cross-feature status. */
  featureStatus(feature: string, opts: ExecOptions = {}): Promise<FeatureStatus> {
    return this.exec<FeatureStatus>(["feature", "status", feature, "--json"], {
      cacheTtlMs: 15_000, ...opts,
    });
  }

  /** `canopy feature diff <name> --json` — aggregated diff across repos. */
  featureDiff(feature: string, opts: ExecOptions = {}): Promise<FeatureDiffResult> {
    return this.exec<FeatureDiffResult>(["feature", "diff", feature, "--json"], {
      cacheTtlMs: 30_000, ...opts,
    });
  }

  /** `canopy comments <alias> --json` — temporally classified PR threads. */
  reviewComments(alias: string, opts: ExecOptions = {}): Promise<ReviewCommentsResult> {
    return this.exec<ReviewCommentsResult>(["comments", alias, "--json"], {
      cacheTtlMs: 60_000, ...opts,
    });
  }

  /** `canopy bot-status --feature <feature> --json`. */
  botStatus(feature: string, opts: ExecOptions = {}): Promise<BotStatusResult> {
    return this.exec<BotStatusResult>(
      ["bot-status", "--feature", feature, "--json"],
      { cacheTtlMs: 60_000, ...opts },
    );
  }

  /** `canopy issue <alias> --json` — provider-native issue body + meta. */
  issueGet(alias: string, opts: ExecOptions = {}): Promise<IssueResult> {
    return this.exec<IssueResult>(["issue", alias, "--json"], {
      cacheTtlMs: 5 * 60_000, ...opts,
    });
  }

  /**
   * `canopy switch <feature> --json` — promote a feature to the canonical slot.
   *
   * Write op: drops the entire read cache after success so the next render
   * pulls fresh data (active_feature, per-repo state, triage all change).
   */
  async switchFeature(
    feature: string,
    opts: SwitchOptions = {},
  ): Promise<SwitchResult> {
    const args = ["switch", feature];
    if (opts.releaseCurrent) args.push("--release-current");
    if (opts.noEvict) args.push("--no-evict");
    if (opts.evict) args.push("--evict", opts.evict);
    args.push("--json");
    const result = await this.exec<SwitchResult>(args);
    this.invalidateCache();
    return result;
  }

  /**
   * `canopy config <key> <value> --json` — write a workspace setting.
   *
   * Used by the Raise-cap affordance to bump `max_worktrees`. Caller passes
   * the value as a string (the CLI coerces to the registered type).
   */
  async setConfig(key: string, value: string): Promise<{ key: string; value: unknown }> {
    const result = await this.exec<{ key: string; value: unknown }>([
      "config", key, value, "--json",
    ]);
    this.invalidateCache();
    return result;
  }

  /** `canopy ship --feature <name> --json` — open/update PRs across repos (M8). */
  async ship(opts: ShipOptions): Promise<ShipResult> {
    const args = ["ship"];
    if (opts.feature) args.push("--feature", opts.feature);
    if (opts.repos?.length) args.push("--repos", opts.repos.join(","));
    if (opts.draft) args.push("--draft");
    if (opts.reviewers?.length) args.push("--reviewers", opts.reviewers.join(","));
    if (opts.base) args.push("--base", opts.base);
    if (opts.dryRun) args.push("--dry-run");
    args.push("--json");
    const result = await this.exec<ShipResult>(args, { timeoutMs: 5 * 60_000 });
    this.invalidateCache();
    return result;
  }

  /** `canopy draft-replies <alias> --json` — addressed-comment drafts (M9). */
  draftReplies(
    alias: string, opts: { includeLikelyResolved?: boolean } = {},
  ): Promise<DraftRepliesResult> {
    const args = ["draft-replies", alias];
    if (opts.includeLikelyResolved) args.push("--include-likely-resolved");
    args.push("--json");
    return this.exec<DraftRepliesResult>(args, { cacheTtlMs: 60_000 });
  }

  /** `canopy conflicts --json` — cross-feature file-overlap (M12). */
  conflicts(opts: ConflictsOptions = {}): Promise<ConflictsResult> {
    const args = ["conflicts"];
    if (opts.feature) args.push("--feature", opts.feature);
    if (opts.other) args.push("--with", opts.other);
    if (opts.includeCold) args.push("--include-cold");
    if (opts.lineLevel) args.push("--lines");
    args.push("--json");
    return this.exec<ConflictsResult>(args, { cacheTtlMs: 60_000 });
  }

  /** `canopy worktree-bootstrap <feature> --json` — env/deps/IDE workspace (M6). */
  async worktreeBootstrap(
    feature: string,
    opts: { force?: boolean; step?: "env" | "deps" | "ide" } = {},
  ): Promise<BootstrapResult> {
    const args = ["worktree-bootstrap", feature];
    if (opts.force) args.push("--force");
    if (opts.step) args.push("--step", opts.step);
    args.push("--json");
    const result = await this.exec<BootstrapResult>(args, { timeoutMs: 10 * 60_000 });
    this.invalidateCache();
    return result;
  }

  /** `canopy pr-checks <alias> --json` — CI rollup (M10). */
  prChecks(alias: string): Promise<PrChecksResult> {
    return this.exec<PrChecksResult>(
      ["pr-checks", alias, "--json"],
      { cacheTtlMs: 30_000 },
    );
  }

  /**
   * `canopy preflight [<feature>] --json` — stage + run hooks.
   *
   * Pass a feature explicitly so we don't depend on the CLI's working-
   * directory context detection (which fires from the workspace root in
   * the extension and would not match the user's intent).
   */
  async preflight(feature?: string): Promise<PreflightResult> {
    const args = ["preflight"];
    if (feature) args.push(feature);
    args.push("--json");
    const result = await this.exec<PreflightResult>(args, { timeoutMs: 5 * 60_000 });
    this.invalidateCache();
    return result;
  }

  /** `canopy commit ... --json`. Wraps the multi-repo commit primitive. */
  async commit(opts: CommitOptions): Promise<CommitResult> {
    const args = ["commit"];
    if (opts.feature) args.push("--feature", opts.feature);
    if (opts.repos?.length) args.push("--repos", opts.repos.join(","));
    if (opts.noHooks) args.push("--no-hooks");
    if (opts.amend) args.push("--amend");
    if (opts.address) args.push("--address", opts.address);
    if (opts.message !== undefined) args.push("-m", opts.message);
    if (opts.paths?.length) args.push("--paths", ...opts.paths);
    args.push("--json");
    const result = await this.exec<CommitResult>(args, { timeoutMs: 5 * 60_000 });
    this.invalidateCache();
    return result;
  }

  /** `canopy push ... --json` — feature-scoped multi-repo push. */
  async push(opts: PushOptions): Promise<PushResult> {
    const args = ["push"];
    if (opts.feature) args.push("--feature", opts.feature);
    if (opts.repos?.length) args.push("--repos", opts.repos.join(","));
    if (opts.setUpstream) args.push("--set-upstream");
    if (opts.forceWithLease) args.push("--force-with-lease");
    if (opts.dryRun) args.push("--dry-run");
    args.push("--json");
    const result = await this.exec<PushResult>(args, { timeoutMs: 2 * 60_000 });
    this.invalidateCache();
    return result;
  }

  /** `canopy stash-save-feature --feature <name> --json`. */
  async stashSaveFeature(
    feature: string,
    message?: string,
  ): Promise<unknown> {
    const args = ["stash-save-feature", "--feature", feature];
    if (message) args.push("-m", message);
    args.push("--json");
    const result = await this.exec(args);
    this.invalidateCache();
    return result;
  }

  /** `canopy stash-pop-feature --feature <name> --json`. */
  async stashPopFeature(feature: string): Promise<unknown> {
    const result = await this.exec([
      "stash-pop-feature", "--feature", feature, "--json",
    ]);
    this.invalidateCache();
    return result;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private spawn(
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      execFile(
        this.cliPath,
        args,
        {
          cwd: this.workspaceRoot,
          env,
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER_BYTES,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          // execFile sets `err` on non-zero exit. Resolve regardless — the
          // caller decides whether the JSON payload is a blocker vs success.
          // Only reject on spawn failure (no `code`), timeout (`killed`),
          // or buffer overflow.
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            return reject(new Error(`canopy CLI not found at ${this.cliPath}`));
          }
          if (err && (err as { killed?: boolean }).killed) {
            return reject(new Error(`canopy ${args.join(" ")} timed out after ${timeoutMs}ms`));
          }
          const exitCode = err && typeof (err as { code?: number }).code === "number"
            ? (err as { code: number }).code
            : 0;
          // Surface stderr as part of the error if there's no usable stdout.
          if (!stdout && stderr && exitCode !== 0) {
            return reject(new Error(`canopy ${args.join(" ")}: ${stderr.trim()}`));
          }
          resolve({ stdout, exitCode });
        },
      );
    });
  }

  /**
   * Build the subprocess env. Prepends a login-shell PATH so tools like
   * `git`, `gh`, etc. are findable when VSCode was launched from Dock/
   * Spotlight (which give the editor a minimal `/usr/bin:/bin` PATH).
   *
   * Cached after first resolution; the shell call is ~100 ms.
   */
  private async subprocessEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.resolvedShellPath === null) {
      this.resolvedShellPath = await loginShellPath();
    }
    const path = this.resolvedShellPath || process.env.PATH || "";
    return {
      ...process.env,
      PATH: path,
      // CANOPY_ROOT is informational for the CLI; cwd is what actually picks
      // the workspace. Set both for safety.
      CANOPY_ROOT: this.workspaceRoot,
    };
  }
}

// ── Module-level helpers (exported for tests) ───────────────────────────

/**
 * Extract and parse the first JSON value from CLI stdout. Some commands
 * print Rich console output (banner / spinner residue) before the JSON
 * payload, especially on error paths.
 *
 * Returns the parsed value, or throws if no `{` or `[` is found.
 */
export function parseCanopyJson(stdout: string): unknown {
  const trimmed = stdout.trimStart();
  if (!trimmed) {
    throw new Error("canopy returned empty stdout (expected --json output)");
  }
  // Find the first JSON-looking character. Rich console output is plain
  // text; JSON starts with `{` or `[`.
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) {
    throw new Error(`canopy stdout had no JSON payload: ${trimmed.slice(0, 200)}`);
  }
  const slice = trimmed.slice(start);
  return JSON.parse(slice);
}

/** True if the parsed value looks like a CanopyBlocker. */
export function isBlocker(value: unknown): value is CanopyBlocker {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).code === "string" &&
    typeof (value as Record<string, unknown>).what === "string" &&
    ((value as Record<string, unknown>).status === "blocked" ||
      (value as Record<string, unknown>).status === "failed")
  );
}

/**
 * Run an interactive login shell to capture the user's real PATH. Returns
 * `null` on any failure — the caller falls back to the inherited PATH.
 *
 * Done as an instance method because the timeout depends on the platform
 * and we may want per-instance overrides later. ~100 ms typical cost; we
 * cache the result.
 */
export async function loginShellPath(): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    execFile(
      shell,
      ["-ilc", "echo $PATH"],
      { encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        // Login shells print MOTD/init noise; PATH is on the last non-empty line.
        const lines = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        const last = lines.pop();
        if (!last || !last.includes(":") || last.includes("=")) {
          // `=` would suggest we accidentally captured an env-set line; skip.
          return resolve(null);
        }
        resolve(last);
      },
    );
  });
}

// ── Result shapes for the wrappers above ────────────────────────────────

export interface FeatureStateAction {
  action: string;
  args: Record<string, unknown>;
  primary?: boolean;
  label?: string;
  preview?: string;
}

export interface FeatureState {
  feature: string;
  state: string;
  summary?: Record<string, unknown>;
  next_actions?: FeatureStateAction[];
  warnings?: Array<{ code: string; what: string; [k: string]: unknown }>;
}

export interface TriageRepoInfo {
  pr_number?: number;
  pr_url?: string;
  pr_title?: string;
  branch?: string;
  review_decision?: string;
  actionable_count?: number;
  actionable_bot_count?: number;
  actionable_human_count?: number;
  physical_state?: "canonical" | "warm" | "cold";
}

export interface TriageFeature {
  feature: string;
  is_canonical: boolean;
  physical_state: "canonical" | "warm" | "cold" | "mixed" | string;
  repos: Record<string, TriageRepoInfo>;
}

export interface TriageResult {
  author?: string;
  canonical_feature: string | null;
  features: TriageFeature[];
}

export interface SwitchOptions {
  /** Wind down the previously canonical feature to cold (with stash). */
  releaseCurrent?: boolean;
  /** Refuse to evict an LRU warm worktree if the cap would be exceeded. */
  noEvict?: boolean;
  /** Evict this specific warm feature instead of the LRU candidate. */
  evict?: string;
}

export interface SwitchResult {
  feature: string;
  mode: "active_rotation" | "wind_down" | string;
  per_repo_paths: Record<string, string>;
  previously_canonical?: string;
  eviction?: {
    feature: string;
    repos: Array<{ repo: string; stashed: boolean }>;
  };
  branches_created?: Array<{ repo: string; branch: string; base: string }>;
  migration?: { ran: boolean; canonical_detected?: string | null };
}

// ── Result shapes added in Phase 3 ─────────────────────────────────────

export interface FeatureListEntry {
  name: string;
  repos: string[];
  status?: string;
  linear_issue?: string | null;
  linear_url?: string | null;
  linear_title?: string | null;
  branches?: Record<string, string>;
  worktree_paths?: Record<string, string>;
  use_worktrees?: boolean;
  repo_states?: Record<string, Record<string, unknown>>;
}

export interface WorkspaceStatusRepo {
  name: string;
  current_branch?: string;
  head_sha?: string;
  is_dirty?: boolean;
  dirty_count?: number;
  ahead_of_default?: number;
  behind_default?: number;
}

export interface WorkspaceStatus {
  name?: string;
  root?: string;
  repos: WorkspaceStatusRepo[];
  active_features?: string[];
}

export interface FeatureStatusRepo {
  branch?: string;
  has_branch?: boolean;
  is_dirty?: boolean;
  dirty_count?: number;
  ahead?: number;
  behind?: number;
  changed_file_count?: number;
  pr_url?: string;
  pr_number?: number;
}

export interface FeatureStatus {
  feature: string;
  repos: Record<string, FeatureStatusRepo>;
  linear_issue?: string | null;
}

export interface FeatureDiffResult {
  feature: string;
  repos: Record<string, {
    files?: Array<{ path: string; additions: number; deletions: number }>;
    diff?: string;
    files_changed?: number;
    additions?: number;
    deletions?: number;
  }>;
  totals?: { files: number; additions: number; deletions: number };
}

export interface ReviewThread {
  id?: string;
  author?: string;
  body?: string;
  path?: string;
  line?: number;
  url?: string;
  created_at?: string;
  is_bot?: boolean;
}

export interface ReviewCommentsRepo {
  pr_number?: number;
  pr_url?: string;
  actionable_threads?: ReviewThread[];
  likely_resolved_threads?: ReviewThread[];
  resolved_thread_count?: number;
}

export interface ReviewCommentsResult {
  actionable_count: number;
  likely_resolved_count: number;
  resolved_thread_count: number;
  repos: Record<string, ReviewCommentsRepo>;
}

export interface BotStatusResult {
  feature: string;
  bot_threads_total?: number;
  unresolved?: Array<{ id: string; author?: string; path?: string; body?: string }>;
  resolved?: Array<{ id: string; resolved_at?: string; sha?: string; repo?: string }>;
}

export interface IssueResult {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  state?: string;
  url?: string;
  assignee?: string | null;
  labels?: string[];
  priority?: string | null;
  raw?: unknown;
}

export interface PreflightRepoResult {
  status: "ok" | "clean" | "hooks_failed" | "error" | string;
  hooks?: { passed: boolean; output?: string } | null;
  error?: string;
}

export interface PreflightResult {
  all_passed?: boolean;
  feature?: string;
  results?: Record<string, PreflightRepoResult>;
}

export interface CommitOptions {
  feature?: string;
  message?: string;
  repos?: string[];
  noHooks?: boolean;
  amend?: boolean;
  address?: string;
  paths?: string[];
}

export interface CommitRepoResult {
  status: "ok" | "nothing" | "hooks_failed" | "failed" | string;
  sha?: string;
  files_changed?: number;
  amended?: boolean;
  hook_output?: string;
  reason?: string;
}

export interface CommitResult {
  feature: string;
  results: Record<string, CommitRepoResult>;
  addressed?: {
    comment_id: string;
    repo?: string;
    sha?: string;
    recorded?: boolean;
    reason?: string;
  };
}

export interface PushOptions {
  feature?: string;
  repos?: string[];
  setUpstream?: boolean;
  forceWithLease?: boolean;
  dryRun?: boolean;
}

export interface PushRepoResult {
  status: "ok" | "up_to_date" | "rejected" | "failed" | string;
  pushed_count?: number;
  ref?: string;
  set_upstream?: boolean;
  dry_run?: boolean;
  reason?: string;
}

export interface PushResult {
  feature: string;
  results: Record<string, PushRepoResult>;
}

// ── M6 / M8 / M9 / M10 / M12 result shapes ─────────────────────────────

export interface ShipOptions {
  feature?: string;
  repos?: string[];
  draft?: boolean;
  reviewers?: string[];
  base?: string;
  dryRun?: boolean;
}

export interface ShipRepoResult {
  status:
    | "opened" | "up_to_date" | "diverged" | "closed" | "skipped"
    | "would_open" | "would_update_or_skip" | "failed" | string;
  pr_number?: number;
  url?: string;
  reason?: string;
  warning?: string;
  draft?: boolean;
  ahead?: number;
  base?: string;
}

export interface ShipResult {
  feature: string;
  results: Record<string, ShipRepoResult>;
  cross_repo_links_updated: boolean;
}

export interface DraftReplyEntry {
  comment_id?: string;
  comment_url?: string;
  original_comment: {
    author?: string;
    path?: string;
    line?: number;
    body?: string;
  };
  addressing_commits: Array<{ sha: string; subject: string; date: string }>;
  draft_reply: string;
  confidence: "high" | "medium" | "low" | string;
}

export interface DraftRepliesResult {
  alias: string;
  addressed_total: number;
  unaddressed_total: number;
  repos: Record<string, {
    pr_number?: number;
    pr_url?: string;
    addressed: DraftReplyEntry[];
    unaddressed: Array<Record<string, unknown>>;
  }>;
}

export interface ConflictsOptions {
  feature?: string;
  other?: string;
  includeCold?: boolean;
  lineLevel?: boolean;
}

export interface ConflictPair {
  feature_a: string;
  feature_b: string;
  overlap: Record<string, {
    files: string[];
    generated_files?: string[];
    lines_a_only?: number;
    lines_b_only?: number;
    lines_both?: number;
  }>;
  severity: "high" | "medium" | "low" | string;
  suggestion: string;
}

export interface ConflictsResult {
  features: string[];
  pairs: ConflictPair[];
}

export interface BootstrapStep {
  status: "ok" | "skipped" | "failed" | "missing_source" | "no_ide_configured" | string;
  files_copied?: string[];
  files_skipped?: string[];
  files_missing?: string[];
  exit_code?: number;
  duration_ms?: number;
  stderr_tail?: string;
  reason?: string;
  path?: string;
}

export interface BootstrapResult {
  feature: string;
  results: Record<string, { env: BootstrapStep; deps: BootstrapStep }>;
  ide: BootstrapStep;
}

export interface CiStatus {
  status: "passing" | "failing" | "pending" | "no_checks" | string;
  passed?: number;
  failing?: number;
  pending?: number;
  skipped?: number;
  required_failing?: string[];
  required_pending?: string[];
  details_url?: string;
}

export interface PrChecksResult {
  alias: string;
  results: Array<{
    repo: string;
    pr_number: number;
    ci_status: CiStatus;
    checks: Array<Record<string, unknown>>;
  }>;
}
