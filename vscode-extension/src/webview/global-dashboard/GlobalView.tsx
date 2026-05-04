/**
 * GlobalView — workspace-wide canonical/warm/cold view.
 *
 * Mockup source: `vscode-extension/mockups/dashboard-pastel.html`.
 *
 * Sections (top → bottom): TopBar, CanonicalSection, WarmSection,
 * ColdSection. Right rail: TriageRail. Composition mirrors the mockup
 * 1:1 so design changes flow through with minimal restructuring.
 *
 * Click semantics:
 *   - Triage item / standby card title / cold row name → open feature view
 *   - Standby card "Switch into main" / cold row "Switch" → switch op
 */
import type { FeatureState, TriageFeature, TriageRepoInfo } from "../../canopyCli";
import type { GlobalDashboardPayload } from "./protocol";
import { post } from "./vscode";
import { Shimmer } from "./Skeletons";

export function GlobalView({ payload }: { payload: GlobalDashboardPayload }) {
  const warmCount = payload.warmFeatures.length;
  const atCap = warmCount >= payload.maxWorktrees;

  return (
    <>
      <TopBar
        workspaceRoot={payload.workspaceRoot}
        canonicalFeature={payload.canonicalFeature}
        warmCount={warmCount}
        cap={payload.maxWorktrees}
        atCap={atCap}
      />
      <div className="layout">
        <main className="main">
          {payload.error && <div className="error-banner">{payload.error}</div>}
          <CanonicalSection payload={payload} />
          <WarmSection payload={payload} atCap={atCap} />
          <ColdSection payload={payload} atCap={atCap} />
        </main>
        <TriageRail payload={payload} />
      </div>
    </>
  );
}

// ── Top bar ─────────────────────────────────────────────────────────────

function TopBar(props: {
  workspaceRoot: string;
  canonicalFeature: string | null;
  warmCount: number;
  cap: number;
  atCap: boolean;
}) {
  return (
    <header className="topbar">
      <span className="logo">canopy</span>
      <span className="station">
        workspace <code>{props.workspaceRoot}</code>
      </span>
      <span className="spacer" />
      <span className="lamp-pill">
        <span className="lamp" />
        Main: <strong>{props.canonicalFeature ?? "—"}</strong>
      </span>
      <span className={`lamp-pill${props.atCap ? " warm" : ""}`}>
        <span className="lamp" />
        Worktrees{" "}
        <strong>
          {props.warmCount} / {props.cap}
        </strong>
      </span>
    </header>
  );
}

// ── Canonical (focus card) ──────────────────────────────────────────────

function CanonicalSection({ payload }: { payload: GlobalDashboardPayload }) {
  const name = payload.canonicalFeature;
  if (!name) {
    return (
      <>
        <SectionHead title="Main" hint="no canonical feature — pick one to focus on" />
        <div className="placeholder">
          Use the Branches list below to switch a feature into main.
        </div>
      </>
    );
  }
  const state = payload.states[name];
  const triage = findTriage(payload.triage, name);
  const entry = payload.entries[name];
  const summary = (state?.summary ?? {}) as Record<string, unknown>;
  const repoSummary = (summary.repos ?? {}) as Record<string, RepoSummary>;
  const subtitle =
    entry?.linear_title ??
    (entry?.linear_issue ? `Linear ${entry.linear_issue}` : "");

  return (
    <>
      <SectionHead
        title="Main"
        countLabel="in focus"
        hint="primary action sourced from feature_state.next_actions[0]"
      />
      <div className="focus">
        <h2
          style={{ cursor: "pointer" }}
          onClick={() => post({ type: "open-feature", feature: name })}
          title="Open feature view"
        >
          {name}
        </h2>
        {subtitle && <div className="subtitle">{subtitle}</div>}
        <div className="meta-row">
          <span className="badge canonical">● in main</span>
          {state?.state ? (
            <span className={`badge state-${state.state}`}>
              {state.state.replace(/_/g, " ")}
            </span>
          ) : (
            <span className="badge" style={{ minWidth: 90 }}>
              <Shimmer width={70} />
            </span>
          )}
          {entry?.linear_url && (
            <a
              className="pill-link"
              onClick={(e) => {
                e.preventDefault();
                post({ type: "open-link", url: entry.linear_url! });
              }}
            >
              issue ↗
            </a>
          )}
        </div>
        <div className="repo-strip">
          {Object.keys(repoSummary).length === 0 ? (
            // state(feature) hasn't returned yet — render one repo-row
            // per known repo (real name from entry) with shimmers in
            // the data cells so the strip has shape without lying.
            (entry?.repos ?? [null]).map((repo, i) => (
              <div className="repo-row" key={i}>
                <span className="name">{repo ?? <Shimmer width={60} />}</span>
                <span className="branch"><Shimmer width={160} /></span>
                <span><Shimmer width={50} /></span>
                <span><Shimmer width={70} /></span>
                <span><Shimmer width={70} /></span>
                <span />
              </div>
            ))
          ) : (
            Object.entries(repoSummary).map(([repo, info]) => (
              <RepoRow
                key={repo}
                name={repo}
                info={info}
                triageRepo={triage?.repos?.[repo]}
              />
            ))
          )}
        </div>
        <CtaRow next={state?.next_actions ?? []} feature={name} />
      </div>
    </>
  );
}

