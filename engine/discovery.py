from __future__ import annotations

from pathlib import Path

import yaml

from . import schema
from .models import Job

JOB_SUFFIX = ".job.yml"
DEFAULTS_FILENAME = "_defaults.yml"

# Keys a _defaults.yml may set. Deliberately excludes id/schedule/type/name/http/script
# so identity and per-job specifics can never leak in through inheritance.
ALLOWED_DEFAULT_KEYS = {
    "timezone",
    "enabled",
    "retries",
    "retry_backoff_seconds",
    "timeout_seconds",
    "misfire_policy",
    "misfire_cap",
    "history_limit",
    "notify",
}


class DiscoveryError(Exception):
    """Raised for filesystem/YAML-level problems. May bundle multiple messages."""


def _load_yaml(path: Path) -> dict:
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise DiscoveryError(f"{path}: expected a YAML mapping at the top level")
    return data


def _shallow_merge(base: dict, override: dict) -> dict:
    result = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(result.get(k), dict):
            result[k] = {**result[k], **v}
        else:
            result[k] = v
    return result


def _defaults_chain_dirs(jobs_root: Path, job_dir: Path) -> list[Path]:
    """Directories from jobs_root down to job_dir, inclusive, shallow -> deep."""
    job_dir = job_dir.resolve()
    jobs_root = jobs_root.resolve()
    if jobs_root not in job_dir.parents and job_dir != jobs_root:
        raise DiscoveryError(f"{job_dir} is not under jobs root {jobs_root}")
    dirs = [job_dir]
    cur = job_dir
    while cur != jobs_root:
        cur = cur.parent
        dirs.append(cur)
    dirs.reverse()
    return dirs


def _load_defaults_chain(jobs_root: Path, job_dir: Path) -> dict:
    merged: dict = {}
    for d in _defaults_chain_dirs(jobs_root, job_dir):
        defaults_path = d / DEFAULTS_FILENAME
        if defaults_path.exists():
            raw = _load_yaml(defaults_path)
            unknown = set(raw.keys()) - ALLOWED_DEFAULT_KEYS
            if unknown:
                raise DiscoveryError(
                    f"{defaults_path}: unknown default key(s) {sorted(unknown)}"
                )
            merged = _shallow_merge(merged, raw)
    return merged


def discover_jobs(jobs_root: Path) -> list[Job]:
    """Walk jobs_root for *.job.yml files, merge _defaults.yml chains, validate,
    and return fully-built Job objects. Raises DiscoveryError/schema.ValidationError
    with every problem found bundled into one message, not just the first."""
    jobs_root = Path(jobs_root)
    if not jobs_root.exists():
        return []

    job_files = sorted(jobs_root.rglob(f"*{JOB_SUFFIX}"))
    jobs: list[Job] = []
    errors: list[str] = []

    for jf in job_files:
        try:
            raw = _load_yaml(jf)
            defaults = _load_defaults_chain(jobs_root, jf.parent)
            merged = _shallow_merge(defaults, raw)
            schema.validate_merged(merged, jf)
            jobs.append(schema.build_job(merged, jf))
        except (DiscoveryError, schema.ValidationError) as e:
            errors.append(str(e))

    if errors:
        raise DiscoveryError("\n".join(errors))

    schema.check_duplicate_ids(jobs)
    return jobs
