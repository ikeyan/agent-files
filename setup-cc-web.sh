#!/bin/bash
set -euo pipefail
git clone --depth=1 https://github.com/ikeyan/agent-files.git /root/agent-files > /root/setup.log 2>&1
cp -rn /root/.claude/skills/. /root/agent-files/skills/
rm -rf /root/.claude/skills
ln -s /root/agent-files/skills /root/.claude/skills

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
