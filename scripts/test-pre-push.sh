#!/usr/bin/env bash
# hooks/pre-push を、push のコマンドの PUSH_OK=1 の有無で push を通す・止めることと、verify.sh がそれを common git dir の hooks へ写す (検査に落ちる clone でも。写しが改変されていれば写し直す) ことを検査する。写しは main worktree の checkout によらず linked worktree の push も止めること、core.hooksPath が hook をよそへ向けていれば verify.sh が設定を書かずに落ちること、写す先にこのリポのものでない pre-push があれば verify.sh が上書きせずに落ちること (旧版の token 方式の hook は写し直す) も見る。verify.sh から呼ぶ。
# ネットワークは使わない (bare リポジトリを file システム上に作って push する)。
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/pre-push.XXXXXX")" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
status=0
# 呼び出し元の許可を引き継がない
unset PUSH_OK

cd "$tmp"
git init -q -b main --bare remote.git
git clone -q remote.git clone
install -m 755 "$here/hooks/pre-push" "$(git -C clone rev-parse --path-format=absolute --git-common-dir)/hooks/pre-push"
echo x > clone/a.txt && git -C clone add a.txt && git -C clone commit -q -m a

# PUSH_OK=1 が無ければ push は止まり、remote には何も届かない。PUSH_OK=0 も止まる
if git -C clone push origin main 2>err.txt; then
  echo "PUSH_OK 無しで push が通った" >&2
  status=1
fi
grep -q 'PUSH_OK=1' err.txt || { echo "PUSH_OK 無しのエラーメッセージに PUSH_OK=1 が無い — $(cat err.txt)" >&2; status=1; }
[ -z "$(git -C remote.git for-each-ref refs/heads/main)" ] || { echo "PUSH_OK 無しで remote に ref ができた" >&2; status=1; }
if PUSH_OK=0 git -C clone push origin main 2>/dev/null; then
  echo "PUSH_OK=0 で push が通った" >&2
  status=1
fi

# PUSH_OK=1 を付ければ push が通る
PUSH_OK=1 git -C clone push -q origin main || { echo "PUSH_OK=1 で push が失敗した" >&2; status=1; }
[ -n "$(git -C remote.git for-each-ref refs/heads/main)" ] || { echo "PUSH_OK=1 で remote に ref ができない" >&2; status=1; }

# 許可は残らない: 続く push は push すべき差分が無くても、hook は毎回呼ばれるので PUSH_OK が無ければ止まる
if git -C clone push origin main 2>/dev/null; then
  echo "PUSH_OK=1 の push の後、PUSH_OK 無し (push する差分も無い) が通った" >&2
  status=1
fi

# verify.sh は、検査が落ちても hooks/pre-push を common git dir の hooks に写してから落ちる (hook が無い clone から push できる期間を作らない)。
# 作業ツリーの verify.sh と hooks/pre-push を clone に写し、shellcheck が落ちるファイルを置いて回す。VERIFY_READONLY は直さないモードなので、CI から継承した値を外す
git clone -q "$here" repo
cp "$here/verify.sh" repo/verify.sh
cp "$here/hooks/pre-push" repo/hooks/pre-push
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

# 写す先にこのリポのものでない pre-push があれば、verify.sh は上書きせず落とす (VERIFY_READONLY=1 でも示すだけで触らない)
git clone -q "$here" repo3
cp "$here/verify.sh" "$here/hooks/pre-push" repo3/
hook3=$tmp/repo3/.git/hooks/pre-push
printf '#!/bin/sh\nexec ./scripts/lint\n' > "$hook3"
chmod 755 "$hook3"
cp "$hook3" foreign.orig
if (cd repo3 && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2> err8.txt; then
  echo "このリポのものでない pre-push があるのに verify.sh が通った" >&2
  status=1
fi
grep -q "このリポのものでない pre-push がある" err8.txt || { echo "他の pre-push を verify.sh が示さない — $(cat err8.txt)" >&2; status=1; }
cmp -s foreign.orig "$hook3" || { echo "verify.sh が他の pre-push を上書きした" >&2; status=1; }
(cd repo3 && VERIFY_READONLY=1 ./verify.sh) > /dev/null 2> err9.txt || true
grep -q "このリポのものでない pre-push がある" err9.txt || { echo "VERIFY_READONLY=1 の verify.sh が他の pre-push を示さない — $(cat err9.txt)" >&2; status=1; }
cmp -s foreign.orig "$hook3" || { echo "VERIFY_READONLY=1 の verify.sh が他の pre-push を書き換えた" >&2; status=1; }

# 旧版 (token 方式) の hook はこのリポのものなので、verify.sh は写し直す
cat > "$hook3" <<'OLD'
#!/bin/sh
set -eu
token="$(git rev-parse --git-dir)/push-ok"
rm -- "$token" 2>/dev/null || exit 1
OLD
(cd repo3 && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2>&1 || true
cmp -s repo3/hooks/pre-push "$hook3" || { echo "旧版の hook を verify.sh が写し直さない" >&2; status=1; }

# hooks/ の無い linked worktree (hooks/pre-push の無い commit と同じ) からも、PUSH_OK 無しの push は止まる
git -C repo worktree add -q --detach ../wt
rm -r wt/hooks
if git -C wt push "$tmp/remote.git" HEAD:refs/heads/wt 2>err5.txt; then
  echo "hooks/ の無い linked worktree から PUSH_OK 無しで push が通った" >&2
  status=1
fi
grep -q PUSH_OK err5.txt || { echo "hooks/ の無い linked worktree の PUSH_OK 無しの push のエラーに PUSH_OK が無い — $(cat err5.txt)" >&2; status=1; }

# main worktree を hooks/pre-push の無い commit に切り替えても、linked worktree からの PUSH_OK 無しの push は止まる
git -C repo checkout -q --detach
git -C repo rm -qf hooks/pre-push
git -C repo commit -q -m 'hooks/pre-push の無い commit'
if git -C wt push "$tmp/remote.git" HEAD:refs/heads/wt 2>err6.txt; then
  echo "main worktree が hooks/pre-push の無い commit のとき、linked worktree から PUSH_OK 無しで push が通った" >&2
  status=1
fi
grep -q PUSH_OK err6.txt || { echo "main worktree が hooks/pre-push の無い commit のときの PUSH_OK 無しの push のエラーに PUSH_OK が無い — $(cat err6.txt)" >&2; status=1; }

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
