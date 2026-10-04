#!/bin/bash
# ikeyan/agent-files の部品のうち、このリポの .agent-sync/archetype が合成するものを描画し、作業ツリーに当てる。当てた結果は人が git diff で確かめてコミットする。
#
# 使い方: .agent-sync/sync.sh (引数なし)。対象はカレントディレクトリの git の作業ツリー。render.sb をこのスクリプトと同じディレクトリから読む。
# 入力 (作業ツリーのルートの .agent-sync/ の下):
#   archetype/archetype.yaml  `source: https://<host>/<path>/<名前>.git#<40 桁の小文字 16 進の sha>` の形の行がちょうど 1 つ (名前は A-Z a-z 0-9 . _ - で、. と .. でない)。この sha が上流の固定で、書き換えが更新。
#   archetype/archetype.lua   catalog.render で上流の部品を合成する。
#   answers.yaml              全ての問いの答え。
#   generated                 前回の sync が置いたパスの一覧。1 行 1 件、LC_ALL=C の順で重複なし。初回は空のファイル。
#   描画に渡すのは archetype/ と answers.yaml のうち、追跡しているか無視されていないファイルの写しだけ。
# 読む環境: PATH (git・archetect・realpath と、macOS では sandbox-exec と otool、Linux では bwrap と ldd)・TMPDIR・SANDBOX_RUNTIME。git は自分の環境変数 (GIT_*) と設定 (url.<base>.insteadOf など) を読む。
#   archetect は空の環境に HOME (作業ディレクトリの下) だけを足して起動するので、ARCHETECT_*・XDG_*・git の global config は描画に届かない (canon: facts/archetect/inputs)。
# ネットワーク: 手順 1 の git fetch だけ。
#
# 手順:
#   1. 取得: 固定した sha を git で浅く取る。上流のコードは実行しない。
#   2. 描画: archetect を OS の sandbox (macOS は sandbox-exec と render.sb、Linux は bwrap) で動かす。ネットワーク無し。読めるのは入力の写し・取得した上流・archetect とその共有ライブラリだけ、書けるのは空の出力ディレクトリだけ。
#   3. 計画: 下の定義域を全て検査する。違反があれば作業ツリーに触れずに終わる。
#   4. 適用: 古いパスを消し、新しい・変わったファイルを置き、mode を揃え、generated を書き換える。
#
# 描画の出力の定義域:
#   - 通常のファイルとディレクトリだけ。
#   - .agent-sync/files/<部品名> (直下の通常のファイル) は置くファイルの一覧で、1 行 1 件 `<上流のパス><TAB><置き先のパス><TAB><mode>`。一覧そのものは作業ツリーに置かない。
#     - 上流のパス: 取得した上流の中の通常のファイル (それも途中のディレクトリも symlink でない)。バイトをそのまま置き先に写す。`-` なら、描画の出力の置き先と同じパスのファイルを置く。
#     - 置き先のパス: 作業ツリーのルートからの相対パス。
#     - mode: 644 か 755。
#   - パスは / で区切った 1 つ以上の名前。名前は POSIX の可搬なファイル名の文字 (A-Z a-z 0-9 . _ -) だけで、. と .. でない。置き先は大文字小文字によらず .git の名前を含まない。
#   - 置き先は全ての一覧を通して、大文字小文字によらず 1 回だけ (後勝ちにしない)。
#   - 一覧の外の描画の出力は、`-` の行の置き先と 1 対 1 に対応する。
# 作業ツリーの定義域 (置き先と、generated にあって置き先に無い古いパス。generated も上のパスの規則に従う):
#   - 途中のディレクトリは、無いか symlink でないディレクトリ。
#   - 既にある置き先は、generated にある通常のファイルか symlink、または置くものと同じバイトの通常のファイル (利用者のファイルを上書きしない)。
#   - 古いパスは、無いか、通常のファイルか symlink。
# 同一性: 生成物は作業ツリーのルートからの相対パスで同定する。置き先は、通常のファイルでないかバイトが違う (cmp) ときに置き直し、mode は毎回揃える。
# 失敗: 手順 1〜3 のどこで落ちても作業ツリーは変わらない。手順 4 は検査済みのパスへの rm・mv・chmod だけだが、ファイルシステムの失敗で途中まで当たることはある (git status に出る)。
# Claude Code の Bash の sandbox の中 (SANDBOX_RUNTIME=1) では描画の sandbox を入れ子にできない (sandbox-exec が exit 71) ので、起動を拒む。
set -euo pipefail

