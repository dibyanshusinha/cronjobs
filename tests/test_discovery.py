from pathlib import Path

import pytest

from engine import discovery, schema


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def test_defaults_inheritance_precedence(tmp_path: Path):
    root = tmp_path / "jobs"
    write(root / "_defaults.yml", "timezone: UTC\nretries: 1\n")
    write(root / "team-a" / "_defaults.yml", "timezone: Asia/Kolkata\n")
    write(
        root / "team-a" / "a.job.yml",
        "id: a\nschedule: '*/5 * * * *'\ntype: http\nhttp:\n  url: https://example.com\n",
    )
    jobs = discovery.discover_jobs(root)
    assert len(jobs) == 1
    job = jobs[0]
    assert job.timezone == "Asia/Kolkata"  # deeper default wins
    assert job.retries == 1  # inherited from root default


def test_job_own_field_overrides_defaults(tmp_path: Path):
    root = tmp_path / "jobs"
    write(root / "_defaults.yml", "retries: 5\n")
    write(
        root / "a.job.yml",
        "id: a\nschedule: '*/5 * * * *'\ntype: http\nretries: 0\nhttp:\n  url: https://example.com\n",
    )
    jobs = discovery.discover_jobs(root)
    assert jobs[0].retries == 0


def test_duplicate_id_across_folders_rejected(tmp_path: Path):
    root = tmp_path / "jobs"
    write(root / "a" / "x.job.yml", "id: dupe\nschedule: '* * * * *'\ntype: http\nhttp:\n  url: https://example.com\n")
    write(root / "b" / "y.job.yml", "id: dupe\nschedule: '* * * * *'\ntype: http\nhttp:\n  url: https://example.com\n")
    with pytest.raises(schema.ValidationError, match="duplicate job id"):
        discovery.discover_jobs(root)


def test_unknown_default_key_rejected(tmp_path: Path):
    root = tmp_path / "jobs"
    write(root / "_defaults.yml", "id: not-allowed\n")
    write(root / "a.job.yml", "id: a\nschedule: '* * * * *'\ntype: http\nhttp:\n  url: https://example.com\n")
    with pytest.raises(discovery.DiscoveryError, match="unknown default key"):
        discovery.discover_jobs(root)


def test_missing_required_field_rejected(tmp_path: Path):
    root = tmp_path / "jobs"
    write(root / "a.job.yml", "schedule: '* * * * *'\ntype: http\nhttp:\n  url: https://example.com\n")
    with pytest.raises(discovery.DiscoveryError):
        discovery.discover_jobs(root)


def test_bad_url_scheme_rejected_by_schema(tmp_path: Path):
    root = tmp_path / "jobs"
    write(root / "a.job.yml", "id: a\nschedule: '* * * * *'\ntype: http\nhttp:\n  url: http://insecure.example.com\n")
    with pytest.raises(discovery.DiscoveryError):
        discovery.discover_jobs(root)


def test_empty_jobs_dir_returns_empty_list(tmp_path: Path):
    assert discovery.discover_jobs(tmp_path / "does-not-exist") == []


def test_notify_defaults_shallow_merge(tmp_path: Path):
    root = tmp_path / "jobs"
    write(root / "_defaults.yml", "notify:\n  on_failure: true\n  on_recovery: true\n")
    write(
        root / "a.job.yml",
        "id: a\nschedule: '* * * * *'\ntype: http\nnotify:\n  on_recovery: false\nhttp:\n  url: https://example.com\n",
    )
    jobs = discovery.discover_jobs(root)
    job = jobs[0]
    assert job.notify_on_failure is True
    assert job.notify_on_recovery is False
