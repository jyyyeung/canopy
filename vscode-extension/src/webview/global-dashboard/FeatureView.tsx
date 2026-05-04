/**
 * FeatureView — per-feature drill-in.
 *
 * Mockup source: `vscode-extension/mockups/dashboard-pastel-feature.html`.
 *
 * Center column (top → bottom):
 *   1. IssueCard      — Linear / GitHub Issue body, badges, "issue ↗"
 *   2. RepoCards      — per-repo branch + dirty + PR + actionable chips
 *   3. ReviewThreads  — temporally-classified actionable threads, grouped
 *      by repo, each with Address / Reply / Resolve buttons
 *   4. DiffStack      — per-file diff blocks (truncated), file name links
 *      to native VS Code diff
 *
 * Right rail (4 sections, atomic actions only — see plan decision #1):
 *   - Priority — top actionable threads with Address / View
 *   - Checks   — Run preflight
 *   - Commit & push — per-repo Stage / Commit / Push / Open PR
 *   - State    — Stash / Pop / Switch back to global
 *   - Open     — Open in IDE / Open issue / Open PRs
 */
import { useMemo, useState } from "react";
import type { FeatureStatusRepo, ReviewThread } from "../../canopyCli";
import type { FeaturePayload, ReviewThreadIntent } from "./protocol";
import { post } from "./vscode";
import { parseUnifiedDiff, type DiffFile, type DiffLine } from "./diff";
import { Shimmer } from "./Skeletons";

export function FeatureView({ payload }: { payload: FeaturePayload }) {
  return (
    <>
      <FeatureTopBar payload={payload} />
      <div className="layout feature">
        <main className="center">
          {payload.error && <div className="error-banner">{payload.error}</div>}
          <IssueCard payload={payload} />
          <RepoCards payload={payload} />
          <ReviewThreads payload={payload} />
          <DiffStack payload={payload} />
        </main>
        <aside className="rail">
          <PriorityRail payload={payload} />
          <ChecksRail payload={payload} />
          <CommitPushRail payload={payload} />
          <StateRail payload={payload} />
          <OpenRail payload={payload} />
        </aside>
      </div>
    </>
  );
}

// ── Top bar (feature mode) ──────────────────────────────────────────────

function FeatureTopBar({ payload }: { payload: FeaturePayload }) {
  return (
    <header className="topbar">
      <div className="crumb">
        <span className="root" onClick={() => post({ type: "back-to-global" })}>
          canopy
        </span>
        <span className="sep">/</span>
        <span className="leaf">{payload.feature}</span>
      </div>
      <span className="station">
        workspace <code>{payload.workspaceRoot}</code>
      </span>
      <span className="spacer" />
      <button className="back-btn" onClick={() => post({ type: "back-to-global" })}>
        ← Back to Global
      </button>
    </header>
  );
}

// ── Issue card ──────────────────────────────────────────────────────────

function IssueCard({ payload }: { payload: FeaturePayload }) {
  const issue = payload.issue;
  const entry = payload.entry;
  const state = payload.state;
  const subtitle = issue?.title ?? entry?.linear_title ?? "";
  const description = issue?.description ?? "";
  const isCanonical = payload.canonicalFeature === payload.feature;

  return (
    <>
      <SectionHead title="Issue" hint="linked Linear / GitHub issue body" />
      <div className="issue-card">
        <h2>{payload.feature}</h2>
        {subtitle && <div className="subtitle">{subtitle}</div>}
        <div className="issue-meta-row">
          {isCanonical && <span className="badge canonical">● in main</span>}
          {state?.state && (
            <span className={`badge state-${state.state}`}>
              {state.state.replace(/_/g, " ")}
            </span>
          )}
          {issue?.url && (
            <a
              className="pill-link"
              onClick={(e) => {
                e.preventDefault();
                post({ type: "open-link", url: issue.url! });
              }}
            >
              issue ↗
            </a>
          )}
          {entry?.linear_issue && !issue?.identifier && (
            <span className="badge">{entry.linear_issue}</span>
          )}
        </div>
        {description ? (
          <details className="issue-disclosure" open>
            <summary>Show issue body</summary>
            <div
              className="issue-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(description) }}
            />
          </details>
        ) : payload.issue === null && payload.entry?.linear_issue ? (
          // Issue body in flight — render the same `.issue-body` block
          // with paragraph-shaped shimmers where the markdown will land.
          <details className="issue-disclosure" open>
            <summary>Show issue body</summary>
            <div className="issue-body" style={{ display: "grid", gap: 8 }}>
              <Shimmer width="90%" />
              <Shimmer width="78%" />
              <Shimmer width="40%" />
              <Shimmer width="85%" style={{ marginTop: 4 }} />
              <Shimmer width="60%" />
            </div>
          </details>
        ) : (
          <div className="placeholder">No issue body found.</div>
        )}
      </div>
    </>
  );
}

