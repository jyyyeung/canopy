"""Tests for Wave 3.0 slot-model switch behavior.

Coverage:
  - fast-path swap when Y is warm in some slot (no worktree add)
  - cold-Y allocates the lowest free slot for X
  - cap-reached + ``no_evict=True`` raises ``BlockerError(worktree_cap_reached)``

T11 will move these fixtures to conftest.py; for T5 they live inline so
the switch refactor can be verified before fixture relocation.
"""
from __future__ import annotations

import subprocess

import pytest


# ── T5-inline fixtures (will move to conftest.py in T11) ────────────────

@pytest.fixture
def canopy_toml_for_workspace(workspace_with_feature):
    """canopy.toml inside the workspace_with_feature root."""
    toml = workspace_with_feature / "canopy.toml"
    toml.write_text("""
[workspace]
name = "test"
slots = 2

[[repos]]
name = "repo-a"
path = "repo-a"

[[repos]]
name = "repo-b"
path = "repo-b"
""")
    return workspace_with_feature


@pytest.fixture
def workspace_with_canonical_only(canopy_toml_for_workspace):
    """Canonical=X, no warm slots, slots=2. Y exists as a cold branch."""
    from canopy.workspace.workspace import Workspace
    from canopy.workspace.config import load_config
    from canopy.actions import slots as sm

    ws = Workspace(load_config(canopy_toml_for_workspace))
    # Seed canonical=X with both repos' main checkouts (X branch).
    for repo in ("repo-a", "repo-b"):
        subprocess.run(["git", "branch", "X"],
                       cwd=canopy_toml_for_workspace / repo, check=True)
        subprocess.run(["git", "checkout", "X"],
                       cwd=canopy_toml_for_workspace / repo, check=True)
        subprocess.run(["git", "branch", "Y"],
                       cwd=canopy_toml_for_workspace / repo, check=True)

    sm.write_state(ws, sm.SlotState(
        slot_count=2,
        canonical=sm.CanonicalEntry(
            feature="X", activated_at=sm.now_iso(),
            per_repo_paths={
                "repo-a": str(canopy_toml_for_workspace / "repo-a"),
                "repo-b": str(canopy_toml_for_workspace / "repo-b"),
            },
        ),
    ))
    return ws


@pytest.fixture
def workspace_with_slots(workspace_with_canonical_only):
    """X canonical, Y warm in slot-1."""
    from canopy.actions.switch import switch
    switch(workspace_with_canonical_only, "Y")  # Y canonical, X warm slot-1
    switch(workspace_with_canonical_only, "X")  # X canonical, Y warm slot-1
    return workspace_with_canonical_only


@pytest.fixture
def workspace_with_full_slots(workspace_with_canonical_only):
    """slots=2; both slots filled (A and B); canonical=X."""
    ws = workspace_with_canonical_only
    for branch in ("A", "B"):
        for repo in ("repo-a", "repo-b"):
            subprocess.run(["git", "branch", branch],
                           cwd=ws.config.root / repo, check=True)
    from canopy.actions.switch import switch
    switch(ws, "A")  # X→warm slot-1, A canonical
    switch(ws, "B")  # A→warm slot-2, B canonical
    switch(ws, "X")  # B→warm? but X was evicted. We need X to be canonical
                     # with A and B in the two warm slots.
    return ws


# ── tests ───────────────────────────────────────────────────────────────

def test_switch_fastpath_when_y_warm(workspace_with_slots):
    """X canonical, Y warm in slot-1, switch(Y) uses fast-path (no worktree add)."""
    ws = workspace_with_slots
    from canopy.actions.switch import switch
    from canopy.actions import slots as sm

    result = switch(ws, "Y")

    assert result["mode"] == "active_rotation"
    per_repo = {r["repo"]: r for r in result["per_repo"]}
    assert per_repo["repo-a"]["status"] == "fastpath_swapped"
    assert per_repo["repo-b"]["status"] == "fastpath_swapped"

    state = sm.read_state(ws)
    assert state is not None
    assert state.canonical is not None
    assert state.canonical.feature == "Y"
    assert "worktree-1" in state.slots
    assert state.slots["worktree-1"].feature == "X"


def test_switch_cold_y_allocates_lowest_free_slot(workspace_with_canonical_only):
    """X canonical alone, switch(Y) where Y is cold — slot-1 gets X."""
    ws = workspace_with_canonical_only
    from canopy.actions.switch import switch
    from canopy.actions import slots as sm

    result = switch(ws, "Y")

    assert result["mode"] == "active_rotation"
    per_repo = {r["repo"]: r for r in result["per_repo"]}
    assert per_repo["repo-a"]["status"] == "evacuated"
    assert per_repo["repo-a"]["slot_id"] == "worktree-1"

    state = sm.read_state(ws)
    assert state is not None
    assert state.canonical is not None
    assert state.canonical.feature == "Y"
    assert "worktree-1" in state.slots
    assert state.slots["worktree-1"].feature == "X"


def test_switch_cap_reached_with_no_evict_raises(workspace_with_full_slots):
    """All slots full + switch new feature → BlockerError(worktree_cap_reached)."""
    ws = workspace_with_full_slots
    from canopy.actions.switch import switch
    from canopy.actions.errors import BlockerError

    # Create a new branch NEW so switch can resolve it
    for repo in ("repo-a", "repo-b"):
        subprocess.run(["git", "branch", "NEW"],
                       cwd=ws.config.root / repo, check=True)

    with pytest.raises(BlockerError) as e:
        switch(ws, "NEW", no_evict=True)
    assert e.value.code == "worktree_cap_reached"
