#!/usr/bin/env bash
# skills/setup-repo/pr-workflow/cleanup-branch.sh を検査する。
# - ブランチの checkout 先ごとに、消えて、checkout していた worktree が同じ commit で detach される
#   - main worktree (既定ブランチは linked worktree で checkout 中)・生きた linked worktree・ディレクトリが消えた linked worktree の登録・どこにも checkout されていない
# - 先端が expected と違う・ブランチが無い・expected が 40 桁の 16 進数でない場合は、断ってブランチを変えない
# verify.sh から呼ぶ。
# ネットワークは使わない (ローカルのリポジトリだけ)。
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
script=$here/skills/setup-repo/pr-workflow/cleanup-branch.sh
tmp=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/cleanup-branch.XXXXXX")" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
gitconfig=$(cd "$(dirname "$0")" && pwd)/test-gitconfig
export GIT_CONFIG_GLOBAL=$gitconfig GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
status=0

# 新しい repo を作り、main に 1 commit、work に 1 commit 足した状態にする。cwd は repo に移る
new_repo() { # <名前>
  rm -rf "${tmp:?}/$1"
  git init -q -b main "$tmp/$1"
  cd "$tmp/$1"
  git commit -q --allow-empty -m base
  git branch work
  git switch -q work
  git commit -q --allow-empty -m work
  git switch -q main
}
tip() { git rev-parse "refs/heads/$1"; }
fail() { echo "$*" >&2; status=1; }

expect_deleted() { # <名前> [<detach されるはずの worktree>]
  local name=$1 wt=${2:-} sha
  sha=$(tip work)
  "$script" work "$sha" > /dev/null 2> "$tmp/err.txt" || fail "$name: 消せなかった — $(cat "$tmp/err.txt")"
  git rev-parse --verify -q refs/heads/work > /dev/null && fail "$name: ブランチが残った"
  if [ -n "$wt" ]; then
    [ "$(git -C "$wt" rev-parse HEAD)" = "$sha" ] || fail "$name: $wt の HEAD が元の commit でない"
    [ -z "$(git -C "$wt" branch --show-current)" ] || fail "$name: $wt が detach されていない"
  fi
}
expect_refused() { # <名前> <ブランチ> <sha>
  local name=$1 before
  before=$(git for-each-ref refs/heads)
  if "$script" "$2" "$3" > /dev/null 2>&1; then fail "$name: 断らなかった"; fi
  [ "$before" = "$(git for-each-ref refs/heads)" ] || fail "$name: 断ったのにブランチが変わった"
}

# main worktree が work を checkout し、既定ブランチ main は linked worktree が checkout 中
new_repo r1
git switch -q work
git worktree add -q ../r1-main main
expect_deleted 'main worktree が checkout' "$tmp/r1"

# 生きた linked worktree が checkout
new_repo r2
git worktree add -q ../r2-wt work
expect_deleted 'linked worktree が checkout' "$tmp/r2-wt"

# ディレクトリが消えた linked worktree の登録が checkout
new_repo r3
git worktree add -q ../r3-wt work
rm -rf "$tmp/r3-wt"
expect_deleted 'ディレクトリが消えた登録'

# どこにも checkout されていない
new_repo r4
expect_deleted 'checkout 無し'

# 断る場合
new_repo r5
good=$(tip work)
expect_refused '先端が違う' work "$(tip main)"
expect_refused 'ブランチが無い' nothing "$good"
expect_refused '短縮形の sha' work "${good:0:7}"
expect_refused '大文字の sha' work "$(printf '%s' "$good" | tr a-f A-F)"
expect_refused 'ref 名' work work
expect_refused 'sha が空' work ''
[ -n "$(git for-each-ref refs/heads/work)" ] || fail "断る場合のあとに work が消えている"

exit "$status"
