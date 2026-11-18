#!/usr/bin/env bash
# Fails on merge-conflict markers left in tracked text files: a line that
# starts with "<<<<<<< " or ">>>>>>> ", or is exactly "=======". Binary files
# are skipped (git grep -I). A file that needs such lines on purpose (a
# fixture) goes in EXCLUDE as a git pathspec.
set -euo pipefail

EXCLUDE=(
  # e.g. ':(exclude)path/to/fixture.txt'
)

if hits=$(git grep -n -I -E '^(<<<<<<< |>>>>>>> |=======$)' -- . "${EXCLUDE[@]}"); then
  echo "$hits"
  echo "::error::merge-conflict markers in tracked files (see above)"
  exit 1
fi
echo "ok: no merge-conflict markers"
