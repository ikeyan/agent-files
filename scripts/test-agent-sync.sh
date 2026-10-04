#!/usr/bin/env bash
# skills/setup-repo/agent-sync/sync.sh を、このリポの catalog (作業ツリーのもの) から作った手元の上流と、下流のリポを相手に回す。verify.sh から呼ぶ。
# - 初回: 部品の一覧のファイルを、上流と同じバイトと一覧の mode で置く。一覧の mode は上流の git の mode と同じ。手で写した sync.sh と render.sb は同じバイトなので引き取る。下流の archetype が描画したファイルも置く。
# - 2 回目は何も変えず、mode のずれと消したファイルは戻す
# - 上流の更新 (v1 → v2): 変わったファイルを置き直し、一覧から消えたファイルを消す (ディレクトリは消さず、利用者の空のディレクトリが残る)
# - 作業ツリーを変えずに落ちる (理由も見る): 引数 (exit 2)、入力ファイルの欠け、archetype.yaml の source の行の定義域、generated の定義域・順序・古いパスの種類、answers の欠け、置き先の重複 (別の置き先の親のディレクトリを含む)、置き先の .agent-sync/ の下、一覧の行が定義域の外 (上流のパスの symlink、置き先の途中の symlink を含む)、一覧と描画の不一致、描画の出力のファイル名に改行、描画が .agent-sync/sync.sh を置かない、利用者のファイル、置き先・古いパスの綴り (途中のディレクトリを含む) が既存のものと大文字小文字だけ違う・KELVIN SIGN など Unicode で同じものに当たる、上流の tree が同じものに当たる別のパスを持つ (NFC と NFD を含む) (一時ディレクトリが大文字小文字を区別しないときだけ。区別するときは別のファイルとして通ることを見る。上流の大文字小文字だけの改名は、古い綴りを消すまで前回の出力だと示して落ちる)、途中のディレクトリの一覧が取れない (root では飛ばす)、置き先のディレクトリの綴りが大文字小文字だけ違う、生成物の同一性の表の落ちる行 (commit 済みの利用者の編集を含む)、ロックが取られている、別のリポの sync.sh の起動、TMPDIR の文字と絶対パス、上流のパスの大文字小文字の衝突、fetch の GIT_TERMINAL_PROMPT、archetect の版、対応していない OS、OS の sandbox を適用できない・描画が非 0 で終わる、リポジトリの場所を決める GIT_* (`git rev-parse --local-env-vars` の各変数)
# - 環境: awk が正規表現の区間を持たなくても通る。GIT_CONFIG* は通る (この test 自身が GIT_CONFIG_COUNT で上流へ向ける)。core.autocrlf・core.eol を変えても、置くバイトは上流の blob と同じ。UTF-8 の locale (LANG・LC_ALL) でも通り、文字の分類 (タブ・制御文字・空白・shell の特殊文字・é・あ・ｚ。canon: facts/shell/string-input-categories) ごとに、置き先・source の名前・TMPDIR の定義域の外として落ちる
# - 標準出力は git status --short と同じ。終わった (落ちた) 後にロックが残らない
# OS の sandbox を適用できない環境 (別の sandbox の中など) では、最初の実際の描画 (初回) が sync.sh の固定の文言「OS の sandbox を適用できない」で落ちる。そのとき、描画を伴う残りの検査を飛ばしたことを理由と一緒に stderr に出す。CI (環境変数 CI が空でない) では落とす。
# それ以外では archetect と、macOS では sandbox-exec と otool、Linux では bwrap と ldd が要り、無ければ落ちる。
# ネットワークは使わない (上流は file システムの上のリポで、sync.sh が取る URL を git の insteadOf で向ける)。
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/agent-sync-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tmp=$(cd "$tmp" && pwd -P)
url=https://github.com/ikeyan/agent-files.git
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.$tmp/upstream.insteadOf" GIT_CONFIG_VALUE_0=$url
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export TMPDIR=$tmp
# hook や rebase --exec から呼ばれても、この test の git が呼び出し元のリポジトリを使わない
for v in $(git rev-parse --local-env-vars); do
  case $v in GIT_CONFIG | GIT_CONFIG_PARAMETERS | GIT_CONFIG_COUNT) ;; *) unset "$v" ;; esac
done
status=0
cd "$tmp"
# 一時ディレクトリのファイルシステムが大文字小文字を区別しないか (macOS の APFS の既定)。検査の環境の選択で、sync.sh の挙動の分岐ではない。
: >CaseProbe
if [ -e caseprobe ]; then ci_fs=1; else ci_fs=0; fi
rm CaseProbe

copy_tracked() { # <元> <先> <パス…>: 元の作業ツリーの、追跡しているか無視されていないファイルを先へ写す
  local from=$1 to=$2 p
  shift 2
  git -C "$from" ls-files -z -c -o --exclude-standard -- "$@" | while IFS= read -r -d '' p; do
    [ -e "$from/$p" ] || [ -L "$from/$p" ] || continue
    mkdir -p "$to/$(dirname "$p")"
    cp -P "$from/$p" "$to/$p"
  done
}

make_ds() { # <名前> <上流の sha>: 手で sync.sh と render.sb を写した下流のリポを作る
  local d=$tmp/$1
  git init -q -b main "$d"
  mkdir -p "$d/.agent-sync/archetype/content/.agent-sync/files" "$d/hooks"
  printf 'description: test downstream\ncatalog:\n  agent-files:\n    source: %s#%s\n' "$url" "$2" >"$d/.agent-sync/archetype/archetype.yaml"
  cat >"$d/.agent-sync/archetype/archetype.lua" <<'LUA'
local context = Context.new()
context:prompt_text("Project:", "project")
directory.render("content", context, { if_exists = Existing.Error })
context:merge(catalog.render("agent-files/agent-sync", context))
context:merge(catalog.render("agent-files/pre-push", context))
context:merge(catalog.render("agent-files/pr-workflow", context))
return context
LUA
  printf 'project {{ project }}\n' >"$d/.agent-sync/archetype/content/NOTICE.txt"
  printf -- '-\tNOTICE.txt\t644\n' >"$d/.agent-sync/archetype/content/.agent-sync/files/local"
  printf 'project: demo\n' >"$d/.agent-sync/answers.yaml"
  : >"$d/.agent-sync/generated"
  cp "$here/skills/setup-repo/agent-sync/sync.sh" "$here/skills/setup-repo/agent-sync/render.sb" "$d/.agent-sync/"
  printf '#!/bin/sh\nexit 0\n' >"$d/hooks/pre-push.local"
  chmod 755 "$d/hooks/pre-push.local"
  printf '.env\n' >"$d/.gitignore"
  printf 'secret\n' >"$d/.env"
  git -C "$d" add -A
  git -C "$d" commit -q -m init
}

snapshot() { # <dir>: .git の外の全てのファイルの種類・実行可能か・中身
  (cd "$1" && { find . -name .git -prune -o \( -type f -o -type l \) -print 2>/dev/null || true; } | LC_ALL=C sort | while IFS= read -r f; do
    if [ -L "$f" ]; then
      echo "L $f $(readlink "$f")"
    elif [ -x "$f" ]; then
      echo "x $f $(cksum <"$f")"
    else
      echo "- $f $(cksum <"$f")"
    fi
  done)
}

