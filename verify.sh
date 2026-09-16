#!/usr/bin/env bash
# このリポの単一検証コマンド。引数なしで全部を検査する。
# 既定では .claude/skills の symlink のずれ (作り忘れ・残骸) を直す。VERIFY_READONLY=1 では直さず違反にする (CI 用)。
# 事前条件: shellcheck と deno が PATH にあること。ネットワーク (www.schemastore.org) に出られること。
set -euo pipefail
# nullglob: 空のディレクトリで glob がパターン文字列そのものに化け、存在しないパスを検査してしまうのを防ぐ。
shopt -s nullglob
cd "$(dirname "$0")"

check_files() { # <コマンド…> -- <パターン>: git が知っているファイルが 1 件以上あるときだけコマンドを回す
  local cmd=() files=()
  while [ "$1" != "--" ]; do cmd+=("$1"); shift; done
  shift
  while IFS= read -r file; do files+=("$file"); done < <(git ls-files --cached --others --exclude-standard "$1")
  if [ ${#files[@]} -gt 0 ]; then "${cmd[@]}" "${files[@]}"; fi
}
check_files shellcheck -- '*.sh'
check_files deno check -- '*.ts'

# .claude/skills と skills/ の対応 (構造は README)。symlink の作成は deno だと無制限の
# --allow-write/--allow-read が要るので shell 側で扱う。
readonly_mode=${VERIFY_READONLY:-}
skills_status=0
if [ ! -d .claude/skills ]; then
  echo ".claude/skills/: 無い" >&2
  skills_status=1
else
  for path in .claude/skills/*; do
    name=${path##*/}
    if [ -L "$path" ]; then
      target=$(readlink "$path")
      if [ "$target" != "../../skills/$name" ]; then
        echo "$path (-> $target): 飛び先 != ../../skills/$name" >&2
        skills_status=1
      elif [ ! -e "$path" ]; then
        if [ -n "$readonly_mode" ]; then
          echo "$path: 切れた symlink" >&2
          skills_status=1
        else
          unlink "$path"
          echo "$path: 切れた symlink を削除した"
        fi
        continue
      fi
    elif [ ! -d "$path" ]; then
      echo "$path: ディレクトリでも symlink でもない" >&2
      skills_status=1
      continue
    fi
    # symlink 経由でも実体でも、SKILL.md が無ければスキルとして読まれない。
    [ -f "$path/SKILL.md" ] || { echo "$path/SKILL.md: 無い" >&2; skills_status=1; }
  done
  for path in skills/*/; do
    name=$(basename "$path")
    link=".claude/skills/$name"
    if [ -L "$link" ] || [ -e "$link" ]; then
      continue
    fi
    if [ ! -f "$path/SKILL.md" ]; then
      echo "$path/SKILL.md: 無い" >&2
      skills_status=1
    elif [ -n "$readonly_mode" ]; then
      echo "$link: 配布スキルへの symlink が無い。 Execute: ln -s ../../skills/$name $link" >&2
      skills_status=1
    else
      ln -s "../../skills/$name" "$link"
      echo "$link: 配布スキルへの symlink を作った"
    fi
  done
fi

git ls-files --cached --others --exclude-standard |
  deno run --allow-read=. --allow-net=www.schemastore.org scripts/verify.ts
exit "$skills_status"