main() {
  [ $# -eq 0 ] || { echo "usage: .agent-sync/sync.sh (引数なし)" >&2; exit 2; }
  if [ "${SANDBOX_RUNTIME:-}" = 1 ]; then
    echo "agent-sync: SANDBOX_RUNTIME=1 (Claude Code の sandbox の中) では描画の sandbox を入れ子にできない。sandbox の外で起動する" >&2
    exit 1
  fi
  here=$(cd "$(dirname "$0")" && pwd)
  root=$(git rev-parse --show-toplevel)
  cfg=$root/.agent-sync
  local f
  for f in archetype/archetype.yaml archetype/archetype.lua answers.yaml generated; do
    [ -f "$cfg/$f" ] || { echo "agent-sync: $cfg/$f が無い" >&2; exit 1; }
  done
  local pins url sha name
  pins=$(sed -nE 's|^[[:space:]]+source:[[:space:]]+(https://[^#[:space:]]+\.git)#([0-9a-f]{40})$|\1 \2|p' "$cfg/archetype/archetype.yaml")
  [ "$(printf '%s\n' "$pins" | grep -c .)" = 1 ] || { echo "agent-sync: $cfg/archetype/archetype.yaml に sha で固定した https の source の行がちょうど 1 つでない" >&2; exit 1; }
  read -r url sha <<<"$pins"
  # archetect の locals は <locals のパス>/<URL のパスのファイル名から .git を除いたもの> を探す (canon: facts/archetect/sources-pinning-and-cache)。
  name=$(basename "$url" .git)
  case $name in . | .. | *[!A-Za-z0-9._-]*) echo "agent-sync: source の URL のファイル名 $name.git が定義域の外" >&2; exit 1 ;; esac

  run=$(mktemp -d "${TMPDIR:-/tmp}/agent-sync.XXXXXX")
  # Seatbelt は解決済みのパスで照合する (macOS の /tmp は /private/tmp)。
  run=$(cd "$run" && pwd -P)
  trap 'rm -rf "$run"' EXIT
  # このパスを archetect の設定の YAML と render.sb の引数に、引用せずに書く。
  case $run in *[!A-Za-z0-9._/-]*) echo "agent-sync: 作業ディレクトリ $run に A-Z a-z 0-9 . _ / - 以外の文字がある (TMPDIR を変える)" >&2; exit 1 ;; esac
  src=$run/src/$name
  mkdir -p "$src" "$run/ds" "$run/out" "$run/conf/home"

  # 1. 取得
  git -C "$src" init -q
  git -C "$src" fetch -q --depth 1 "$url" "$sha"
  git -C "$src" -c advice.detachedHead=false checkout -q FETCH_HEAD
  [ "$(git -C "$src" rev-parse HEAD)" = "$sha" ] || { echo "agent-sync: 取得した commit が $sha でない" >&2; exit 1; }
  rm -rf "$src/.git"

  local p
  git -C "$root" ls-files -z -c -o --exclude-standard -- .agent-sync/archetype .agent-sync/answers.yaml |
    while IFS= read -r -d '' p; do
      [ -e "$root/$p" ] || [ -L "$root/$p" ] || continue
      mkdir -p "$run/ds/$(dirname "$p")"
      cp -P "$root/$p" "$run/ds/$p"
    done
  printf 'locals:\n  enabled: true\n  paths:\n    - %s\n' "$run/src" >"$run/conf/archetect.yaml"

  # 2. 描画
  local bin
  bin=$(realpath "$(command -v archetect)")
  local args=(render "$run/ds/.agent-sync/archetype" --destination . --headless --offline
    -c "$run/conf/archetect.yaml" -A "$run/ds/.agent-sync/answers.yaml")
  case $(uname -s) in
  Darwin)
    local profile=$run/conf/render.sb lib
    cp "$here/render.sb" "$profile"
    otool -L "$bin" | awk 'NR > 1 && $1 !~ /^\/(usr\/lib|System)\// {print $1}' | while read -r lib; do
      for p in "$lib" "$(realpath "$lib")"; do
        case $p in *[\"\\]*) echo "agent-sync: profile に書けないパス: $p" >&2; exit 1 ;; esac
        printf '(allow file-read* file-map-executable (literal "%s"))\n' "$p"
      done
    done >>"$profile"
    (cd "$run/out" && env -i HOME="$run/conf/home" \
      sandbox-exec -f "$profile" -D BIN="$bin" -D KEG="$(dirname "$(dirname "$bin")")" \
      -D DS="$run/ds" -D SRC="$run/src" -D CONF="$run/conf" -D OUT="$run/out" \
      "$bin" "${args[@]}" </dev/null)
    ;;
  Linux)
    # namespace には archetect とその共有ライブラリと入力しか無い。/bin/sh が無いので os.execute・io.popen は何も起動できない。
    # bwrap が作る root は書き込める tmpfs なので、--remount-ro / で外れた書き込みを消えずに失敗させる。
    local b=(--unshare-all --die-with-parent --new-session --clearenv --proc /proc --dev /dev)
    for f in "$bin" $(ldd "$bin" | awk '$2 == "=>" && $3 ~ /^\// {print $3} $1 ~ /^\// && $2 ~ /^\(0x/ {print $1}'); do
      b+=(--ro-bind "$f" "$f")
    done
    b+=(--ro-bind "$run/ds" "$run/ds" --ro-bind "$run/src" "$run/src" --ro-bind "$run/conf" "$run/conf"
      --bind "$run/out" "$run/out" --chdir "$run/out" --setenv HOME "$run/conf/home" --remount-ro /)
    bwrap "${b[@]}" "$bin" "${args[@]}" </dev/null
    ;;
  *)
    echo "agent-sync: 対応していない OS: $(uname -s)" >&2
    exit 1
    ;;
  esac

  # 3. 計画
  cd "$run/out"
  [ -z "$(find . ! -type f ! -type d)" ] || { echo "agent-sync: 描画が通常のファイルでもディレクトリでもないものを出した" >&2; exit 1; }
  local lists=.agent-sync/files
  if [ -d "$lists" ]; then
    [ -z "$(find "$lists" -mindepth 1 \( ! -type f -o -path "$lists/*/*" \))" ] || { echo "agent-sync: $lists の下に、直下の通常のファイルでないものがある" >&2; exit 1; }
  fi
  find . -type f ! -path "./$lists/*" | sed 's|^\./||' | LC_ALL=C sort >"$run/rendered"
  # records: <置き先>\t<上流のパスか ->\t<mode>\t<一覧>
  find . -type f -path "./$lists/*" | LC_ALL=C sort | sed 's|^\./||' | {
    files=()
    while IFS= read -r f; do files+=("$f"); done
    [ ${#files[@]} -eq 0 ] || awk -F '\t' '
      function bad_path(p, dest,   n, a, i) {
        n = split(p, a, "/")
        if (n == 0) return 1
        for (i = 1; i <= n; i++) {
          if (a[i] !~ /^[A-Za-z0-9._-]+$/ || a[i] == "." || a[i] == "..") return 1
          if (dest && tolower(a[i]) == ".git") return 1
        }
        return 0
      }
      function fail(msg) { print "agent-sync: " FILENAME ":" FNR ": " msg > "/dev/stderr"; bad = 1 }
      NF != 3 { fail("タブ区切りの 3 つの欄でない"); next }
      $1 != "-" && bad_path($1, 0) { fail("上流のパスが定義域の外: " $1); next }
      bad_path($2, 1) { fail("置き先のパスが定義域の外: " $2); next }
      $3 != "644" && $3 != "755" { fail("mode が 644 でも 755 でもない: " $3); next }
      { print $2 "\t" $1 "\t" $3 "\t" FILENAME }
      END { exit bad }
    ' "${files[@]}"
  } >"$run/records"
  awk -F '\t' '
    { k = tolower($1) }
    k in seen { print "agent-sync: 置き先が重複している (大文字小文字によらない): " $1 " (" $4 ") と " seen[k] > "/dev/stderr"; bad = 1; next }
    { seen[k] = $1 " (" $4 ")" }
    END { exit bad }
  ' "$run/records"
  awk -F '\t' '$2 == "-" {print $1}' "$run/records" | LC_ALL=C sort >"$run/declared"
  local errs=0
  while IFS= read -r p; do
    echo "agent-sync: 描画の出力 $p が、どの一覧にも - の行で無い" >&2
    errs=1
  done < <(LC_ALL=C comm -23 "$run/rendered" "$run/declared")
  while IFS= read -r p; do
    echo "agent-sync: 一覧の - の行の $p を、描画が出していない" >&2
    errs=1
  done < <(LC_ALL=C comm -13 "$run/rendered" "$run/declared")

  awk -F '\t' '
    function bad_path(p,   n, a, i) {
      n = split(p, a, "/")
      if (n == 0) return 1
      for (i = 1; i <= n; i++) if (a[i] !~ /^[A-Za-z0-9._-]+$/ || a[i] == "." || a[i] == ".." || tolower(a[i]) == ".git") return 1
      return 0
    }
    bad_path($0) { print "agent-sync: generated:" NR ": パスが定義域の外: " $0 > "/dev/stderr"; bad = 1 }
    END { exit bad }
  ' "$cfg/generated"
  LC_ALL=C sort -c -u "$cfg/generated" 2>/dev/null || { echo "agent-sync: $cfg/generated が LC_ALL=C の順で重複なしでない" >&2; exit 1; }
  cut -f1 "$run/records" | LC_ALL=C sort >"$run/new"
  LC_ALL=C comm -23 "$cfg/generated" "$run/new" >"$run/stale"

  local dest from mode list t
  while IFS=$'\t' read -r dest from mode list; do
    if [ "$from" != - ]; then
      if ! parents_ok "$src" "$from" || [ -L "$src/$from" ] || [ ! -f "$src/$from" ]; then
        echo "agent-sync: $list: 上流のパス $from が、symlink を通らない通常のファイルでない" >&2
        errs=1
      fi
    fi
    t=$root/$dest
    if ! parents_ok "$root" "$dest"; then
      echo "agent-sync: 置き先 $dest の途中に、symlink かディレクトリでないものがある" >&2
      errs=1
    elif [ -L "$t" ] || [ -e "$t" ]; then
      if grep -qxF -- "$dest" "$cfg/generated"; then
        { [ -L "$t" ] || [ -f "$t" ]; } || { echo "agent-sync: 置き先 $dest が通常のファイルでも symlink でもない" >&2; errs=1; }
      elif [ -L "$t" ] || [ ! -f "$t" ] || ! cmp -s "$(content_of "$dest" "$from")" "$t"; then
        echo "agent-sync: 置き先 $dest に、generated に無く置くものと違うもの (利用者のファイル) がある。消すか移してから起動し直す" >&2
        errs=1
      fi
    fi
  done <"$run/records"
  while IFS= read -r p; do
    t=$root/$p
    if ! parents_ok "$root" "$p"; then
      echo "agent-sync: 古いパス $p の途中に、symlink かディレクトリでないものがある" >&2
      errs=1
    elif [ -e "$t" ] && [ ! -L "$t" ] && [ ! -f "$t" ]; then
      echo "agent-sync: 古いパス $p が通常のファイルでも symlink でもない" >&2
      errs=1
    fi
  done <"$run/stale"
  [ "$errs" = 0 ] || exit 1

  # 4. 適用
  local d tmp
  while IFS= read -r p; do
    rm -f "$root/$p"
    d=$(dirname "$p")
    while [ "$d" != . ] && rmdir "$root/$d" 2>/dev/null; do d=$(dirname "$d"); done
  done <"$run/stale"
  while IFS=$'\t' read -r dest from mode list; do
    t=$root/$dest
    if [ -L "$t" ] || ! cmp -s "$(content_of "$dest" "$from")" "$t"; then
      mkdir -p "$(dirname "$t")"
      # 新しい inode に書いて rename する。動いている sync.sh 自身も置き換えるので、上書きで中身を変えない。
      tmp=$(mktemp "$(dirname "$t")/.agent-sync.XXXXXX")
      cp "$(content_of "$dest" "$from")" "$tmp"
      chmod "$mode" "$tmp"
      mv -f "$tmp" "$t"
    else
      chmod "$mode" "$t"
    fi
  done <"$run/records"
  tmp=$(mktemp "$cfg/.agent-sync.XXXXXX")
  cp "$run/new" "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$cfg/generated"
  git -C "$root" status --short
}

parents_ok() { # <基点> <相対パス>: 途中のディレクトリが、無いか symlink でないディレクトリ
  local cur=$1 rest=$2
  while [ "${rest#*/}" != "$rest" ]; do
    cur=$cur/${rest%%/*}
    rest=${rest#*/}
    if [ -L "$cur" ] || { [ -e "$cur" ] && [ ! -d "$cur" ]; }; then return 1; fi
  done
}

content_of() { # <置き先> <上流のパスか ->: 置き先に置く中身のファイル
  if [ "$2" = - ]; then printf '%s\n' "$run/out/$1"; else printf '%s\n' "$src/$2"; fi
}

main "$@"; exit
