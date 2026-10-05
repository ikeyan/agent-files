#!/usr/bin/env bash
# hooks/pre-push と verify.sh を検査する。
# - push のコマンドの PUSH_OK=1 の有無で、push を通す・止める
# - PUSH_OK=1 の push は、hooks/pre-push.local があればそれに同じ引数と stdin で替わる。実行可能な通常のファイルでなければ (実行可能でない・ディレクトリ・壊れた symlink) 止まる
# - 作業ツリーが無い (bare) リポジトリと .git の中からの push は止まる (git 自身のエラーも見える)
# - main worktree と linked worktree、そのサブディレクトリからの push は、その作業ツリーのルートの pre-push.local を呼ぶ
# - verify.sh は hooks/pre-push を common git dir の hooks へ写す (検査に落ちるリポでも)
# - verify.sh を回すリポに scripts/ は無く、shellcheck の版が違っても verify.sh はこの test を呼び返さない
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
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pre-push.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tmp=$(cd "$tmp" && pwd -P)
# 自動 maintenance の背景の gc が、直後の clone や読み取りの最中に loose object を消さないよう止める (canon: facts/git/auto-maintenance-races-local-clone)
printf '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n' > "$tmp/gitconfig"
export GIT_CONFIG_GLOBAL=$tmp/gitconfig GIT_CONFIG_SYSTEM=/dev/null
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

# hooks/pre-push.local は、PUSH_OK=1 の push でだけ同じ引数と stdin で呼ばれ、その終了コードが push の可否になる
mkdir clone/hooks
cat > clone/hooks/pre-push.local <<LOCAL
#!/bin/sh
printf '%s\n' "\$@" > "$tmp/local.args"
cat > "$tmp/local.stdin"
exit "\$(cat "$tmp/local.rc")"
LOCAL
chmod 755 clone/hooks/pre-push.local
echo y > clone/b.txt && git -C clone add b.txt && git -C clone commit -q -m b
echo 0 > local.rc
git -C clone push origin main 2>/dev/null && { echo "pre-push.local があると PUSH_OK 無しで push が通った" >&2; status=1; }
[ ! -e local.args ] || { echo "PUSH_OK 無しの push で pre-push.local が呼ばれた" >&2; status=1; }
echo 1 > local.rc
if PUSH_OK=1 git -C clone push origin main 2>/dev/null; then
  echo "pre-push.local が 1 で終わったのに push が通った" >&2
  status=1
fi
[ "$(cat local.args 2>/dev/null)" = "$(printf 'origin\n%s' "$tmp/remote.git")" ] || { echo "pre-push.local の引数が push の remote 名と URL でない — $(cat local.args 2>/dev/null)" >&2; status=1; }
grep -q "^refs/heads/main $(git -C clone rev-parse HEAD) refs/heads/main " local.stdin 2>/dev/null || { echo "pre-push.local の stdin に push する ref の行が無い — $(cat local.stdin 2>/dev/null)" >&2; status=1; }
[ "$(git -C remote.git rev-parse main)" != "$(git -C clone rev-parse HEAD)" ] || { echo "pre-push.local が 1 で終わったのに remote が進んだ" >&2; status=1; }
echo 0 > local.rc
PUSH_OK=1 git -C clone push -q origin main || { echo "pre-push.local が 0 で終わったのに push が失敗した" >&2; status=1; }
# 実行可能な通常のファイルでない pre-push.local は、無視せず push を止めて示す (検査が黙って外れない)。実行可能にすれば通る
check_bad_local() { # <名前>: PUSH_OK=1 の push が止まり、pre-push.local の問題を示し、remote が進まないこと
  local name=$1
  rm -f local.args
  echo "$name" > "clone/$name.txt" && git -C clone add "$name.txt" && git -C clone commit -q -m "$name"
  if PUSH_OK=1 git -C clone push -q origin main 2>err10.txt; then
    echo "$name: pre-push.local が実行可能な通常のファイルでないのに push が通った" >&2
    status=1
  fi
  grep -q '実行可能な通常のファイルでない' err10.txt || { echo "$name: pre-push.local の問題を示さない — $(cat err10.txt)" >&2; status=1; }
  [ ! -e local.args ] || { echo "$name: 実行可能でない pre-push.local が呼ばれた" >&2; status=1; }
  [ "$(git -C remote.git rev-parse main)" != "$(git -C clone rev-parse HEAD)" ] || { echo "$name: push が止まらず remote が進んだ" >&2; status=1; }
}
chmod 644 clone/hooks/pre-push.local
echo 0 > local.rc
check_bad_local 実行可能でない
chmod 755 clone/hooks/pre-push.local
mv clone/hooks/pre-push.local clone/hooks/real.local
mkdir clone/hooks/pre-push.local
check_bad_local ディレクトリ
rmdir clone/hooks/pre-push.local
ln -s "$tmp/nowhere" clone/hooks/pre-push.local
check_bad_local 壊れた_symlink
rm clone/hooks/pre-push.local
mv clone/hooks/real.local clone/hooks/pre-push.local
PUSH_OK=1 git -C clone push -q origin main || { echo "pre-push.local を実行可能な通常のファイルに戻しても push が止まる" >&2; status=1; }
rm -r clone/hooks

