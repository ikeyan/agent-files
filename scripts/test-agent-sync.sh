#!/usr/bin/env bash
# skills/setup-repo/agent-sync/sync.sh を、このリポの catalog (作業ツリーのもの) から作った手元の上流と、下流のリポを相手に回す。verify.sh から呼ぶ。
# - 初回: 部品の一覧のファイルを、上流と同じバイトと一覧の mode で置く。一覧の mode は上流の git の mode と同じ。手で写した sync.sh と render.sb は同じバイトなので引き取る。下流の archetype が描画したファイルも置く。
# - 2 回目は何も変えず、mode のずれと消したファイルは戻す
# - 上流の更新 (v1 → v2): 変わったファイルを置き直し、一覧から消えたファイルを消す
# - 作業ツリーを変えずに落ちる (理由も見る): 引数 (exit 2)、入力ファイルの欠け、archetype.yaml の source の行の定義域、generated の定義域・順序・古いパスの種類、answers の欠け、置き先の重複、一覧の行が定義域の外 (上流のパスの symlink、置き先の途中の symlink を含む)、一覧と描画の不一致、利用者のファイル、HEAD とも置くものとも違う生成物と HEAD から変わった古いパス、ロックが取られている、TMPDIR の文字、archetect の版、対応していない OS、OS の sandbox を適用できない (描画が非 0 で終わる)、リポジトリの場所を決める GIT_* (`git rev-parse --local-env-vars` の各変数)
# - 環境: GIT_CONFIG* は通る (この test 自身が GIT_CONFIG_COUNT で上流へ向ける)。UTF-8 の locale (LANG・LC_ALL) でも通り、非 ASCII の文字は定義域の外として落ちる (置き先・source の名前・TMPDIR)
# - 標準出力は git status --short と同じ。終わった (落ちた) 後にロックが残らない
# OS の sandbox を適用できない環境 (別の sandbox の中など) では、実際に適用を試す probe が失敗するので、描画を伴う検査を飛ばしたことを理由と一緒に stderr に出す。CI (環境変数 CI が空でない) では飛ばさず落とす。
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
  (cd "$1" && find . -name .git -prune -o \( -type f -o -type l \) -print | LC_ALL=C sort | while IFS= read -r f; do
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

# OS の sandbox を適用できなければ、描画が非 0 で終わった状態を示して落ちる (sandbox-exec・bwrap を exit 71 で終わるものに替える)
mkdir shim-sb
printf '#!/bin/sh\nexit 71\n' >shim-sb/sandbox-exec
cp shim-sb/sandbox-exec shim-sb/bwrap
chmod 755 shim-sb/sandbox-exec shim-sb/bwrap
make_ds nosb "$v1"
expect_fail 'OS の sandbox を適用できない' nosb '描画が exit 71 で終わった' "PATH=$tmp/shim-sb:$PATH"
# 描画に実際に OS の sandbox を適用できるかを、最小の probe で見る
case $(uname -s) in
Darwin) probe=(sandbox-exec -p '(version 1)(allow default)' /usr/bin/true) ;;
Linux) probe=(bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev /usr/bin/true) ;;
esac
if ! "${probe[@]}" >/dev/null 2>"$tmp/probe.err"; then
  if [ -n "${CI:-}" ]; then
    echo "test-agent-sync.sh: CI で OS の sandbox を適用できない (${probe[*]}) — $(cat "$tmp/probe.err")" >&2
    exit 1
  fi
  echo "test-agent-sync.sh: OS の sandbox を適用できない (${probe[*]}: $(cat "$tmp/probe.err")) ので、描画を伴う検査を飛ばした。適用できる環境 (別の sandbox の外や CI) で回すと全部を検査する" >&2
  exit "$status"
fi
loc=
avail=$(locale -a)
for l in en_US.UTF-8 en_US.utf8 ja_JP.UTF-8 ja_JP.utf8 C.UTF-8 C.utf8; do
  if grep -qix "$l" <<<"$avail"; then loc=$l; break; fi
done
[ -n "$loc" ] || echo "test-agent-sync.sh: UTF-8 の locale が無いので、locale の検査を飛ばした" >&2

# 初回
make_ds ds "$v1"
sync_ok 初回 ds
for list in $lists; do
  while IFS=$'\t' read -r from dest mode; do
    want_mode=$(git -C upstream ls-files -s -- "$from" | cut -c1-6)
    [ "$want_mode" = "100$mode" ] || { echo "$list: $from の mode $mode が上流の git の mode ($want_mode) と違う" >&2; status=1; }
    cmp -s "upstream/$from" "ds/$dest" || { echo "初回: ds/$dest が upstream/$from と違う" >&2; status=1; }
    if [ "$mode" = 755 ]; then [ -x "ds/$dest" ]; else [ ! -x "ds/$dest" ]; fi || { echo "初回: ds/$dest の mode が $mode でない" >&2; status=1; }
  done <"upstream/$list"
