"""Validate job definitions without executing anything.

Used by .github/workflows/validate.yml on push/PR to jobs/**, and safe to run
locally any time you add or edit a job.
"""
from __future__ import annotations

import sys
from pathlib import Path

from . import discovery, schema
from .executors.script_executor import ScriptSecurityError, resolve_interpreter, resolve_script_path

REPO_ROOT = Path(__file__).resolve().parent.parent
JOBS_ROOT = REPO_ROOT / "jobs"


def main() -> int:
    try:
        jobs = discovery.discover_jobs(JOBS_ROOT)
    except (discovery.DiscoveryError, schema.ValidationError) as e:
        print("Job validation failed:\n", file=sys.stderr)
        print(str(e), file=sys.stderr)
        return 1

    # Schema validation can't check the filesystem — catch unsafe/missing
    # script paths here so a bad job fails on PR, not at 3am in production.
    script_errors = []
    for job in jobs:
        if job.type != "script":
            continue
        try:
            resolve_script_path(REPO_ROOT, job.script.path)
            resolve_interpreter(job.script)
        except ScriptSecurityError as e:
            script_errors.append(f"{job.file_path}: {e}")
    if script_errors:
        print("Job validation failed:\n", file=sys.stderr)
        print("\n".join(script_errors), file=sys.stderr)
        return 1

    print(f"OK: {len(jobs)} job(s) validated under {JOBS_ROOT}")
    for job in sorted(jobs, key=lambda j: j.id):
        status = "enabled" if job.enabled else "disabled"
        print(f"  - {job.id} [{job.type}, {status}] schedule='{job.schedule}' tz={job.timezone}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
