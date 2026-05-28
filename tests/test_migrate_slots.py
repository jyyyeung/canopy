import json
import pytest
import subprocess
from pathlib import Path


@pytest.fixture
def workspace_v2_layout(workspace_with_feature):
    """Pre-3.0 layout: feature-named worktree dirs + active_feature.json + max_worktrees in toml.

    Builds from the existing workspace_with_feature fixture by:
      1. Writing a pre-3.0 canopy.toml (uses max_worktrees, not slots).
      2. Checking out main in both repos so auth-flow branch is free.
      3. Adding feature-named worktrees for `auth-flow` via `git worktree add`.
      4. Writing a legacy active_feature.json shape.
    """
    root = workspace_with_feature
    (root / "canopy.toml").write_text("""\
[workspace]
name = "legacy"
max_worktrees = 2

[[repos]]
name = "repo-a"
path = "repo-a"

[[repos]]
name = "repo-b"
path = "repo-b"
""")
    # workspace_with_feature leaves repos on auth-flow branch.
    # Check out main so the branch is free for `git worktree add`.
    for repo in ("repo-a", "repo-b"):
        subprocess.run(["git", "checkout", "main"], cwd=root / repo, check=True,
                       capture_output=True)

    wt_base = root / ".canopy/worktrees/auth-flow"
    wt_base.mkdir(parents=True, exist_ok=True)
    for repo in ("repo-a", "repo-b"):
        subprocess.run(
            ["git", "worktree", "add", str(wt_base / repo), "auth-flow"],
            cwd=root / repo, check=True, capture_output=True,
        )

    # Write legacy active_feature.json (canonical was something else; auth-flow is warm)
    state_dir = root / ".canopy/state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "active_feature.json").write_text(json.dumps({
        "feature": None,  # no canonical in this fixture; auth-flow is warm
        "activated_at": "2026-05-01T00:00:00Z",
        "per_repo_paths": {},
        "previous_feature": None,
        "last_touched": {"auth-flow": "2026-05-26T14:00:00Z"},
    }))
    return root


def test_migrate_moves_feature_dirs_to_slots(workspace_v2_layout):
    from canopy.actions.migrate_slots import migrate
    from canopy.workspace.workspace import Workspace
    from canopy.workspace.config import load_config
    from canopy.actions import slots as slots_mod

    result = migrate(workspace_v2_layout)

    # Old feature-named dir should be gone
    assert not (workspace_v2_layout / ".canopy/worktrees/auth-flow").exists()
    # New slot dir should exist with .git file inside
    assert (workspace_v2_layout / ".canopy/worktrees/worktree-1/repo-a/.git").exists()

    # Now the toml is rewritten — load_config should work
    ws = Workspace(load_config(workspace_v2_layout))
    state = slots_mod.read_state(ws)
    assert state is not None
    assert state.slots["worktree-1"].feature == "auth-flow"

    # active_feature.json should be deleted
    assert not (workspace_v2_layout / ".canopy/state/active_feature.json").exists()

    # canopy.toml should have slots, not max_worktrees
    toml_text = (workspace_v2_layout / "canopy.toml").read_text()
    assert "max_worktrees" not in toml_text
    assert "slots = " in toml_text

    # Result shape
    assert "moved" in result
    assert any("auth-flow/repo-a" in m["from"] for m in result["moved"])
    assert result["slots"]["worktree-1"] == "auth-flow"


def test_migrate_refuses_if_slots_json_exists(workspace_v2_layout):
    (workspace_v2_layout / ".canopy/state").mkdir(parents=True, exist_ok=True)
    (workspace_v2_layout / ".canopy/state/slots.json").write_text("{}")
    from canopy.actions.migrate_slots import migrate, AlreadyMigratedError
    with pytest.raises(AlreadyMigratedError):
        migrate(workspace_v2_layout)
