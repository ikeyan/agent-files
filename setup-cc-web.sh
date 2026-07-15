#!/bin/bash
# cc-web の環境セットアップスクリプト欄から呼ぶ:
# curl -fsSL https://raw.githubusercontent.com/ikeyan/agent-files/main/setup-cc-web.sh -o /tmp/setup-cc-web.sh && bash /tmp/setup-cc-web.sh
set -euo pipefail

if [[ -f .setup-sandbox.sh ]]; then
  /bin/bash .setup-sandbox.sh
elif [[ -f package-lock.json ]]; then
  npm ci
elif [[ -f pnpm-lock.yaml ]]; then
  pnpm install --frozen-lockfile
elif [[ -f yarn.lock ]]; then
  yarn install --frozen-lockfile
elif [[ -f bun.lock ]]; then
  bun install --frozen-lockfile
fi
