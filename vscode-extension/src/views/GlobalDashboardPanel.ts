/**
 * DashboardPanel — webview controller for the pastel dashboard.
 *
 * One singleton WebviewPanel hosts two modes:
 *   - global  → workspace-wide canonical/warm/cold view
 *               (mockup: dashboard-pastel.html)
 *   - feature → per-feature drill-in: issue body, repo cards, review
 *               threads, diff, action drawer
 *               (mockup: dashboard-pastel-feature.html)
 *
 * The webview is a small React bundle (`dist/webview/global-dashboard.js`);
 * this controller owns its lifecycle and the data round-trip:
 *
 *   1. Webview boots → posts `{type: "ready"}`.
 *   2. Controller fetches workspace state for the current mode and posts
 *      `{type: "data", payload}` back.
 *   3. Webview renders. User intent (`switch`, `raise-cap`, `preflight`,
 *      `commit`, `push`, `open-feature`, `back-to-global`, …) flows back
 *      as inbound messages → controller calls the corresponding CLI op
 *      then re-fetches and posts a new `data`.
 *   4. File-watcher fires (`active_feature.json`, `heads.json`,
 *      `features.json`) → `invalidate()` drops caches and re-renders.
 *
 * The class is exported as `GlobalDashboardPanel` (the old name) for
 * back-compat with extension.ts wiring + the Phase-2 watcher hook.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  CanopyCli, CanopyBlockerError,
  type BotStatusResult, type FeatureDiffResult, type FeatureState,
  type FeatureStatus, type IssueResult, type ReviewCommentsResult,
  type TriageResult,
} from "../canopyCli";
import { StateReader } from "../stateReader";
import type {
  FeaturePayload,
  GlobalDashboardPayload,
  Inbound,
  Outbound,
} from "../webview/global-dashboard/protocol";
import { renderThemeOverride } from "./themeShim";

type Mode = { kind: "global" } | { kind: "feature"; name: string };

const MODE_STATE_KEY = "canopy.dashboardMode";

/**
 * Module-level caches — survive panel disposal so re-opening the
 * dashboard hits warm data instantly. The patterns below mirror Phil's
 * `dashboardPanel.ts` (see docs/plans/2026-05-03-phil-fork-cherry-picks.md).
 *
 * Semantics:
 *   - `undefined` field → "not yet fetched, skeleton in webview"
 *   - explicit `null`   → "fetched, no data" (or fetch failed gracefully)
 *
 * Two caches because the two modes have orthogonal data needs:
 *   - GLOBAL_CACHE holds `triage` + a per-feature partial `states` map
 *     populated lazily as features come into view
 *   - FEATURE_CACHE keys per-feature payload sections (state/status/
 *     diff/comments/botStatus/issue) for the feature mode
 *
 * `state(feature)` writes to BOTH caches so global hover/preview sees
 * the same value the feature view used.
 */
interface FeatureCacheEntry {
  state?: FeatureState | null;
  status?: FeatureStatus | null;
  diff?: FeatureDiffResult | null;
  comments?: ReviewCommentsResult | null;
  botStatus?: BotStatusResult | null;
  issue?: IssueResult | null;
  fetchedAt: number;
}
interface GlobalCacheEntry {
  triage?: TriageResult | null;
  states: Record<string, FeatureState>;
  fetchedAt: number;
}
const FEATURE_CACHE = new Map<string, FeatureCacheEntry>();
let GLOBAL_CACHE: GlobalCacheEntry = { states: {}, fetchedAt: 0 };

function targetForMode(mode: Mode): string {
  return mode.kind === "global" ? "global" : `feature:${mode.name}`;
}

export class GlobalDashboardPanel {
  private static current: GlobalDashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private webviewReady = false;
  private disposed = false;
  private generation = 0;
  private mode: Mode = { kind: "global" };

