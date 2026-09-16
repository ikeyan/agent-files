#!/usr/bin/env bash
# このリポの単一検証コマンド。引数なしで全部を検査する。
# 事前条件: shellcheck と deno が PATH にあること。ネットワーク (www.schemastore.org) に出られること。
set -euo pipefail
cd "$(dirname "$0")"

mapfile -t sh_files < <(git ls-files --cached --others --exclude-standard '*.sh')
shellcheck "${sh_files[@]}"

mapfile -t ts_files < <(git ls-files --cached --others --exclude-standard '*.ts')
deno check "${ts_files[@]}"

deno run --allow-read=. --allow-run=git --allow-net=www.schemastore.org scripts/verify.ts
