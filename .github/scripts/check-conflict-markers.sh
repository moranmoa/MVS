#!/usr/bin/env bash
# Fails on merge-conflict markers left in tracked text files: a line that
# starts with "<<<<<<< ", ">>>>>>> " or the diff3 base marker "||||||| ", or
# is exactly "=======" (a CR or other trailing whitespace allowed, so CRLF
# files are caught). Binary files are skipped (git grep -I). A file that
# needs such lines on purpose (a fixture) goes in EXCLUDE as a git pathspec.
set -uo pipefail

EXCLUDE=(
  # e.g. ':(exclude)path/to/fixture.txt'
)

hits=$(git grep -n -I -E '^(<<<<<<< |>>>>>>> |\|\|\|\|\|\|\| |=======[[:space:]]*$)' -- . "${EXCLUDE[@]}")
status=$?
case $status in
  0)
    echo "$hits"
    echo "::error::merge-conflict markers in tracked files (see above)"
    exit 1
    ;;
  1) echo "ok: no merge-conflict markers" ;;
  *)
    echo "::error::git grep failed (exit $status): check EXCLUDE"
    exit "$status"
    ;;
esac
