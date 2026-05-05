#!/usr/bin/env bash
# Wrapper for audit-new-packages.ts with minimal Deno permissions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR="${TMPDIR:-/tmp}"

exec deno run \
  --allow-read=".,${TMPDIR}" \
  --allow-write="${TMPDIR}" \
  --allow-net=registry.npmjs.org,pypi.org \
  --allow-run=tar,unzip \
  "${SCRIPT_DIR}/audit-new-packages.ts" \
  "$@"