expect_fail() { # <名前> <dir> <stderr に含まれる文字列> [<環境変数の代入…>]: sync.sh が落ち、作業ツリーを変えず、理由を示す
  local name=$1 d=$2 want=$3 before had=0
  shift 3
  before=$(snapshot "$d")
  [ ! -e "$d/.git/agent-sync.lock" ] || had=1
  if (cd "$d" && env "$@" ./.agent-sync/sync.sh) >/dev/null 2>"$tmp/err.txt"; then
    echo "$name: sync.sh が通った" >&2
    status=1
  fi
  [ "$(snapshot "$d")" = "$before" ] || { echo "$name: 落ちた sync.sh が作業ツリーを変えた" >&2; status=1; }
  [ -e "$d/.git/agent-sync.lock" ] && [ "$had" = 0 ] && { echo "$name: 落ちた sync.sh がロックを残した" >&2; status=1; }
  [ -e "$d/.git/agent-sync.lock" ] || [ "$had" = 0 ] || { echo "$name: 他の起動のロックを消した" >&2; status=1; }
  grep -qF -- "$want" "$tmp/err.txt" || { echo "$name: stderr に「$want」が無い — $(cat "$tmp/err.txt")" >&2; status=1; }
}

sync_ok() { # <名前> <dir> [<環境変数の代入…>]: 通り、標準出力が git status --short と同じで、ロックを残さない
  (cd "$2" && env "${@:3}" ./.agent-sync/sync.sh) >"$tmp/out.txt" 2>"$tmp/err.txt" || { echo "$1: sync.sh が落ちた — $(cat "$tmp/err.txt")" >&2; status=1; }
  [ "$(cat "$tmp/out.txt")" = "$(git -C "$2" status --short)" ] || { echo "$1: 標準出力が git status --short と違う — $(cat "$tmp/out.txt")" >&2; status=1; }
  [ ! -e "$2/.git/agent-sync.lock" ] || { echo "$1: ロックが残った" >&2; status=1; }
}

clean() { # <名前> <dir>: 作業ツリーが commit と同じ
  [ -z "$(git -C "$2" status --porcelain)" ] || { echo "$1: 作業ツリーが変わった — $(git -C "$2" status --porcelain)" >&2; status=1; }
}

case $(uname -s) in
Darwin) tools="archetect sandbox-exec otool" ;;
Linux) tools="archetect bwrap ldd" ;;
*) tools="archetect unsupported-os-$(uname -s)" ;;
esac
for t in $tools; do
  command -v "$t" >/dev/null || { echo "test-agent-sync.sh: $t が PATH に無い (AGENTS.md「このリポの検証」の必要なもの)" >&2; exit 1; }
done

# 上流: このリポの作業ツリーの catalog と、一覧が指すファイルに、sandbox の外へ出ようとする検査用の部品 probe を足したもの
mkdir upstream outside
copy_tracked "$here" upstream archetype.yaml components hooks skills/setup-repo
printf 'secret\n' >secret.txt
printf '  probe:\n    source: ./components/probe\n' >>upstream/archetype.yaml
mkdir -p upstream/components/probe/content/.agent-sync/files
printf 'description: probe\n' >upstream/components/probe/archetype.yaml
cat >upstream/components/probe/archetype.lua <<LUA
local context = Context.new()
print("lua-stdout")
local results = {}
local function try(name, f)
  local ok, r = pcall(f)
  results[#results + 1] = name .. ": " .. tostring(ok and r)
end
try("write-outside", function()
  local h = io.open("$tmp/outside/written", "w")
  if h then h:write("x"); h:close(); return "written" end
end)
try("read-outside", function()
  local h = io.open("$tmp/secret.txt")
  if h then local s = h:read("a"); h:close(); return s end
end)
try("os.execute", function() return os.execute("/usr/bin/touch $tmp/outside/executed") end)
try("io.popen", function()
  local h = io.popen("/usr/bin/id")
  if h then local s = h:read("a"); h:close(); if s ~= "" then return s end end
end)
context:set("results", table.concat(results, "\\n"))
directory.render("content", context, { if_exists = Existing.Error })
return context
LUA
printf '{{ results }}\n' >upstream/components/probe/content/probe.txt
printf -- '-\tprobe.txt\t644\n' >upstream/components/probe/content/.agent-sync/files/probe
ln -s pre-push upstream/hooks/link
ln -s hooks upstream/hlink
git -C upstream init -q -b main
git -C upstream add -A
git -C upstream commit -q -m v1
v1=$(git -C upstream rev-parse HEAD)
lists=$(cd upstream && find components -type f -path '*/content/.agent-sync/files/*' ! -path 'components/probe/*' | LC_ALL=C sort)
[ -n "$lists" ] || { echo "上流に部品の一覧が無い" >&2; exit 1; }

# OS の sandbox を適用できなければ、固定の文言で落ちる (sandbox-exec・bwrap を、対象を起動する前に失敗する起動側の出力と終了状態の shim に替える)。文言の無い非 0 は、描画の失敗として落ちる
mkdir shim-sb shim-sb-plain
printf '#!/bin/sh\necho "sandbox-exec: sandbox_apply: Operation not permitted" >&2\nexit 71\n' >shim-sb/sandbox-exec
printf '#!/bin/sh\necho "bwrap: No permissions to create new namespace" >&2\nexit 1\n' >shim-sb/bwrap
printf '#!/bin/sh\nexit 71\n' >shim-sb-plain/sandbox-exec
printf '#!/bin/sh\nexit 1\n' >shim-sb-plain/bwrap
chmod 755 shim-sb/sandbox-exec shim-sb/bwrap shim-sb-plain/sandbox-exec shim-sb-plain/bwrap
no_sandbox_msg='agent-sync: OS の sandbox を適用できない'
make_ds nosb "$v1"
expect_fail 'OS の sandbox を適用できない' nosb "$no_sandbox_msg" "PATH=$tmp/shim-sb:$PATH"
expect_fail '文言の無い起動側の失敗は描画の失敗' nosb '描画が exit' "PATH=$tmp/shim-sb-plain:$PATH"
! grep -qF "$no_sandbox_msg" "$tmp/err.txt" || { echo '文言の無い起動側の失敗が、OS の sandbox を適用できないとされた' >&2; status=1; }
# 起動コマンドだけが無い PATH (sync.sh が他に使うコマンドは残す)
mkdir shim-nolauncher
IFS=: read -ra path_dirs <<<"$PATH"
for d in "${path_dirs[@]}"; do
  for f in "$d"/*; do
    { [ -f "$f" ] && [ -x "$f" ]; } || continue
    case ${f##*/} in sandbox-exec | bwrap) continue ;; esac
    ln -s "$f" "shim-nolauncher/${f##*/}" 2>/dev/null || true
  done
done
expect_fail '起動コマンドが PATH に無い' nosb '描画を起動できない' "PATH=$tmp/shim-nolauncher"
! grep -qF "$no_sandbox_msg" "$tmp/err.txt" || { echo '起動コマンドが無い失敗が、OS の sandbox を適用できないとされた' >&2; status=1; }
loc=
avail=$(locale -a)
for l in en_US.UTF-8 en_US.utf8 ja_JP.UTF-8 ja_JP.utf8 C.UTF-8 C.utf8; do
  if grep -qix "$l" <<<"$avail"; then loc=$l; break; fi
done
[ -n "$loc" ] || echo "test-agent-sync.sh: UTF-8 の locale が無いので、locale の検査を飛ばした" >&2

