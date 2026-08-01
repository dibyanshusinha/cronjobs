"""HTTP job execution with safe defaults: HTTPS-only (enforced upstream by the
job schema), a hard timeout, a bounded/streamed response read, a capped
redirect count, a stable per-occurrence execution-id header, and optional
${ENV_VAR} substitution in header values so a GitHub Secret can be referenced
from a public job file without ever being committed in plaintext.

Never returns or logs response bodies, headers, or raw exception messages that
might embed a URL's query string — only a short, safe summary string.
"""
from __future__ import annotations

import os
import re

import requests

from ..models import HttpSpec

MAX_RESPONSE_BYTES = 64 * 1024
MAX_REDIRECTS = 3

_ENV_REF = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def resolve_headers(headers: dict) -> dict:
    """Header values of the exact form ${VAR_NAME} are substituted from the
    process environment at execution time; anything else passes through as-is."""
    resolved = {}
    for key, value in headers.items():
        m = _ENV_REF.match(value) if isinstance(value, str) else None
        resolved[key] = os.environ.get(m.group(1), "") if m else value
    return resolved


def execute(job_id: str, scheduled_time_iso: str, spec: HttpSpec) -> tuple[bool, str]:
    execution_id = f"{job_id}:{scheduled_time_iso}"
    headers = resolve_headers(spec.headers)
    headers.setdefault("User-Agent", "self-hosted-cron-dispatcher/1.0")
    headers["X-Cron-Execution-Id"] = execution_id

    session = requests.Session()
    session.max_redirects = MAX_REDIRECTS
    try:
        resp = session.request(
            spec.method,
            spec.url,
            headers=headers,
            data=spec.body or None,
            timeout=spec.timeout_seconds,
            stream=True,
        )
        try:
            content = bytearray()
            for chunk in resp.iter_content(chunk_size=4096):
                content += chunk
                if len(content) >= MAX_RESPONSE_BYTES:
                    break
            snippet = bytes(content[:MAX_RESPONSE_BYTES]).decode("utf-8", errors="replace")
        finally:
            resp.close()

        status_ok = resp.status_code in spec.expected_status
        contains_ok = (spec.validate_contains in snippet) if spec.validate_contains else True
        ok = status_ok and contains_ok

        parts = [f"HTTP {resp.status_code}"]
        if not status_ok:
            parts.append("unexpected status")
        if not contains_ok:
            parts.append("validate_contains not found")
        return ok, "; ".join(parts)
    except requests.exceptions.RequestException as e:
        return False, f"request error: {type(e).__name__}"
