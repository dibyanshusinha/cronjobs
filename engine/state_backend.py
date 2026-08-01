"""Generic, GitHub-agnostic key->JSON-blob storage.

`Ledger` and `HistoryStore` depend only on the `StateBackend` protocol below, not
on any particular storage technology. The GitHub Actions edition points
`JsonFileStateBackend` at a checkout of the `cron-state` branch. A future
self-hosted deployment can implement the same protocol on top of SQLite (or
anything else) without touching `engine.ledger`, `engine.history`, or
`engine.dispatch`.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Protocol


class StateBackend(Protocol):
    def load(self, name: str, default: dict) -> dict: ...

    def save(self, name: str, data: dict) -> None: ...


class JsonFileStateBackend:
    """One JSON file per `name` (which may include subdirectories, e.g.
    'history/some-job-id'), rooted at `base_dir`. Writes are atomic (write to a
    temp file, then rename) so a crash mid-write can't corrupt state.
    """

    def __init__(self, base_dir: Path):
        self.base_dir = Path(base_dir)

    def _path(self, name: str) -> Path:
        return self.base_dir / f"{name}.json"

    def load(self, name: str, default: dict) -> dict:
        path = self._path(name)
        if not path.exists():
            return default
        with open(path) as f:
            return json.load(f)

    def save(self, name: str, data: dict) -> None:
        path = self._path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2, sort_keys=True)
            f.write("\n")
        tmp.replace(path)
