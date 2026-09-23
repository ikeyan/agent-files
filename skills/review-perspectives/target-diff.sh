#!/usr/bin/env bash
# review-perspectives の手順 1: レビュー対象を作業ディレクトリの target.diff に書き出す。
#
# 使い方: target-diff.sh [<対象>] [-- <path>...]
#   <対象> 無し: 今のチェックアウト (既定ブランチとの分岐点から先のコミット、未コミットの変更、未追跡のファイル)
#   <対象> が数字だけ: PR 番号 (gh で head ブランチと base の commit を引く。分岐点は base の commit と head の merge-base。GitHub は base の commit をマージの時点で止めるので、マージ済みでも全コミットが対象で、head に取り込んだ base のコミットは対象外)
#   <対象> がそれ以外: 手元のブランチ、origin のブランチ、revision の順に解決する。既定ブランチの first-parent の線上にある revision は、その 1 コミットだけが対象 (fast-forward や rebase でマージ済みのブランチの分岐点は履歴に残らない。全コミットは PR 番号で指定する)
#   <path>: log と diff をそのパスに限る。glob も pathspec magic も無いそのままのパス名で、cwd からの相対パスかリポジトリの中の絶対パス (シンボリックリンクを経由してよい。リポジトリの外に置いた、中のファイルへのリンクはリポジトリの外として止まる)
# 出力 (stdout、1 行 1 つ): work=<レビュー対象ごとの作業ディレクトリ> run=<この実行の生成物のディレクトリ ($TMPDIR の下。消えて困るものは置かない)> repo=<レビュアーに渡すリポジトリのルート> diff=<target.diff (PR 番号なら PR のタイトルと説明、各コミットのメッセージ、patch の順)> tree=<レビュー対象の内容全体 (未追跡を含む) の tree id> rules=<レビューの規則 (SKILL.md・観点・リポ固有の検索対象) の hash>
# 事前条件: origin があり、その HEAD が既定ブランチを指している。
# 事後条件: 対象を指定したら repo は run の下の linked worktree。レビュー後に git worktree remove <repo> してから rm -r <run> で消す。失敗して終わるときは自分で消す。同じ対象を並行して回しても run は別で、work の exclusions.md と origin の remote-tracking ref だけを共有する。
#
# 受け付ける環境の形 (canon: facts/git/repository-shapes) と扱い:
#   処理する: linked worktree、--single-branch の clone、shallow clone、unborn HEAD、root commit、既定ブランチに入った revision と merge commit、既定ブランチ以外へ向く PR、手元だけ・リモートだけのブランチ、未追跡の項目の全種 (- 始まりの名前、シンボリックリンク、入れ子のリポジトリ)、diff と log の出力を変える git の設定 (diff.external・GIT_EXTERNAL_DIFF・textconv・color・diff.noprefix・log.showSignature)、リポジトリの hook (走らせない)、gh の既定のリポジトリ (GH_REPO・gh repo set-default) が origin と違う
#   対象外:   submodule と入れ子のリポジトリの中身 (gitlink の commit id だけを見る。中の変更はそのリポジトリで回す)、本来の index の内容 (作業ツリーを正とする。staged した後に作業ツリーを戻した内容は出ない)、.gitignore で無視された項目 (git add -A が拾わないので diff にも tree にも入らない)
#   止まる:   同時に始めた別の実行と fetch が衝突した (cannot lock ref。やり直せば通る)、origin が無い、origin の HEAD が既定ブランチを指していない (set-head --auto の Cannot determine remote HEAD)、<対象> が解決できない (PR 番号で origin が GitHub のリポジトリでない・gh が認証されていないものを含む)、PR の base の commit が origin のブランチから辿れない (マージの後で base を force push・削除した)、共通の祖先が無い、<path> がリポジトリの外、レビュー対象が空 (変更が無い、<path> が何にも一致しない、コミットが打ち消し合って patch が空)
# 外さないもの: fetch の refspec と --prune と --no-write-fetch-head、unshallow の origin、set-head --auto、--path-format=absolute --git-common-dir、add -A の前の read-tree、patch の diff-index、log の --no-show-signature (理由は canon の同ページ)
set -euo pipefail

