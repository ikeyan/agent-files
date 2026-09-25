#!/usr/bin/env bash
# Codex の利用上限の窓を、codex app-server (stdio の JSON-RPC) の account/rateLimits/read で読む。model の turn は使わない (canon: facts/codex/app-server-account-rate-limits-read)。
#
# 使い方: codex-limits.sh
# 出力 (成功、stdout にタブ区切りの 3 行。値の無いところは -):
#   primary<TAB><usedPercent><TAB><resetsAt (epoch 秒)><TAB><windowDurationMins>
#   secondary<TAB><usedPercent><TAB><resetsAt (epoch 秒)><TAB><windowDurationMins>
#   reached<TAB><rateLimitReachedType>
#   窓そのものが無ければ、その行は <usedPercent> から - になる。
# 終了コード: 0 成功。1 app-server が error を返した (stderr に message)。2 codex が PATH に無いか、app-server が 30 秒以内に応答しない (途中で終わったときを含む。stderr に理由)。
# 事前条件: codex と jq が PATH にあること。環境変数は読まない (codex 自身が読むものはそのまま効く)。
set -uo pipefail

command -v codex > /dev/null || { echo "codex-limits.sh: codex が PATH に無い" >&2; exit 2; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/codex-limits.XXXXXX") || exit 2
mkfifo "$tmp/in" "$tmp/out" || exit 2
# codex の stderr は捨てる (ログが混ざると、呼び出し側が理由として読む stderr の 1 行目が埋もれる)
codex app-server < "$tmp/in" > "$tmp/out" 2> /dev/null &
pid=$!
trap 'kill "$pid" 2> /dev/null; rm -rf "$tmp"' EXIT
# app-server が先に終わったときに SIGPIPE で黙って止まらず、下の read の EOF で理由を出す
trap '' PIPE
exec 3> "$tmp/in" 4< "$tmp/out"
printf '%s\n' \
  '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"pr-workflow","title":"pr-workflow","version":"0"}}}' \
  '{"method":"initialized"}' \
  '{"id":2,"method":"account/rateLimits/read","params":null}' >&3
end=$((SECONDS + 30))
while :; do
  left=$((end - SECONDS))
  [ "$left" -gt 0 ] || { echo "codex-limits.sh: codex app-server が 30 秒以内に応答しない" >&2; exit 2; }
  IFS= read -r -t "$left" -u 4 line || {
    rc=$?
    if [ "$rc" -gt 128 ]; then echo "codex-limits.sh: codex app-server が 30 秒以内に応答しない" >&2; else echo "codex-limits.sh: codex app-server が応答の前に終わった" >&2; fi
    exit 2
  }
  res=$(jq -c 'select(.id == 2)' <<< "$line" 2> /dev/null) && [ -n "$res" ] && break
done
if msg=$(jq -er '.error.message' <<< "$res"); then
  echo "codex-limits.sh: $msg" >&2
  exit 1
fi
jq -r '.result.rateLimits |
  def win($n): .[$n] as $w | "\($n)\t\($w.usedPercent // "-")\t\($w.resetsAt // "-")\t\($w.windowDurationMins // "-")";
  win("primary"), win("secondary"), "reached\t\(.rateLimitReachedType // "-")"' <<< "$res"