// ── Per-repo cards ──────────────────────────────────────────────────────

function RepoCards({ payload }: { payload: FeaturePayload }) {
  const status = payload.status;
  const entry = payload.entry;
  const repos = entry?.repos ?? Object.keys(status?.repos ?? {});
  if (repos.length === 0) {
    return (
      <>
        <SectionHead title="Repos" />
        <div className="placeholder">No repos in this feature.</div>
      </>
    );
  }
  return (
    <>
      <SectionHead
        title="Repos"
        countLabel={String(repos.length)}
        hint="per-repo branch + target + status"
      />
      <div className="repo-grid">
        {repos.map((repo) => {
          const repoStatus = payload.status?.repos?.[repo] ?? {};
          const preflightOk = preflightStateForRepo(payload, repo, repoStatus);
          // `payload.status === null` means featureStatus() is still in
          // flight; flag the card so it shimmers in branch + meta + chip
          // slots until the call resolves.
          const loading = payload.status === null;
          return (
            <RepoCard
              key={repo}
              repo={repo}
              target={payload.targetBranches[repo] ?? "main"}
              info={repoStatus}
              actionable={
                payload.comments?.repos?.[repo]?.actionable_threads?.length ?? 0
              }
              botCount={
                payload.comments?.repos?.[repo]?.actionable_threads?.filter((t) => t.is_bot).length ?? 0
              }
              preflight={preflightOk}
              loading={loading}
            />
          );
        })}
      </div>
    </>
  );
}

/**
 * Translate the cached preflight entry into a per-repo verdict:
 *   - "passed" if last run was green AND its head SHA matches current HEAD
 *   - "failed" if last run failed
 *   - "stale"  if green but SHA drifted
 *   - null     if we have no record
 */
function preflightStateForRepo(
  payload: FeaturePayload,
  _repo: string,
  status: FeatureStatusRepo,
): "passed" | "failed" | "stale" | null {
  const h = payload.preflightHistory;
  if (!h) return null;
  if (!h.passed) return "failed";
  // SHA comparison — the entry may not record per-repo SHAs in older
  // workspaces; treat that as "stale enough to want a re-run."
  // status.branch exists but no head SHA on the FeatureStatusRepo shape;
  // we only flip stale when we have something to compare. Be conservative.
  const headPerRepo = h.head_sha_per_repo ?? {};
  const recordedSha = headPerRepo[_repo];
  // featureStatus doesn't expose head SHA; fall back to "passed" if no
  // recorded SHA, otherwise pretend stale (we'd flip to passed once we
  // start surfacing head SHA on FeatureStatusRepo).
  if (!recordedSha) return "passed";
  // We don't have a current head SHA in the payload to compare against,
  // so once we have a recorded sha we mark stale — encourages a re-run.
  return "stale";
}

