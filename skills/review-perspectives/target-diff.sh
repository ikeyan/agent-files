#!/usr/bin/env bash
# review-perspectives の手順 1: レビュー対象を作業ディレクトリの target.diff に書き出す。
#
# 使い方: target-diff.sh [<対象>] [-- <path>...]
#   <対象> 無し: 今のチェックアウト (既定ブランチとの分岐点から先のコミット、未コミットの変更、未追跡のファイル)
#   <対象> が数字だけ: PR 番号 (gh で head と base ブランチを引く)
#   <対象> がそれ以外: 手元のブランチ、origin のブランチ、revision の順に解決する
#   <path>: log と diff をそのパスに限る。glob も pathspec magic も無いそのままのパス名
# 出力 (stdout、1 行 1 つ): work=<レビュー対象ごとの作業ディレクトリ> run=<この実行の生成物のディレクトリ> repo=<レビュアーに渡すリポジトリのルート> diff=<target.diff>
# 事前条件: origin があり、その HEAD が既定ブランチを指している。PR 番号は gh の認証。
# 事後条件: 対象を指定したら repo は run の下の linked worktree。レビュー後に git worktree remove <repo> してから rm -r <run> で消す。失敗して終わるときは自分で消す。
#           同じ対象を並行して回しても run は別で、work の exclusions.md と origin の remote-tracking ref だけを共有する。
#
# 受け付ける環境の形 (canon: facts/git/repository-shapes) と扱い:
#   処理する: linked worktree、--single-branch の clone、shallow clone、unborn HEAD、root commit、
#             既定ブランチに入った revision と merge commit、既定ブランチ以外へ向く PR、手元だけ・リモートだけのブランチ、
#             未追跡の項目の全種 (- 始まりの名前、シンボリックリンク、入れ子のリポジトリ)
#   対象外:   submodule と入れ子のリポジトリの中身 (gitlink の commit id だけを見る。中の変更はそのリポジトリで回す)
#   止まる:   同時に始めた別の実行と fetch が衝突した (cannot lock ref。やり直せば通る)、origin が無い、origin の HEAD が既定ブランチを指していない (set-head --auto の Cannot determine remote HEAD)、<対象> が解決できない、共通の祖先が無い、レビュー対象が空 (変更が無い、<path> が何にも一致しない、コミットが打ち消し合って patch が空)
# 外さないもの: fetch の refspec と --prune、set-head --auto、--path-format=absolute --git-common-dir、add -A の前の read-tree (理由は canon の同ページ)
set -euo pipefail

target=
if [ $# -gt 0 ] && [ "$1" != -- ]; then target=$1; shift; fi
if [ $# -gt 0 ]; then
  [ "$1" = -- ] || { echo "usage: target-diff.sh [<対象>] [-- <path>...]" >&2; exit 2; }
  shift
fi
paths=("$@")
export GIT_LITERAL_PATHSPECS=1

git fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*'
git remote set-head origin --auto
common=$(git rev-parse --path-format=absolute --git-common-dir)
base_ref=origin/HEAD
rev=
if [ -z "$target" ]; then
  name=$(git symbolic-ref --short -q HEAD) || name=$(git rev-parse --short HEAD)
elif [[ $target =~ ^[0-9]+$ ]]; then
  IFS=$'\t' read -r name base_branch < <(gh pr view "$target" --json headRefName,baseRefName --jq '[.headRefName, .baseRefName] | @tsv')
  base_ref=origin/$base_branch
  git fetch -q origin "refs/pull/$target/head"
  rev=$(git rev-parse FETCH_HEAD)
else
  name=$target
  rev=$(git rev-parse --verify -q "refs/heads/$target") ||
    rev=$(git rev-parse --verify -q "refs/remotes/origin/$target") ||
    rev=$(git rev-parse --verify "$target^{commit}")
fi

work=$common/review-perspectives/$name
mkdir -p "$work"
run=$(mktemp -d "$work/run.XXXXXX")
ok=
repo=$(git rev-parse --show-toplevel)
start=$PWD
trap '[ -n "$ok" ] || { cd "$start" && rm -rf "$run" && git worktree prune; }' EXIT
if [ -n "$rev" ]; then
  repo=$run/tree
  git worktree add -q --detach "$repo" "$rev"
  cd "$repo"
fi

empty_tree=$(git hash-object -t tree /dev/null)
head=$(git rev-parse --verify -q 'HEAD^{commit}') || head=
if [ -z "$head" ]; then
  base=$empty_tree
else
  base=$(git merge-base "$base_ref" HEAD) || {
    [ "$(git rev-parse --is-shallow-repository)" = true ] || { echo "target-diff.sh: $base_ref と HEAD に共通の祖先が無い" >&2; exit 1; }
    git fetch --unshallow
    base=$(git merge-base "$base_ref" HEAD)
  }
  # 既定ブランチに入った revision は merge-base が自身になる。first-parent の線上で最寄りの祖先から先を対象にする。
  if [ -n "$rev" ] && [ "$base" = "$head" ]; then
    base=$empty_tree
    for c in $(git rev-list --first-parent "$base_ref"); do
      if [ "$c" != "$head" ] && git merge-base --is-ancestor "$c" HEAD; then base=$c; break; fi
    done
  fi
fi

export GIT_INDEX_FILE=$run/index
if [ -n "$head" ]; then git read-tree HEAD; else git read-tree --empty; fi
git add -A --no-warn-embedded-repo
git diff --cached "$base" -- "${paths[@]+"${paths[@]}"}" > "$run/patch.diff"
[ -s "$run/patch.diff" ] || { echo "target-diff.sh: レビュー対象が空" >&2; exit 1; }
{
  if [ -n "$head" ]; then git log --reverse --format='commit %h%n%n%B' "$base..HEAD" -- "${paths[@]+"${paths[@]}"}"; fi
  cat "$run/patch.diff"
} > "$run/target.diff"

ok=1
printf 'work=%s\nrun=%s\nrepo=%s\ndiff=%s\n' "$work" "$run" "$repo" "$run/target.diff"