# 上流の tree が、ファイルシステムの同じものに当たる別のパスを持てば、何も残さず落ちる (macOS の APFS の既定のように大文字小文字と Unicode の正規化を同一視するファイルシステムでは、後の blob が先のものを上書きする)。綴りの規則を再現せず、置く前に在るかをファイルシステムに聞くので、KELVIN SIGN (U+212A) の K と ASCII の K、NFC と NFD の é も落ちる。
# macOS の作業ツリーでは両方を置けないので、git のオブジェクトを直接作る。どの ref からも届かない commit を sha で取る。区別するファイルシステムでは別のパスとして置かれるので、衝突の fixture は同一視するときだけ。
blob_a=$(printf 'a\n' | git -C upstream hash-object -w --stdin)
blob_b=$(printf 'b\n' | git -C upstream hash-object -w --stdin)
kelvin=$(printf '\xe2\x84\xaa')
nfc=$(printf '\xc3\xa9')
nfd=$(printf 'e\xcc\x81')
tree_commit() { # <名前> <mktree の入力>: 入力の tree の commit を作る
  printf '%s' "$2" | git -C upstream mktree | xargs -I{} git -C upstream commit-tree {} -m "$1"
}
two_files() { # <x の下の 1 つ目の名前> <2 つ目の名前>: 中身の違う 2 つのファイルを x の下に持つ tree の入力
  printf '040000 tree %s\tx\n' "$(printf '100644 blob %s\t%s\n100644 blob %s\t%s\n' "$blob_a" "$1" "$blob_b" "$2" | git -C upstream mktree)"
}
sub_dir=$(printf '100644 blob %s\tx\n' "$blob_b" | git -C upstream mktree)
c_nl=$(printf '100644 blob %s\ta\nb\0' "$blob_a" | git -C upstream mktree -z | xargs -I{} git -C upstream commit-tree {} -m newline)
collisions="newline|$c_nl|に改行がある"
if [ "$ci_fs" = 1 ]; then
  c_file=$(tree_commit file-file "$(two_files README.md readme.md)")
  c_dir=$(tree_commit file-dir "$(printf '100644 blob %s\tFoo\n040000 tree %s\tfoo\n' "$blob_a" "$sub_dir")")
  c_dir_first=$(tree_commit dir-file "$(printf '040000 tree %s\tFoo\n100644 blob %s\tfoo\n' "$sub_dir" "$blob_a")")
  c_kelvin=$(tree_commit kelvin "$(two_files K.txt "$kelvin.txt")")
  c_norm=$(tree_commit nfc-nfd "$(two_files "$nfc.txt" "$nfd.txt")")
  collisions="file-file|$c_file|上流のパス x/readme.md がファイルシステム上で別のパスと同じものに当たる
file-dir|$c_dir|の親のディレクトリを作れない
dir-file|$c_dir_first|上流のパス foo がファイルシステム上で別のパスと同じものに当たる
kelvin|$c_kelvin|がファイルシステム上で別のパスと同じものに当たる
nfc-nfd|$c_norm|がファイルシステム上で別のパスと同じものに当たる
$collisions"
fi
while IFS='|' read -r cname csha cwant; do
  make_ds collide "$csha"
  expect_fail "上流のパスの衝突 $cname" collide "$cwant"
  rm -rf collide
done <<<"$collisions"
# fetch は GIT_TERMINAL_PROMPT=0 で呼ばれる (環境に GIT_TERMINAL_PROMPT=1 があっても。排他を握ったまま端末で資格情報を待たない)。git を、fetch のときの環境変数を記録する shim に替える
mkdir shim-git
cat >shim-git/git <<SHIM
#!/bin/sh
for a in "\$@"; do
  [ "\$a" = fetch ] && echo "\${GIT_TERMINAL_PROMPT-unset}" >>"$tmp/fetch-prompt.txt"
done
exec "$(command -v git)" "\$@"
SHIM
chmod 755 shim-git/git
make_ds prompt "$v1"
expect_fail 'fetch の GIT_TERMINAL_PROMPT' prompt 'OS の sandbox を適用できない' "PATH=$tmp/shim-git:$tmp/shim-sb:$PATH" GIT_TERMINAL_PROMPT=1
[ "$(cat "$tmp/fetch-prompt.txt" 2>/dev/null)" = 0 ] || { echo "fetch の GIT_TERMINAL_PROMPT が 0 でない — $(cat "$tmp/fetch-prompt.txt" 2>/dev/null)" >&2; status=1; }

# TMPDIR は絶対パス。相対パスなら、作業ディレクトリが cwd (リポの中) にできる前に落ちる
expect_fail 'TMPDIR が相対パス' prompt '絶対パスでない' TMPDIR=.
expect_fail 'TMPDIR が相対パス (ディレクトリ名)' prompt '絶対パスでない' TMPDIR=sub/dir

# 初回。最初の実際の描画が OS の sandbox を適用できずに落ちたとき、CI (CI が空でない) なら落とし、そうでなければ描画を伴う残りの検査を飛ばす。
# 外せる条件: Claude Code の sandbox の中でも入れ子の sandbox-exec が通るようになれば、この分岐は動かない。分岐ごと消す。
make_ds ds "$v1"
status_before=$status
sync_ok 初回 ds
if grep -qF "$no_sandbox_msg" "$tmp/err.txt"; then
  if [ -n "${CI:-}" ]; then
    echo "test-agent-sync.sh: CI で OS の sandbox を適用できない — $(cat "$tmp/err.txt")" >&2
    exit 1
  fi
  echo "test-agent-sync.sh: 初回の描画で OS の sandbox を適用できなかった ($(tail -n 3 "$tmp/err.txt" | tr '\n' ' ')) ので、描画を伴う残りの検査を飛ばした。適用できる環境 (別の sandbox の外や CI) で回すと全部を検査する" >&2
  exit "$status_before"
fi
check_placed() { # <名前> <dir> <上流の rev>: 一覧のファイルが、その rev の blob と同じバイトと一覧の mode で置かれている
  local list from dest mode want_mode
  for list in $lists; do
    while IFS=$'\t' read -r from dest mode; do
      want_mode=$(git -C upstream ls-tree "$3" -- "$from" | cut -c1-6)
      [ "$want_mode" = "100$mode" ] || { echo "$list: $from の mode $mode が上流の git の mode ($want_mode) と違う" >&2; status=1; }
      git -C upstream cat-file blob "$3:$from" | cmp -s - "$2/$dest" || { echo "$1: $2/$dest が上流の $from と違う" >&2; status=1; }
      if [ "$mode" = 755 ]; then [ -x "$2/$dest" ]; else [ ! -x "$2/$dest" ]; fi || { echo "$1: $2/$dest の mode が $mode でない" >&2; status=1; }
    done < <(git -C upstream show "$3:$list")
  done
}
check_placed 初回 ds "$v1"
[ "$(cat ds/NOTICE.txt 2>/dev/null)" = "project demo" ] || { echo "初回: 下流の archetype が描画した NOTICE.txt が違う" >&2; status=1; }
# generated は <置き先><TAB><置いたバイトの id>。上流のバイトの id と、下流が描画した NOTICE.txt のバイトの id
want_generated=$({
  for list in $lists; do
    while IFS=$'\t' read -r from dest mode; do printf '%s\t%s\n' "$dest" "$(git hash-object --no-filters "upstream/$from")"; done <"upstream/$list"
  done
  printf 'NOTICE.txt\t%s\n' "$(printf 'project demo\n' | git hash-object --stdin)"
} | LC_ALL=C sort)
[ "$(cat ds/.agent-sync/generated)" = "$want_generated" ] || { echo "初回: generated が <置き先><TAB><id> の一覧でない — $(cat ds/.agent-sync/generated)" >&2; status=1; }
[ -z "$(git -C ds status --porcelain -- .agent-sync/sync.sh .agent-sync/render.sb .env hooks/pre-push.local)" ] || { echo "初回: 手で写した sync.sh・render.sb か、下流のファイルが変わった" >&2; status=1; }
[ ! -e ds/.agent-sync/files ] || { echo "初回: 一覧そのものを作業ツリーに置いた" >&2; status=1; }
first_snap=$(snapshot ds)
git -C ds add -A
git -C ds commit -q -m sync

sync_ok 2回目 ds
clean 2回目 ds
# awk が正規表現の区間 {n} を持たなくても (mawk 1.3.4-20200724 より前。canon: facts/shell/awk-interval-expressions) 通る。区間を含むプログラムを拒む awk の shim で回す
mkdir shim-awk
cat >shim-awk/awk <<SHIM
#!/bin/sh
for a in "\$@"; do
  if printf '%s\n' "\$a" | grep -qE '[]a-z0-9)]\{[0-9]+(,[0-9]*)?\}'; then echo "awk: 区間表現を含むプログラム" >&2; exit 2; fi