  static show(
    context: vscode.ExtensionContext,
    workspaceRoot: vscode.Uri,
    cli: CanopyCli,
    state: StateReader,
    output: vscode.OutputChannel,
    initialMode?: Mode,
  ): GlobalDashboardPanel {
    if (GlobalDashboardPanel.current) {
      GlobalDashboardPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (initialMode) {
        void GlobalDashboardPanel.current.setMode(initialMode);
      }
      return GlobalDashboardPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "canopy.globalDashboard",
      "Canopy",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
          vscode.Uri.joinPath(context.extensionUri, "src", "webview"),
        ],
      },
    );
    GlobalDashboardPanel.current = new GlobalDashboardPanel(
      context, workspaceRoot, cli, state, output, panel, initialMode,
    );
    return GlobalDashboardPanel.current;
  }

  /** External hook: file-watchers call this on disk changes. No-op if closed. */
  static invalidate(): void {
    if (!GlobalDashboardPanel.current) return;
    GlobalDashboardPanel.current.revalidate();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: vscode.Uri,
    private readonly cli: CanopyCli,
    private readonly state: StateReader,
    private readonly output: vscode.OutputChannel,
    panel: vscode.WebviewPanel,
    initialMode: Mode | undefined,
  ) {
    this.panel = panel;
    // Restore last mode if the user has been here before in this workspace.
    const stored = context.workspaceState.get<Mode>(MODE_STATE_KEY);
    this.mode = initialMode ?? stored ?? { kind: "global" };
    this.panel.webview.html = this.buildHtml();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.onDispose()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("canopy.dashboard.theme")) {
          // Rebuild the HTML so the new `:root` override (re-)inlines.
          // Webview re-evaluates its bundle; the `ready` round-trip
          // re-fetches data and re-renders. Cheap and keeps the
          // controller stateless about the swap.
          this.webviewReady = false;
          this.panel.webview.html = this.buildHtml();
        }
      }),
    );
  }

  // ── Inbound message dispatch ──────────────────────────────────────────

  private async onMessage(msg: Inbound): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.webviewReady = true;
        // Paint immediately from cache + sync state-file reads, then
        // fire fetches only for sections we don't have yet. On first
        // ever open the cache is empty so the webview shows skeletons
        // while the patches arrive section-by-section. On re-opens
        // the cache is warm and the user sees real data instantly.
        this.refresh();
        return;
      case "refresh":
        this.forceRefresh();
        return;
      case "back-to-global":
        await this.setMode({ kind: "global" });
        return;
      case "open-feature":
        await this.setMode({ kind: "feature", name: msg.feature });
        return;
      case "switch":
        await this.handleSwitch(msg);
        return;
      case "raise-cap":
        await this.handleRaiseCap(msg);
        return;
      case "open-link":
        void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case "open-ide":
        await vscode.commands.executeCommand("canopy.openInIde", msg.feature);
        return;
      case "open-file":
        await this.handleOpenFile(msg);
        return;
      case "preflight":
        await this.runAction("preflight", () => this.cli.preflight(msg.feature));
        return;
      case "stage":
        // Stage is implemented as `commit --paths . --no-hooks` semantics
        // server-side via preflight (which stages without committing). We
        // surface it as a button labeled "Stage" so the user has the same
        // model as the Git CLI.
        await this.runAction("stage", () => this.cli.preflight(msg.feature));
        return;
      case "commit":
        await this.handleCommit(msg);
        return;
      case "push":
        await this.runAction("push", () =>
          this.cli.push({ feature: msg.feature, repos: msg.repo ? [msg.repo] : undefined }),
        );
        return;
      case "open-pr":
        await this.handleOpenPr(msg);
        return;
      case "stash-save":
        await this.runAction("stash-save", () => this.cli.stashSaveFeature(msg.feature));
        return;
      case "stash-pop":
        await this.runAction("stash-pop", () => this.cli.stashPopFeature(msg.feature));
        return;
      case "address-thread":
        await this.handleAddressThread(msg);
        return;
      case "reply-thread":
        await this.handleReplyThread(msg);
        return;
      case "mark-addressed":
        await this.handleMarkAddressed(msg);
        return;
      case "ship":
        await this.runAction("ship", () =>
          this.cli.ship({
            feature: msg.feature, draft: msg.draft, dryRun: msg.dryRun,
          }),
        );
        return;
      case "draft-replies":
        await this.handleDraftReplies(msg);
        return;
      case "bootstrap":
        await this.runAction("bootstrap", () =>
          this.cli.worktreeBootstrap(msg.feature, { force: msg.force }),
        );
        return;
      case "conflicts":
        await this.handleConflicts(msg);
        return;
    }
  }

  private async handleSwitch(msg: Extract<Inbound, { type: "switch" }>): Promise<void> {
    try {
      await this.cli.switchFeature(msg.feature, {
        evict: msg.evict,
        releaseCurrent: msg.releaseCurrent,
      });
      this.state.invalidateAll();
      this.invalidateAllCache();
      this.post({ type: "action-result", label: "switch", ok: true });
      this.refresh();
    } catch (err) {
      this.reportError("switch", err);
    }
  }

  private async handleRaiseCap(msg: Extract<Inbound, { type: "raise-cap" }>): Promise<void> {
    if (msg.value < 1) return;
    try {
      await this.cli.setConfig("max_worktrees", String(msg.value));
      this.state.invalidate("canopy_toml");
      this.post({ type: "action-result", label: "raise-cap", ok: true });
      // max_worktrees only affects the global view's "X / Y" pill,
      // sourced from sync state. No async cache to invalidate; just
      // re-read the skeleton.
      this.refresh();
    } catch (err) {
      this.reportError("raise-cap", err);
    }
  }

  private async handleCommit(msg: Extract<Inbound, { type: "commit" }>): Promise<void> {
    let message = msg.message;
    if (!message) {
      message = await vscode.window.showInputBox({
        title: msg.repo ? `Commit ${msg.repo}` : `Commit ${msg.feature}`,
        prompt: "Commit message",
        ignoreFocusOut: true,
        validateInput: (v) => (v && v.trim().length > 0 ? null : "Message required"),
      });
      if (!message) return;
    }
    await this.runAction("commit", () =>
      this.cli.commit({
        feature: msg.feature,
        message,
        repos: msg.repo ? [msg.repo] : undefined,
      }),
    );
  }

  private async handleOpenPr(msg: Extract<Inbound, { type: "open-pr" }>): Promise<void> {
    if (msg.url) {
      void vscode.env.openExternal(vscode.Uri.parse(msg.url));
      return;
    }
    void vscode.window.showInformationMessage(
      `Canopy: no PR yet for ${msg.repo}. Push first, then run \`gh pr create\`.`,
    );
  }

  private async handleOpenFile(msg: Extract<Inbound, { type: "open-file" }>): Promise<void> {
    const active = this.state.activeFeature();
    const repoPath = active?.per_repo_paths?.[msg.repo];
    if (!repoPath) {
      void vscode.window.showWarningMessage(
        `Canopy: no checkout path recorded for ${msg.repo}. Try switching to the feature first.`,
      );
      return;
    }
    const fileUri = vscode.Uri.file(path.join(repoPath, msg.path));
    try {
      await vscode.window.showTextDocument(fileUri, { preview: true });
    } catch (err) {
      void vscode.window.showErrorMessage(`Canopy: open file failed — ${(err as Error).message}`);
    }
  }

  private async handleAddressThread(
    msg: Extract<Inbound, { type: "address-thread" }>,
  ): Promise<void> {
    const t = msg.thread;
    const location = t.path
      ? `${t.path}${t.line ? `:${t.line}` : ""}`
      : "(general)";
    const author = t.author ?? "reviewer";
    const body = (t.body ?? "").trim();
    const prompt =
      `Address PR review thread on ${msg.feature} (${msg.repo} · ${location}):\n\n` +
      `From ${author}:\n${body}\n\n` +
      (t.url ? `Thread: ${t.url}\n\n` : "") +
      `Plan a fix, write tests, then run \`canopy preflight\` before committing.`;
    await vscode.env.clipboard.writeText(prompt);
    const choice = await vscode.window.showInformationMessage(
      `Canopy: thread context copied to clipboard. Open Claude Code to address?`,
      "Open Claude",
      "Open Terminal",
    );
    if (choice === "Open Claude") {
      // Try the official extension command. If it's not installed, fall
      // back to a terminal — per plan decision #3 we assume claude-code is
      // present in the happy path but degrade gracefully.
      try {
        await vscode.commands.executeCommand("claude-code.openFromPrompt", prompt);
      } catch {
        this.openTerminalWithPrompt(prompt);
      }
    } else if (choice === "Open Terminal") {
      this.openTerminalWithPrompt(prompt);
    }
  }

  private async handleReplyThread(
    msg: Extract<Inbound, { type: "reply-thread" }>,
  ): Promise<void> {
    // Canopy doesn't ship a reply-thread CLI primitive yet. Surface the
    // honest UX: open the PR thread URL where the user can type a reply
    // in GitHub's UI directly.
    if (msg.thread.url) {
      void vscode.env.openExternal(vscode.Uri.parse(msg.thread.url));
      return;
    }
    void vscode.window.showInformationMessage(
      "Canopy: inline reply isn't wired up yet. Use Address-in-agent or open the PR.",
    );
  }

  /**
   * Mark a bot review thread as addressed by an existing commit.
   * Prompts for the commit short-sha, then runs `canopy commit
   * --address <id> --amend` with no message change so the resolution is
   * recorded against an existing commit. The bot-resolutions log
   * persists; the next dashboard render will hide the thread from
   * actionable.
   */
  private async handleMarkAddressed(
    msg: Extract<Inbound, { type: "mark-addressed" }>,
  ): Promise<void> {
    const id = msg.thread.id;
    if (!id) {
      void vscode.window.showWarningMessage(
        "Canopy: this thread has no comment id; can't mark addressed.",
      );
      return;
    }
    const note = await vscode.window.showInputBox({
      title: `Mark addressed (${msg.repo})`,
      prompt: "Optional commit message tail (Enter to use the default)",
      ignoreFocusOut: true,
    });
    if (note === undefined) return; // user pressed Esc
    await this.runAction("mark-addressed", () =>
      this.cli.commit({
        feature: msg.feature,
        repos: [msg.repo],
        amend: true,
        address: String(id),
        message: note || undefined,
      }),
    );
  }

  private async handleDraftReplies(
    msg: Extract<Inbound, { type: "draft-replies" }>,
  ): Promise<void> {
    try {
      const result = await this.cli.draftReplies(msg.feature);
      this.post({ type: "action-result", label: "draft-replies", ok: true,
                   detail: `${result.addressed_total} addressed, ${result.unaddressed_total} unaddressed` });
      // Surface the drafts in a quick-pick the user can copy from.
      const items: vscode.QuickPickItem[] = [];
      for (const [repo, info] of Object.entries(result.repos)) {
        for (const draft of info.addressed) {
          items.push({
            label: `[${repo}] ${draft.original_comment.author ?? ""}`,
            description: draft.draft_reply,
            detail: draft.original_comment.path
              ? `${draft.original_comment.path}:${draft.original_comment.line ?? ""} · ${draft.confidence}`
              : draft.confidence,
          });
        }
      }
      if (items.length === 0) {
        void vscode.window.showInformationMessage(
          `Canopy draft-replies: nothing to draft (${result.unaddressed_total} unaddressed).`,
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(items, {
        title: `Drafts for ${msg.feature} (${result.addressed_total})`,
        placeHolder: "Pick a draft to copy to clipboard",
      });
      if (pick?.description) {
        await vscode.env.clipboard.writeText(pick.description);
        void vscode.window.showInformationMessage("Canopy: draft copied to clipboard.");
      }
    } catch (err) {
      this.reportError("draft-replies", err);
    }
  }

  private async handleConflicts(
    msg: Extract<Inbound, { type: "conflicts" }>,
  ): Promise<void> {
    try {
      const result = await this.cli.conflicts({
        feature: msg.feature, lineLevel: true,
      });
      const lines = result.pairs.map((p) => {
        const repos = Object.keys(p.overlap).join(", ");
        return `[${p.severity}] ${p.feature_a} ↔ ${p.feature_b}  (${repos})`;
      });
      const detail = lines.length === 0
        ? "no overlaps"
        : `${lines.length} pair(s)`;
      this.post({ type: "action-result", label: "conflicts", ok: true, detail });
      if (lines.length > 0) {
        void vscode.window.showInformationMessage(
          `Canopy conflicts: ${lines.join(" · ")}`,
        );
      } else {
        void vscode.window.showInformationMessage("Canopy conflicts: none detected.");
      }
    } catch (err) {
      this.reportError("conflicts", err);
    }
  }

  // ── Generic action runner — toast + result post ────────────────────────

  private async runAction<T>(label: string, fn: () => Promise<T>): Promise<void> {
    try {
      await fn();
      this.post({ type: "action-result", label, ok: true });
      this.cli.invalidateCache();
      this.invalidateAllCache();
      this.refresh();
    } catch (err) {
      this.reportError(label, err);
    }
  }

  private openTerminalWithPrompt(prompt: string): void {
    const term = vscode.window.createTerminal({
      name: "Canopy · address thread",
      cwd: this.workspaceRoot.fsPath,
    });
    term.show();
    // Echo the prompt in the terminal so the user can pipe it wherever.
    // Trailing newline + escape-friendly: we send via sendText (no exec).
    term.sendText(`# Thread context (copied to clipboard):`, true);
    for (const line of prompt.split("\n")) {
      term.sendText(`# ${line}`, true);
    }
  }

  // ── Mode switching ─────────────────────────────────────────────────────

  private async setMode(next: Mode): Promise<void> {
    if (sameMode(this.mode, next)) return;
    this.mode = next;
    await this.context.workspaceState.update(MODE_STATE_KEY, next);
    this.panel.title = next.kind === "feature" ? `Canopy · ${next.name}` : "Canopy";
    // refresh() builds payload from cache + skeleton, posts it
    // immediately, and fires only the missing-section fetches. On
    // repeat clicks of the same feature the cache is fully warm and
    // the swap is essentially free.
    this.refresh();
  }

  /**
   * Empty-but-valid payload so the webview can render the new mode's
   * shell while the controller is still fetching real data. Every
   * field is null/empty; the placeholders in the React components
   * read this as "loading" and show themselves accordingly.
   */
  private skeletonPayload(mode: Mode): GlobalDashboardPayload | FeaturePayload {
    const workspaceName =
      this.state.workspaceName() || path.basename(this.workspaceRoot.fsPath);
    if (mode.kind === "global") {
      const active = this.state.activeFeature();
      const entries = this.state.features();
      const canonicalFeature = active?.feature ?? null;
      // Partition the feature roster sync from features.json — this is
      // skeleton data, not async, so it must populate on first paint.
      // (Earlier refactor accidentally left these arrays empty, which
      // is why warm/cold sections rendered "no warm worktrees" + "no
      // cold branches" even though features.json had 5 entries.)
      const warm: string[] = [];
      const cold: string[] = [];
      for (const [name, entry] of Object.entries(entries)) {
        if (name === canonicalFeature) continue;
        if (entry.status && entry.status !== "active") continue;
        const hasWorktree =
          Boolean(entry.use_worktrees) ||
          Boolean(entry.worktree_paths && Object.keys(entry.worktree_paths).length);
        (hasWorktree ? warm : cold).push(name);
      }
      warm.sort();
      cold.sort();
      return {
        mode: "global",
        workspaceName,
        workspaceRoot: this.workspaceRoot.fsPath,
        canonicalFeature,
        warmFeatures: warm,
        coldFeatures: cold,
        maxWorktrees: this.state.maxWorktrees(),
        states: {},
        entries,
        triage: null,
        fetchedAt: Date.now(),
        error: null,
      };
    }
    const entries = this.state.features();
    const active = this.state.activeFeature();
    return {
      mode: "feature",
      feature: mode.name,
      workspaceName,
      workspaceRoot: this.workspaceRoot.fsPath,
      canonicalFeature: active?.feature ?? null,
      entry: entries[mode.name] ?? null,
      state: null,
      status: null,
      diff: null,
      comments: null,
      botStatus: null,
      issue: null,
      preflight: null,
      preflightHistory: this.state.preflight()[mode.name] ?? null,
      targetBranches: this.resolveTargetBranches(entries[mode.name] ?? null),
      fetchedAt: Date.now(),
      error: null,
    };
  }

  // ── Data fetch ─────────────────────────────────────────────────────────

  // ── Three lifecycle entrypoints (Phil's pattern) ──────────────────────

  /**
   * Render shell from cache (skeleton for missing sections), then fire
   * fetches only for the sections we don't have. Used after `setMode`
   * and on the first `ready` post-handshake.
   *
   * If the cache is warm for the current mode, the user sees real data
   * instantly with no subprocess spawn on the critical path; the patches
   * arrive only for the still-undefined slots.
   */
  private refresh(): void {
    if (!this.webviewReady || this.disposed) return;
    const gen = ++this.generation;
    this.post({ type: "data", payload: this.buildPayloadFromCache(this.mode) });
    this.fireMissingFetches(gen, this.mode);
  }

  /**
   * User-driven force refresh — wipes the cache for the current mode,
   * paints skeletons, then refires every section. Used by the panel's
   * `refresh` inbound message + post-write actions where we know the
   * cached data is stale.
   */
  private forceRefresh(): void {
    this.invalidateCacheForMode(this.mode);
    this.refresh();
  }

  /**
   * Background revalidation triggered by the file-watcher. Doesn't
   * reset the view (no skeleton flash); instead drops every cache and
   * fires every section fetch in place. Each completed fetch posts its
   * patch and the webview merges in.
   */
  private revalidate(): void {
    if (!this.webviewReady || this.disposed) return;
    this.invalidateAllCache();
    const gen = ++this.generation;
    this.fireMissingFetches(gen, this.mode);
  }

  // ── Cache → payload ────────────────────────────────────────────────────

  /**
   * Compose the initial `data` payload from the sync state-file reads
   * (workspace name, canonical, target branches, worktree roster) plus
   * whatever's already in the module-level cache for this mode.
   *
   * Sections still missing from cache come back as `null` and the
   * webview draws skeletons; section patches will overwrite them as
   * each CLI call resolves.
   */
  private buildPayloadFromCache(mode: Mode): GlobalDashboardPayload | FeaturePayload {
    if (mode.kind === "global") {
      const skeleton = this.skeletonPayload(mode) as GlobalDashboardPayload;
      return {
        ...skeleton,
        states: { ...GLOBAL_CACHE.states },
        triage: GLOBAL_CACHE.triage ?? null,
      };
    }
    const cache = FEATURE_CACHE.get(mode.name);
    const skeleton = this.skeletonPayload(mode) as FeaturePayload;
    return {
      ...skeleton,
      // If the user just clicked through from global → feature, the
      // feature's `state` may already be in GLOBAL_CACHE.states from
      // an earlier per-feature fetch. Promote it so the focus card's
      // state badge lands instantly.
      state: cache?.state ?? GLOBAL_CACHE.states[mode.name] ?? null,
      status: cache?.status ?? null,
      diff: cache?.diff ?? null,
      comments: cache?.comments ?? null,
      botStatus: cache?.botStatus ?? null,
      issue: cache?.issue ?? null,
    };
  }

  /** Fire one fetch per still-undefined section in the cache. */
  private fireMissingFetches(gen: number, mode: Mode): void {
    if (mode.kind === "global") {
      if (GLOBAL_CACHE.triage === undefined) this.fetchTriage(gen);
      // Per-feature state for everything in the entries roster.
      const entries = this.state.features();
      for (const name of Object.keys(entries)) {
        if (GLOBAL_CACHE.states[name] === undefined) {
          this.fetchFeatureState(name, gen, "global");
        }
      }
      return;
    }
    const f = mode.name;
    const cache = FEATURE_CACHE.get(f);
    if (cache?.state === undefined) this.fetchFeatureState(f, gen, `feature:${f}`);
    if (cache?.status === undefined) this.fetchStatus(f, gen);
    if (cache?.diff === undefined) this.fetchDiff(f, gen);
    if (cache?.comments === undefined) this.fetchComments(f, gen);
    if (cache?.botStatus === undefined) this.fetchBotStatus(f, gen);
    if (cache?.issue === undefined) this.fetchIssue(f, gen);
  }

  // ── Per-section fetches — each posts its own patch ────────────────────

  private fetchTriage(gen: number): void {
    void this.cli.triage()
      .then((t) => {
        if (this.disposed) return;
        GLOBAL_CACHE.triage = t;
        GLOBAL_CACHE.fetchedAt = Date.now();
        this.postPatchIf(gen, "global", { triage: t });
      })
      .catch((e) => {
        this.degrade("triage", e, null);
        GLOBAL_CACHE.triage = null;
        this.postPatchIf(gen, "global", { triage: null });
      });
  }

  private fetchFeatureState(feature: string, gen: number, target: string): void {
    void this.cli.state(feature)
      .then((s) => {
        if (this.disposed) return;
        GLOBAL_CACHE.states[feature] = s;
        this.featureCache(feature).state = s;
        // Send to BOTH targets: when in global, patch the states map;
        // when in feature mode for this feature, patch the single
        // state field. Mismatched target patches are dropped client-
        // side via `postPatchIf`.
        if (target === "global") {
          this.postPatchIf(gen, "global", { states: { [feature]: s } });
        } else {
          this.postPatchIf(gen, target, { state: s });
        }
      })
      .catch((e) => {
        this.degrade(`state(${feature})`, e, null);
        this.featureCache(feature).state = null;
        if (target !== "global") {
          this.postPatchIf(gen, target, { state: null });
        }
      });
  }

  private fetchStatus(feature: string, gen: number): void {
    void this.cli.featureStatus(feature)
      .then((s) => {
        if (this.disposed) return;
        this.featureCache(feature).status = s;
        this.postPatchIf(gen, `feature:${feature}`, { status: s });
      })
      .catch((e) => {
        this.degrade(`featureStatus(${feature})`, e, null);
        this.featureCache(feature).status = null;
        this.postPatchIf(gen, `feature:${feature}`, { status: null });
      });
  }

  private fetchDiff(feature: string, gen: number): void {
    void this.cli.featureDiff(feature)
      .then((d) => {
        if (this.disposed) return;
        this.featureCache(feature).diff = d;
        this.postPatchIf(gen, `feature:${feature}`, { diff: d });
      })
      .catch((e) => {
        this.degrade(`featureDiff(${feature})`, e, null);
        this.featureCache(feature).diff = null;
        this.postPatchIf(gen, `feature:${feature}`, { diff: null });
      });
  }

  private fetchComments(feature: string, gen: number): void {
    void this.cli.reviewComments(feature)
      .then((c) => {
        if (this.disposed) return;
        this.featureCache(feature).comments = c;
        this.postPatchIf(gen, `feature:${feature}`, { comments: c });
      })
      .catch((e) => {
        this.degrade(`reviewComments(${feature})`, e, null);
        this.featureCache(feature).comments = null;
        this.postPatchIf(gen, `feature:${feature}`, { comments: null });
      });
  }

  private fetchBotStatus(feature: string, gen: number): void {
    void this.cli.botStatus(feature)
      .then((b) => {
        if (this.disposed) return;
        this.featureCache(feature).botStatus = b;
        this.postPatchIf(gen, `feature:${feature}`, { botStatus: b });
      })
      .catch((e) => {
        this.degrade(`botStatus(${feature})`, e, null);
        this.featureCache(feature).botStatus = null;
        this.postPatchIf(gen, `feature:${feature}`, { botStatus: null });
      });
  }

  private fetchIssue(feature: string, gen: number): void {
    const entry = this.state.features()[feature];
    const alias = entry?.linear_issue || feature;
    void this.cli.issueGet(alias)
      .then((i) => {
        if (this.disposed) return;
        this.featureCache(feature).issue = i;
        this.postPatchIf(gen, `feature:${feature}`, { issue: i });
      })
      .catch((e) => {
        this.degrade(`issueGet(${alias})`, e, null);
        this.featureCache(feature).issue = null;
        this.postPatchIf(gen, `feature:${feature}`, { issue: null });
      });
  }

  // ── Cache helpers ─────────────────────────────────────────────────────

  private featureCache(feature: string): FeatureCacheEntry {
    let c = FEATURE_CACHE.get(feature);
    if (!c) {
      c = { fetchedAt: Date.now() };
      FEATURE_CACHE.set(feature, c);
    }
    return c;
  }

  private invalidateCacheForMode(mode: Mode): void {
    if (mode.kind === "global") {
      GLOBAL_CACHE = { states: {}, fetchedAt: 0 };
    } else {
      FEATURE_CACHE.delete(mode.name);
    }
  }

  private invalidateAllCache(): void {
    GLOBAL_CACHE = { states: {}, fetchedAt: 0 };
    FEATURE_CACHE.clear();
  }

  /**
   * Post a patch only if (a) the fetch's generation is still current
   * (no newer fetch has started) and (b) the patch's target matches
   * the panel's current mode. Stale patches get dropped silently —
   * no flash, no out-of-order paints.
   */
  private postPatchIf(
    gen: number, target: string,
    patch: Partial<GlobalDashboardPayload> & Partial<FeaturePayload>,
  ): void {
    if (gen !== this.generation || this.disposed) return;
    if (target !== targetForMode(this.mode)) return;
    this.post({ type: "patch", target, patch });
  }

  /**
   * Pull per-repo target branches out of the entry, falling back to "main".
   * Phil's per-repo augment lives under [[repos]] target_branch — for now
   * we read it directly from canopy.toml via a simple regex grep against
   * the repo-named [[repos]] sections, since stateReader's minimal parser
   * doesn't surface this yet.
   */
  private resolveTargetBranches(entry: { repos?: string[] } | null): Record<string, string> {
    const out: Record<string, string> = {};
    if (!entry?.repos) return out;
    let toml = "";
    try {
      toml = fs.readFileSync(
        path.join(this.workspaceRoot.fsPath, "canopy.toml"), "utf8",
      );
    } catch {
      // canopy.toml missing — leave defaults.
    }
    for (const repo of entry.repos) {
      const target = matchTargetBranchForRepo(toml, repo);
      out[repo] = target ?? "main";
    }
    return out;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private degrade<T>(label: string, err: unknown, fallback: T): T {
    const message = err instanceof Error ? err.message : String(err);
    this.output.appendLine(`[canopy.dashboard] ${label} failed: ${message}`);
    return fallback;
  }

  private reportError(label: string, err: unknown): void {
    if (err instanceof CanopyBlockerError) {
      void vscode.window.showWarningMessage(
        `Canopy ${label}: ${err.what} (${err.code})`,
      );
    } else {
      void vscode.window.showErrorMessage(
        `Canopy ${label}: ${(err as Error).message}`,
      );
    }
    this.output.appendLine(
      `[canopy.dashboard] ${label} failed: ${(err as Error).stack ?? (err as Error).message}`,
    );
    this.post({ type: "action-result", label, ok: false, detail: (err as Error).message });
  }

  // ── Webview plumbing ───────────────────────────────────────────────────

  private post(msg: Outbound): void {
    void this.panel.webview.postMessage(msg);
  }

  private onDispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    if (GlobalDashboardPanel.current === this) {
      GlobalDashboardPanel.current = undefined;
    }
  }

  private buildHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "global-dashboard.js"),
    );
    // pastel.css is copied to dist/ by esbuild.config.mjs so it travels
    // with the .vsix (`.vscodeignore` excludes the whole `src/` tree).
    // Dev fallback: read from src/ when running unpackaged via the
    // launch config, where dist/ may not have the css yet.
    const distCss = path.join(
      this.context.extensionUri.fsPath, "dist", "webview", "pastel.css",
    );
    const srcCss = path.join(
      this.context.extensionUri.fsPath, "src", "webview", "shared", "pastel.css",
    );
    let css = "";
    for (const candidate of [distCss, srcCss]) {
      try {
        css = fs.readFileSync(candidate, "utf8");
        break;
      } catch {
        // try next candidate
      }
    }
    if (!css) {
      this.output.appendLine(
        `[canopy.dashboard] failed to read pastel.css at ${distCss} or ${srcCss}`,
      );
    }
    // Layer the configured theme override on top of pastel.css. Empty
    // for `pastel` (the default :root in pastel.css already wins);
    // remaps every variable to the matching `webview/themes/<name>.ts`
    // tokens for `minimal` / `navy` / future additions.
    const themeName = vscode.workspace
      .getConfiguration("canopy")
      .get<string>("dashboard.theme", "minimal");
    const override = renderThemeOverride(themeName);
    if (override) css = `${css}\n\n/* theme=${themeName} */\n${override}`;
    const nonce = randomNonce();
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Canopy Dashboard</title>
<style>${css}</style>
</head>
<body>
<div id="root"><div class="placeholder">Loading workspace…</div></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────

function sameMode(a: Mode, b: Mode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "feature" && b.kind === "feature") return a.name === b.name;
  return true;
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/**
 * Look up `[[repos]]` sections by `name` and return the `target_branch`
 * field if set. Naive but sufficient — canopy.toml is small. Falls back
 * to null which the caller maps to "main".
 */
function matchTargetBranchForRepo(toml: string, repoName: string): string | null {
  // Find the section that has `name = "<repoName>"` and look for
  // `target_branch = "..."` within the same section body.
  const sections = toml.split(/^\s*\[\[repos\]\]\s*$/m).slice(1);
  for (const body of sections) {
    const cleaned = body
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trimEnd())
      .join("\n");
    const nameMatch = /^\s*name\s*=\s*["']([^"']+)["']\s*$/m.exec(cleaned);
    if (nameMatch?.[1] !== repoName) continue;
    const targetMatch = /^\s*target_branch\s*=\s*["']([^"']+)["']\s*$/m.exec(cleaned);
    if (targetMatch) return targetMatch[1];
    return null;
  }
  return null;
}
