"""Tests for actions/slot_load.py — slot_load primitive (T16)."""
import subprocess

import pytest


def test_slot_load_auto_allocates_lowest_free_slot(workspace_with_canonical_only):
    from canopy.actions.slot_load import slot_load
    result = slot_load(workspace_with_canonical_only, "Y")
    assert result["slot_id"] == "worktree-1"
    from canopy.actions import slots as sm
    state = sm.read_state(workspace_with_canonical_only)
    assert state.slots["worktree-1"].feature == "Y"


def test_slot_load_explicit_slot(workspace_with_canonical_only):
    from canopy.actions.slot_load import slot_load
    result = slot_load(workspace_with_canonical_only, "Y", slot_id="worktree-2")
    assert result["slot_id"] == "worktree-2"


def test_slot_load_refuses_when_feature_is_canonical(workspace_with_slots):
    from canopy.actions.slot_load import slot_load
    from canopy.actions.errors import BlockerError
    with pytest.raises(BlockerError) as e:
        slot_load(workspace_with_slots, "X")  # X is canonical
    assert e.value.code == "feature_is_canonical"


def test_slot_load_refuses_when_already_warm(workspace_with_slots):
    """Y is already warm in slot-1 — loading Y again is a no-op or error."""
    from canopy.actions.slot_load import slot_load
    from canopy.actions.errors import BlockerError
    with pytest.raises(BlockerError) as e:
        slot_load(workspace_with_slots, "Y", slot_id="worktree-2")
    assert e.value.code == "feature_already_warm"


def test_slot_load_occupied_slot_replace(workspace_with_slots):
    """slot-1 has Y; load Z into slot-1 with --replace evicts Y first."""
    from canopy.actions.slot_load import slot_load
    # Pre-create Z as a cold branch in both repos
    for repo in ("repo-a", "repo-b"):
        subprocess.run(
            ["git", "branch", "Z"],
            cwd=workspace_with_slots.config.root / repo,
            check=True,
        )
    result = slot_load(workspace_with_slots, "Z", slot_id="worktree-1", replace=True)
    assert result["slot_id"] == "worktree-1"
    assert result["evicted"]["feature"] == "Y"