done
[ "$(cat ds/NOTICE.txt 2>/dev/null)" = "project demo" ] || { echo "初回: 下流の archetype が描画した NOTICE.txt が違う" >&2; status=1; }
want_generated=$({ for list in $lists; do cut -f2 "upstream/$list"; done; echo NOTICE.txt; } | LC_ALL=C sort)
[ "$(cat ds/.agent-sync/generated)" = "$want_generated" ] || { echo "初回: generated が置き先の一覧でない — $(cat ds/.agent-sync/generated)" >&2; status=1; }
[ -z "$(git -C ds status --porcelain -- .agent-sync/sync.sh .agent-sync/render.sb .env hooks/pre-push.local)" ] || { echo "初回: 手で写した sync.sh・render.sb か、下流のファイルが変わった" >&2; status=1; }
[ ! -e ds/.agent-sync/files ] || { echo "初回: 一覧そのものを作業ツリーに置いた" >&2; status=1; }
first_snap=$(snapshot ds)
git -C ds add -A
git -C ds commit -q -m sync

sync_ok 2回目 ds
clean 2回目 ds
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

# generated は、パスが定義域の中で、LC_ALL=C の順で重複が無く、古いパスは通常のファイルか symlink
gen=ds/.agent-sync/generated
cp "$gen" generated.orig
LC_ALL=C sort -r generated.orig >"$gen"
expect_fail 'generated が逆順' ds '重複なしでない'
{ cat generated.orig; tail -n 1 generated.orig; } >"$gen"
expect_fail 'generated が重複' ds '重複なしでない'
{ cat generated.orig; echo ../x; } >"$gen"
expect_fail 'generated のパスが定義域の外' ds 'パスが定義域の外'
{ cat generated.orig; echo zdir; } >"$gen"
mkdir ds/zdir
expect_fail '古いパスがディレクトリ' ds '古いパス zdir が通常のファイルでも symlink でもない'
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

# TMPDIR の文字、archetect の版、OS
mkdir "$tmp/t m p" shim-ver shim-os
expect_fail 'TMPDIR に使えない文字' ds 'A-Z a-z 0-9 . _ / - 以外の文字がある' "TMPDIR=$tmp/t m p"
printf '#!/bin/sh\necho archetect 3.6.0\n' >shim-ver/archetect
cat >shim-os/uname <<SHIM
#!/bin/sh
[ "\$1" = -s ] && { echo Plan9; exit 0; }
exec $(command -v uname) "\$@"
SHIM
chmod 755 shim-ver/archetect shim-os/uname
expect_fail 'archetect の版' ds 'archetect 3.6.1 が PATH に無い' "PATH=$tmp/shim-ver:$PATH"
expect_fail '対応していない OS' ds '対応していない OS: Plan9' "PATH=$tmp/shim-os:$PATH"
if [ -n "$loc" ]; then
  loc_env=(LC_ALL="$loc" LANG="$loc")
  printf 'description: x\ncatalog:\n  agent-files:\n    source: https://example.com/x/é.git#%s\n' "$v1" >"$yaml"
  expect_fail 'source の名前に非 ASCII の文字 (UTF-8 の locale)' ds '定義域の外' "${loc_env[@]}"
  cp yaml.orig "$yaml"
  mkdir "$tmp/é"
  expect_fail 'TMPDIR に非 ASCII の文字 (UTF-8 の locale)' ds 'A-Z a-z 0-9 . _ / - 以外の文字がある' "TMPDIR=$tmp/é" "${loc_env[@]}"
  cp "$local_list" list.orig
  printf 'hooks/pre-push\té\t644\n' >>"$local_list"
  expect_fail '置き先に非 ASCII の文字 (UTF-8 の locale)' ds '置き先のパスが定義域の外' "${loc_env[@]}"
  cp list.orig "$local_list"
fi
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

