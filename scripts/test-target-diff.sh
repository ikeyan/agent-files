#!/usr/bin/env bash
# skills/review-perspectives/target-diff.sh を、その先頭が受け付けると宣言する環境の形ごとに一時リポで実行し、出力を検査する。verify.sh から呼ぶ。
# PR 番号 (gh が要る) は回さない。
set -euo pipefail
script=$(cd "$(dirname "$0")/.." && pwd)/skills/review-perspectives/target-diff.sh
tmp=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/target-diff.XXXXXX")" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
status=0

commit() { # <ファイル名>: そのファイルを作ってコミットする
  echo "$1" > "$1" && git add -- "$1" && git commit -q -m "$1"
}
run() { # <実行するディレクトリ> [<対象>] [-- <path>...]: スクリプトを回し、出力を $out に、diff を $diff に置く。止まったら違反
  local dir=$1; shift
  out=$(cd "$dir" && "${bash:-bash}" "$script" "$@") || { echo "run $dir $*: 止まった" >&2; status=1; return 1; }
  [ "$(grep -c -v -E '^(work|run|repo|diff|tree)=' <<< "$out")" = 0 ] || { echo "run $dir $*: 出力に形式外の行がある — $out" >&2; status=1; }
  tree=$(sed -n 's/^tree=//p' <<< "$out")
  diff=$(sed -n 's/^diff=//p' <<< "$out")
  repo=$(sed -n 's/^repo=//p' <<< "$out")
}
fails() { # <名前> <実行するディレクトリ> [<対象>] [-- <path>...]: スクリプトが止まることを期待する
  local name=$1 dir=$2; shift 2
  if (cd "$dir" && "$script" "$@") >/dev/null 2>&1; then echo "$name: 止まらない" >&2; status=1; fi
}
expect() { # <名前> <期待するパス (空白区切り)> <期待するコミットの件名 (空白区切り)>: $diff の内容を照合する
  local paths commits
  paths=$(sed -n 's|^diff --git a/\(.*\) b/.*|\1|p' "$diff" | sort | tr '\n' ' ')
  commits=$(awk '/^commit /{getline; getline; print}' "$diff" | sort | tr '\n' ' ')
  [ "$paths" = "${2:+$2 }" ] || { echo "$1: diff のパスが違う — 期待 [$2] 実際 [$paths]" >&2; status=1; }
  [ "$commits" = "${3:+$3 }" ] || { echo "$1: コミットが違う — 期待 [$3] 実際 [$commits]" >&2; status=1; }
}

# 履歴: main は c1 → c2 → M (topic の t1・t2 を --no-ff でマージ) → ff1 → ff2 (ff を fast-forward でマージ)。stacked は topic から s1。remote-only は main から r1。
cd "$tmp"
git init -q -b main src && cd src
commit a.txt && commit b.txt
git checkout -q -b topic && commit t1.txt && commit t2.txt
git checkout -q -b stacked && commit s1.txt
git checkout -q main && git merge -q --no-ff -m M topic
git checkout -q -b ff && commit ff1.txt && commit ff2.txt && git checkout -q main && git merge -q --ff-only ff
git checkout -q -b remote-only && commit r1.txt && git checkout -q main
cd "$tmp" && git clone -q --bare src origin.git && git clone -q origin.git clone
root=$(git -C clone rev-list --max-parents=0 origin/main)
merge=$(git -C clone rev-list --merges --max-count=1 origin/main)

# 今のチェックアウト: ブランチのコミット、未コミットの変更、未追跡の全種 (- 始まり、リンク、入れ子のリポジトリ、サブディレクトリ)
cd clone
git checkout -q -b local-only && commit l1.txt && git checkout -q main
git checkout -q -b feature && commit f1.txt
echo changed > a.txt
echo x > ./--stat
mkdir sub && echo u > sub/u.txt && ln -s sub linkdir && echo b > "sub/[b].txt" && echo c > ":c.txt"
git init -q nested && git -C nested commit -q --allow-empty -m n
run . && expect "今のチェックアウト" "--stat :c.txt a.txt f1.txt linkdir nested sub/[b].txt sub/u.txt" "f1.txt"
grep -q '^new file mode 120000' "$diff" || { echo "今のチェックアウト: リンクが 120000 で出ない" >&2; status=1; }
grep -q '^+Subproject commit' "$diff" || { echo "今のチェックアウト: 入れ子のリポジトリが gitlink で出ない" >&2; status=1; }
git diff --cached --quiet || { echo "今のチェックアウト: 本来の index が変わった" >&2; status=1; }
run . -- sub && expect "path (ディレクトリ)" "sub/[b].txt sub/u.txt" ""
t1=$tree && echo v > sub/v.txt && run . -- sub && [ "$tree" != "$t1" ] || { echo "tree: 未追跡ファイルの追加で変わらない" >&2; status=1; }
t1=$tree && echo w > sub/v.txt && run . -- sub && [ "$tree" != "$t1" ] || { echo "tree: 内容の変更で変わらない" >&2; status=1; }
rm sub/v.txt
run . -- "sub/[b].txt" :c.txt && expect "path (pathspec の記号を含む名前)" ":c.txt sub/[b].txt" ""

