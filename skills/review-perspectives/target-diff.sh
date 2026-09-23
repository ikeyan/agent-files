#!/usr/bin/env bash
# review-perspectives の手順 1: レビュー対象を作業ディレクトリの target.diff に書き出す。
#
# 使い方: target-diff.sh [<対象>] [-- <path>...]
#   <対象> 無し: 今のチェックアウト (既定ブランチとの分岐点から先のコミット、未コミットの変更、未追跡のファイル)
#   <対象> が数字だけ: PR 番号 (gh で head・base ブランチ・コミット一覧を引く。分岐点は PR の最初のコミットの親なので、マージ済みでも全コミットが対象)
#   <対象> がそれ以外: 手元のブランチ、origin のブランチ、revision の順に解決する。既定ブランチの first-parent の線上にある revision は、その 1 コミットだけが対象
#                       (fast-forward や rebase でマージ済みのブランチの分岐点は履歴に残らない。全コミットは PR 番号で指定する)
#   <path>: log と diff をそのパスに限る。glob も pathspec magic も無いそのままのパス名で、cwd からの相対パスかリポジトリの中の絶対パス
# 出力 (stdout、1 行 1 つ): work=<レビュー対象ごとの作業ディレクトリ> run=<この実行の生成物のディレクトリ ($TMPDIR の下。消えて困るものは置かない)> repo=<レビュアーに渡すリポジトリのルート> diff=<target.diff> tree=<レビュー対象の内容全体 (未追跡を含む) の tree id>
# 事前条件: origin があり、その HEAD が既定ブランチを指している。PR 番号は gh の認証。
# 事後条件: 対象を指定したら repo は run の下の linked worktree。レビュー後に git worktree remove <repo> してから rm -r <run> で消す。失敗して終わるときは自分で消す。
#           同じ対象を並行して回しても run は別で、work の exclusions.md と origin の remote-tracking ref だけを共有する。
#
# 受け付ける環境の形 (canon: facts/git/repository-shapes) と扱い:
#   処理する: linked worktree、--single-branch の clone、shallow clone、unborn HEAD、root commit、
#             既定ブランチに入った revision と merge commit、既定ブランチ以外へ向く PR、手元だけ・リモートだけのブランチ、
#             未追跡の項目の全種 (- 始まりの名前、シンボリックリンク、入れ子のリポジトリ)
#   対象外:   submodule と入れ子のリポジトリの中身 (gitlink の commit id だけを見る。中の変更はそのリポジトリで回す)、
#             本来の index の内容 (作業ツリーを正とする。staged した後に作業ツリーを戻した内容は出ない)
#   止まる:   同時に始めた別の実行と fetch が衝突した (cannot lock ref。やり直せば通る)、origin が無い、origin の HEAD が既定ブランチを指していない (set-head --auto の Cannot determine remote HEAD)、<対象> が解決できない、共通の祖先が無い、<path> がリポジトリの外 (絶対パスの .. でルートより上を通るものを含む)、レビュー対象が空 (変更が無い、<path> が何にも一致しない、コミットが打ち消し合って patch が空)
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
git remote set-head origin --auto > /dev/null
common=$(git rev-parse --path-format=absolute --git-common-dir)
base_ref=origin/HEAD
rev=
pr_base=
if [ -z "$target" ]; then
  name=$(git symbolic-ref --short -q HEAD) || name=$(git rev-parse --short HEAD)
elif [[ $target =~ ^[0-9]+$ ]]; then
  IFS=$'\t' read -r name base_branch first < <(gh pr view "$target" --json headRefName,baseRefName,commits --jq '[.headRefName, .baseRefName, .commits[0].oid] | @tsv')
  base_ref=origin/$base_branch
  git fetch -q origin "refs/pull/$target/head"
  rev=$(git rev-parse FETCH_HEAD)
  pr_base=$(git rev-parse --verify -q "$first^") || pr_base=$(git hash-object -t tree /dev/null)
elif rev=$(git rev-parse --verify -q "refs/heads/$target") || rev=$(git rev-parse --verify -q "refs/remotes/origin/$target"); then
  name=$target
else
  rev=$(git rev-parse --verify "$target^{commit}")
  name=$rev
fi

# ブランチ名は / を含み、消えたブランチの作業ディレクトリの中の exclusions.md とも重なりうるので、名前の hash をディレクトリ名にする
work=$common/review-perspectives/$(printf '%s' "$name" | git hash-object --stdin)
mkdir -p "$work"
run=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/review-perspectives.XXXXXX")" && pwd -P)
ok=
repo=$(git rev-parse --show-toplevel)
prefix=$(git rev-parse --show-prefix)
# シンボリックリンク経由で入ると、呼び出し側の論理パス ($PWD) は物理パスの $repo と一致しない。
# $PWD の下は prefix で写し、$PWD が prefix で終わるならその上を論理ルートとして扱う。
lroot=$repo
case $PWD in */"${prefix%/}") lroot=${PWD%/"${prefix%/}"} ;; esac
[ -n "$prefix" ] || lroot=$PWD
s=/
for i in "${!paths[@]}"; do
  # 絶対パスは前方一致で写すので、重なった区切りを 1 つに畳む (相対パスの . や .. は git が畳む)
  while [[ ${paths[i]} == *$s$s* ]]; do paths[i]=${paths[i]//$s$s/$s}; done
  case ${paths[i]} in
    "$repo"|"$repo"/|"$lroot"|"$lroot"/) paths[i]=. ;;
    "$PWD"|"$PWD"/) paths[i]=${prefix:-.} ;;
    "$repo"/*) paths[i]=${paths[i]#"$repo"/} ;;
    "$PWD"/*) paths[i]=$prefix${paths[i]#"$PWD"/} ;;
    "$lroot"/*) paths[i]=${paths[i]#"$lroot"/} ;;
    /*) echo "target-diff.sh: <path> がリポジトリの外: ${paths[i]}" >&2; exit 1 ;;
    *) paths[i]=$prefix${paths[i]} ;;
  esac
done
start=$PWD
trap '[ -n "$ok" ] || { cd "$start" && rm -rf "$run" && git worktree prune; }' EXIT
if [ -n "$rev" ]; then
  repo=$run/tree
  git worktree add -q --detach "$repo" "$rev"
fi
cd "$repo"

empty_tree=$(git hash-object -t tree /dev/null)
head=$(git rev-parse --verify -q 'HEAD^{commit}') || head=
if [ -z "$head" ]; then
  base=$empty_tree
elif [ -n "$pr_base" ]; then
  base=$pr_base
else
  # shallow だと merge-base も first-parent の走査も途中で切れる (走査は失敗せず短い結果を返す)
  if [ "$(git rev-parse --is-shallow-repository)" = true ]; then git fetch -q --unshallow; fi
  base=$(git merge-base "$base_ref" HEAD) || { echo "target-diff.sh: $base_ref と HEAD に共通の祖先が無い" >&2; exit 1; }
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

tree=$(git write-tree)
ok=1
printf 'work=%s\nrun=%s\nrepo=%s\ndiff=%s\ntree=%s\n' "$work" "$run" "$repo" "$run/target.diff" "$tree"