done
exec "$(command -v awk)" "\$@"
SHIM
chmod 755 shim-awk/awk
sync_ok 'awk が区間を持たない' ds "PATH=$tmp/shim-awk:$PATH"
clean 'awk が区間を持たない' ds
[ -z "$loc" ] || { sync_ok "locale $loc" ds LC_ALL="$loc" LANG="$loc"; clean "locale $loc" ds; }
chmod 644 ds/hooks/pre-push
chmod 755 ds/.claude/skills/pr-workflow/SKILL.md
rm ds/.claude/skills/pr-workflow/gh.md
sync_ok 'mode のずれと消したファイル' ds
clean 'mode のずれと消したファイル' ds

# 失敗して作業ツリーを変えない。一覧の行は下流の一覧に足す (作業ツリーの archetype を描画に渡す)
local_list=ds/.agent-sync/archetype/content/.agent-sync/files/local
cp ds/.agent-sync/answers.yaml answers.orig
printf '{}\n' >ds/.agent-sync/answers.yaml
expect_fail 'answers の欠け' ds project
cp answers.orig ds/.agent-sync/answers.yaml
while IFS='|' read -r line want; do
  cp "$local_list" list.orig
  printf '%b\n' "$line" >>"$local_list"
  expect_fail "一覧の行 $line" ds "$want"
  cp list.orig "$local_list"
done <<'CASES'
hooks/pre-push\thooks/pre-push\t755|置き先が重複している
hooks/pre-push\tHOOKS/pre-push\t755|置き先が重複している
-\tNOTICE.txt\t644|置き先が重複している
/etc/passwd\tpasswd\t644|上流のパスが定義域の外
hooks/../hooks/pre-push\tx\t644|上流のパスが定義域の外
hooks/pre-push\t../x\t644|置き先のパスが定義域の外
hooks/pre-push\t.git/hooks/pre-push\t755|置き先のパスが定義域の外
hooks/pre-push\t.GIT/x\t755|置き先のパスが定義域の外
hooks/pre-push\tx y\t644|置き先のパスが定義域の外
hooks/pre-push\tfoo\t644\nhooks/pre-push\tfoo/bar\t644|の親のディレクトリ
hooks/pre-push\tfoo/bar\t644\nhooks/pre-push\tfoo\t644|の親のディレクトリ
hooks/pre-push\tFOO/bar\t644\nhooks/pre-push\tfoo\t644|の親のディレクトリ
hooks/pre-push\tDocs/b.md\t644\nhooks/pre-push\tdocs/a.md\t644|ディレクトリの綴りが大文字小文字だけ違う
hooks/pre-push\tdocs/a.md\t644\nhooks/pre-push\tDOCS/b/c.md\t644|ディレクトリの綴りが大文字小文字だけ違う
hooks/pre-push\thooks\t644|の親のディレクトリ
hooks/pre-push\tNOTICE.txt/x\t644|の親のディレクトリ
hooks/pre-push\t.agent-sync/answers.yaml\t644|置いてよい 2 つ
hooks/pre-push\t.agent-sync/archetype/archetype.lua\t644|置いてよい 2 つ
hooks/pre-push\t.agent-sync/generated\t644|置いてよい 2 つ
hooks/pre-push\t.AGENT-SYNC/sync.sh\t644|置いてよい 2 つ
hooks/pre-push\t.agent-sync\t644|置いてよい 2 つ
hooks/pre-push\tx\t600|mode が 644 でも 755 でもない
hooks/pre-push\tx|タブ区切りの 3 つの欄でない
hooks/missing\tx\t644|symlink を通らない通常のファイルでない
-\tmissing.txt\t644|描画が出していない
CASES
printf 'x\n' >ds/.agent-sync/archetype/content/extra.txt
expect_fail '一覧に無い描画の出力' ds 'どの一覧にも - の行で無い'
rm ds/.agent-sync/archetype/content/extra.txt
printf 'hooks/pre-push\thooks/pre-push\t755\n' >ds/.agent-sync/archetype/content/.agent-sync/files/pre-push
# 下流の archetype が先に描画するので、部品の描画の if_exists が重なりを拒むかを見る
expect_fail '部品と同じ名前の一覧' ds 'File already exists'
rm ds/.agent-sync/archetype/content/.agent-sync/files/pre-push
clean 失敗の後 ds

# 引数があれば exit 2 で何もしない
rc=0
(cd ds && ./.agent-sync/sync.sh extra) >/dev/null 2>"$tmp/err.txt" || rc=$?
[ "$rc" = 2 ] || { echo "引数: exit $rc (2 のはず)" >&2; status=1; }
grep -q usage "$tmp/err.txt" || { echo "引数: usage が無い — $(cat "$tmp/err.txt")" >&2; status=1; }

# archetype.yaml の source の行は、sha で固定した https の URL がちょうど 1 つで、名前が定義域の中
yaml=ds/.agent-sync/archetype/archetype.yaml
cp "$yaml" yaml.orig
{ cat yaml.orig; printf '  other:\n    source: %s#%s\n' "$url" "$v1"; } >"$yaml"
expect_fail 'source の行が 2 つ' ds 'ちょうど 1 つでない'
while IFS='|' read -r src want; do
  printf 'description: x\ncatalog:\n  agent-files:\n%b' "$src" >"$yaml"
  expect_fail "source $src" ds "$want"
done <<CASES
|ちょうど 1 つでない
    source: $url#abc\n|ちょうど 1 つでない
    source: ${v1}0\n|ちょうど 1 つでない
    source: $(printf %s "$v1" | tr a-f A-F)\n|ちょうど 1 つでない
    source: http://github.com/ikeyan/agent-files.git#$v1\n|ちょうど 1 つでない
    source: https://example.com/x/...git#$v1\n|定義域の外
    source: https://example.com/x/a%20b.git#$v1\n|定義域の外
CASES
cp yaml.orig "$yaml"

# 入力ファイルが無い
for f in archetype/archetype.yaml archetype/archetype.lua answers.yaml generated; do
  mv "ds/.agent-sync/$f" missing.orig
  expect_fail "入力 $f が無い" ds "$f が無い"
  mv missing.orig "ds/.agent-sync/$f"
done

# generated は、1 行が <パス><TAB><id> で、パスが定義域の中で LC_ALL=C の順に重複が無く、id が 40 桁か 64 桁の小文字 16 進。古いパスは通常のファイル
gen=ds/.agent-sync/generated
cp "$gen" generated.orig
id40=$(printf 'x\n' | git hash-object --stdin)
LC_ALL=C sort -r generated.orig >"$gen"
expect_fail 'generated が逆順' ds '重複なしでない'
{ cat generated.orig; tail -n 1 generated.orig; } >"$gen"
expect_fail 'generated が重複' ds '重複なしでない'
{ cat generated.orig; printf '%s\t%s\n' "$(tail -n 1 generated.orig | cut -f1)" "$id40"; } >"$gen"
expect_fail 'generated が同じパスで id 違いの重複' ds '重複なしでない'
{ cat generated.orig; printf '../x\t%s\n' "$id40"; } >"$gen"
expect_fail 'generated のパスが定義域の外' ds 'パスが定義域の外'
{ cat generated.orig; printf '.agent-sync/answers.yaml\t%s\n' "$id40"; } >"$gen"
expect_fail 'generated に .agent-sync/ の入力' ds '置いてよい 2 つ'
{ cat generated.orig; echo zzz; } >"$gen"
expect_fail 'generated の行に id が無い' ds '2 つの欄でない'
{ cat generated.orig; printf 'zzz\t%s\textra\n' "$id40"; } >"$gen"
expect_fail 'generated の行が 3 欄' ds '2 つの欄でない'
for bad_id in abc "$(printf %s "$id40" | tr a-f A-F)" "${id40}0" "$(printf %s "$id40" | tr 0-9 g)"; do
  { cat generated.orig; printf 'zzz\t%s\n' "$bad_id"; } >"$gen"
  expect_fail "generated の id $bad_id" ds '小文字 16 進でない'
