#!/usr/bin/env bash
# このリポの単一検証コマンド。引数なしで全部を検査する。
# 段は 2 種類で、その場で直す状態 (hooks/pre-push の写し (無いときだけ置く)、.claude/skills の symlink のずれ) を先に揃え、検査を後に回す。検査が落ちても状態は揃っているようにするため。VERIFY_READONLY=1 では直さず違反にする (CI 用)。
# 検査は互いに独立なので並行に回し、全部を待ってから、段ごとの出力を下に並べた順で出す。
# - 通った段: 標準出力を stdout へ、標準エラーを stderr へ出す。
# - 落ちた段: 両方を stderr へ出す。
# - どれかが落ちれば exit 1。
# 事前条件: shellcheck (0.11.0 だけ。.github/workflows/verify.yml が入れる版と同じ)・deno・curl (7.84 以降)・jq・archetect と、macOS では sandbox-exec と otool、Linux では bwrap と ldd が PATH にあること。ネットワーク (www.schemastore.org) に出られること。
# agent-sync の描画の sandbox を適用できない環境 (別の sandbox の中など) では、test-agent-sync.ts の最初の描画が sync.sh の「OS の sandbox を適用できない」で落ちるので、描画を伴う残りの検査を飛ばして理由を stderr に出す。CI では落とす。全部を検査するのは適用できる環境。
# git は hook を $GIT_COMMON_DIR/hooks (linked worktree も共有し、checkout で変わらない) から呼ぶので、hooks/pre-push をそこへ写す。core.hooksPath (どの scope でも) が hook をよそへ向けていれば違反にし、設定は書かない。
# 写す先の pre-push の状態ごとの扱い:
# - 無い (壊れた symlink を含む。git が実行できない): 写す
# - hooks/pre-push と同じ実行可能なファイル: 何もしない
# - それ以外 (旧版、利用者が置いた別の hook、手を入れた写し): このリポのものかを中身から決められないので、上書きせず落として置き換えのコマンドを示す
# 判定は verify.sh を走らせた環境 (GIT_CONFIG_GLOBAL・GIT_CONFIG_COUNT などの設定の差し替えを含む) についてのものなので、push する環境で走らせる。
# step "$@" の間接呼び出しを shellcheck が追えず、step が呼ぶ関数を未使用と見る。追えるようになるか step をやめたら外す。
# shellcheck disable=SC2329
set -euo pipefail
# nullglob: 空のディレクトリで glob がパターン文字列そのものに化け、存在しないパスを検査してしまうのを防ぐ。
shopt -s nullglob
cd "$(dirname "$0")"

readonly_mode=${VERIFY_READONLY:-}
status=0
common=$(git rev-parse --path-format=absolute --git-common-dir)
hooks_dir=$(git rev-parse --path-format=absolute --git-path hooks)
if [ "$hooks_dir" != "$common/hooks" ]; then
  echo "hook の置き場が $hooks_dir で、$common/hooks でない ($(git config --show-origin --show-scope --get core.hooksPath | tr '\t' ' '))。 Execute: git config --file <その file> --unset core.hooksPath" >&2
  status=1
fi
hook=$common/hooks/pre-push
if [ ! -x "$hook" ] || ! cmp -s hooks/pre-push "$hook"; then
  if [ -e "$hook" ] || [ -n "$readonly_mode" ]; then
    echo "$hook: hooks/pre-push と同じ実行可能なファイルでない (上書きしない)。中身を確かめ、置き換えてよければ Execute: install -m 755 hooks/pre-push '$hook'" >&2
    status=1
  elif mkdir -p "$common/hooks" && install -m 755 hooks/pre-push "$hook"; then
    echo "$hook: hooks/pre-push を写した"
  else
    echo "$hook: hooks/pre-push を写せない。 Execute: install -m 755 hooks/pre-push '$hook'" >&2
    status=1
  fi
