# Canopy CLI / MCP — Changelog

Tracks the Python side (CLI + MCP server). The VSCode extension has its own [vscode-extension/CHANGELOG.md](vscode-extension/CHANGELOG.md).

Versions follow semver. Pre-1.0 — minor bumps may add features or break behavior; the README is the source-of-truth contract.

## 0.7.0

Five new top-level commands + a CI-aware state machine.

- **`canopy ship`** takes a feature from "code is committed" to "PR is open across every repo." Per-repo recipe: ensure-pushed → ensure-PR-exists → cross-repo body refresh so each PR description links to its siblings. Idempotent (`up_to_date` on re-run); refuses to silently recreate closed PRs; surfaces force-push divergence as `diverged`. Exposed as `mcp__canopy__ship`.
- **`canopy draft-replies <alias>`** walks each unresolved review comment's anchor sha through `git log -- <path>`. Addressed comments get a template-based draft (`Done — <subject>. (<sha>)` / `Addressed in <sha>: <subject>.` / `Addressed across N commits — <list>.`) with high/medium/low confidence based on commit count + keyword overlap. No LLM. Exposed as `mcp__canopy__draft_replies`.
- **CI status integration.** `feature_state.repos[*].pr.ci_status` carries a rolled-up CI verdict from `gh pr checks`. The state machine gains `awaiting_ci` (approved + pending CI), and approved + failing CI now flips to `needs_work` instead of misleadingly reporting `approved`. New `canopy pr-checks <alias>` + `mcp__canopy__pr_checks` for the raw check list.
- **`canopy worktree-bootstrap <feature>`** runs three optional steps per repo: copy `env_files` from main checkout into the worktree, run `install_cmd` (e.g. `uv sync` / `pnpm install`), and write `.canopy/workspaces/<feature>.code-workspace` when `[workspace] ide = "vscode"`. New per-repo `env_files` / `install_cmd` / `ide_settings` keys in canopy.toml; per-workspace `bootstrap_default` opt-in.
- **`canopy conflicts`** pairwise intersects each active feature's changed-files per repo. `--lines` opts into a deeper `git diff --unified=0` parse for line-range overlap (downgrades to `medium` when files overlap but lines don't); generated/lockfile-style files auto-drop to `medium` with an "auto-mergeable" suggestion. Exposed as `mcp__canopy__conflicts`.

MCP tools 54 → 59. Tests 651 → 712. Comment-shape adds `commit_id` so the file-history walk in draft-replies can anchor properly.

## 0.5.0

Catches the `__version__` constant up to ~6 months of shipped work. The handshake the doctor's staleness checks rely on is only useful when this number actually moves — this release fixes that drift.

- **`canopy commit` + `canopy push`** — feature-scoped multi-repo commit and push with `wrong_branch` / `no_upstream` blockers and per-repo result classification.
- **Provider-injection architecture** — `docs/architecture/providers.md` design doc for the issue-provider contract.
- **`canopy doctor`** — single recovery primitive with 16 diagnostic categories (state-file integrity + install / version / mcp / skill / vsix). `--fix` for auto-repairable; severity tiers; structured JSON.
- **Issue providers** — `IssueProvider` Protocol + registry under `canopy.providers.*`. Linear refactored into the contract; `GitHubIssuesProvider` via `gh` CLI. `[issue_provider]` block in canopy.toml; `issue_get` / `issue_list_my_issues` MCP tools (deprecated `linear_*` aliases retained).
- **Augments** — per-workspace `[augments]` block in canopy.toml + per-repo overrides. `preflight_cmd` is the first consumer; `review_bots` and `test_cmd` reserved. Multi-skill installer; `augment-canopy` skill teaches the agent how to mutate canopy.toml safely.
- **Bot-comment tracking** — per-comment resolution log at `.canopy/state/bot_resolutions.json`; `canopy commit --address <comment-id>` auto-suffixes the message and records the resolution; `canopy bot-status` rollup; new `awaiting_bot_resolution` state.
- **Historian** — per-feature persistent memory at `.canopy/memory/<feature>.md`. Auto-read on `canopy switch` (response carries `memory: <markdown>`); 5 MCP tools (`historian_decide` / `historian_pause` / `historian_defer_comment` / `feature_memory` / `historian_compact`); 2 CLI commands (`canopy historian show` / `compact`); auto-mirror from `commit --address` and `github_get_pr_comments`.

MCP tools 41 → 54. Tests ~400 → 624. State machine 8 → 9 (added `awaiting_bot_resolution`). Bundled skills 1 → 2 (`using-canopy` + opt-in `augment-canopy`).

## 0.1.0

Initial release: workspace discovery, feature lanes, post-checkout hook, drift detection, `switch` / `triage` / `feature_state` actions, MCP server, agent setup.