done
{ cat generated.orig; printf 'zdir\t%s\n' "$id40"; } >"$gen"
mkdir ds/zdir
expect_fail '古いパスがディレクトリ' ds '古いパス zdir が通常のファイルでない'
rmdir ds/zdir
cp generated.orig "$gen"

# 上流のパスの symlink と、置き先の途中の symlink
ln -s hooks ds/link
while IFS='|' read -r line want; do
  cp "$local_list" list.orig
  printf '%b\n' "$line" >>"$local_list"
  expect_fail "一覧の行 $line" ds "$want"
  cp list.orig "$local_list"
done <<'CASES'
hooks/link\tx\t644|symlink を通らない通常のファイルでない
hlink/pre-push\tx\t644|symlink を通らない通常のファイルでない
hooks/pre-push\tlink/x\t644|途中に、symlink
CASES
rm ds/link

# 他の起動がロックを取っていれば落ちる。そのロックは消さない
mkdir ds/.git/agent-sync.lock
expect_fail 'ロックが取られている' ds 'agent-sync.lock がある'
rmdir ds/.git/agent-sync.lock

# TMPDIR の文字の分類、archetect の版、OS
mkdir shim-ver shim-os
printf '#!/bin/sh\necho archetect 3.6.0\n' >shim-ver/archetect
cat >shim-os/uname <<SHIM
#!/bin/sh
[ "\$1" = -s ] && { echo Plan9; exit 0; }
exec "$(command -v uname)" "\$@"
SHIM
chmod 755 shim-ver/archetect shim-os/uname
expect_fail 'archetect の版' ds 'archetect 3.6.1 が PATH に無い' "PATH=$tmp/shim-ver:$PATH"
expect_fail '対応していない OS' ds '対応していない OS: Plan9' "PATH=$tmp/shim-os:$PATH"

# 文字の分類 (canon: facts/shell/string-input-categories) ごとに、置き先・source の名前・TMPDIR の定義域が拒む。UTF-8 の locale があればその下で回す。
# 分類: 表示名 | 文字 | source の名前での文言 | 置き先での文言。タブと空白は、欄・単語の区切りの検査が先に当たる。
loc_env=()
[ -z "$loc" ] || loc_env=(LC_ALL="$loc" LANG="$loc")
char_cases=(
  "tab|$(printf '\t')|ちょうど 1 つでない|タブ区切りの 3 つの欄でない"
  "x01|$(printf '\001')|定義域の外|置き先のパスが定義域の外"
  "space| |ちょうど 1 つでない|置き先のパスが定義域の外"
  "dollar|\$|定義域の外|置き先のパスが定義域の外"
  "star|*|定義域の外|置き先のパスが定義域の外"
  "dquote|\"|定義域の外|置き先のパスが定義域の外"
  "squote|'|定義域の外|置き先のパスが定義域の外"
  "backslash|\\|定義域の外|置き先のパスが定義域の外"
  "latin-e-acute|é|定義域の外|置き先のパスが定義域の外"
  "cjk-a|あ|定義域の外|置き先のパスが定義域の外"
  "fullwidth-z|ｚ|定義域の外|置き先のパスが定義域の外"
)
tmpdir_msg='A-Z a-z 0-9 . _ / - 以外の文字がある'
for c in "${char_cases[@]}"; do
  IFS='|' read -r cname ch want_src want_dest <<<"$c"
  mkdir "$tmp/t${ch}m"
  expect_fail "TMPDIR に文字 $cname" ds "$tmpdir_msg" "TMPDIR=$tmp/t${ch}m" ${loc_env[@]+"${loc_env[@]}"}
  printf 'description: x\ncatalog:\n  agent-files:\n    source: https://example.com/x/a%s.git#%s\n' "$ch" "$v1" >"$yaml"
  expect_fail "source の名前に文字 $cname" ds "$want_src" ${loc_env[@]+"${loc_env[@]}"}
  cp yaml.orig "$yaml"
  cp "$local_list" list.orig
  printf 'hooks/pre-push\ta%sb\t644\n' "$ch" >>"$local_list"
  expect_fail "置き先に文字 $cname" ds "$want_dest" ${loc_env[@]+"${loc_env[@]}"}
  cp list.orig "$local_list"
done
clean 定義域の検査の後 ds

# 上流の更新: hooks/pre-push を変え、codex-limits.sh を一覧から消す
printf '# v2\n' >>upstream/hooks/pre-push
grep -v codex-limits.sh upstream/components/pr-workflow/content/.agent-sync/files/pr-workflow >pr-workflow.list
cp pr-workflow.list upstream/components/pr-workflow/content/.agent-sync/files/pr-workflow
git -C upstream commit -q -am v2
v2=$(git -C upstream rev-parse HEAD)
sed "s/#$v1\$/#$v2/" ds/.agent-sync/archetype/archetype.yaml >archetype.yaml
cp archetype.yaml ds/.agent-sync/archetype/archetype.yaml
sync_ok v2 ds
[ ! -e ds/.claude/skills/pr-workflow/codex-limits.sh ] || { echo "v2: 一覧から消えた codex-limits.sh が残った" >&2; status=1; }
cmp -s upstream/hooks/pre-push ds/hooks/pre-push || { echo "v2: hooks/pre-push が v2 でない" >&2; status=1; }
! grep -q codex-limits.sh ds/.agent-sync/generated || { echo "v2: generated に codex-limits.sh が残った" >&2; status=1; }
[ "$(git -C ds status --porcelain | LC_ALL=C sort)" = "$(printf '%s\n' ' D .claude/skills/pr-workflow/codex-limits.sh' ' M .agent-sync/archetype/archetype.yaml' ' M .agent-sync/generated' ' M hooks/pre-push' | LC_ALL=C sort)" ] ||
  { echo "v2: 変わったものが想定と違う — $(git -C ds status --porcelain)" >&2; status=1; }
git -C ds add -A
git -C ds commit -q -m v2

# リポジトリの場所を決める GIT_* が設定されていれば、手順 1 の前に落ちる。指された別のリポジトリにも何も起きない (GIT_CONFIG* は通る: この test 自身が使う)
git init -q -b main other
git -C other commit -q --allow-empty -m other
other_before=$(git -C other for-each-ref; find other/.git -type f | LC_ALL=C sort)
ds_head=$(git -C ds rev-parse HEAD)
for v in $(git rev-parse --local-env-vars); do
  case $v in GIT_CONFIG | GIT_CONFIG_PARAMETERS | GIT_CONFIG_COUNT) continue ;; esac
  expect_fail "$v が設定されている" ds "$v が設定されている" "$v=$tmp/other/.git"
done
[ "$(git -C other for-each-ref; find other/.git -type f | LC_ALL=C sort)" = "$other_before" ] || { echo "GIT_*: 指された別のリポジトリが変わった" >&2; status=1; }
[ "$(git -C ds rev-parse HEAD)" = "$ds_head" ] || { echo "GIT_*: ds の HEAD が変わった" >&2; status=1; }
clean 'GIT_* の後' ds

