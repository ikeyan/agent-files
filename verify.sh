#!/usr/bin/env bash
# このリポの単一検証コマンド。引数なしで全部を検査する。
# 既定では .claude/skills の symlink のずれ (作り忘れ・残骸) を直す。VERIFY_READONLY=1 では直さず違反にする (CI 用)。
# 事前条件: shellcheck と deno が PATH にあること。ネットワーク (www.schemastore.org) に出られること。
set -euo pipefail
cd "$(dirname "$0")"

mapfile -t sh_files < <(git ls-files --cached --others --exclude-standard '*.sh')
shellcheck "${sh_files[@]}"

mapfile -t ts_files < <(git ls-files --cached --others --exclude-standard '*.ts')
deno check "${ts_files[@]}"

# .claude/skills と skills/ の対応 (構造は README)。symlink の作成は deno だと無制限の
# --allow-write/--allow-read が要るので shell 側で扱う。
readonly_mode=${VERIFY_READONLY:-}
skills_status=0
for path in .claude/skills/*; do
  name=${path##*/}
  if [ ! -L "$path" ]; then
    [ -f "$path/SKILL.md" ] || { echo "$path: SKILL.md が無い" >&2; skills_status=1; }
    if [ -d "skills/$name" ]; then
      echo "$path: 同名の配布スキルが skills/ にある — どちらが読まれるか紛らわしい" >&2
      skills_status=1
    fi
    continue
  fi
  target=$(readlink "$path")
  if [ "$target" != "../../skills/$name" ]; then
    echo "$path: symlink 先が ../../skills/$name でない — $target" >&2
    skills_status=1
  elif [ ! -e "$path" ]; then
    if [ -n "$readonly_mode" ]; then
      echo "$path: symlink 先の配布スキルが無い (消した・改名した残骸)" >&2
      skills_status=1
    else
      unlink "$path"
      echo "$path: 切れた symlink を消した"
    fi
  fi
done
for path in skills/*/; do
  name=$(basename "$path")
  link=".claude/skills/$name"
  if [ -e "$link" ] || [ -L "$link" ]; then
    continue
  fi
  if [ -n "$readonly_mode" ]; then
    echo "$link: 配布スキルへの symlink が無い — ln -s ../../skills/$name $link" >&2
    skills_status=1
  else
    ln -s "../../skills/$name" "$link"
    echo "$link: 配布スキルへの symlink を作った"
  fi
done

git ls-files --cached --others --exclude-standard |
  deno run --allow-read=. --allow-net=www.schemastore.org scripts/verify.ts
exit "$skills_status"
