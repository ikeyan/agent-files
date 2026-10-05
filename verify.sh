#!/usr/bin/env bash
# このリポの単一検証コマンド。引数なしで全部を検査する。
# 段は 2 種類で、その場で直す状態 (hooks/pre-push の写し (無いときだけ置く)、.claude/skills の symlink のずれ) を先に揃え、検査を後に回す。検査が落ちても状態は揃っているようにするため。VERIFY_READONLY=1 では直さず違反にする (CI 用)。
# 検査の段は scripts/run-checks.ts が並行に回す (出力の順・終了コード・止め方はその先頭)。
# 事前条件: shellcheck (0.11.0 だけ。.github/workflows/verify.yml が入れる版と同じ)・deno・curl (7.84 以降)・jq・archetect と、macOS では sandbox-exec と otool、Linux では bwrap と ldd が PATH にあること。ネットワーク (www.schemastore.org) に出られること。
# agent-sync の描画の sandbox を適用できない環境 (別の sandbox の中など) では、test-agent-sync.ts の最初の描画が sync.sh の「OS の sandbox を適用できない」で落ちるので、描画を伴う残りの検査を飛ばして理由を stderr に出す。CI では落とす。全部を検査するのは適用できる環境。
# git は hook を $GIT_COMMON_DIR/hooks (linked worktree も共有し、checkout で変わらない) から呼ぶので、hooks/pre-push をそこへ写す。core.hooksPath (どの scope でも) が hook をよそへ向けていれば違反にし、設定は書かない。
# 写す先の pre-push の状態ごとの扱い:
# - 無い (壊れた symlink を含む。git が実行できない): 写す
# - hooks/pre-push と同じ実行可能なファイル: 何もしない
# - それ以外 (旧版、利用者が置いた別の hook、手を入れた写し): このリポのものかを中身から決められないので、上書きせず落として置き換えのコマンドを示す
# 判定は verify.sh を走らせた環境 (GIT_CONFIG_GLOBAL・GIT_CONFIG_COUNT などの設定の差し替えを含む) についてのものなので、push する環境で走らせる。
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

# exec で替わるので、verify.sh に届く SIGHUP・SIGINT・SIGTERM は run-checks.ts が受けて段を止める。
# Deno.kill で段のプロセスグループに送るには、パスを付けない --allow-run が要る (パスで絞ると NotCapable。canon: facts/deno/command-spawn の「Deno.kill」)。Deno.kill がパスで絞った --allow-run で通るようになったら、段が起動するもの (git・deno・shellcheck) に絞る。
exec deno run --allow-run --allow-env=TMPDIR scripts/run-checks.ts "$status"