# 生成物の同一性 (sync.sh の同一性の表の行ごと)。表は git の状態・HEAD を見ないので、commit 済みの編集も、追跡していない・無視されているも、中身の id だけで決まる。
base=$(git -C ds rev-parse HEAD)
reset_ds() { git -C ds reset -q --hard "$base" && git -C ds clean -fdq; }
dest=hooks/pre-push
placed=upstream/hooks/pre-push
text_id() { printf '%s\n' "$1" | git hash-object --stdin; }
rec_as() { # <パス> <id>: generated のそのパスの行の id を差し替える。id が - なら行を消す
  awk -F '\t' -v OFS='\t' -v p="$1" -v id="$2" '$1 == p { if (id == "-") next; $2 = id } 1' ds/.agent-sync/generated >"$tmp/gen.new"
  cp "$tmp/gen.new" ds/.agent-sync/generated
}
placed_ok() { # <名前>: 通り、$dest が置くものと同じバイトの実行可能なファイルで、generated の行がその id
  sync_ok "$1" ds
  { cmp -s "$placed" "ds/$dest" && [ -x "ds/$dest" ]; } || { echo "$1: $dest が置くものと同じバイトの実行可能なファイルでない" >&2; status=1; }
  grep -qxF "$(printf '%s\t%s' "$dest" "$(git hash-object --no-filters "$placed")")" ds/.agent-sync/generated || { echo "$1: generated の $dest の行が置いたバイトの id でない" >&2; status=1; }
  reset_ds
}
dest_refused() { # <名前> [<文言>]: 落ち、$dest に触らない
  expect_fail "$1" ds "${2:-前回置いたもの (generated の id) とも今回置くものとも違う}"
  reset_ds
}
rm "ds/$dest"; placed_ok '置き先: 無い'
rec_as "$dest" "$(text_id other)"; placed_ok '置き先: cur = new (generated の id は違う)'
printf 'old\n' >"ds/$dest"; rec_as "$dest" "$(text_id old)"; placed_ok '置き先: cur = rec ≠ new (前回の結果)'
printf 'old\n' >"ds/$dest"; rec_as "$dest" "$(text_id old)"; git -C ds add "$dest"; placed_ok '置き先: 前回の結果が staged'
printf 'old\n' >"ds/$dest"; rec_as "$dest" "$(text_id old)"; printf '%s\n' "$dest" >>ds/.gitignore; git -C ds rm -q --cached "$dest"; placed_ok '置き先: 前回の結果が追跡されず無視されている'
printf 'mine\n' >"ds/$dest"; dest_refused '置き先: 利用者の編集 (未コミット)'
printf 'mine\n' >"ds/$dest"; git -C ds commit -q -am mine; dest_refused '置き先: 利用者の編集を commit した'
printf 'mine\n' >"ds/$dest"; git -C ds add "$dest"; dest_refused '置き先: 利用者の編集が staged'
printf 'mine\n' >"ds/$dest"; rec_as "$dest" -; dest_refused '置き先: generated に無く、置くものと違う'
rec_as "$dest" -; placed_ok '置き先: generated に無く、置くものと同じ'
chmod 644 "ds/$dest"; placed_ok '置き先: mode だけ違う'
ln "ds/$dest" hl; chmod 644 "ds/$dest"; sync_ok '置き先: hard link で mode だけ違う' ds
{ [ -x "ds/$dest" ] && [ ! "ds/$dest" -ef hl ]; } || { echo "置き先: hard link で mode だけ違う: $dest が新しい inode の実行可能なファイルでない" >&2; status=1; }
{ [ ! -x hl ] && cmp -s "$placed" hl && [ -n "$(find hl -perm 644)" ]; } || { echo '置き先: hard link で mode だけ違う: 別の hard link の mode かバイトが変わった' >&2; status=1; }
rm hl; reset_ds
rm "ds/$dest"; ln -s nowhere "ds/$dest"; dest_refused '置き先: symlink' '通常のファイルでない'
mkdir ds/linkdir; rm "ds/$dest"; ln -s ../linkdir "ds/$dest"
expect_fail '置き先: ディレクトリへの symlink' ds '通常のファイルでない'
[ -z "$(ls -A ds/linkdir)" ] || { echo '置き先: ディレクトリへの symlink の先に書かれた' >&2; status=1; }
reset_ds
rm "ds/$dest"; mkdir "ds/$dest"; dest_refused '置き先: ディレクトリ' '通常のファイルでない'

# 作業ツリーの既存のパスの綴りは、要求した綴りと完全に等しくなければならない。大文字小文字を区別しないファイルシステムでは、別の綴りの利用者のファイルや途中のディレクトリに当たるので落ちる。区別するファイルシステムでは別のファイルなので通る。
clash=綴りの違う既存の
if [ "$ci_fs" = 1 ]; then
  rm ds/NOTICE.txt; printf 'project demo\n' >ds/notice.txt; dest_refused '置き先: 大文字小文字だけ違う利用者のファイル (中身が同じ、generated に id がある)' "$clash"
  rm ds/NOTICE.txt; printf 'project demo\n' >ds/notice.txt; rec_as NOTICE.txt -; dest_refused '置き先: 大文字小文字だけ違う利用者のファイル (中身が同じ、generated に無い)' "$clash"
  # git の reset は既存の綴りを直さないので、綴りを変えたものは消して index の綴りで取り直す
  mv "ds/$dest" ds/hooks/Pre-Push; dest_refused '置き先: 利用者が綴りの大文字小文字を変えた' "$clash"
  rm -rf ds/hooks; git -C ds checkout -q -- hooks
  mv ds/hooks ds/Hooks; dest_refused '置き先: 途中のディレクトリが大文字小文字だけ違う' "$clash"
  rm -rf ds/Hooks; git -C ds checkout -q -- hooks
  # 綴りの規則を再現せず、一覧の完全一致で見るので、大文字小文字の畳み込みでない同一視 (KELVIN SIGN と K) も落ちる
  mv ds/hooks "ds/hoo${kelvin}s"; dest_refused '置き先: 途中のディレクトリが KELVIN SIGN の別名' "$clash"
  rm -rf "ds/hoo${kelvin}s"; git -C ds checkout -q -- hooks
else
  printf 'mine\n' >ds/notice.txt; sync_ok '置き先: 大文字小文字だけ違うファイルが別にある' ds
  [ "$(cat ds/notice.txt)" = mine ] || { echo '置き先: 別のファイル notice.txt が変わった' >&2; status=1; }
  reset_ds
  mkdir ds/Hooks; printf 'mine\n' >ds/Hooks/pre-push; sync_ok '置き先: 大文字小文字だけ違うディレクトリが別にある' ds
  [ "$(cat ds/Hooks/pre-push)" = mine ] || { echo '置き先: 別のディレクトリ Hooks が変わった' >&2; status=1; }
  reset_ds
fi

# 途中のディレクトリの一覧が取れなければ (中身を開けない mode 111)、綴りを突き合わせられないので落ちる。大文字小文字を区別するかによらない。
if [ "$(id -u)" = 0 ]; then
  echo 'test-agent-sync.sh: root は mode 111 のディレクトリも一覧できるので、一覧が取れない検査を飛ばした' >&2
else
  unreadable_before=$(snapshot ds)
  chmod 111 ds/hooks
  expect_fail '置き先: 途中のディレクトリの一覧が取れない' ds 'の一覧を取れない'
  chmod 755 ds/hooks
  [ "$(snapshot ds)" = "$unreadable_before" ] || { echo '置き先: 一覧が取れずに落ちた sync.sh が作業ツリーを変えた' >&2; status=1; }
  reset_ds
fi