function RepoCard(props: {
  repo: string;
  target: string;
  info: FeatureStatusRepo;
  actionable: number;
  botCount: number;
  preflight: "passed" | "failed" | "stale" | null;
  loading: boolean;
}) {
  const { repo, target, info, actionable, botCount, preflight, loading } = props;
  const dirty = info.dirty_count ?? 0;
  const prUrl = info.pr_url;
  const prNum = info.pr_number;
  return (
    <div className="repo-card">
      <h3>
        {repo}
        <span className="branch">
          {info.branch ? info.branch : <Shimmer width={140} />}
          <span className="arrow">→</span>
          <span className="target">{target}</span>
        </span>
      </h3>
      <div className="repo-meta">
        {loading && info.changed_file_count === undefined ? (
          // status fetch in flight — shape-of-meta shimmer.
          <>
            <span><Shimmer width={90} /></span>
            <span><Shimmer width={110} /></span>
          </>
        ) : (
          <>
            {info.changed_file_count !== undefined && (
              <span>{info.changed_file_count} files changed</span>
            )}
            {info.ahead !== undefined && info.ahead > 0 && (
              <span>{info.ahead} commits ahead</span>
            )}
            {info.behind !== undefined && info.behind > 0 && (
              <span>{info.behind} behind</span>
            )}
          </>
        )}
      </div>
      <div className="stat-row">
        {loading && info.branch === undefined ? (
          // Pre-data: one chip-shaped shimmer where the dirty/clean
          // chip will land. Real chips render as data arrives.
          <span className="stat-chip" style={{ minWidth: 56 }}>
            <Shimmer width={48} />
          </span>
        ) : dirty > 0 ? (
          <span className="stat-chip dirty">{dirty} dirty</span>
        ) : (
          <span className="stat-chip clean">clean</span>
        )}
        {preflight === "passed" && (
          <span className="stat-chip preflight-pass">preflight ✓</span>
        )}
        {preflight === "failed" && (
          <span className="stat-chip preflight-fail">preflight ✗</span>
        )}
        {preflight === "stale" && (
          <span className="stat-chip">preflight stale</span>
        )}
        {prUrl && (
          <span
            className="stat-chip pr"
            onClick={() => post({ type: "open-link", url: prUrl })}
          >
            PR {prNum ? `#${prNum}` : ""} ↗
          </span>
        )}
        {actionable > 0 && (
          <span className="stat-chip actionable">{actionable} actionable</span>
        )}
        {botCount > 0 && (
          <span className="stat-chip bot">{botCount} bot</span>
        )}
      </div>
    </div>
  );
}

// ── Review threads ──────────────────────────────────────────────────────