fi

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
# 版で出す指摘が違う (SC2015 は 0.9.0 が出し 0.11.0 は出さない。canon: facts/shellcheck) ので、手元と CI で同じ版に揃える。
readonly shellcheck_version=0.11.0
run_shellcheck() {
  local actual
  actual=$(shellcheck --version 2>/dev/null | sed -n 's/^version: //p') || actual=
  if [ "$actual" != "$shellcheck_version" ]; then
    echo "shellcheck の版が ${actual:-不明 (shellcheck が無い)} で、$shellcheck_version でない。macOS: brew install shellcheck (Homebrew の版が $shellcheck_version でなければ https://github.com/koalaman/shellcheck/releases/tag/v$shellcheck_version の成果物を PATH に置く)。Linux: .github/workflows/verify.yml の shellcheck の手順と同じに入れる" >&2
    return 1
  fi
  check_files shellcheck -- '*.sh' hooks/pre-push
}

out=$(mktemp -d "${TMPDIR:-/tmp}/verify.XXXXXX")
names=() pids=()
# 段は自分のプロセスグループで回る (set -m)。止めるときはグループごと TERM を送り、段が起こした pr.sh などを残さない。
trap 'kill -TERM -- ${pids[@]+"${pids[@]/#/-}"} 2>/dev/null || true; rm -rf "$out"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
set -m
step() { # <名前> <コマンド…>: 裏で回し、標準出力を $out/<番号>.out に、標準エラーを $out/<番号>.err に、かかった秒数を $out/<番号>.time に残す
  local i=${#names[@]}
  names+=("$1")
  shift
  (
    start=$SECONDS code=0
    "$@" < /dev/null > "$out/$i.out" 2> "$out/$i.err" || code=$?
    echo "$((SECONDS - start))" > "$out/$i.time"
    exit "$code"
  ) &
  pids+=($!)
}
step shellcheck run_shellcheck
step "deno check" check_files deno check -- '*.ts'
step scripts/test-target-diff.sh scripts/test-target-diff.sh
# 書き込みは $TMPDIR の下だけだが、シンボリックリンクを作るので Deno はパスを絞った許可を受け付けない
step scripts/test-target-diff.ts deno run --allow-run=git,bash --allow-env --allow-read --allow-write scripts/test-target-diff.ts
# sync.sh の写しと shim を一時ディレクトリから起動し、symlink を作るので、run・read・write はパスを絞れない
step scripts/test-agent-sync.ts deno run --allow-run --allow-env=CI,PATH,TMPDIR --allow-read --allow-write scripts/test-agent-sync.ts
# 一時ディレクトリに symlink を作るので、read・write はパスを絞れない
step scripts/test-pre-push.ts deno run --allow-run=git,env --allow-env=PATH,TMPDIR --allow-read --allow-write scripts/test-pre-push.ts
step scripts/test-cleanup-branch.ts deno run --allow-run=git,skills/setup-repo/pr-workflow/cleanup-branch.sh --allow-env=PATH,TMPDIR --allow-read="${TMPDIR:-/tmp}" --allow-write="${TMPDIR:-/tmp}" scripts/test-cleanup-branch.ts
step scripts/test-codex-limits.ts deno run --allow-run=bash,skills/setup-repo/pr-workflow/codex-limits.sh --allow-env=PATH,TMPDIR --allow-read="${TMPDIR:-/tmp}" --allow-write="${TMPDIR:-/tmp}" scripts/test-codex-limits.ts
step scripts/test-pr.ts deno run --allow-run=bash --allow-net=127.0.0.1 --allow-env=PR_RUNS,FC_SEED,PATH --allow-read="${TMPDIR:-/tmp}" --allow-write="${TMPDIR:-/tmp}" scripts/test-pr.ts
step scripts/verify.ts bash -c 'set -o pipefail; git ls-files --cached --others --exclude-standard | deno run --allow-read=. --allow-net=www.schemastore.org scripts/verify.ts'

for i in "${!names[@]}"; do
  code=0
  wait "${pids[$i]}" || code=$?
  if [ "$code" = 0 ]; then
    echo "== ${names[$i]}: 通った ($(cat "$out/$i.time") 秒)"
    cat "$out/$i.out"
    cat "$out/$i.err" >&2
  else
    {
      echo "== ${names[$i]}: 落ちた (exit $code、$(cat "$out/$i.time" 2>/dev/null || echo ?) 秒)"
      cat "$out/$i.out" "$out/$i.err"
    } >&2
    status=1
  fi
done
pids=()
exit "$status"