old=zzz-old.txt
printf 'old\n' >"ds/$old"
printf '%s\t%s\n' "$old" "$(text_id old)" >>ds/.agent-sync/generated
git -C ds add -A
git -C ds commit -q -m old
base=$(git -C ds rev-parse HEAD)
stale_gone() { # <名前>: 通り、古いパスが無く generated にも無い
  sync_ok "$1" ds
  if [ -e "ds/$old" ] || grep -q "^$old$(printf '\t')" ds/.agent-sync/generated; then echo "$1: 古いパス $old か generated の行が残った" >&2; status=1; fi
  reset_ds
}
stale_refused() { # <名前> [<文言>]: 落ち、古いパスに触らない
  expect_fail "$1" ds "${2:-古いパス $old の中身が、前回置いたもの (generated の id) と違う}"
  reset_ds
}
stale_gone '古いパス: cur = rec'
rm "ds/$old"; stale_gone '古いパス: 消した'
git -C ds rm -q "$old"; git -C ds commit -q -m "no $old"; stale_gone '古いパス: 初めから無い'
printf 'edited\n' >>"ds/$old"; stale_refused '古いパス: 編集 (未コミット)'
printf 'edited\n' >>"ds/$old"; git -C ds commit -q -am "edit $old"; stale_refused '古いパス: 編集を commit した'
printf 'edited\n' >>"ds/$old"; git -C ds add "$old"; stale_refused '古いパス: 編集が staged'
printf 'old\n' >"ds/$old"; git -C ds rm -q --cached "$old"; git -C ds commit -q -m "untrack $old"; stale_gone '古いパス: 追跡していないが cur = rec'
printf '%s\n' "$old" >>ds/.gitignore; git -C ds rm -q --cached "$old"; stale_gone '古いパス: 無視されているが cur = rec'
chmod 755 "ds/$old"; stale_gone '古いパス: mode だけ違う'
rm "ds/$old"; ln -s nowhere "ds/$old"; stale_refused '古いパス: symlink' '古いパス zzz-old.txt が通常のファイルでない'
rm "ds/$old"; mkdir "ds/$old"; stale_refused '古いパス: ディレクトリ' '古いパス zzz-old.txt が通常のファイルでない'

if [ "$ci_fs" = 1 ]; then
  rm "ds/$old"; printf 'old\n' >ds/ZZZ-old.txt; stale_refused '古いパス: 大文字小文字だけ違う利用者のファイル (中身が同じ)' "$clash"
  printf 'zzzdir/o.txt\t%s\n' "$(text_id old)" >>ds/.agent-sync/generated
  mkdir ds/Zzzdir; printf 'old\n' >ds/Zzzdir/o.txt; stale_refused '古いパス: 途中のディレクトリが大文字小文字だけ違う' "$clash"
  printf 'zzzk.txt\t%s\n' "$(text_id old)" >>ds/.agent-sync/generated
  printf 'old\n' >"ds/zzz${kelvin}.txt"; stale_refused '古いパス: KELVIN SIGN の別名のファイル (中身が同じ)' "$clash"
else
  printf 'old\n' >ds/ZZZ-old.txt; sync_ok '古いパス: 大文字小文字だけ違うファイルが別にある' ds
  { [ ! -e "ds/$old" ] && [ -f ds/ZZZ-old.txt ]; } || { echo '古いパス: 別のファイル ZZZ-old.txt を消したか、古いパスが残った' >&2; status=1; }
  reset_ds
fi

# 利用者が生成物を編集して commit した後、上流が同じファイルを置き続けても、一覧から消しても、落ちて何も変えない。上流が v2 に進む前の v1 の下流を作って回す。
v1_downstream() { # <名前>: v1 の生成物を置いて commit した下流
  make_ds "$1" "$v1"
  sync_ok "$1 の初回" "$1"
  git -C "$1" add -A
  git -C "$1" commit -q -m sync
}
to_v2() { sed "s/#$v1\$/#$v2/" "$1/.agent-sync/archetype/archetype.yaml" >"$tmp/archetype.v2.yaml"; cp "$tmp/archetype.v2.yaml" "$1/.agent-sync/archetype/archetype.yaml"; }
# 上流が置き先を大文字小文字だけ改名すると、大文字小文字を区別しないファイルシステムでは前回の出力の古い綴りに当たって落ちる。文言は前回の出力だと示し、古い綴りを消せば通る (描画の出力の改名で再現する)。
if [ "$ci_fs" = 1 ]; then
  v1_downstream ren
  content=ren/.agent-sync/archetype/content
  git -C ren rm -q --cached .agent-sync/archetype/content/NOTICE.txt
  mv "$content/NOTICE.txt" "$content/rename.tmp"; mv "$content/rename.tmp" "$content/notice.txt"
  printf -- '-\tnotice.txt\t644\n' >"$content/.agent-sync/files/local"
  git -C ren add -A
  expect_fail '上流の大文字小文字だけの改名' ren '前回 sync が置いた NOTICE.txt と綴りが違う (ファイルシステム上は同じもの)。NOTICE.txt を消してから起動し直す'
  rm ren/NOTICE.txt
  sync_ok '上流の大文字小文字だけの改名の後、古い綴りを消した' ren
  { [ -n "$(find ren -maxdepth 1 -name notice.txt)" ] && ! grep -q NOTICE.txt ren/.agent-sync/generated && grep -q "^notice.txt$(printf '\t')" ren/.agent-sync/generated; } || { echo '上流の大文字小文字だけの改名: notice.txt が置かれず generated が改名後の綴りでない' >&2; status=1; }
fi

v1_downstream edit
printf '# mine\n' >>edit/hooks/pre-push
git -C edit commit -q -am 'user edit of a generated file'
expect_fail '編集を commit した生成物を、上流が置き続ける (同じ pin)' edit '前回置いたもの (generated の id) とも今回置くものとも違う'
to_v2 edit
expect_fail '編集を commit した生成物を、上流が置き続ける (v2 で中身も変わる)' edit '前回置いたもの (generated の id) とも今回置くものとも違う'
git -C edit checkout -q -- .agent-sync/archetype/archetype.yaml
v1_downstream edit2
printf '# mine\n' >>edit2/.claude/skills/pr-workflow/codex-limits.sh
git -C edit2 commit -q -am 'user edit of a generated file'
to_v2 edit2
expect_fail '編集を commit した生成物を、上流が一覧から消す' edit2 '古いパス .claude/skills/pr-workflow/codex-limits.sh の中身が'
[ -e edit2/.claude/skills/pr-workflow/codex-limits.sh ] || { echo '編集を commit した古いパスが消えた' >&2; status=1; }
git -C edit2 checkout -q -- .agent-sync/archetype/archetype.yaml

# 描画の出力のファイル名に改行があれば、一覧の - の行の突き合わせで foo と bar に割れて通らないよう、手順 3 の最初に落ちる。古いパスを消さずに落ちる (下流の archetype.lua は上流のコードと同じく信頼しない)
v1_downstream nlname
sed -i.bak '/agent-files\/pr-workflow/d' nlname/.agent-sync/archetype/archetype.lua
rm nlname/.agent-sync/archetype/archetype.lua.bak
sed -i.bak 's|^return context|local h = io.open("foo\\nbar", "w"); h:write("x"); h:close()\nreturn context|' nlname/.agent-sync/archetype/archetype.lua
rm nlname/.agent-sync/archetype/archetype.lua.bak
printf -- '-\tfoo\t644\n-\tbar\t644\n' >>nlname/.agent-sync/archetype/content/.agent-sync/files/local
expect_fail '描画の出力のファイル名に改行' nlname '描画の出力のパスが定義域の外'
[ -e nlname/.claude/skills/pr-workflow/SKILL.md ] || { echo '描画の出力のファイル名に改行: 古いパスを消した' >&2; status=1; }