function ReviewThreads({ payload }: { payload: FeaturePayload }) {
  const comments = payload.comments;
  if (!comments) {
    // Render the same threads-group shape, one thread-card skeleton per
    // repo, so the layout doesn't shift when comments arrive.
    const repos = payload.entry?.repos ?? [];
    return (
      <>
        <SectionHead title="Review threads" hint="loading…" />
        {(repos.length ? repos : [""]).map((repo, i) => (
          <div className="threads-group" key={i}>
            {repo && <div className="group-head">{repo} · loading…</div>}
            <ThreadSkeleton />
          </div>
        ))}
      </>
    );
  }
  const totalActionable = comments.actionable_count ?? 0;
  const groups = Object.entries(comments.repos)
    .filter(([, info]) => (info.actionable_threads?.length ?? 0) > 0);

  if (groups.length === 0) {
    return (
      <>
        <SectionHead title="Review threads" countLabel="0 actionable" />
        <div className="placeholder">No actionable threads.</div>
      </>
    );
  }

  return (
    <>
      <SectionHead
        title="Review threads"
        countLabel={`${totalActionable} actionable`}
        hint="grouped by repo · click filename to open"
      />
      {groups.map(([repo, info]) => (
        <div key={repo} className="threads-group">
          <div className="group-head">
            {repo} · {info.actionable_threads?.length ?? 0} actionable
          </div>
          {(info.actionable_threads ?? []).map((t, i) => (
            <ThreadCard
              key={t.id ?? i}
              feature={payload.feature}
              repo={repo}
              thread={t}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function ThreadCard(props: {
  feature: string;
  repo: string;
  thread: ReviewThread;
}) {
  const t = props.thread;
  const intent: ReviewThreadIntent = {
    id: t.id, author: t.author, body: t.body, path: t.path,
    line: t.line, url: t.url,
  };
  return (
    <div className="thread">
      <div className="thread-head">
        <span className={`thread-author${t.is_bot ? " bot" : ""}`}>
          {t.author ?? "(unknown)"}
        </span>
        {t.path && (
          <span
            className="thread-file"
            style={{ cursor: "pointer" }}
            onClick={() =>
              post({ type: "open-file", repo: props.repo, path: t.path! })
            }
          >
            {t.path}
            {t.line ? `:${t.line}` : ""}
          </span>
        )}
        {t.created_at && <span className="thread-when">{relativeTime(t.created_at)}</span>}
      </div>
      <div
        className="thread-comment"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(t.body ?? "") }}
      />
      <div className="thread-actions">
        <button
          className="action-btn primary"
          style={{ padding: "5px 11px", fontSize: 11 }}
          onClick={() =>
            post({
              type: "address-thread",
              feature: props.feature, repo: props.repo, thread: intent,
            })
          }
        >
          Address in agent
        </button>
        {t.is_bot ? (
          <button
            className="action-btn"
            style={{ padding: "5px 11px", fontSize: 11 }}
            onClick={() =>
              post({
                type: "mark-addressed",
                feature: props.feature, repo: props.repo, thread: intent,
              })
            }
          >
            Mark addressed
          </button>
        ) : (
          <button
            className="action-btn"
            style={{ padding: "5px 11px", fontSize: 11 }}
            onClick={() =>
              post({
                type: "reply-thread",
                feature: props.feature, repo: props.repo, thread: intent,
              })
            }
          >
            Reply
          </button>
        )}
        {t.url && (
          <button
            className="action-btn"
            style={{ padding: "5px 11px", fontSize: 11 }}
            onClick={() => post({ type: "open-link", url: t.url! })}
          >
            Open thread ↗
          </button>
        )}
      </div>
    </div>
  );
}

// ── Diff stack ──────────────────────────────────────────────────────────

function DiffStack({ payload }: { payload: FeaturePayload }) {
  const aggregated = useMemo(() => collectDiffs(payload), [payload]);
  if (!payload.diff) {
    // Render one diff-block skeleton in shape: file-header + 3 lines
    // of unified-diff body. Doesn't claim a file path or stat counts.
    return (
      <>
        <SectionHead title="Diff" hint="loading…" />
        <DiffBlockSkeleton />
      </>
    );
  }
  if (aggregated.files.length === 0) {
    return (
      <>
        <SectionHead title="Diff" countLabel="no changes" />
        <div className="placeholder">No diff against target branches.</div>
      </>
    );
  }
  return (
    <>
      <SectionHead
        title="Diff"
        countLabel={`${aggregated.files.length} files · +${aggregated.totalAdd} / −${aggregated.totalDel}`}
        hint="full diff vs target · click filename to open in editor"
      />
      {aggregated.files.map((file, i) => (
        <DiffBlock key={`${file.repo}:${file.newPath}:${i}`} file={file} />
      ))}
    </>
  );
}

interface AggregatedDiff {
  files: DiffFile[];
  totalAdd: number;
  totalDel: number;
}

function collectDiffs(payload: FeaturePayload): AggregatedDiff {
  const out: DiffFile[] = [];
  let totalAdd = 0;
  let totalDel = 0;
  if (!payload.diff) return { files: out, totalAdd, totalDel };
  for (const [repo, info] of Object.entries(payload.diff.repos ?? {})) {
    if (typeof info.diff === "string" && info.diff.trim().length > 0) {
      const files = parseUnifiedDiff(info.diff, repo);
      out.push(...files);
    } else if (Array.isArray(info.files)) {
      // No raw diff text — synthesize header-only blocks so the user sees
      // the file list at least.
      for (const f of info.files) {
        out.push({
          repo,
          oldPath: f.path,
          newPath: f.path,
          additions: f.additions ?? 0,
          deletions: f.deletions ?? 0,
          hunks: [],
          binary: false,
        });
      }
    }
  }
  for (const f of out) {
    totalAdd += f.additions;
    totalDel += f.deletions;
  }
  return { files: out, totalAdd, totalDel };
}

const DEFAULT_HUNK_VISIBLE = 12;

function DiffBlock({ file }: { file: DiffFile }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="diff-block">
      <div className="diff-head">
        <span className="repo">{file.repo}</span>
        <span
          className="path"
          onClick={() =>
            post({ type: "open-file", repo: file.repo, path: file.newPath })
          }
        >
          {file.newPath || file.oldPath}
        </span>
        <span className="stats">
          <span className="add">+{file.additions}</span>{" "}
          <span className="del">−{file.deletions}</span>
        </span>
      </div>
      {file.binary ? (
        <div className="placeholder" style={{ padding: "12px 16px" }}>
          Binary file — open in editor to view.
        </div>
      ) : file.hunks.length === 0 ? (
        <div className="placeholder" style={{ padding: "12px 16px" }}>
          File-list only (no inline diff returned).
        </div>
      ) : (
        <div className="diff-body">
          {file.hunks.map((hunk, hi) => {
            const visible = expanded ? hunk.lines : hunk.lines.slice(0, DEFAULT_HUNK_VISIBLE);
            const hidden = hunk.lines.length - visible.length;
            return (
              <div key={hi}>
                {visible.map((line, li) => (
                  <DiffRow key={li} line={line} />
                ))}
                {hidden > 0 && (
                  <div
                    className="diff-truncate"
                    onClick={() => setExpanded(true)}
                  >
                    show full hunk · {hidden} more lines
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const cls = `diff-line${line.kind === "hunk" ? " hunk" : line.kind === "add" ? " add" : line.kind === "del" ? " del" : ""}`;
  return (
    <div className={cls}>
      <span className="ln-old">{line.oldNo ?? ""}</span>
      <span className="ln-new">{line.newNo ?? ""}</span>
      <span className="code">{line.text}</span>
    </div>
  );
}

// ── Right rail sections ─────────────────────────────────────────────────

function PriorityRail({ payload }: { payload: FeaturePayload }) {
  const items: Array<{ repo: string; thread: ReviewThread; kind: string }> = [];
  for (const [repo, info] of Object.entries(payload.comments?.repos ?? {})) {
    for (const t of info.actionable_threads ?? []) {
      items.push({
        repo,
        thread: t,
        kind: t.is_bot ? "bot" : "changes_requested",
      });
    }
  }
  return (
    <div className="rail-section">
      <h3>
        Priority <span className="total">{items.length}</span>
      </h3>
      {items.length === 0 && (
        <div className="placeholder" style={{ padding: "8px 18px" }}>
          No actionable threads.
        </div>
      )}
      {items.map((it, i) => {
        const intent: ReviewThreadIntent = {
          id: it.thread.id, author: it.thread.author, body: it.thread.body,
          path: it.thread.path, line: it.thread.line, url: it.thread.url,
        };
        const gist = (it.thread.body ?? "").split("\n")[0].slice(0, 80);
        return (
          <div className="priority-item" key={i}>
            <div className="top">
              <span className={`kind ${it.kind}`}>
                {it.kind === "bot" ? "bot" : "changes requested"}
              </span>
              <span className="repo-tag">{it.repo}</span>
            </div>
            <div className="gist">
              <span className="author">
                {(it.thread.author ?? "?")}:
              </span>{" "}
              {gist}
            </div>
            <div className="actions">
              <button
                onClick={() =>
                  post({
                    type: "address-thread",
                    feature: payload.feature, repo: it.repo, thread: intent,
                  })
                }
              >
                Address
              </button>
              <button
                onClick={() =>
                  it.thread.url
                    ? post({ type: "open-link", url: it.thread.url })
                    : undefined
                }
                disabled={!it.thread.url}
              >
                View
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChecksRail({ payload }: { payload: FeaturePayload }) {
  return (
    <div className="rail-section">
      <h3>Checks</h3>
      <div className="action-list">
        <button
          className="action-btn"
          onClick={() => post({ type: "preflight", feature: payload.feature })}
        >
          Run preflight
          <span className="preview">stages all repos · runs hooks · no commit</span>
        </button>
        <button
          className="action-btn"
          onClick={() => post({ type: "conflicts", feature: payload.feature })}
        >
          Cross-feature conflicts
          <span className="preview">overlap with other active features</span>
        </button>
        <button
          className="action-btn"
          onClick={() => post({ type: "bootstrap", feature: payload.feature })}
        >
          Bootstrap worktrees
          <span className="preview">env-files · install · IDE workspace</span>
        </button>
      </div>
    </div>
  );
}

function CommitPushRail({ payload }: { payload: FeaturePayload }) {
  const repos = payload.entry?.repos ?? Object.keys(payload.status?.repos ?? {});
  if (repos.length === 0) {
    return (
      <div className="rail-section">
        <h3>Commit & push</h3>
        <div className="placeholder" style={{ padding: "8px 18px" }}>
          No repos.
        </div>
      </div>
    );
  }
  return (
    <div className="rail-section">
      <h3>Commit & push</h3>
      <div className="action-list">
        <button
          className="action-btn primary"
          onClick={() => post({ type: "ship", feature: payload.feature })}
        >
          Ship feature
          <span className="preview">push + open/update PR per repo · cross-repo links</span>
        </button>
        <button
          className="action-btn"
          onClick={() => post({ type: "draft-replies", feature: payload.feature })}
        >
          Draft replies for addressed threads
          <span className="preview">templates per addressed comment</span>
        </button>
      </div>
      <div className="action-list per-repo">
        {repos.map((repo) => {
          const status = payload.status?.repos?.[repo];
          const dirty = status?.dirty_count ?? 0;
          const prUrl = status?.pr_url;
          return (
            <RepoActionRow
              key={repo}
              feature={payload.feature}
              repo={repo}
              dirty={dirty}
              prUrl={prUrl}
            />
          );
        })}
      </div>
    </div>
  );
}

function RepoActionRow(props: {
  feature: string;
  repo: string;
  dirty: number;
  prUrl?: string;
}) {
  return (
    <>
      <span className="repo-label">
        {props.repo} · {props.dirty} dirty
      </span>
      <button
        className="action-btn"
        onClick={() => post({ type: "stage", feature: props.feature, repo: props.repo })}
      >
        Stage
      </button>
      <button
        className="action-btn"
        onClick={() => post({ type: "commit", feature: props.feature, repo: props.repo })}
      >
        Commit
      </button>
      <button
        className="action-btn"
        onClick={() => post({ type: "push", feature: props.feature, repo: props.repo })}
      >
        Push
      </button>
      <button
        className="action-btn"
        onClick={() =>
          post({
            type: "open-pr",
            feature: props.feature,
            repo: props.repo,
            url: props.prUrl,
          })
        }
      >
        {props.prUrl ? "Open PR ↗" : "Open PR"}
      </button>
    </>
  );
}

function StateRail({ payload }: { payload: FeaturePayload }) {
  return (
    <div className="rail-section">
      <h3>State</h3>
      <div className="action-list">
        <button
          className="action-btn"
          onClick={() => post({ type: "stash-save", feature: payload.feature })}
        >
          Stash this feature
        </button>
        <button
          className="action-btn"
          onClick={() => post({ type: "stash-pop", feature: payload.feature })}
        >
          Pop stash
        </button>
        <button
          className="action-btn"
          onClick={() => post({ type: "back-to-global" })}
        >
          ← Back to global
        </button>
      </div>
    </div>
  );
}

function OpenRail({ payload }: { payload: FeaturePayload }) {
  const issueUrl = payload.issue?.url ?? payload.entry?.linear_url;
  const prUrls: Array<{ repo: string; url: string }> = [];
  for (const [repo, info] of Object.entries(payload.comments?.repos ?? {})) {
    if (info.pr_url) prUrls.push({ repo, url: info.pr_url });
  }
  return (
    <div className="rail-section">
      <h3>Open</h3>
      <div className="action-list">
        <button
          className="action-btn"
          onClick={() => post({ type: "open-ide", feature: payload.feature })}
        >
          Open in IDE <span className="preview">all repo worktrees</span>
        </button>
        <button
          className="action-btn"
          disabled={!issueUrl}
          onClick={() => issueUrl && post({ type: "open-link", url: issueUrl })}
        >
          Open issue ↗
        </button>
        {prUrls.length > 0 && (
          <button
            className="action-btn"
            onClick={() => {
              for (const { url } of prUrls) post({ type: "open-link", url });
            }}
          >
            Open PRs ↗
            <span className="preview">
              {prUrls.map((p) => `${p.repo}: ${p.url.split("/").pop()}`).join(" · ")}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function SectionHead(props: {
  title: string;
  countLabel?: string;
  hint?: string;
}) {
  return (
    <div className="section-head">
      {props.title}
      {props.countLabel && <span className="count">{props.countLabel}</span>}
      {props.hint && <span className="hint">{props.hint}</span>}
    </div>
  );
}

/**
 * Tiny markdown-ish renderer for issue + thread bodies. Handles paragraphs,
 * inline `code`, fenced ```code``` blocks, and bare URLs. Anything more is
 * out of scope for v1 (avoid adding a markdown lib and inflating the
 * webview bundle). HTML is escaped before pattern substitution.
 */
function renderMarkdown(input: string): string {
  if (!input) return "";
  const escaped = escapeHtml(input);
  // Fenced code blocks first (so inline code doesn't munge them).
  let out = escaped.replace(/```([\s\S]*?)```/g, (_m, body) =>
    `<pre>${body}</pre>`,
  );
  // Inline code.
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Bare URLs → links (escaped already, so we just look for http(s)://).
  out = out.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  // Paragraphs: split on blank lines.
  const paragraphs = out.split(/\n\s*\n/).map((p) => {
    if (p.startsWith("<pre>")) return p;
    return `<p>${p.replace(/\n/g, "<br/>")}</p>`;
  });
  return paragraphs.join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Thread-card skeleton — same shape as a real `<ThreadCard>`: head
 * row (author + file:line), one body line, action-button stubs.
 * Pulled out here rather than into Skeletons.tsx because it's
 * tightly coupled to FeatureView's existing class structure.
 */
function ThreadSkeleton() {
  return (
    <div className="thread">
      <div className="thread-head">
        <span className="thread-author"><Shimmer width={80} /></span>
        <span className="thread-file"><Shimmer width={140} /></span>
      </div>
      <div className="thread-comment" style={{ display: "grid", gap: 6 }}>
        <Shimmer width="92%" />
        <Shimmer width="60%" />
      </div>
      <div className="thread-actions">
        <span style={{ width: 110, height: 22, display: "inline-flex", alignItems: "center" }}>
          <Shimmer width={90} />
        </span>
        <span style={{ width: 60, height: 22, display: "inline-flex", alignItems: "center" }}>
          <Shimmer width={50} />
        </span>
      </div>
    </div>
  );
}

/** Diff-block skeleton — head bar + monospace body lines. */
function DiffBlockSkeleton() {
  return (
    <div className="diff-block">
      <div className="diff-head">
        <span className="repo"><Shimmer width={50} /></span>
        <span className="path"><Shimmer width={220} /></span>
        <span className="stats"><Shimmer width={60} /></span>
      </div>
      <div className="diff-body" style={{ padding: "8px 16px", display: "grid", gap: 8 }}>
        <Shimmer width="60%" />
        <Shimmer width="80%" />
        <Shimmer width="45%" />
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Date.now() - t;
  const min = Math.floor(delta / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
