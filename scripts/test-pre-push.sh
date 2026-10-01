#!/usr/bin/env bash
# hooks/pre-push と verify.sh を検査する。
# - push のコマンドの PUSH_OK=1 の有無で、push を通す・止める
# - verify.sh は hooks/pre-push を common git dir の hooks へ写す (検査に落ちる clone でも)
# - 写す先の pre-push の状態ごとに、写す・何もしない・触らずに落とすのどれかになる
#   - 無い・壊れた symlink: 写す (VERIFY_READONLY=1 では写さずに落ちる)
#   - 現行と同じ実行可能なファイル: 何もしない (この test の最初の push と verify.sh の通常の実行)
#   - それ以外 (旧版、別の hook、PUSH_OK の判定を足した hook、手を入れた写し、同じ中身で実行可能でないもの、ディレクトリ): 触らずに落とす (旧版と別の hook は VERIFY_READONLY=1 でも確かめる)
# - 写しは main worktree の checkout によらず linked worktree の push も止める
# - core.hooksPath が hook をよそへ向けていれば、verify.sh は設定を書かずに落ちる
# verify.sh から呼ぶ。
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
# 作業ツリーの verify.sh と hooks/pre-push を clone に写す。
# どの clone も shellcheck が落ちるファイルを置く: verify.sh は hook の段の後に shellcheck で落ち、後ろの検査 (この test の再帰) を回さない。VERIFY_READONLY は直さないモードなので、CI から継承した値を外す
git clone -q "$here" repo
cp "$here/verify.sh" repo/verify.sh
cp "$here/hooks/pre-push" repo/hooks/pre-push
cat > repo/bad.sh <<'BAD'
#!/bin/bash
if [ $x = y ]; then :; fi
BAD
hook=$tmp/repo/.git/hooks/pre-push
rm -f "$hook"
if (cd repo && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2>&1; then
  echo "shellcheck が落ちるファイルがあるのに verify.sh が通った" >&2
  status=1
fi
if [ ! -x "$hook" ] || ! cmp -s repo/hooks/pre-push "$hook"; then
  echo "検査に落ちた verify.sh が $hook に hooks/pre-push の実行可能な写しを置いていない" >&2
  status=1
fi

# 無いときに VERIFY_READONLY=1 なら、写さずに落として示す
rm -f "$hook"
(cd repo && VERIFY_READONLY=1 ./verify.sh) > /dev/null 2> err4.txt && { echo "VERIFY_READONLY=1 で pre-push が無いのに verify.sh が通った" >&2; status=1; }
grep -q "$hook: hooks/pre-push と同じ実行可能なファイルでない" err4.txt || { echo "VERIFY_READONLY=1 の verify.sh が pre-push が無いことを示さない — $(cat err4.txt)" >&2; status=1; }
[ ! -e "$hook" ] || { echo "VERIFY_READONLY=1 の verify.sh が pre-push を作った" >&2; status=1; }
install -m 755 repo/hooks/pre-push "$hook"

# hooks/pre-push と同じ実行可能なファイルでない pre-push は、verify.sh が上書きせずに落とす (VERIFY_READONLY=1 でも示すだけで触らない)
check_foreign() { # <名前> <モード: normal|readonly>: $hook に置いた内容と実行可能かどうかを verify.sh が変えず、示して落ちること
  local name=$1 mode=$2 x_before=0
  cp "$hook" foreign.orig
  [ ! -x "$hook" ] || x_before=1
  if [ "$mode" = readonly ]; then
    (cd repo && VERIFY_READONLY=1 ./verify.sh) > /dev/null 2> err8.txt && { echo "$name ($mode): 同じ実行可能なファイルでない pre-push があるのに verify.sh が通った" >&2; status=1; }
  else
    (cd repo && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2> err8.txt && { echo "$name ($mode): 同じ実行可能なファイルでない pre-push があるのに verify.sh が通った" >&2; status=1; }
  fi
  grep -q "hooks/pre-push と同じ実行可能なファイルでない (上書きしない)" err8.txt || { echo "$name ($mode): 他の pre-push を verify.sh が示さない — $(cat err8.txt)" >&2; status=1; }
  cmp -s foreign.orig "$hook" || { echo "$name ($mode): verify.sh が他の pre-push を書き換えた" >&2; status=1; }
  { [ -x "$hook" ] && [ "$x_before" = 1 ]; } || { [ ! -x "$hook" ] && [ "$x_before" = 0 ]; } || { echo "$name ($mode): verify.sh が pre-push の実行可能かどうかを変えた" >&2; status=1; }
}
cat > "$hook" <<'OLD'
#!/bin/sh
# push を、$(git rev-parse --git-dir)/push-ok がある 1 回だけ通し、通したら消す。token は pr-workflow の push の手順で作る (レビュアーなどの push を止めるため)。token は worktree ごと (git rev-parse --git-dir の下) で、main checkout の token では linked worktree の push は通らない。
# git が呼ぶのは verify.sh が $GIT_COMMON_DIR/hooks (全 worktree で共有) に写した写しで、このファイルではない。githooks(5) の pre-push: push の前に呼ばれ、非 0 で終わると git push は何も push せずに止まる。
set -eu
token="$(git rev-parse --git-dir)/push-ok"
rm -- "$token" 2>/dev/null || {
  echo "pre-push: $token が無い。push は pr-workflow の手順で行う (touch \"$token\" してから push)" >&2
  exit 1
}
OLD
chmod 755 "$hook"
check_foreign '旧版の hook' normal
check_foreign '旧版の hook' readonly
printf '#!/bin/sh\nexec ./scripts/lint\n' > "$hook"
chmod 755 "$hook"
check_foreign '別の hook' normal
check_foreign '別の hook' readonly
cat > "$hook" <<'USER'
#!/bin/sh
[ "${PUSH_OK:-}" = 1 ] || exit 1
exec ./scripts/lint
USER
check_foreign 'PUSH_OK の判定を足した利用者の hook' normal
cp repo/hooks/pre-push "$hook"
printf 'echo extra\n' >> "$hook"
check_foreign '現行版に手を入れた写し' normal
cp repo/hooks/pre-push "$hook"
chmod 644 "$hook"
check_foreign '現行版と同じ中身で実行可能でない写し' normal
[ ! -x "$hook" ] || { echo "実行可能でない写しを verify.sh が実行可能にした" >&2; status=1; }
rm -f "$hook"
mkdir "$hook"
(cd repo && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2> err9.txt && { echo "ディレクトリの pre-push があるのに verify.sh が通った" >&2; status=1; }
grep -q "hooks/pre-push と同じ実行可能なファイルでない (上書きしない)" err9.txt || { echo "ディレクトリの pre-push を verify.sh が示さない — $(cat err9.txt)" >&2; status=1; }
{ [ -d "$hook" ] && [ ! -e "$hook/pre-push" ]; } || { echo "ディレクトリの pre-push を verify.sh が置き換えた、または中に書いた" >&2; status=1; }
rmdir "$hook"

# 壊れた symlink は無いものとして扱う。置き換えか書き通しかでなく、実行可能な写しが残ることを見る
ln -s "$tmp/nowhere" "$hook"
(cd repo && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2>&1 || true
{ [ -x "$hook" ] && cmp -s repo/hooks/pre-push "$hook"; } || { echo "壊れた symlink の pre-push を verify.sh が実行可能な写しにしない" >&2; status=1; }
rm -f "$hook" "$tmp/nowhere"
install -m 755 repo/hooks/pre-push "$hook"

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
