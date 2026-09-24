#!/usr/bin/env bash
# gh.md の「PR の watch」と「返信と resolve」を GitHub の REST・GraphQL で行う。gh は sandbox 内で TLS に失敗するので、curl で呼ぶ。
#
# 使い方:
#   pr.sh watch <owner>/<repo> <PR 番号> <状態のディレクトリ> [<間隔の秒数>]
#     対応が要るものを見つけたら出して終わる (Bash ツールの run_in_background で回す)。
#     初回 (状態が無い): 未対応 (unresolved のレビューコメント・head の CI の失敗・閉じた PR) があれば出して終わる。無ければ基準にして待つ。
#     以後: 前回との差 (コメント・review の追加と編集、タイトル、説明、CI の失敗、PR の close) を見つけたら、10 秒待って取り直し、まとめて出して終わる。
#     出さないもの: resolve 済みのスレッドのレビューコメント、本文の無い COMMENTED の review (返信で作られる)、Codex の summary コメントの Completed 以外への編集。
#   pr.sh reply-resolve <owner>/<repo> <PR 番号> <スレッド先頭のレビューコメントの id> <本文>
#     スレッドに返信し、そのスレッドを resolve する。
# 出力 (watch、1 行 1 件): open・new・changed に続けてイベント文。説明の変更は "description changed" の行に unified diff が続く。
#   auth で始まる行を出して終わったら、トークンが無いか無効 (401)。
# 失敗: 401 以外の API の失敗 (ネットワーク・5xx・レート制限) は、watch では出さずに間隔を倍にして (上限 900 秒) 再試行し、reply-resolve では止まる。
# 事前条件: curl と jq。トークンは GH_TOKEN か gh auth token。
# GraphQL の $cursor と jq の式は、単一引用符で展開させずに渡す
# shellcheck disable=SC2016
set -uo pipefail

