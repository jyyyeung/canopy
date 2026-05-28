"""Tests for wave3 slot-aware switch preflight.

Coverage:
  - cap fires + no_evict=True → BlockerError(worktree_cap_reached)
  - LRU eviction candidate is derived from slots last_touched (oldest wins)
"""
from __future__ import annotations

import subprocess

import pytest


# ── Fixture stack (mirrors test_switch.py; T11 will move both to conftest) ──

@pytest.fixture
def canopy_toml_for_workspace(workspace_with_feature):
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
    from canopy.workspace.workspace import Workspace
    from canopy.workspace.config import load_config
    from canopy.actions import slots as sm

    ws = Workspace(load_config(canopy_toml_for_workspace))
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
def workspace_with_full_slots(workspace_with_canonical_only):
    """slots=2, both slots filled (A and B), canonical=X."""
    ws = workspace_with_canonical_only
    for branch in ("A", "B"):
        for repo in ("repo-a", "repo-b"):
            subprocess.run(["git", "branch", branch],
                           cwd=ws.config.root / repo, check=True)
    from canopy.actions.switch import switch
    switch(ws, "A")   # X→warm slot-1, A canonical
    switch(ws, "B")   # A→warm slot-2, B canonical
    switch(ws, "X")   # B→warm? — see test_switch.py for rationale
    return ws


@pytest.fixture
def workspace_with_two_warm(workspace_with_full_slots):
    """Alias for workspace_with_full_slots, with last_touched patched so B is
    older than A (making B the LRU eviction candidate from {A, B})."""
    from canopy.actions import slots as sm

    ws = workspace_with_full_slots
    state = sm.read_state(ws)
    assert state is not None
    # B older, A newer — B must sort first under (timestamp ASC, name ASC)
    state.last_touched["A"] = "2026-01-02T00:00:00+00:00"
    state.last_touched["B"] = "2026-01-01T00:00:00+00:00"
    sm.write_state(ws, state)
    return ws


# ── tests ───────────────────────────────────────────────────────────────────

def test_preflight_cap_uses_workspace_slots_value(workspace_with_two_warm):
    """When slots=2 and 2 are already warm, switching a fresh feature fires cap."""
    ws = workspace_with_two_warm  # slots=2, both filled by A and B
    from canopy.actions.switch_preflight import preflight
    from canopy.actions.errors import BlockerError

    # Create branch C so preflight doesn't trip on missing-branch for wrong reason
    for repo in ("repo-a", "repo-b"):
        subprocess.run(["git", "branch", "C"],
                       cwd=ws.config.root / repo, check=True)

    repo_branches = {"repo-a": "C", "repo-b": "C"}
    with pytest.raises(BlockerError) as exc_info:
        preflight(ws, "C", repo_branches, no_evict=True)
    assert exc_info.value.code == "worktree_cap_reached"


def test_preflight_lru_candidate_from_slots_last_touched(workspace_with_two_warm):
    """preflight returns lru_eviction_candidate == 'B' (the older slot occupant)."""
    ws = workspace_with_two_warm  # last_touched: A newer, B older
    from canopy.actions.switch_preflight import preflight

    for repo in ("repo-a", "repo-b"):
        subprocess.run(["git", "branch", "C"],
                       cwd=ws.config.root / repo, check=True)

    info = preflight(ws, "C", {"repo-a": "C", "repo-b": "C"})
    assert info["cap_will_fire"] is True
    assert info["lru_eviction_candidate"] == "B"
