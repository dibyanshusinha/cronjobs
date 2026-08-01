from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Callable, TypeVar

T = TypeVar("T")


def run_bounded(tasks: list[Callable[[], T]], max_workers: int = 5) -> list[T]:
    """Run each zero-arg callable, capped at `max_workers` concurrent. Results
    are returned in the same order as `tasks` regardless of completion order.
    Both executors are blocking I/O calls (requests, subprocess), so threads
    are the right tool here — no benefit to an asyncio rewrite at this scale.
    """
    if not tasks:
        return []
    with ThreadPoolExecutor(max_workers=max(1, max_workers)) as pool:
        futures = [pool.submit(task) for task in tasks]
        return [f.result() for f in futures]