# generated にあるパスの同一性 (sync.sh の同一性の表の行ごと)。HEAD と同じ (行 2) は 2回目・v2 が見ている
base=$(git -C ds rev-parse HEAD)
reset_ds() { git -C ds reset -q --hard "$base" && git -C ds clean -fdq; }
dest=hooks/pre-push
placed=upstream/hooks/pre-push
head_as() { # <中身>: HEAD の $dest を <中身> にする (HEAD に無い状態は dest_untracked・dest_ignored で作る)
  printf '%s\n' "$1" >"ds/$dest"
  git -C ds commit -q -am "head $1"
}
dest_untracked() { git -C ds rm -q "$dest" && git -C ds commit -q -m "no $dest"; }
dest_ignored() { dest_untracked && printf '%s\n' "$dest" >>ds/.gitignore && git -C ds add .gitignore && git -C ds commit -q -m "ignore $dest"; }
dest_ok() { # <名前>: 通り、$dest が置くものと同じバイトで実行可能
  sync_ok "$1" ds
  cmp -s "$placed" "ds/$dest" && [ -x "ds/$dest" ] || { echo "$1: $dest が置くものと同じバイトの実行可能なファイルでない" >&2; status=1; }
  reset_ds
}
dest_refused() { # <名前>: 落ち、$dest に触らない
  expect_fail "$1" ds 'HEAD とも置くものとも違う'
  reset_ds
}
rm "ds/$dest"; dest_ok '置き先: 無い'
head_as other; cp "$placed" "ds/$dest"; dest_ok '置き先: HEAD と違い、置くものと同じバイト'
head_as other; printf 'mine\n' >"ds/$dest"; dest_refused '置き先: HEAD と違い、置くものと違うバイト'
printf 'mine\n' >>"ds/$dest"; dest_refused '置き先: HEAD から変えた'
head_as other; cp "$placed" "ds/$dest"; git -C ds add "$dest"; dest_ok '置き先: staged で、置くものと同じバイト'
printf 'mine\n' >>"ds/$dest"; git -C ds add "$dest"; dest_refused '置き先: staged で、置くものと違うバイト'
dest_untracked; cp "$placed" "ds/$dest"; dest_ok '置き先: 追跡していなくて、置くものと同じバイト'
dest_untracked; printf 'mine\n' >"ds/$dest"; dest_refused '置き先: 追跡していなくて、置くものと違うバイト'
dest_ignored; cp "$placed" "ds/$dest"; dest_ok '置き先: 無視されていて、置くものと同じバイト'
dest_ignored; printf 'mine\n' >"ds/$dest"; dest_refused '置き先: 無視されていて、置くものと違うバイト'
chmod 644 "ds/$dest"; dest_ok '置き先: mode だけ違う'
rm "ds/$dest"; ln -s nowhere "ds/$dest"; git -C ds add "$dest"; git -C ds commit -q -m "symlink $dest"; dest_ok '置き先: symlink で HEAD と同じ'
rm "ds/$dest"; ln -s nowhere "ds/$dest"; dest_refused '置き先: symlink で HEAD と違う'
rm "ds/$dest"; mkdir "ds/$dest"; expect_fail '置き先: ディレクトリ' ds "置き先 $dest が通常のファイルでも symlink でもない"; reset_ds

old=zzz-old.txt
printf 'old\n' >"ds/$old"
echo "$old" >>ds/.agent-sync/generated
git -C ds add -A
git -C ds commit -q -m old
base=$(git -C ds rev-parse HEAD)
stale_gone() { # <名前>: 通り、古いパスが無く generated にも無い
  sync_ok "$1" ds
  if [ -e "ds/$old" ] || grep -qx "$old" ds/.agent-sync/generated; then echo "$1: 古いパス $old か generated の行が残った" >&2; status=1; fi
  reset_ds
}
stale_refused() { # <名前>: 落ち、古いパスに触らない
  expect_fail "$1" ds "古いパス $old が HEAD から変わっている"
  reset_ds
}
stale_gone '古いパス: HEAD と同じ'
rm "ds/$old"; stale_gone '古いパス: 消した'
git -C ds rm -q "$old"; git -C ds commit -q -m "no $old"; stale_gone '古いパス: 初めから無い'
printf 'edited\n' >>"ds/$old"; stale_refused '古いパス: HEAD から変えた'
printf 'edited\n' >>"ds/$old"; git -C ds add "$old"; stale_refused '古いパス: staged'
git -C ds rm -q --cached "$old"; git -C ds commit -q -m "untrack $old"; stale_refused '古いパス: 追跡していない'
git -C ds rm -q --cached "$old"; printf '%s\n' "$old" >>ds/.gitignore; git -C ds add .gitignore; git -C ds commit -q -m "ignore $old"; stale_refused '古いパス: 無視されている'
chmod 755 "ds/$old"; stale_gone '古いパス: mode だけ違う'

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
printf 'local context = Context.new()\ncontext:merge(catalog.render("agent-files/probe", context))\nreturn context\n' >hostile/.agent-sync/archetype/archetype.lua
rm -r hostile/.agent-sync/archetype/content
git -C hostile add -A
git -C hostile commit -q -m probe
sync_ok 'probe の部品' hostile
want_probe=$(printf '%s: nil\n' write-outside read-outside os.execute io.popen)
[ "$(cat hostile/probe.txt 2>/dev/null)" = "$want_probe" ] || { echo "probe の部品: sandbox の外への操作が通った — $(cat hostile/probe.txt 2>/dev/null)" >&2; status=1; }
[ -z "$(ls -A outside)" ] || { echo "probe の部品: sandbox の外にファイルができた — $(ls -A outside)" >&2; status=1; }

# generated に無い置き先に利用者のファイルがあれば、置き換えない
make_ds user "$v1"
printf '#!/bin/sh\necho mine\n' >user/hooks/pre-push
expect_fail '利用者のファイル' user '利用者のファイル'

exit "$status"
