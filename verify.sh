#!/usr/bin/env bash
# このリポの単一検証コマンド。引数なしで全部を検査する。
# 段は 2 種類で、その場で直す設定 (core.hooksPath、.claude/skills の symlink のずれ) を先に揃え、検査を後に回す。検査が落ちても設定は揃っているようにするため。VERIFY_READONLY=1 では直さず違反にする (CI 用)。
# 事前条件: shellcheck・deno・curl (7.84 以降)・jq が PATH にあること。ネットワーク (www.schemastore.org) に出られること。
# core.hooksPath は設定ファイル (system・global・local・worktree と include) の値で判定し、GIT_CONFIG_COUNT/KEY_<n>/VALUE_<n>・GIT_CONFIG_PARAMETERS (git -c)・GIT_CONFIG は無視する。値は main worktree (git rev-parse --git-common-dir の親) の hooks の絶対パスで、main worktree の .git がディレクトリであるリポ (--separate-git-dir や bare でない) に限る。
set -euo pipefail
# nullglob: 空のディレクトリで glob がパターン文字列そのものに化け、存在しないパスを検査してしまうのを防ぐ。
shopt -s nullglob
cd "$(dirname "$0")"

readonly_mode=${VERIFY_READONLY:-}
status=0
# 後の検査が落ちても hooks/pre-push が有効であるよう、検査より先に行う。command スコープの値は process と共に消え、GIT_CONFIG は git config にしか効かないので、同じ値を示していても後の git push の hook にならない。
# 相対パスは hook を走らせる worktree ごとに解決され、hooks/ の無い commit の worktree からは hook 無しで push が通るので、main worktree の hooks を絶対パスで指す。
file_config() { env -u GIT_CONFIG -u GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT=0 git config "$@"; }
hooks_dir=$(git rev-parse --path-format=absolute --git-common-dir)
hooks_dir=${hooks_dir%/*}/hooks
hooks_path=$(file_config --get core.hooksPath || true)
if [ "$hooks_path" != "$hooks_dir" ]; then
  if [ -n "$readonly_mode" ]; then
    echo "core.hooksPath (${hooks_path:-未設定}) != $hooks_dir。 Execute: git config core.hooksPath '$hooks_dir'" >&2
    status=1
  elif ! file_config core.hooksPath "$hooks_dir"; then
    echo "core.hooksPath を $hooks_dir にできない。 Execute: git config core.hooksPath '$hooks_dir'" >&2
    status=1
  elif [ "$(file_config --get core.hooksPath)" != "$hooks_dir" ]; then
    echo "core.hooksPath: local を $hooks_dir にしたが、別の設定元の値が勝つ ($(file_config --show-origin --show-scope --get core.hooksPath | tr '\t' ' '))。 Execute: git config --file <その file> --unset core.hooksPath" >&2
    status=1
  else
    echo "core.hooksPath: ${hooks_path:-未設定} から $hooks_dir にした"
  fi
fi
# hooks_dir に実行可能な pre-push が無いと、git は hook 無しで push を通す。
[ -x "$hooks_dir/pre-push" ] || { echo "$hooks_dir/pre-push: 実行可能なファイルが無く、どの worktree の push も hook 無しで通る (main worktree が hooks/pre-push の無い commit にあるか、.git がディレクトリでないリポ)" >&2; status=1; }

# .claude/skills と skills/ の対応 (構造は README)。symlink の作成は deno だと無制限の
# --allow-write/--allow-read が要るので shell 側で扱う。Claude Code のサンドボックス内では
# .claude/skills が保護パスで書けないので、直せなければ違反として報告して検査を続ける。
if [ -L .claude/skills ]; then
  echo ".claude/skills: symlink になっている (実体のディレクトリであるべき。構造は README)" >&2
  status=1
elif [ ! -d .claude/skills ]; then
  echo ".claude/skills/: 無い" >&2
  status=1
else
  for path in .claude/skills/*; do
    name=${path##*/}
    if [ -L "$path" ]; then
      target=$(readlink "$path")
      if [ "$target" != "../../skills/$name" ]; then
        echo "$path (-> $target): 飛び先 != ../../skills/$name" >&2
        status=1
      elif [ ! -e "$path" ]; then
        if [ -n "$readonly_mode" ]; then
          echo "$path: 切れた symlink" >&2
          status=1
        else
          if unlink "$path"; then
            echo "$path: 切れた symlink を削除した"
          else
            echo "$path: 切れた symlink を削除できない。 Execute: unlink $path" >&2
            status=1
          fi
        fi
        continue
      fi
    elif [ ! -d "$path" ]; then
      echo "$path: ディレクトリでも symlink でもない" >&2
      status=1
      continue
    fi
    # symlink 経由でも実体でも、SKILL.md が無ければスキルとして読まれない。
    [ -f "$path/SKILL.md" ] || { echo "$path/SKILL.md: 無い" >&2; status=1; }
  done
  for path in skills/*/; do
    name=$(basename "$path")
    link=".claude/skills/$name"
    if [ -L "$link" ]; then
      continue # symlink 先の SKILL.md は上のループで見ている
    fi
    if [ ! -f "$path/SKILL.md" ]; then
      echo "$path/SKILL.md: 無い" >&2
      status=1
    elif [ -e "$link" ]; then
      continue # 同名の実体で差し替えている
    elif [ -n "$readonly_mode" ]; then
      echo "$link: 配布スキルへの symlink が無い。 Execute: ln -s ../../skills/$name $link" >&2
      status=1
    else
      if ln -s "../../skills/$name" "$link"; then
        echo "$link: 配布スキルへの symlink を作った"
      else
        echo "$link: 配布スキルへの symlink を作れない。 Execute: ln -s ../../skills/$name $link" >&2
        status=1
      fi
    fi
  done
fi

check_files() { # <コマンド…> -- <パターン…>: git が知っているファイルが 1 件以上あるときだけコマンドを回す
  local cmd=() files=()
  while [ "$1" != "--" ]; do cmd+=("$1"); shift; done
  shift
  while IFS= read -r file; do files+=("$file"); done < <(git ls-files --cached --others --exclude-standard "$@")
  if [ ${#files[@]} -gt 0 ]; then "${cmd[@]}" "${files[@]}"; fi
}
check_files shellcheck -- '*.sh' hooks/pre-push
check_files deno check -- '*.ts'
scripts/test-target-diff.sh
scripts/test-pre-push.sh
scripts/test-codex-limits.sh
# 書き込みは $TMPDIR の下だけだが、シンボリックリンクを作るので Deno はパスを絞った許可を受け付けない
deno run --allow-run=git,bash --allow-env --allow-read --allow-write scripts/test-target-diff.ts
deno run --allow-run=bash --allow-net=127.0.0.1 --allow-env=PR_RUNS,FC_SEED,PATH --allow-read="${TMPDIR:-/tmp}" --allow-write="${TMPDIR:-/tmp}" scripts/test-pr.ts

git ls-files --cached --others --exclude-standard |
  deno run --allow-read=. --allow-net=www.schemastore.org scripts/verify.ts
exit "$status"