interface RepoSummary {
  branch?: string;
  is_dirty?: boolean;
  dirty_count?: number;
  ahead?: number;
  behind?: number;
  actionable_count?: number;
  review_decision?: string;
  pr_url?: string;
  pr_number?: number;
  ci_status?: { status?: string; required_failing?: string[]; required_pending?: string[] };
}

function RepoRow(props: {
  name: string;
  info: RepoSummary;
  triageRepo?: TriageRepoInfo;
}) {
  const { name, info, triageRepo } = props;
  const prUrl = info.pr_url ?? triageRepo?.pr_url;
  const prNumber = info.pr_number ?? triageRepo?.pr_number;
  const actionable = info.actionable_count ?? triageRepo?.actionable_count ?? 0;
  return (
    <div className="repo-row">
      <span className="name">{name}</span>
      <span className="branch">{info.branch ?? ""}</span>
      {info.is_dirty ? (
        <span className="dirty">{info.dirty_count ?? "?"} dirty</span>
      ) : (
        <span />
      )}
      {prUrl ? (
        <a
          className="pr"
          onClick={(e) => {
            e.preventDefault();
            post({ type: "open-link", url: prUrl });
          }}
        >
          PR {prNumber ? `#${prNumber}` : ""} ↗
        </a>
      ) : (
        <span />
      )}
      {actionable > 0 ? (
        <span className="actionable">{actionable} actionable</span>
      ) : (
        <span />
      )}
      {info.ci_status?.status && info.ci_status.status !== "no_checks" ? (
        <span
          className={`badge state-${ciToStateClass(info.ci_status.status)}`}
          title={
            (info.ci_status.required_failing ?? []).length
              ? `failing: ${info.ci_status.required_failing!.join(", ")}`
              : (info.ci_status.required_pending ?? []).length
                ? `pending: ${info.ci_status.required_pending!.join(", ")}`
                : info.ci_status.status
          }
        >
          ci {info.ci_status.status}
        </span>
      ) : (
        <span />
      )}
    </div>
  );
}

function ciToStateClass(status: string): string {
  switch (status) {
    case "passing": return "approved";
    case "failing": return "needs_work";
    case "pending": return "in_progress";
    default: return "awaiting_review";
  }
}

