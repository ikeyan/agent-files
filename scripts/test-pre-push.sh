#!/usr/bin/env bash
# hooks/pre-push を、token (<git-dir>/push-ok) の有無で push を通す・止めることを検査する。verify.sh から呼ぶ。
# ネットワークは使わない (bare リポジトリを file システム上に作って push する)。
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/pre-push.XXXXXX")" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
status=0

cd "$tmp"
git init -q -b main --bare remote.git
git clone -q remote.git clone
git -C clone config core.hooksPath "$here/hooks"
echo x > clone/a.txt && git -C clone add a.txt && git -C clone commit -q -m a

# token が無ければ push は止まり、remote には何も届かない
if git -C clone push origin main 2>err.txt; then
  echo "token 無しで push が通った" >&2
  status=1
fi
grep -q push-ok err.txt || { echo "token 無しのエラーメッセージに push-ok が無い — $(cat err.txt)" >&2; status=1; }
[ -z "$(git -C remote.git for-each-ref refs/heads/main)" ] || { echo "token 無しで remote に ref ができた" >&2; status=1; }

# token を置けば push が通り、token は消える
git_dir=$(git -C clone rev-parse --path-format=absolute --git-dir)
touch "$git_dir/push-ok"
git -C clone push -q origin main || { echo "token ありで push が失敗した" >&2; status=1; }
[ -n "$(git -C remote.git for-each-ref refs/heads/main)" ] || { echo "token ありで remote に ref ができない" >&2; status=1; }
[ ! -e "$git_dir/push-ok" ] || { echo "push 後に token が残っている" >&2; status=1; }

# 2 回目の push は push すべき差分が無くても、hook は毎回呼ばれるので token が無ければ止まる
if git -C clone push origin main 2>/dev/null; then
  echo "2 回目 (token 無し、push する差分も無い) が通った" >&2
  status=1
fi

exit "$status"
