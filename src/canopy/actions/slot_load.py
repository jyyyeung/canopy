"""slot_load / slot_clear / slot_swap — slot-targeted operations (T16, T17).

These complement `switch` by letting the caller manipulate warm slots
without changing canonical. Useful for the dashboard's load/clear/swap
buttons and for pre-warming.
"""
from __future__ import annotations

from typing import Any

from ..git import repo as git
from ..workspace.workspace import Workspace
from .aliases import resolve_feature, repos_for_feature
from .errors import BlockerError, FixAction
from . import slots as slots_mod


def slot_load(
    workspace: Workspace,
    feature: str,
    *,
    slot_id: str | None = None,
    replace: bool = False,
    bootstrap: bool = False,
) -> dict[str, Any]:
    """Warm a cold feature into a slot without changing canonical.

    Raises BlockerError for:
      - feature_is_canonical: feature is already canonical
      - feature_already_warm: feature is already in a warm slot
      - slot_occupied: target slot is occupied and replace=False
      - unknown_slot: slot_id is out of range
      - worktree_cap_reached: all slots full and slot_id was not given
    """
    feature_name = resolve_feature(workspace, feature)
    state = slots_mod.read_state(workspace) or slots_mod.SlotState(
        slot_count=workspace.config.slots,
    )

    # Refuse if already canonical — it's loaded more strongly than warm.
    if state.canonical and state.canonical.feature == feature_name:
        raise BlockerError(
            code="feature_is_canonical",
            what=f"feature '{feature_name}' is already canonical — use `switch` to move it",
        )

    # Refuse if already warm in any slot.
    existing_slot = slots_mod.slot_for_feature(workspace, feature_name)
    if existing_slot is not None:
        raise BlockerError(
            code="feature_already_warm",
            what=f"feature '{feature_name}' is already warm in {existing_slot}",
            details={"current_slot": existing_slot, "requested_slot": slot_id},
            fix_actions=[
                FixAction(
                    action="slot_swap",
                    args={"slot_a": existing_slot, "slot_b": slot_id or "?"},
                    safe=False,
                    preview="use `slot swap` to move between slots",
                ),
            ],
        )

    # Resolve slot id — pick lowest free, or use caller's choice.
    if slot_id is None:
        chosen = slots_mod.allocate_slot(state)
        if chosen is None:
            raise BlockerError(
                code="worktree_cap_reached",
                what=f"all {state.slot_count} slots are occupied",
                fix_actions=[
                    FixAction(
                        action="slot_clear",
                        args={"slot_id": "<LRU>"},
                        safe=False,
                        preview="clear an LRU slot first",
                    ),
                ],
            )
        slot_id = chosen

    # Validate slot id range.
    valid_slots = {f"worktree-{i}" for i in range(1, state.slot_count + 1)}
    if slot_id not in valid_slots:
        raise BlockerError(
            code="unknown_slot",
            what=f"slot '{slot_id}' out of range (cap={state.slot_count})",
        )

    # If occupied: evict with replace=True, else refuse.
    evicted: dict | None = None
    if slot_id in state.slots:
        if not replace:
            raise BlockerError(
                code="slot_occupied",
                what=f"{slot_id} is occupied by '{state.slots[slot_id].feature}'",
                details={"slot": slot_id, "occupant": state.slots[slot_id].feature},
                fix_actions=[
                    FixAction(
                        action="slot_load",
                        args={"feature": feature_name, "slot_id": slot_id, "replace": True},
                        safe=False,
                        preview="evict occupant to cold and load this feature",
                    ),
                ],
            )
        evicted = slot_clear(workspace, slot_id)

    # Re-read state after potential eviction.
    state = slots_mod.read_state(workspace) or slots_mod.SlotState(
        slot_count=workspace.config.slots,
    )

    # Add worktrees per repo — iterate repos_for_feature (respects partial scope).
    repo_branches = repos_for_feature(workspace, feature_name) or {
        r.config.name: feature_name for r in workspace.repos
    }
    per_repo: list[dict] = []
    for repo_name, branch in repo_branches.items():
        try:
            repo = workspace.get_repo(repo_name)
        except KeyError:
            continue
        if not git.branch_exists(repo.abs_path, branch):
            git.create_branch(repo.abs_path, branch,
                              start_point=repo.config.default_branch)
        dest = slots_mod.slot_worktree_path(workspace, slot_id, repo_name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        git.worktree_add(repo.abs_path, dest, branch, create_branch=False)
        per_repo.append({
            "repo": repo_name,
            "branch": branch,
            "worktree_path": str(dest.resolve()),
        })

    # Persist slot entry + bump last_touched.
    now = slots_mod.now_iso()
    state.slots[slot_id] = slots_mod.SlotEntry(feature=feature_name, occupied_at=now)
    state.last_touched[feature_name] = now
    slots_mod.write_state(workspace, state)

    # Optional bootstrap.
    bootstrap_result = None
    if bootstrap or getattr(workspace.config, "bootstrap_default", False):
        try:
            from . import bootstrap as bs
            bootstrap_result = bs.bootstrap_feature(workspace, feature_name)
        except (ImportError, AttributeError) as e:
            bootstrap_result = {"skipped": f"bootstrap module not available: {e}"}
        except Exception as e:
            bootstrap_result = {"error": str(e)}

    return {
        "feature": feature_name,
        "slot_id": slot_id,
        "per_repo": per_repo,
        "evicted": evicted,
        "bootstrap": bootstrap_result,
    }


def slot_clear(workspace: Workspace, slot_id: str) -> dict[str, Any]:
    """Evict a feature from a slot to cold (T17 stub — minimal for T16 eviction).

    Removes the worktrees for all repos the feature touches, then
    removes the slot entry from slots.json. The branch is kept; this
    operation only removes the warm worktree.
    """
    state = slots_mod.read_state(workspace)
    if state is None or slot_id not in state.slots:
        raise BlockerError(
            code="empty_slot",
            what=f"slot '{slot_id}' is empty — nothing to clear",
        )
    feature = state.slots[slot_id].feature
    repo_branches = repos_for_feature(workspace, feature) or {
        r.config.name: feature for r in workspace.repos
    }
    cleared: list[dict] = []
    for repo_name in repo_branches:
        try:
            repo = workspace.get_repo(repo_name)
        except KeyError:
            continue
        slot_path = slots_mod.slot_worktree_path(workspace, slot_id, repo_name)
        if slot_path.exists():
            git.worktree_remove(repo.abs_path, slot_path, force=True)
        cleared.append({"repo": repo_name, "slot_path": str(slot_path)})
    # Re-read to get latest state, then remove slot entry.
    state = slots_mod.read_state(workspace) or state
    if slot_id in state.slots:
        del state.slots[slot_id]
    slots_mod.write_state(workspace, state)
    return {"slot_id": slot_id, "feature": feature, "repos": cleared}


def slot_swap(workspace: Workspace, slot_a: str, slot_b: str) -> dict[str, Any]:
    """Swap features between two slots (T17 stub — full implementation in T17)."""
    raise NotImplementedError("slot_swap lands in T17")
