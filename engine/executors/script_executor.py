"""Script job execution, confined to the repo's scripts/ directory.

Security model:
  - `script.path` must be a relative path with no leading '/' and no '..'
    segment, and must resolve (after following any symlinks) to somewhere
    under scripts/'s real path — rejects both simple traversal and symlink
    escapes.
  - Only a fixed interpreter allowlist (bash/python3/node) is ever invoked,
    always as an argv list with shell=False — never a shell string, so there
    is no inline-shell-command surface at all.
  - stdout/stderr are captured only to detect success/failure length for the
    detail string's exit code; raw output is never returned or stored (a
    script could easily echo a secret from its environment by accident).
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path, PurePosixPath

from ..models import ScriptSpec

ALLOWED_INTERPRETERS = {"bash": "bash", "python3": "python3", "node": "node"}

_EXTENSION_INTERPRETER = {".sh": "bash", ".py": "python3", ".js": "node"}


class ScriptSecurityError(Exception):
    pass


def resolve_script_path(repo_root: Path, raw_path: str) -> Path:
    """`raw_path` is repo-relative (e.g. 'scripts/examples/foo.sh') and must
    resolve to somewhere under <repo_root>/scripts/."""
    if raw_path.startswith("/") or ".." in PurePosixPath(raw_path).parts:
        raise ScriptSecurityError(
            f"script path '{raw_path}' must be relative, under scripts/, with no '..' segment"
        )

    repo_root_resolved = repo_root.resolve()
    scripts_root_resolved = (repo_root_resolved / "scripts").resolve()
    candidate = (repo_root_resolved / raw_path).resolve()

    try:
        candidate.relative_to(scripts_root_resolved)
    except ValueError:
        raise ScriptSecurityError(f"script path '{raw_path}' must be under scripts/")

    # Belt-and-suspenders: reject if any path component along the way is a
    # symlink, even though .resolve() above would already have caught an
    # escape via the relative_to() check.
    walked = repo_root_resolved
    for part in Path(raw_path).parts:
        walked = walked / part
        if walked.is_symlink():
            raise ScriptSecurityError(f"script path '{raw_path}' contains a symlink — not allowed")

    if not candidate.is_file():
        raise ScriptSecurityError(f"script '{raw_path}' does not exist or is not a regular file")

    return candidate


def resolve_interpreter(spec: ScriptSpec) -> str:
    interpreter = spec.interpreter
    if interpreter is None:
        ext = Path(spec.path).suffix
        interpreter = _EXTENSION_INTERPRETER.get(ext)
    if interpreter not in ALLOWED_INTERPRETERS:
        raise ScriptSecurityError(f"interpreter '{interpreter}' is not in the allowlist")
    return interpreter


def execute(job_id: str, spec: ScriptSpec, repo_root: Path) -> tuple[bool, str]:
    try:
        script_path = resolve_script_path(repo_root, spec.path)
        interpreter = resolve_interpreter(spec)
    except ScriptSecurityError as e:
        return False, f"blocked: {e}"

    cmd = [ALLOWED_INTERPRETERS[interpreter], str(script_path), *spec.args]
    try:
        proc = subprocess.run(
            cmd,
            shell=False,
            timeout=spec.timeout_seconds,
            capture_output=True,
            text=True,
        )
        return proc.returncode == 0, f"exit code {proc.returncode}"
    except subprocess.TimeoutExpired:
        return False, f"timed out after {spec.timeout_seconds}s"
    except OSError as e:
        return False, f"launch error: {type(e).__name__}"