function CtaRow(props: { next: NonNullable<FeatureState["next_actions"]>; feature: string }) {
  return (
    <div className="cta-row">
      <button
        className="btn primary"
        onClick={() => post({ type: "open-feature", feature: props.feature })}
      >
        Open feature view
      </button>
      <button
        className="btn"
        onClick={() => post({ type: "open-ide", feature: props.feature })}
      >
        Open in IDE
      </button>
      {props.next.slice(0, 3).map((a, i) => {
        const handler = nextActionHandler(props.feature, a);
        return (
          <button
            key={i}
            className="btn"
            disabled={!handler}
            onClick={handler ?? undefined}
            title={handler ? undefined : "no client-side handler — run the suggested CLI"}
          >
            {a.label ?? a.action}
            {a.preview && <span className="preview">{a.preview}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Map a feature_state.next_action to the matching webview message.
 * Returns null when we don't have a button-friendly counterpart — the
 * UI then renders the chip as disabled (with the label preserved as
 * the agent-facing CLI hint).
 */
function nextActionHandler(
  feature: string, action: NonNullable<FeatureState["next_actions"]>[number],
): (() => void) | null {
  switch (action.action) {
    case "preflight": return () => post({ type: "preflight", feature });
    case "commit":    return () => post({ type: "commit", feature });
    case "push":      return () => post({ type: "push", feature });
    case "stash":     return () => post({ type: "stash-save", feature });
    case "pr_create": return () => post({ type: "ship", feature });
    case "address_review_comments":
    case "address_bot_comments":
    case "comments":
      return () => post({ type: "open-feature", feature });
    case "investigate_ci":
    case "wait_for_ci":
    case "refresh":
      return () => post({ type: "refresh" });
    case "merge":
      return null; // canopy has no merge primitive — surface as a hint, agent handles it
    default:
      return null;
  }
}

// ── Warm (worktree standby) ────────────────────────────────────────────

function WarmSection({
  payload,
  atCap,
}: {
  payload: GlobalDashboardPayload;
  atCap: boolean;
}) {
  return (
    <>
      <SectionHead
        title="Worktrees"
        countLabel={`${payload.warmFeatures.length} / ${payload.maxWorktrees}`}
        countAtCap={atCap}
        capWarning={atCap ? "at cap" : undefined}
        hint="linked worktrees · click name to drill in"
        action={
          <button
            className="raise-cap-btn"
            onClick={() =>
              post({ type: "raise-cap", value: payload.maxWorktrees + 1 })
            }
          >
            Raise cap to {payload.maxWorktrees + 1}
          </button>
        }
      />
      {payload.warmFeatures.length === 0 ? (
        <div className="placeholder">No warm worktrees.</div>
      ) : (
        <div className="standby-row">
          {payload.warmFeatures.map((name) => (
            <StandbyCard key={name} name={name} payload={payload} />
          ))}
        </div>
      )}
    </>
  );
}

function StandbyCard({
  name,
  payload,
}: {
  name: string;
  payload: GlobalDashboardPayload;
}) {
  const state = payload.states[name];
  const entry = payload.entries[name];
  const triage = findTriage(payload.triage, name);
  const summary = describeRepoSummary(state, triage);
  return (
    <div className="standby-card">
      <h3
        style={{ cursor: "pointer" }}
        onClick={() => post({ type: "open-feature", feature: name })}
        title="Open feature view"
      >
        {name}
      </h3>
      <div className="meta-row">
        <span className="badge warm">● worktree</span>
        {state?.state ? (
          <span className={`badge state-${state.state}`}>
            {state.state.replace(/_/g, " ")}
          </span>
        ) : (
          <span className="badge" style={{ minWidth: 90 }}>
            <Shimmer width={70} />
          </span>
        )}
      </div>
      <div className="summary">
        <span>{(entry?.repos ?? []).join(" + ") || "?"}</span>
        {summary.map((s, i) => (
          <span key={i}>{s}</span>
        ))}
      </div>
      <div className="actions">
        <button
          className="btn primary"
          onClick={() => post({ type: "switch", feature: name })}
        >
          Switch into main
        </button>
        <button
          className="btn"
          onClick={() => post({ type: "open-ide", feature: name })}
        >
          Open IDE
        </button>
      </div>
    </div>
  );
}

// ── Cold (branch ledger) ───────────────────────────────────────────────

function ColdSection({
  payload,
  atCap,
}: {
  payload: GlobalDashboardPayload;
  atCap: boolean;
}) {
  return (
    <>
      <SectionHead
        title="Branches"
        countLabel={String(payload.coldFeatures.length)}
        hint={
          atCap
            ? "no worktree · switching evicts the LRU worktree"
            : "no worktree · switching creates one"
        }
      />
      {payload.coldFeatures.length === 0 ? (
        <div className="placeholder">No cold branches.</div>
      ) : (
        <div className="cold">
          {payload.coldFeatures.map((name) => (
            <ColdRow key={name} name={name} payload={payload} willEvict={atCap} />
          ))}
        </div>
      )}
    </>
  );
}

function ColdRow(props: {
  name: string;
  payload: GlobalDashboardPayload;
  willEvict: boolean;
}) {
  const { name, payload, willEvict } = props;
  const state = payload.states[name];
  const entry = payload.entries[name];
  const triage = findTriage(payload.triage, name);
  const repoStr = (entry?.repos ?? []).join(" + ") || "?";
  const actionable = totalActionable(triage);
  return (
    <div className="cold-row">
      <span
        className="name"
        style={{ cursor: "pointer" }}
        onClick={() => post({ type: "open-feature", feature: name })}
      >
        {name}
        {state?.state ? (
          <span className={`badge state-${state.state}`}>
            {state.state.replace(/_/g, " ")}
          </span>
        ) : (
          <span className="badge" style={{ minWidth: 80 }}>
            <Shimmer width={60} />
          </span>
        )}
      </span>
      <span className="meta-info">
        {repoStr}
        {actionable > 0 && ` · ${actionable} actionable thread${actionable === 1 ? "" : "s"}`}
      </span>
      <button
        className={`warm-it${willEvict ? " evicts" : ""}`}
        onClick={() => post({ type: "switch", feature: name })}
      >
        {willEvict ? "Switch (evicts LRU worktree)" : "Switch"}
      </button>
    </div>
  );
}

// ── Triage rail ────────────────────────────────────────────────────────

function TriageRail({ payload }: { payload: GlobalDashboardPayload }) {
  const features = payload.triage?.features ?? [];
  return (
    <aside className="triage">
      <h3>
        Triage <span className="total">{features.length} features</span>
      </h3>
      {payload.triage === null && (
        // triage() in flight — render N triage-item-shaped skeletons,
        // one per known feature in the entries roster (or 3 generic if
        // we don't know yet). Matches the real shape: priority row +
        // feature name + secondary line.
        (Object.keys(payload.entries).slice(0, 4).length
          ? Object.keys(payload.entries).slice(0, 4)
          : ["", "", ""]
        ).map((name, i) => (
          <div className="triage-item" key={`s${i}`}>
            <div className="priority-row">
              <span className="priority" style={{ minWidth: 90 }}>
                <Shimmer width={70} />
              </span>
            </div>
            <div className="feature-name">
              {name || <Shimmer width={140} />}
            </div>
            <div className="secondary">
              <Shimmer width="80%" />
            </div>
          </div>
        ))
      )}
      {payload.triage !== null && features.length === 0 && (
        <div className="placeholder" style={{ padding: "16px 20px" }}>
          No PRs needing attention.
        </div>
      )}
      {features.map((f) => (
        <TriageItem
          key={f.feature}
          item={f}
          isCanonical={f.feature === payload.canonicalFeature}
        />
      ))}
    </aside>
  );
}

function TriageItem(props: { item: TriageFeature; isCanonical: boolean }) {
  const f = props.item;
  const priority = (f as TriageFeature & { priority?: string }).priority ?? "review_required";
  const priorityLabel = priorityToLabel(priority);
  const priorityClass = priorityToClass(priority);
  const summary = describeTriageFeature(f);
  return (
    <div
      className="triage-item"
      onClick={() => post({ type: "open-feature", feature: f.feature })}
    >
      <div className="priority-row">
        <span className={`priority ${priorityClass}`}>{priorityLabel}</span>
        {props.isCanonical && <span className="focus-tag">● focused</span>}
      </div>
      <div className="feature-name">{f.feature}</div>
      <div className="secondary">{summary}</div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function SectionHead(props: {
  title: string;
  countLabel?: string;
  countAtCap?: boolean;
  capWarning?: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-head">
      {props.title}
      {props.countLabel && (
        <span className={`count${props.countAtCap ? " at-cap" : ""}`}>
          {props.countLabel}
        </span>
      )}
      {props.capWarning && <span className="cap-warning">{props.capWarning}</span>}
      {props.hint && <span className="hint">{props.hint}</span>}
      {props.action}
    </div>
  );
}

function findTriage(
  triage: GlobalDashboardPayload["triage"],
  feature: string,
): TriageFeature | undefined {
  return triage?.features.find((f) => f.feature === feature);
}

function totalActionable(triage: TriageFeature | undefined): number {
  if (!triage) return 0;
  return Object.values(triage.repos).reduce(
    (sum, r) => sum + (r.actionable_count ?? 0),
    0,
  );
}

function describeRepoSummary(
  state: FeatureState | undefined,
  triage: TriageFeature | undefined,
): string[] {
  const out: string[] = [];
  const summary = (state?.summary ?? {}) as Record<string, unknown>;
  const repos = (summary.repos ?? {}) as Record<string, RepoSummary>;
  let dirty = 0;
  let ahead = 0;
  for (const r of Object.values(repos)) {
    if (r.is_dirty) dirty += r.dirty_count ?? 1;
    if (r.ahead) ahead += r.ahead;
  }
  if (dirty > 0) out.push(`${dirty} dirty`);
  else out.push("clean");
  if (ahead > 0) out.push(`${ahead} commits ahead`);
  const prCount = triage
    ? Object.values(triage.repos).filter((r) => r.pr_number).length
    : 0;
  if (prCount === 0) out.push("no PR yet");
  return out;
}

function describeTriageFeature(f: TriageFeature): string {
  const repoCount = Object.keys(f.repos).length;
  const actionable = totalActionable(f);
  if (actionable > 0) {
    return `${actionable} actionable thread${actionable === 1 ? "" : "s"} across ${repoCount} PR${repoCount === 1 ? "" : "s"}`;
  }
  const decisions = Object.values(f.repos)
    .map((r) => r.review_decision)
    .filter(Boolean);
  if (decisions.length) return decisions.join(" · ");
  return `${repoCount} repo${repoCount === 1 ? "" : "s"} · ${f.physical_state}`;
}

function priorityToLabel(p: string): string {
  switch (p) {
    case "changes_requested": return "changes requested";
    case "review_required_with_bot_comments": return "bot review";
    case "review_required": return "review required";
    case "approved": return "approved";
    default: return p.replace(/_/g, " ");
  }
}

function priorityToClass(p: string): string {
  switch (p) {
    case "changes_requested": return "changes_requested";
    case "review_required_with_bot_comments": return "bot";
    case "review_required": return "review_required";
    case "approved": return "approved";
    default: return "stuck";
  }
}
