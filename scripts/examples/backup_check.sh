#!/usr/bin/env bash
set -euo pipefail

# Example script job. Replace with real logic; exit non-zero on failure.
# Deliberately does not echo anything sensitive — script stdout/stderr is
# never persisted to history/dashboard data (see engine/history.py), so keep
# output generic even during local debugging.

verbose=false
for arg in "$@"; do
  if [[ "$arg" == "--verbose" ]]; then
    verbose=true
  fi
done

if [[ "$verbose" == true ]]; then
  echo "backup_check: running example check"
fi

echo "backup_check: ok"
exit 0