# 古いパスの削除は記録したファイルだけで、ディレクトリは消さない (利用者の空のディレクトリに sync が置いたファイルを、上流が落としても残る)
make_ds keepdir "$v1"
mkdir -p keepdir/.claude/skills/pr-workflow
sync_ok 'keepdir の初回' keepdir
[ -f keepdir/.claude/skills/pr-workflow/SKILL.md ] || { echo 'keepdir: 初回が pr-workflow を置かなかった' >&2; status=1; }
grep -v 'agent-files/pr-workflow' keepdir/.agent-sync/archetype/archetype.lua >"$tmp/lua.keepdir"
cp "$tmp/lua.keepdir" keepdir/.agent-sync/archetype/archetype.lua
sync_ok 'keepdir: 上流が部品を落とす' keepdir
[ ! -e keepdir/.claude/skills/pr-workflow/SKILL.md ] || { echo 'keepdir: 古いパスが残った' >&2; status=1; }
[ -d keepdir/.claude/skills/pr-workflow ] || { echo 'keepdir: 利用者の空のディレクトリを消した' >&2; status=1; }

# 前回の結果を commit する前に続けて起動しても、何も変わらない
make_ds twice "$v1"
sync_ok 'commit 前の 1 回目' twice
twice_snap=$(snapshot twice)
sync_ok 'commit 前の 2 回目' twice
[ "$(snapshot twice)" = "$twice_snap" ] || { echo "commit 前の 2 回目が作業ツリーを変えた" >&2; status=1; }
[ "$twice_snap" = "$first_snap" ] || { echo "commit 前の 1 回目が、初回と違う結果を作った" >&2; status=1; }

# 手順 4 の mv が途中で失敗すれば、一時ファイルとロックを残さずに落ちる。起動し直せば、続けて起動したのと同じ作業ツリーに収束する
mkdir shim-mv
cat >shim-mv/mv <<'SHIM'
#!/bin/sh
n=$(cat "$MV_COUNT" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" >"$MV_COUNT"
for last; do :; done
case $last in $MV_FAIL_PAT) echo "mv: 疑似の失敗" >&2; exit 1 ;; esac
[ "$n" != "$MV_FAIL_AT" ] || { echo "mv: 疑似の失敗" >&2; exit 1; }
exec /bin/mv "$@"
SHIM
chmod 755 shim-mv/mv
apply_fails() { # <名前> <dir> <MV_FAIL_AT=n | MV_FAIL_PAT=glob>: 手順 4 が落ち、一時ファイルとロックを残さず、その後の起動が収束する
  local name=$1 d=$2 left
  rm -f "$tmp/mv.count"
  if (cd "$d" && env PATH="$tmp/shim-mv:$PATH" MV_COUNT="$tmp/mv.count" MV_FAIL_AT=0 MV_FAIL_PAT=- "$3" ./.agent-sync/sync.sh) >/dev/null 2>"$tmp/err.txt"; then
    echo "$name: sync.sh が通った" >&2
    status=1
  fi
  grep -qF 'mv: 疑似の失敗' "$tmp/err.txt" || { echo "$name: mv が失敗していない — $(cat "$tmp/err.txt")" >&2; status=1; }
  left=$(find "$d" -name '.agent-sync.*' -not -path '*/.git/*')
  [ -z "$left" ] || { echo "$name: 一時ファイルが残った — $left" >&2; status=1; }
  [ ! -e "$d/.git/agent-sync.lock" ] || { echo "$name: ロックが残った" >&2; status=1; }
  sync_ok "$name の後の起動し直し" "$d"
  [ "$(snapshot "$d")" = "$first_snap" ] || { echo "$name: 起動し直しが、初回と同じ作業ツリーに収束しない" >&2; status=1; }
}
make_ds part1 "$v1"
apply_fails 'mv の失敗 (2 つ目)' part1 MV_FAIL_AT=2
[ "$(cat "$tmp/mv.count")" = 2 ] || { echo "mv の失敗 (2 つ目): 2 つ目の mv で失敗していない (数: $(cat "$tmp/mv.count"))" >&2; status=1; }
make_ds part2 "$v1"
apply_fails 'mv の失敗 (generated)' part2 'MV_FAIL_PAT=*/generated'

# 上流の部品の Lua は、sandbox の外へ書けず、外を読めず、プロセスを起動できない
make_ds hostile "$v1"
printf 'local context = Context.new()\ncontext:merge(catalog.render("agent-files/agent-sync", context))\ncontext:merge(catalog.render("agent-files/probe", context))\nreturn context\n' >hostile/.agent-sync/archetype/archetype.lua
rm -r hostile/.agent-sync/archetype/content
git -C hostile add -A
git -C hostile commit -q -m probe
sync_ok 'probe の部品' hostile
want_probe=$(printf '%s: nil\n' write-outside read-outside os.execute io.popen)
[ "$(cat hostile/probe.txt 2>/dev/null)" = "$want_probe" ] || { echo "probe の部品: sandbox の外への操作が通った — $(cat hostile/probe.txt 2>/dev/null)" >&2; status=1; }
[ -z "$(ls -A outside)" ] || { echo "probe の部品: sandbox の外にファイルができた — $(ls -A outside)" >&2; status=1; }

# 取り出しは git の設定 (core.autocrlf・core.eol) に依らず、置くバイトは上流の blob と同じ (checkout なら shebang が CRLF になる。canon: facts/git/checkout-filters-vs-raw-blob)
make_ds crlf "$v1"
sync_ok 'core.autocrlf=true・core.eol=crlf' crlf GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_1=core.autocrlf GIT_CONFIG_VALUE_1=true GIT_CONFIG_KEY_2=core.eol GIT_CONFIG_VALUE_2=crlf
check_placed 'core.autocrlf=true・core.eol=crlf' crlf "$v1"
! grep -q "$(printf '\r')" crlf/hooks/pre-push || { echo 'core.autocrlf=true: hooks/pre-push に CR がある' >&2; status=1; }

# 描画が .agent-sync/sync.sh を置かなければ (agent-sync の部品を合成していない・一覧が 1 つも無い)、generated の全てを古いパスとして消さずに落ちる
make_ds nocomp "$v1"
sync_ok 'nocomp の初回' nocomp
git -C nocomp add -A
git -C nocomp commit -q -m sync
grep -v 'agent-files/agent-sync' nocomp/.agent-sync/archetype/archetype.lua >"$tmp/lua.nocomp"
cp "$tmp/lua.nocomp" nocomp/.agent-sync/archetype/archetype.lua
expect_fail 'agent-sync の部品を合成していない' nocomp '.agent-sync/sync.sh を置かない'
printf 'return Context.new()\n' >nocomp/.agent-sync/archetype/archetype.lua
rm -r nocomp/.agent-sync/archetype/content
expect_fail '描画が一覧を 1 つも出さない' nocomp '.agent-sync/sync.sh を置かない'

# このスクリプトが、カレントの作業ツリーの .agent-sync/ のものでなければ落ちる。どちらの作業ツリーも変えない
git init -q -b main wrong
git -C wrong commit -q --allow-empty -m wrong
before_ds=$(snapshot ds)
before_wrong=$(snapshot wrong)
rc=0
(cd wrong && "$tmp/ds/.agent-sync/sync.sh") >/dev/null 2>"$tmp/err.txt" || rc=$?
[ "$rc" != 0 ] || { echo '別のリポの sync.sh が通った' >&2; status=1; }
grep -qF 'の .agent-sync/ でない' "$tmp/err.txt" || { echo "別のリポの sync.sh: 理由が無い — $(cat "$tmp/err.txt")" >&2; status=1; }
{ [ "$(snapshot ds)" = "$before_ds" ] && [ "$(snapshot wrong)" = "$before_wrong" ]; } || { echo '別のリポの sync.sh が作業ツリーを変えた' >&2; status=1; }
{ [ ! -e ds/.git/agent-sync.lock ] && [ ! -e wrong/.git/agent-sync.lock ]; } || { echo '別のリポの sync.sh がロックを残した' >&2; status=1; }

# generated に無い置き先に利用者のファイルがあれば、置き換えない
make_ds user "$v1"
printf '#!/bin/sh\necho mine\n' >user/hooks/pre-push
expect_fail '利用者のファイル' user '利用者のファイル'

exit "$status"
