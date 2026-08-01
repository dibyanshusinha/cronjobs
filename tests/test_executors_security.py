import os
from pathlib import Path

import pytest

from engine.executors.http_executor import resolve_headers
from engine.executors.script_executor import (
    ScriptSecurityError,
    resolve_interpreter,
    resolve_script_path,
)
from engine.models import ScriptSpec


def make_repo(tmp_path: Path) -> Path:
    (tmp_path / "scripts" / "examples").mkdir(parents=True)
    (tmp_path / "scripts" / "examples" / "ok.sh").write_text("#!/bin/sh\necho hi\n")
    return tmp_path


def test_resolve_script_path_happy_case(tmp_path: Path):
    repo = make_repo(tmp_path)
    resolved = resolve_script_path(repo, "scripts/examples/ok.sh")
    assert resolved == (repo / "scripts" / "examples" / "ok.sh").resolve()


def test_resolve_script_path_rejects_leading_slash(tmp_path: Path):
    repo = make_repo(tmp_path)
    with pytest.raises(ScriptSecurityError):
        resolve_script_path(repo, "/etc/passwd")


def test_resolve_script_path_rejects_dotdot_traversal(tmp_path: Path):
    repo = make_repo(tmp_path)
    (tmp_path / "secret.sh").write_text("echo leaked")
    with pytest.raises(ScriptSecurityError):
        resolve_script_path(repo, "scripts/../secret.sh")


def test_resolve_script_path_rejects_outside_scripts_dir(tmp_path: Path):
    repo = make_repo(tmp_path)
    (repo / "notscripts").mkdir()
    (repo / "notscripts" / "x.sh").write_text("echo hi")
    with pytest.raises(ScriptSecurityError):
        resolve_script_path(repo, "notscripts/x.sh")


def test_resolve_script_path_rejects_missing_file(tmp_path: Path):
    repo = make_repo(tmp_path)
    with pytest.raises(ScriptSecurityError):
        resolve_script_path(repo, "scripts/examples/does-not-exist.sh")


def test_resolve_script_path_rejects_symlink_escape(tmp_path: Path):
    repo = make_repo(tmp_path)
    outside = tmp_path.parent / "outside_target.sh"
    outside.write_text("echo escaped")
    link = repo / "scripts" / "examples" / "escape.sh"
    try:
        os.symlink(outside, link)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not supported in this environment")
    with pytest.raises(ScriptSecurityError):
        resolve_script_path(repo, "scripts/examples/escape.sh")


def test_resolve_interpreter_from_extension():
    spec = ScriptSpec(path="scripts/examples/ok.sh")
    assert resolve_interpreter(spec) == "bash"


def test_resolve_interpreter_explicit_wins():
    spec = ScriptSpec(path="scripts/examples/ok.sh", interpreter="python3")
    assert resolve_interpreter(spec) == "python3"


def test_resolve_interpreter_rejects_unknown():
    spec = ScriptSpec(path="scripts/examples/ok.custom", interpreter="perl")
    with pytest.raises(ScriptSecurityError):
        resolve_interpreter(spec)


def test_resolve_headers_substitutes_env_var(monkeypatch):
    monkeypatch.setenv("MY_TOKEN", "s3cr3t")
    resolved = resolve_headers({"Authorization": "${MY_TOKEN}", "X-Plain": "unchanged"})
    assert resolved == {"Authorization": "s3cr3t", "X-Plain": "unchanged"}


def test_resolve_headers_missing_env_var_becomes_empty(monkeypatch):
    monkeypatch.delenv("UNSET_VAR", raising=False)
    resolved = resolve_headers({"Authorization": "${UNSET_VAR}"})
    assert resolved == {"Authorization": ""}
