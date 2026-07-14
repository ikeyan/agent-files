#!/bin/bash
# 使い方: check-sync.sh [--warn] <file>...
# 各 file を frontmatter の `source:` (GitHub blob URL) の内容と比較し、drift があれば diff を表示して exit 1。
# --warn: drift しても exit 0 (PR の CI 用)。
set -euo pipefail

warn=0
if [[ "${1:-}" == "--warn" ]]; then
  warn=1
  shift
fi

status=0
for f in "$@"; do
  src=$(sed -n 's/^source: //p' "$f" | head -1)
  if [[ -z "$src" ]]; then
    echo "$f: frontmatter に source: が無い" >&2
    status=1
    continue
  fi
  raw=${src/github.com/raw.githubusercontent.com}
  raw=${raw/\/blob\///}
  if diff -u <(curl -fsSL "$raw") "$f"; then
    echo "$f: OK"
  else
    echo "$f: source と drift しています ($src)" >&2
    status=1
  fi
done

if [[ $warn -eq 1 ]]; then
  exit 0
fi
exit $status
