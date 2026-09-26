#!/usr/bin/env bash
# hooks/pre-push を、token (<git-dir>/push-ok) の有無で push を通す・止めることと、verify.sh がそれを common git dir の hooks へ写す (検査に落ちる clone でも。写しが改変されていれば写し直す) ことを検査する。写しは main worktree の checkout によらず linked worktree の push も止めること、core.hooksPath が hook をよそへ向けていれば verify.sh が設定を書かずに落ちることも見る。verify.sh から呼ぶ。
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
install -m 755 "$here/hooks/pre-push" "$(git -C clone rev-parse --path-format=absolute --git-common-dir)/hooks/pre-push"
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

# verify.sh は、検査が落ちても hooks/pre-push を common git dir の hooks に写してから落ちる (hook が無い clone から push できる期間を作らない)。
# 作業ツリーの verify.sh を clone に写し、shellcheck が落ちるファイルを置いて回す。VERIFY_READONLY は直さないモードなので、CI から継承した値を外す
git clone -q "$here" repo
cp "$here/verify.sh" repo/verify.sh
cat > repo/bad.sh <<'BAD'
#!/bin/bash
if [ $x = y ]; then :; fi
BAD
hook=$tmp/repo/.git/hooks/pre-push
if (cd repo && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2>&1; then
  echo "shellcheck が落ちるファイルがあるのに verify.sh が通った" >&2
  status=1
fi
if [ ! -x "$hook" ] || ! cmp -s repo/hooks/pre-push "$hook"; then
  echo "検査に落ちた verify.sh が $hook に hooks/pre-push の実行可能な写しを置いていない" >&2
  status=1
fi

# 写しが改変されていれば verify.sh は写し直す。VERIFY_READONLY=1 では写さずに落ちて示す
printf x >> "$hook"
(cd repo && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2>&1 || true
cmp -s repo/hooks/pre-push "$hook" || { echo "改変された写しを verify.sh が写し直さない" >&2; status=1; }
printf x >> "$hook"
(cd repo && VERIFY_READONLY=1 ./verify.sh) > /dev/null 2> err4.txt || true
grep -q "$hook: hooks/pre-push と同じ実行可能なファイルでない" err4.txt || { echo "VERIFY_READONLY=1 の verify.sh が改変された写しを示さない — $(cat err4.txt)" >&2; status=1; }
! cmp -s repo/hooks/pre-push "$hook" || { echo "VERIFY_READONLY=1 の verify.sh が写しを直した" >&2; status=1; }
cp repo/hooks/pre-push "$hook"

# hooks/ の無い linked worktree (hooks/pre-push の無い commit と同じ) からも、token 無しの push は止まる
git -C repo worktree add -q --detach ../wt
rm -r wt/hooks
if git -C wt push "$tmp/remote.git" HEAD:refs/heads/wt 2>err5.txt; then
  echo "hooks/ の無い linked worktree から token 無しで push が通った" >&2
  status=1
fi
grep -q push-ok err5.txt || { echo "hooks/ の無い linked worktree の token 無しの push のエラーに push-ok が無い — $(cat err5.txt)" >&2; status=1; }

# main worktree を hooks/pre-push の無い commit に切り替えても、linked worktree からの token 無しの push は止まる
git -C repo checkout -q --detach
git -C repo rm -q hooks/pre-push
git -C repo commit -q -m 'hooks/pre-push の無い commit'
if git -C wt push "$tmp/remote.git" HEAD:refs/heads/wt 2>err6.txt; then
  echo "main worktree が hooks/pre-push の無い commit のとき、linked worktree から token 無しで push が通った" >&2
  status=1
fi
grep -q push-ok err6.txt || { echo "main worktree が hooks/pre-push の無い commit のときの token 無しの push のエラーに push-ok が無い — $(cat err6.txt)" >&2; status=1; }

# core.hooksPath が hook をよそへ向けていれば、verify.sh は設定元を示して落ち、設定は書き換えない
git clone -q "$here" repo2
cp "$here/verify.sh" repo/bad.sh repo2/
git -C repo2 config core.hooksPath hooks
if (cd repo2 && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2> err7.txt; then
  echo "core.hooksPath が hook をよそへ向けているのに verify.sh が通った" >&2
  status=1
fi
grep -q "local file:.git/config hooks" err7.txt || { echo "core.hooksPath の設定元を verify.sh が示さない — $(cat err7.txt)" >&2; status=1; }
[ "$(git -C repo2 config --get core.hooksPath)" = hooks ] || { echo "verify.sh が core.hooksPath を書き換えた" >&2; status=1; }

exit "$status"