# 作業ツリーが無い (bare リポジトリ) からの push は、pre-push.local を探せないので止まる
git clone -q --bare remote.git bare.git
install -m 755 "$here/hooks/pre-push" bare.git/hooks/pre-push
git init -q -b main --bare remote2.git
if PUSH_OK=1 git -C bare.git push "$tmp/remote2.git" main 2>err11.txt; then
  echo "bare リポジトリから push が通った" >&2
  status=1
fi
grep -q 'bare リポジトリ' err11.txt || { echo "bare リポジトリからの push のエラーに理由が無い — $(cat err11.txt)" >&2; status=1; }
[ -z "$(git -C remote2.git for-each-ref)" ] || { echo "bare リポジトリからの push で remote に ref ができた" >&2; status=1; }

# hook は push を打った場所によらず作業ツリーのルートで走るので、そのルートの hooks/pre-push.local を呼ぶ。linked worktree は main のものを使わない。
# 作業ツリーのルートを得られない .git の中からの push は、git 自身のエラーを隠さず止まる
write_local() { # <dir> <名前>: <dir>/hooks/pre-push.local が、呼ばれたら who に <名前> を書く
  mkdir -p "$1/hooks"
  printf '#!/bin/sh\necho %s > "%s/who"\n' "$2" "$tmp" > "$1/hooks/pre-push.local"
  chmod 755 "$1/hooks/pre-push.local"
}
who_pushes() { # <cwd> <branch>: <cwd> から PUSH_OK=1 で push し、呼ばれた pre-push.local の名前を出す (呼ばれなければ空)
  rm -f who
  (cd "$1" && PUSH_OK=1 git push -q "$tmp/remote.git" "HEAD:refs/heads/$2") || echo "$1 からの push が失敗した" >&2
  cat who 2>/dev/null || true
}
git -C clone worktree add -q --detach ../lwt
mkdir -p clone/sub/deep lwt/sub/deep
write_local clone main
write_local lwt linked
[ "$(who_pushes clone w1)" = main ] || { echo "main worktree のルートからの push が、そのルートの pre-push.local を呼ばない" >&2; status=1; }
[ "$(who_pushes clone/sub/deep w2)" = main ] || { echo "main worktree のサブディレクトリからの push が、そのルートの pre-push.local を呼ばない" >&2; status=1; }
[ "$(who_pushes lwt w3)" = linked ] || { echo "linked worktree のルートからの push が、その worktree の pre-push.local を呼ばない" >&2; status=1; }
[ "$(who_pushes lwt/sub/deep w4)" = linked ] || { echo "linked worktree のサブディレクトリからの push が、その worktree の pre-push.local を呼ばない" >&2; status=1; }
rm lwt/hooks/pre-push.local
[ -z "$(who_pushes lwt w5)" ] || { echo "linked worktree に pre-push.local が無いのに、main のものが呼ばれた" >&2; status=1; }
if (cd clone/.git && PUSH_OK=1 git push "$tmp/remote.git" HEAD:refs/heads/w6) 2>err12.txt; then
  echo ".git の中からの push が通った" >&2
  status=1