[ $# -ge 4 ] || { echo "usage: pr.sh watch <owner>/<repo> <n> <dir> [<interval>] | reply-resolve <owner>/<repo> <n> <comment-id> <body>" >&2; exit 2; }
cmd=$1 repo=$2 pr=$3
token=${GH_TOKEN:-$(gh auth token)}
[ -n "$token" ] || { echo "auth GitHub のトークンが無い。GH_TOKEN を設定するか gh auth login する"; exit 1; }

req() { # <メソッド> <URL> [<JSON の本文>]: 応答の本文を出す。401 なら 2、他の失敗は 1 を返す
  local res code data=()
  [ $# -lt 3 ] || data=(--data "$3")
  res=$(printf 'Authorization: Bearer %s\n' "$token" | curl -sS --max-time 30 -X "$1" -H @- -H "Accept: application/vnd.github+json" "${data[@]}" -w '\n%{http_code}' "$2") || return 1
  code=${res##*$'\n'}
  case $code in 2??) printf '%s\n' "${res%$'\n'*}" ;; 401) return 2 ;; *) return 1 ;; esac
}
fail() { # <終了コード>: 401 (2) なら auth の行を出し、そのコードで終わる
  [ "$1" != 2 ] || echo "auth GitHub のトークンが無効 (401)。gh auth login してから起動し直す"
  exit "$1"
}
rest() { # <API パス (クエリ可)> <jq フィルタ>: 全ページを取り、各ページに jq を当てる
  local page=1 body sep='?'
  case $1 in *'?'*) sep='&' ;; esac
  while :; do
    body=$(req GET "https://api.github.com/$1${sep}per_page=100&page=$page") || return
    jq -r "$2" <<<"$body" || return 1
    [ "$(jq 'if type == "array" then length else (.check_runs // .statuses | length) end' <<<"$body")" -eq 100 ] || return 0
    page=$((page + 1))
  done
}
gql() { # <PR の接続のフィールド (after: $cursor を取る)> <接続のノードごとの jq フィルタ>: 全ページを取る
  local cursor=null body conn
  local q="query(\$owner:String!,\$name:String!,\$pr:Int!,\$cursor:String){repository(owner:\$owner,name:\$name){pullRequest(number:\$pr){$1}}}"
  while :; do
    body=$(req POST https://api.github.com/graphql "$(jq -n --arg q "$q" --arg o "${repo%/*}" --arg n "${repo#*/}" --argjson p "$pr" --argjson c "$cursor" '{query: $q, variables: {owner: $o, name: $n, pr: $p, cursor: $c}}')") || return
    jq -e '.errors == null' <<<"$body" > /dev/null || return 1
    conn=$(jq '.data.repository.pullRequest | to_entries[0].value' <<<"$body") || return 1
    jq -r ".nodes[] | $2" <<<"$conn" || return 1
    [ "$(jq -r .pageInfo.hasNextPage <<<"$conn")" = true ] || return 0
    cursor=$(jq .pageInfo.endCursor <<<"$conn")
  done
}

if [ "$cmd" = reply-resolve ]; then
  [ $# -eq 5 ] || { echo "usage: pr.sh reply-resolve <owner>/<repo> <n> <comment-id> <body>" >&2; exit 2; }
  id=$4 text=$5
  req POST "https://api.github.com/repos/$repo/pulls/$pr/comments/$id/replies" "$(jq -n --arg b "$text" '{body: $b}')" > /dev/null || fail $?
  thread=$(gql 'reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id comments(first:1){nodes{databaseId}}}}' "select(.comments.nodes[0].databaseId == $id) | .id") || fail $?
  [ -n "$thread" ] || { echo "pr.sh: レビューコメント $id を先頭に持つスレッドが無い" >&2; exit 1; }
  res=$(req POST https://api.github.com/graphql "$(jq -n --arg t "$thread" '{query: "mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}", variables: {t: $t}}')") || fail $?
  jq -e '.data.resolveReviewThread.thread.isResolved' <<<"$res" > /dev/null || { echo "pr.sh: resolve できない: $res" >&2; exit 1; }
  exit 0
fi
[ "$cmd" = watch ] || { echo "pr.sh: 知らないサブコマンド: $cmd" >&2; exit 2; }

dir=$4 interval=${5:-60}
state=$dir/state
mkdir -p "$dir" || exit
poll() { # 現状を「キー<TAB>版<TAB>イベント文」の行で出し、説明を $dir/body.new に置く。イベント文が空の行は版だけを追う
  local pr_json sha roots
  pr_json=$(req GET "https://api.github.com/repos/$repo/pulls/$pr") || return
  jq -r .body <<<"$pr_json" > "$dir/body.new" || return 1
  jq -r '"pr\t\(.state)\tpr \(.state) merged=\(.merged) \(.html_url)", "title\t\(.title | gsub("\t"; " "))\ttitle \(.title | gsub("\t"; " "))"' <<<"$pr_json" || return 1
  sha=$(jq -r .head.sha <<<"$pr_json") || return 1
  rest "repos/$repo/issues/$pr/comments" '.[] |
    if (.body | startswith("<!-- codex-pull-request-review-summary -->")) then
      if (.body | test("\\*\\*Completed\\*\\*")) then
        (first(.body | capture("`(?<c>[0-9a-f]{7,40})`").c) // "") as $c | "ic:\(.id)\tcompleted \($c)\tcodex-review completed \($c) \(.html_url)"
      else "ic:\(.id)\trunning\t" end
    else "ic:\(.id)\t\(.updated_at)\tcomment \(.user.login) \(.html_url)" end' || return
  # resolve の有無は GraphQL にしか無いので、unresolved のスレッドの先頭のコメントの id だけを取り、コメントは REST で全ページ取る (返信の in_reply_to_id は先頭を指す)
  roots=$(gql 'reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{databaseId}}}}' \
    'select(.isResolved | not) | .comments.nodes[0].databaseId') || return
  rest "repos/$repo/pulls/$pr/comments" "[${roots//$'\n'/,}] as \$roots | .[] | select((.in_reply_to_id // .id) as \$r | \$roots | any(. == \$r)) | \"rc:\\(.id)\\t\\(.updated_at)\\treview-comment \\(.user.login) \\(.html_url)\"" || return
  gql 'reviews(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{databaseId state body updatedAt url author{login}}}' \
    'select(.state != "COMMENTED" or .body != "") | "rv:\(.databaseId)\t\(.state) \(.updatedAt)\treview \(.state) \(.author.login) \(.url)"' || return
  rest "repos/$repo/commits/$sha/check-runs?filter=all" '.check_runs[] | select(.conclusion | IN("failure", "timed_out", "cancelled", "action_required", "startup_failure")) | "cr:\(.id)\t\(.conclusion)\tci-failure \(.name) \(.conclusion) \(.html_url)"' || return
  rest "repos/$repo/commits/$sha/status" '.statuses[] | select(.state == "failure" or .state == "error") | "st:\(.id)\t\(.state)\tci-failure \(.context) \(.state) \(.target_url)"' || return
}
diff_events() { # <現状>: 状態ファイルとの差をイベントの行で出す
  printf '%s\n' "$1" | awk -F'\t' 'NR == FNR { seen[$1] = $2; next } $3 == "" { next } !($1 in seen) { print "new " $3; next } seen[$1] != $2 { print "changed " $3 }' "$state" -
  if ! cmp -s "$dir/body" "$dir/body.new"; then echo "description changed"; diff -u "$dir/body" "$dir/body.new" | tail -n +3; fi
}
closed_line() { # <現状>: PR が閉じていれば、その行を出す
  printf '%s\n' "$1" | awk -F'\t' '$1 == "pr" && $2 == "closed" { print "changed " $3 }'
}
delay=$interval
while :; do
  cur=$(poll) && rc=0 || rc=$?
  if [ "$rc" = 0 ] && [ ! -f "$state" ]; then
    events=$(printf '%s\n' "$cur" | awk -F'\t' '$1 ~ /^(rc|cr|st):/ { print "open " $3 }'; closed_line "$cur")
  elif [ "$rc" = 0 ]; then
    events=$(diff_events "$cur")
    if [ -n "$events" ]; then
      # レビューコメントと Codex の summary の編集は続けて来るので、窓を置いてまとめる
      sleep 10
      # 取り直しが失敗したら、この周期は確定しない (body.new だけが次の版に進んでいる)
      if next=$(poll); then cur=$next events=$(diff_events "$cur"); else rc=$?; fi
    fi
    case $events in *"changed pr closed"*) ;; *) closed=$(closed_line "$cur") && events=${events:+$events$'\n'}$closed ;; esac
    events=${events%$'\n'}
  fi
  if [ "$rc" = 2 ]; then
    fail 2
  elif [ "$rc" != 0 ]; then
    delay=$((delay * 2 > 900 ? 900 : delay * 2))
  else
    delay=$interval
    printf '%s\n' "$cur" > "$state"
    mv "$dir/body.new" "$dir/body"
    [ -z "$events" ] || { printf '%s\n' "$events"; exit 0; }
  fi
  sleep "$delay"
done
