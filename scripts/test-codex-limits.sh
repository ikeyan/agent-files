#!/usr/bin/env bash
# skills/setup-repo/pr-workflow/codex-limits.sh を、PATH の先頭に置いた偽の codex (app-server の役) を相手に回し、出力・終了コード・後始末を検査する。verify.sh から呼ぶ。
# 応答しない例は codex-limits.sh の 30 秒の timeout を待つので、他の例と並行に回す。
set -euo pipefail
script=$(cd "$(dirname "$0")/.." && pwd)/skills/setup-repo/pr-workflow/codex-limits.sh
bash_bin=$(command -v bash)
tmp=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/test-codex-limits.XXXXXX")" && pwd -P)
hang=
# kill は hang の run() が wait 済み (プロセスが既に居ない) でも起こるので、trap の続き (rm -rf) を set -e で打ち切らせない
trap 'kill "$hang" 2> /dev/null || true; rm -rf "$tmp"' EXIT
status=0

mkdir "$tmp/bin"
cat > "$tmp/bin/codex" << 'EOF'
#!/usr/bin/env bash
# 偽の codex app-server。$CASE/mode が hang なら応答せず、exit なら何も返さずに終わる。それ以外は id 1 に応え、id 2 に通知を挟んで $CASE/response を返す。受けた行を $CASE/in に書く
[ "$1" = app-server ] || exit 64
echo $$ > "$CASE/pid"
case $(cat "$CASE/mode") in
  hang) exec sleep 60 ;;
  exit) exit 0 ;;
esac
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$CASE/in"
  case $line in
    '{"id":1,'*) echo '{"id":1,"result":{"userAgent":"fake"}}' ;;
    '{"id":2,'*) echo '{"method":"remoteControl/status/changed","params":{"status":"disabled"}}' && cat "$CASE/response" ;;
  esac
done
EOF
chmod +x "$tmp/bin/codex"

run() { # <例の名前> <mode> [<id 2 への応答>] [<PATH>]: 例のディレクトリで codex-limits.sh を回し、stdout・stderr・終了コードを置く
  local case=$tmp/$1
  mkdir "$case" "$case/tmp"
  echo "$2" > "$case/mode"
  printf '%s\n' "${3:-}" > "$case/response"
  set +e
  CASE=$case TMPDIR=$case/tmp PATH="${4:-$tmp/bin:$PATH}" "$bash_bin" "$script" > "$case/stdout" 2> "$case/stderr"
  echo $? > "$case/code"
  set -e
}
expect() { # <例の名前> <終了コード> <stdout> <stderr の 1 行目>: run の結果を照合し、app-server と一時ディレクトリが残っていないことを確かめる
  local case=$tmp/$1
  [ "$(cat "$case/code")" = "$2" ] || { echo "$1: 終了コード $(cat "$case/code") != $2 — $(cat "$case/stderr")" >&2; status=1; }
  [ "$(cat "$case/stdout")" = "$3" ] || { echo "$1: stdout が違う — 期待 [$3] 実際 [$(cat "$case/stdout")]" >&2; status=1; }
  [ "$(head -n 1 "$case/stderr")" = "$4" ] || { echo "$1: stderr が違う — 期待 [$4] 実際 [$(cat "$case/stderr")]" >&2; status=1; }
  if [ -f "$case/pid" ] && kill -0 "$(cat "$case/pid")" 2> /dev/null; then echo "$1: app-server が残っている" >&2; status=1; fi
  [ -z "$(ls "$case/tmp")" ] || { echo "$1: 一時ディレクトリが残っている — $(ls "$case/tmp")" >&2; status=1; }
}

run hang hang &
hang=$!

run full respond '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":100,"resetsAt":1790000000,"windowDurationMins":300},"secondary":{"usedPercent":41,"resetsAt":1790500000,"windowDurationMins":10080},"rateLimitReachedType":"rate_limit_reached","planType":"business"}}}'
expect full 0 "$(printf 'primary\t100\t1790000000\t300\nsecondary\t41\t1790500000\t10080\nreached\trate_limit_reached')" ""
want_in='{"id":1,"method":"initialize","params":{"clientInfo":{"name":"pr-workflow","title":"pr-workflow","version":"0"}}}
{"method":"initialized"}
{"id":2,"method":"account/rateLimits/read","params":null}'
[ "$(cat "$tmp/full/in")" = "$want_in" ] || { echo "full: app-server に送った行が違う — $(cat "$tmp/full/in")" >&2; status=1; }

run nulls respond '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":0,"resetsAt":null,"windowDurationMins":null},"secondary":null,"rateLimitReachedType":null}}}'
expect nulls 0 "$(printf 'primary\t0\t-\t-\nsecondary\t-\t-\t-\nreached\t-')" ""

run error respond '{"id":2,"error":{"code":-32603,"message":"failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)"}}'
expect error 1 "" "codex-limits.sh: failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)"

run exit exit
expect exit 2 "" "codex-limits.sh: codex app-server が応答の前に終わった"

mkdir "$tmp/none" "$tmp/none/tmp"
set +e
TMPDIR=$tmp/none/tmp PATH=/usr/bin:/bin "$bash_bin" "$script" > "$tmp/none/stdout" 2> "$tmp/none/stderr"
echo $? > "$tmp/none/code"
set -e
expect none 2 "" "codex-limits.sh: codex app-server が応答の前に終わった"

# jq だけ PATH に無い例。PATH のディレクトリを丸ごと除くと mktemp 等の必須コマンドも道連れになり得るので、必要なコマンドだけを集めたディレクトリを使う
mkdir "$tmp/nojq-bin"
ln -s "$tmp/bin/codex" "$tmp/nojq-bin/codex"
for c in mktemp mkfifo cat rm bash; do ln -s "$(command -v "$c")" "$tmp/nojq-bin/$c"; done
nojq_path=$tmp/nojq-bin
nojq_start=$SECONDS
run nojq respond '{"id":2,"result":{"rateLimits":{}}}' "$nojq_path"
nojq_elapsed=$((SECONDS - nojq_start))
[ "$nojq_elapsed" -lt 5 ] || { echo "nojq: $nojq_elapsed 秒かかった — jq 不在なのに 30 秒 timeout を待った疑い" >&2; status=1; }
[ "$(cat "$tmp/nojq/code")" = 2 ] || { echo "nojq: 終了コード $(cat "$tmp/nojq/code") != 2 — $(cat "$tmp/nojq/stderr")" >&2; status=1; }
[ "$(cat "$tmp/nojq/stdout")" = "" ] || { echo "nojq: stdout が違う — $(cat "$tmp/nojq/stdout")" >&2; status=1; }
case "$(head -n 1 "$tmp/nojq/stderr")" in
  *jq*) ;;
  *) echo "nojq: stderr が jq に言及していない — $(cat "$tmp/nojq/stderr")" >&2; status=1 ;;
esac
if [ -f "$tmp/nojq/pid" ] && kill -0 "$(cat "$tmp/nojq/pid")" 2> /dev/null; then echo "nojq: app-server が残っている" >&2; status=1; fi
[ -z "$(ls "$tmp/nojq/tmp")" ] || { echo "nojq: 一時ディレクトリが残っている — $(ls "$tmp/nojq/tmp")" >&2; status=1; }

wait "$hang"
expect hang 2 "" "codex-limits.sh: codex app-server が 30 秒以内に応答しない"
exit "$status"