fi
grep -q 'must be run in a work tree' err12.txt || { echo ".git の中からの push で git 自身のエラーが見えない — $(cat err12.txt)" >&2; status=1; }
grep -q 'ルートを得られない' err12.txt || { echo ".git の中からの push のエラーに理由が無い — $(cat err12.txt)" >&2; status=1; }
[ -z "$(git -C remote.git for-each-ref refs/heads/w6)" ] || { echo ".git の中からの push で remote に ref ができた" >&2; status=1; }
git -C clone worktree remove --force ../lwt
rm -r clone/hooks clone/sub

# verify.sh は、検査が落ちても hooks/pre-push を common git dir の hooks に写してから落ちる (hook が無い clone から push できる期間を作らない)。
# verify.sh を回すリポは、作業ツリーの verify.sh と hooks/pre-push だけを commit したもの。scripts/ が無いので検査の段は起動できずに落ち、verify.sh はこの test を呼び返さない。VERIFY_READONLY は直さないモードなので、CI から継承した値を外す
verify_repo() { # <dir>: 作業ツリーの verify.sh と hooks/pre-push だけを commit したリポを作る
  git init -q -b main "$1"
  mkdir "$1/hooks"
  cp "$here/verify.sh" "$1/verify.sh"
  cp "$here/hooks/pre-push" "$1/hooks/pre-push"
  git -C "$1" add verify.sh hooks/pre-push
  git -C "$1" commit -q -m init
}
verify_repo repo
hook=$tmp/repo/.git/hooks/pre-push
rm -f "$hook"
if (cd repo && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2>&1; then
  echo "検査の段が落ちるのに verify.sh が通った" >&2
  status=1
fi
if [ ! -x "$hook" ] || ! cmp -s repo/hooks/pre-push "$hook"; then
  echo "検査に落ちた verify.sh が $hook に hooks/pre-push の実行可能な写しを置いていない" >&2
  status=1
fi

# 版の違う shellcheck が先にあっても (その段だけが落ちて残りの段は回る)、verify.sh はこの test を呼び返さない
mkdir old-shellcheck
printf '#!/bin/sh\necho "version: 0.9.0"\n' > old-shellcheck/shellcheck
chmod 755 old-shellcheck/shellcheck
(cd repo && PATH="$tmp/old-shellcheck:$PATH" env -u VERIFY_READONLY ./verify.sh) > /dev/null 2> err13.txt && { echo "shellcheck の版が違うのに verify.sh が通った" >&2; status=1; }
grep -q 'shellcheck の版が 0.9.0 で' err13.txt || { echo "verify.sh が shellcheck の版の違いを示さない — $(cat err13.txt)" >&2; status=1; }
grep -q '^== scripts/test-pre-push.sh: 落ちた (exit 127、' err13.txt || { echo "shellcheck の版が違うとき、verify.sh を回すリポの scripts/test-pre-push.sh の段が起動できずに落ちていない — $(cat err13.txt)" >&2; status=1; }

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
verify_repo repo2
git -C repo2 config core.hooksPath hooks
if (cd repo2 && env -u VERIFY_READONLY ./verify.sh) > /dev/null 2> err7.txt; then
  echo "core.hooksPath が hook をよそへ向けているのに verify.sh が通った" >&2
  status=1
fi
grep -q "local file:.git/config hooks" err7.txt || { echo "core.hooksPath の設定元を verify.sh が示さない — $(cat err7.txt)" >&2; status=1; }
[ "$(git -C repo2 config --get core.hooksPath)" = hooks ] || { echo "verify.sh が core.hooksPath を書き換えた" >&2; status=1; }

exit "$status"