# linked worktree の中から (detached なので名前は短い id)
git worktree add -q --detach "$tmp/lw" feature
run "$tmp/lw" && expect "linked worktree" "f1.txt" "f1.txt"
case $diff in "$tmp/clone/.git/"*) ;; *) echo "linked worktree: 作業ディレクトリが本体の .git の下でない — $diff" >&2; status=1 ;; esac

# 同じ対象を並行して回しても生成物は別
run . -- sub && first=$diff && run . -- a.txt
if [ "$first" = "$diff" ] || ! grep -q 'sub/u.txt' "$first" || grep -q 'a.txt' "$first"; then echo "並行実行: 生成物を共有している" >&2; status=1; fi

# 対象の指定: 手元だけのブランチ、リモートだけのブランチ、マージ済みの topic、topic から積んだブランチ、merge commit、root commit、fast-forward でマージ済みのブランチ (最後の 1 コミットだけ)
run . local-only && expect "手元だけのブランチ" "l1.txt" "l1.txt"
run . remote-only && expect "リモートだけのブランチ" "r1.txt" "r1.txt"
run . topic && expect "マージ済みの topic" "t1.txt t2.txt" "t1.txt t2.txt"
run . stacked && expect "topic から積んだブランチ" "s1.txt" "s1.txt"
run . "$merge" && expect "merge commit" "t1.txt t2.txt" "M t1.txt t2.txt"
[ "$(git -C "$repo" rev-parse HEAD)" = "$merge" ] || { echo "merge commit: repo が対象を指していない" >&2; status=1; }
run . "$merge" && expect "同じ対象の 2 回目" "t1.txt t2.txt" "M t1.txt t2.txt"
run . "$root" && expect "root commit" "a.txt" "a.txt"
run . origin/ff && expect "fast-forward でマージ済みのブランチ" "ff2.txt" "ff2.txt"

# clone の形: --single-branch、shallow
cd "$tmp"
git clone -q --single-branch --branch stacked origin.git single
run single && expect "--single-branch" "s1.txt" "s1.txt"
git clone -q --depth 1 --branch stacked "file://$tmp/origin.git" shallow
run shallow && expect "shallow" "s1.txt" "s1.txt"

# unborn HEAD (initial commit の前、origin はある)
git init -q -b fresh unborn && git -C unborn remote add origin "$tmp/origin.git" && echo x > unborn/x.txt
run unborn && expect "unborn HEAD" "x.txt" ""

# 空の対象では止まる (一致しない pathspec)。対象を指定して止まったときは worktree を残さない
fails "一致しない path" clone -- no-such-dir
trees=$(git -C clone worktree list | wc -l)
fails "一致しない path (対象あり)" clone topic -- no-such-dir
[ "$(git -C clone worktree list | wc -l)" = "$trees" ] || { echo "止まったのに worktree が残る" >&2; status=1; }

# macOS 標準の bash 3.2 でも同じ (pathspec 無しの空配列の展開)
if [ -x /bin/bash ]; then bash=/bin/bash run clone && expect "bash 3.2" "--stat :c.txt a.txt f1.txt linkdir nested sub/[b].txt sub/u.txt" "f1.txt"; fi

# コミットが打ち消し合って patch が空なら止まる
git -C clone checkout -q -b cancel origin/main && (cd clone && commit z.txt && git rm -q z.txt && git commit -qm "rm z.txt")
fails "打ち消し合うコミット" clone cancel

# origin の HEAD が既定ブランチを指していなければ止まる
git clone -q --bare src badhead.git && git -C badhead.git symbolic-ref HEAD refs/heads/gone && git clone -q -b main badhead.git badhead
fails "origin の HEAD が無い" badhead

# path に指定したファイルがコミットで削除されている
git -C clone checkout -q -b del origin/main && git -C clone rm -qf a.txt && git -C clone commit -qm "rm a.txt"
run clone del -- a.txt && expect "path (削除されたファイル)" "a.txt" "rm a.txt"

# origin から消えたブランチは対象に解決しない
git -C origin.git branch -q -D remote-only
fails "消えたリモートブランチ" clone remote-only

# origin が無ければ止まる
git init -q -b main noorigin && (cd noorigin && commit a.txt)
fails "origin 無し" noorigin

exit "$status"
