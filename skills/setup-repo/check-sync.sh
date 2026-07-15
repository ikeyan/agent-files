#!/bin/bash
# 使い方: check-sync.sh [--warn] <file>...
# 各 file を frontmatter の `source:` (GitHub blob URL) の内容と比較し、drift があれば diff を表示して exit 1。
# --warn: drift は警告に留めて exit 0 (PR の CI 用)。source: 欠落・取得失敗は --warn でも exit 1。
set -euo pipefail

warn=0
if [[ "${1:-}" == "--warn" ]]; then
  warn=1
  shift
fi
if [[ $# -eq 0 ]]; then
  echo "使い方: check-sync.sh [--warn] <file>..." >&2
  exit 1
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

error=0
drift=0
for f in "$@"; do
  if [[ ! -r "$f" ]]; then
    echo "$f: 読めない" >&2
    error=1
    continue
  fi
  src=$(sed -n '/^source: /{s///p;q}' "$f")
  if [[ -z "$src" ]]; then
    echo "$f: frontmatter に source: が無い" >&2
    error=1
    continue
  fi
  raw=${src/github.com/raw.githubusercontent.com}
  raw=${raw/\/blob\///}
  if ! curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 --retry-connrefused "$raw" -o "$tmp"; then
    echo "$f: source の取得に失敗 ($raw)" >&2
    error=1
    continue
  fi
  if diff -u "$tmp" "$f"; then
    echo "$f: OK"
  else
    echo "$f: source と drift しています ($src)" >&2
    drift=1
  fi
done

if [[ $error -eq 1 ]]; then
  exit 1
fi
if [[ $drift -eq 1 && $warn -eq 0 ]]; then
  exit 1
fi
exit 0
