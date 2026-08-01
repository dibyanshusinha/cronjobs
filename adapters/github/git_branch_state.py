"""git add/commit/push, scoped to a single working directory — a checkout or
worktree of the `cron-state` branch. This is the only place in the whole
project that shells out to git; engine/ never does.
"""
from __future__ import annotations

import subprocess
from pathlib import Path


class GitCommitter:
    def __init__(self, work_dir: Path, branch: str = "cron-state"):
        self.work_dir = Path(work_dir)
        self.branch = branch

    def _git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", *args], cwd=self.work_dir, check=True, capture_output=True, text=True
        )

    def commit_and_push(self, paths: list[str], message: str) -> bool:
        """Stage `paths` (relative to work_dir) and commit+push if anything
        actually changed. Returns False (no-op) if there was nothing to commit
        — the common case on a quiet tick with only a heartbeat timestamp
        change is still "something changed" by design, so this mainly guards
        against a truly identical re-run rather than idle ticks."""
        if not paths:
            return False
        self._git("add", *paths)
        diff = subprocess.run(
            ["git", "diff", "--cached", "--quiet"], cwd=self.work_dir
        )
        if diff.returncode == 0:
            return False
        self._git("commit", "-m", message)
        self._git("push", "origin", f"HEAD:{self.branch}")
        return True