target=
if [ $# -gt 0 ] && [ "$1" != -- ]; then target=$1; shift; fi
if [ $# -gt 0 ]; then
  [ "$1" = -- ] || { echo "usage: target-diff.sh [<対象>] [-- <path>...]" >&2; exit 2; }
  shift
fi
paths=("$@")
# worktree add の post-checkout などの hook が、対象の worktree にファイルを足して diff に混ぜないように
git() { command git -c core.hooksPath=/dev/null "$@"; }
here=$(cd "$(dirname "$0")" && pwd -P)
export GIT_LITERAL_PATHSPECS=1
repo=$(git rev-parse --show-toplevel)
s=/
for i in "${!paths[@]}"; do
  # 物理パスに直してルートと比べる。シンボリックリンクの cwd でも論理パスの字面から推さず、存在する最長の祖先を cd -P で解く。
  # 最後の要素はたどらない (リポジトリの中のリンクはリンク自身を指す) が、それでリポジトリの外になるディレクトリはたどる (リポジトリへのリンク)
  p=${paths[i]}
  case $p in /*) ;; *) p=$PWD/$p ;; esac
  # 先頭の // は POSIX で意味が決まっておらず、pwd -P もそのまま残すので、重なった区切りを畳む
  while [[ $p == *$s$s* ]]; do p=${p//$s$s/$s}; done
  p=${p%/} leaf=${p##*/} dir=${p%/*}
  case $leaf in .|..) leaf='' dir=$p ;; esac
  rest=$leaf
  until phys=$(cd -P -- "${dir:-/}" 2>/dev/null && pwd -P); do rest=${dir##*/}/$rest dir=${dir%/*}; done
  full=${phys%/}/$rest
  case $full in "$repo"|"$repo"/*) ;; *) if [ -d "$p" ]; then full=$(cd -P -- "$p" && pwd -P)/; fi ;; esac
  case $full in
    "$repo"|"$repo"/) paths[i]=. ;;
    "$repo"/*) paths[i]=${full#"$repo"/} ;;
    *) echo "target-diff.sh: <path> がリポジトリの外: ${paths[i]}" >&2; exit 1 ;;
  esac
done

git fetch -q --no-write-fetch-head --prune origin '+refs/heads/*:refs/remotes/origin/*'
# shallow だと merge-base も first-parent の走査も途中で切れる (走査は失敗せず短い結果を返す)
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then git fetch -q --no-write-fetch-head --unshallow origin; fi
git remote set-head origin --auto > /dev/null
common=$(git rev-parse --path-format=absolute --git-common-dir)
base_ref=origin/HEAD
rev=
pr_base=
if [ -z "$target" ]; then
  name=$(git symbolic-ref --short -q HEAD) || name=$(git rev-parse --short HEAD)
elif [[ $target =~ ^[0-9]+$ ]]; then
  origin_url=$(git remote get-url origin)
  IFS=$'\t' read -r name rev base_oid < <(gh pr view "$target" -R "$origin_url" --json headRefName,headRefOid,baseRefOid --jq '[.headRefName, .headRefOid, .baseRefOid] | @tsv')
  git fetch -q --no-write-fetch-head origin "refs/pull/$target/head"
  pr_base=$(git merge-base "$base_oid" "$rev") || { echo "target-diff.sh: PR の base の commit $base_oid と head の merge-base が取れない" >&2; exit 1; }
# origin/HEAD は既定ブランチを指す symref なので、HEAD を origin のブランチとして引かない (ブランチ名に HEAD は使えない)
elif rev=$(git rev-parse --verify -q "refs/heads/$target") || { [ "$target" != HEAD ] && rev=$(git rev-parse --verify -q "refs/remotes/origin/$target"); }; then
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
git diff-index -p -M --cached "$base" -- "${paths[@]+"${paths[@]}"}" > "$run/patch.diff"
[ -s "$run/patch.diff" ] || { echo "target-diff.sh: レビュー対象が空" >&2; exit 1; }
{
  if [ -n "$pr_base" ]; then gh pr view "$target" -R "$origin_url" --json title,body --jq '"pull request: \(.title)\n\n\(.body)\n"'; fi
  if [ -n "$head" ]; then git log --no-show-signature --reverse --format='commit %h%n%n%B' "$base..HEAD" -- "${paths[@]+"${paths[@]}"}"; fi
  cat "$run/patch.diff"
} > "$run/target.diff"

tree=$(git write-tree)
shopt -s nullglob
# 検索対象は名前で観点に割り当てるので、内容と一緒に名前も hash する
rules_files=("$here"/SKILL.md "$here"/perspectives/*.md review-perspectives/*.md)
rules=$(paste -d ' ' <(git hash-object "${rules_files[@]}") <(printf '%s\n' "${rules_files[@]#"$here"/}") | git hash-object --stdin)
ok=1
printf 'work=%s\nrun=%s\nrepo=%s\ndiff=%s\ntree=%s\nrules=%s\n' "$work" "$run" "$repo" "$run/target.diff" "$tree" "$rules"
