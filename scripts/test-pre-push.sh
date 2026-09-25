#!/usr/bin/env bash
# hooks/pre-push を、token (<git-dir>/push-ok) の有無で push を通す・止めることと、verify.sh が検査に落ちる clone でも core.hooksPath を設定ファイルに hooks と書き (command スコープや GIT_CONFIG の値では済ませない)、hooks にできなければ落ちることを検査する。verify.sh から呼ぶ。
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

# gh.md の push の手順は、結果によらず rm -f で token を消す。存在しない remote 名は
# git push が hook (remote に問い合わせた後にしか呼ばれない) より前に失敗するので、その cleanup を検査できる
if (cd clone; t=$(git rev-parse --git-dir)/push-ok; touch "$t"; git push -u nonexistent-remote main; s=$?; rm -f "$t"; exit "$s") 2>err3.txt; then
  echo "存在しない remote への push が通った" >&2
  status=1
fi
grep -q "does not appear to be a git repository" err3.txt || { echo "存在しない remote への push のエラーが違う — $(cat err3.txt)" >&2; status=1; }
[ ! -e "$git_dir/push-ok" ] || { echo "hook より前に失敗した push の後、手順の cleanup で token が消えない" >&2; status=1; }

# cleanup で token が消えたので、続く (無関係な) push は token 無しで止まる
if git -C clone push origin main 2>/dev/null; then
  echo "手順の cleanup の後、token 無しで push が通った" >&2
  status=1
fi

# verify.sh は、検査が落ちても core.hooksPath を hooks にしてから落ちる (hook が無い clone から push できる期間を作らない)。
# 作業ツリーの verify.sh を clone に写し、shellcheck が落ちるファイルを置いて回す。VERIFY_READONLY は直さないモードなので、CI から継承した値を外す
git clone -q "$here" repo
cp "$here/verify.sh" repo/verify.sh
cat > repo/bad.sh <<'BAD'
#!/bin/bash
if [ $x = y ]; then :; fi
BAD
if (cd repo && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2>&1; then
  echo "shellcheck が落ちるファイルがあるのに verify.sh が通った" >&2
  status=1
fi
[ "$(git -C repo config --get core.hooksPath)" = hooks ] || { echo "検査に落ちた verify.sh が core.hooksPath を hooks にしていない" >&2; status=1; }

# worktree スコープの値が local に勝つ clone では、verify.sh は落ちて設定元を示し、worktree の設定は書き換えない
git clone -q "$here" repo2
cp "$here/verify.sh" repo/bad.sh repo2/
git -C repo2 config extensions.worktreeConfig true
git -C repo2 config --worktree core.hooksPath /dev/null
if (cd repo2 && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2> err4.txt; then
  echo "worktree スコープの core.hooksPath が勝つのに verify.sh が通った" >&2
  status=1
fi
grep -q "別の設定元の値が勝つ (worktree " err4.txt || { echo "worktree スコープが勝つことを verify.sh が示さない — $(cat err4.txt)" >&2; status=1; }
[ "$(git -C repo2 config --worktree --get core.hooksPath)" = /dev/null ] || { echo "verify.sh が worktree スコープの core.hooksPath を書き換えた" >&2; status=1; }

# command スコープ (GIT_CONFIG_COUNT 等・-c が渡す GIT_CONFIG_PARAMETERS) と GIT_CONFIG の値は clone に残らないので、それが hooks でも verify.sh は local に書く
printf '[core]\n\thooksPath = hooks\n' > hooks.gitconfig
n=3
for override in 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=hooks' "GIT_CONFIG_PARAMETERS='core.hookspath'='hooks'" GIT_CONFIG=../hooks.gitconfig; do
  read -ra assignments <<< "$override"
  git clone -q "$here" "repo$n"
  cp "$here/verify.sh" repo/bad.sh "repo$n/"
  (cd "repo$n" && env -u VERIFY_READONLY "${assignments[@]}" ./verify.sh) > /dev/null 2>&1 || true
  [ "$(git -C "repo$n" config --local --get core.hooksPath)" = hooks ] || { echo "$override のとき、verify.sh が local に core.hooksPath を書かない" >&2; status=1; }
  n=$((n + 1))
done

exit "$status"
