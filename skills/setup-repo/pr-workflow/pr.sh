#!/usr/bin/env bash
# gh.md の「PR の watch」と「返信と resolve」を GitHub の REST・GraphQL で行う。gh は sandbox 内で TLS に失敗するので、curl で呼ぶ。
#
# 使い方:
#   pr.sh watch <owner>/<repo> <PR 番号> <状態のディレクトリ> [<間隔の秒数 (1〜900 の整数、既定 60)>]
#     対応が要るものを見つけたら出して終わる (Bash ツールの run_in_background で回す)。同じ <状態のディレクトリ> で二重に起動しない (ロックしないので状態の読み書きが競合する)。
#     初回 (状態が無い): 以後の周期で出す対象 (コメント・本文のある COMMENTED の review・レビュアーごとに最後に提出した COMMENTED 以外の review が CHANGES_REQUESTED のもの・unresolved のレビューコメント・head の CI の失敗 (再実行や同じ context の後の status で置き換えられたものを含む)・閉じた PR・Completed の Codex の summary) が既にあれば、open で出して終わる。無ければ基準にして待つ。
#     以後: 前回との差 (コメント・review の追加と編集、タイトル、説明、CI の失敗、PR の close) を見つけたら、間隔と 10 秒の短いほうだけ待って取り直し、まとめて出して終わる。
#     出さないもの: resolve 済みのスレッドのレビューコメント、本文の無い COMMENTED の review (返信で作られる)、Codex の summary コメントの、今の head の Completed 以外への編集、Codex のレビューの利用上限のコメント (回復すると最新の head を自分でレビューする。canon: facts/codex-github/usage-limit-auto-resume)。
#     自分 (トークンの持ち主) の通常のコメントは出す (エージェントの返信とユーザー自身の指示を見分けられない)。
#   pr.sh reply-resolve <owner>/<repo> <PR 番号> <スレッド先頭のレビューコメントの id (整数)> <本文>
#     スレッドに返信し、そのスレッドを resolve する。
#   環境変数 GITHUB_API_URL: API の基点 (既定 https://api.github.com)。REST と GraphQL (<基点>/graphql) が同じ基点の下にある api.github.com の配置だけを扱い、GHES (REST は /api/v3、GraphQL は /api/graphql) は対象外。
# 出力 (watch、1 行 1 件): open・new・changed に続けてイベント文。説明の変更は "description changed" の行に unified diff が続く。
#   auth で始まる行を出して終わったら、トークンが無いか無効 (401)。error で始まる行なら、PR 番号・リポジトリ・権限・問い合わせの誤り (3xx、401 以外の 4xx、レート制限でない GraphQL の errors)。3xx はリポジトリの改名・移動で、新しい名前で起動し直す。
# 失敗: 一時的な API の失敗 (ネットワーク・5xx・レート制限の 403・429) は、watch では出さずに間隔を倍にして (上限 900 秒) 再試行し、reply-resolve では止まる。
#   reply-resolve は、止まった後にそのままやり直してよい (スレッドに自分の同じ本文の返信があれば返信を重ねない)。同じスレッドに並行に起動しない (返信の有無を見てから返信するまでに割り込まれると、返信が重なる)。
# 事前条件: curl と jq。トークンは GH_TOKEN か gh auth token。
# GraphQL の $cursor と jq の式は、単一引用符で展開させずに渡す
# shellcheck disable=SC2016
set -uo pipefail

[ $# -ge 4 ] || { echo "usage: pr.sh watch <owner>/<repo> <n> <dir> [<interval>] | reply-resolve <owner>/<repo> <n> <comment-id> <body>" >&2; exit 2; }
cmd=$1 repo=$2 pr=$3
# 無いと一時的な失敗と区別できずに再試行し続けるので、先に確かめる
if ! command -v curl > /dev/null || ! command -v jq > /dev/null; then echo "pr.sh: curl と jq が要る" >&2; exit 2; fi
api=${GITHUB_API_URL:-https://api.github.com}
token=${GH_TOKEN:-$(gh auth token)}
[ -n "$token" ] || { echo "auth GitHub のトークンが無い。GH_TOKEN を設定するか gh auth login する"; exit 1; }

req() { # <メソッド> <URL> [<JSON の本文>]: 応答の本文を出す。失敗は、一時的 (ネットワーク・5xx・レート制限。GraphQL の 200 の errors がレート制限を示すものを含む) なら 1、401 なら 2、3xx (リダイレクト。リポジトリの改名・移動) とそれ以外の 4xx とレート制限でない GraphQL の errors なら error の行を出して 3 を返す
  local res tail code remaining retry limited body data=()
  [ $# -lt 3 ] || data=(--data "$3")
  res=$(printf 'Authorization: Bearer %s\n' "$token" | curl -sS --max-time 30 -X "$1" -H @- -H "Accept: application/vnd.github+json" "${data[@]}" \
    -w '\n%{http_code}\t%header{x-ratelimit-remaining}\t%header{retry-after}' "$2") || return 1
  tail=${res##*$'\n'} body=${res%$'\n'*}
  IFS=$'\t' read -r code remaining retry <<<"$tail"
  # レート制限は、primary なら x-ratelimit-remaining が 0、secondary なら retry-after があるか remaining が 0、無ければ本文が示す (canon: facts/github/rest-rate-limit-responses)
  limited=
  if [ -n "$retry" ] || [ "$remaining" = 0 ] || [[ $body == *"rate limit"* ]]; then limited=1; fi
  case $code in
    2??)
      # GraphQL は失敗も 200 で返し、本文の errors に入れる
      if [[ $2 != */graphql ]] || jq -e '.errors == null' <<<"$body" > /dev/null; then printf '%s\n' "$body"; return 0; fi
      [ -z "$limited" ] || return 1 ;;
    401) return 2 ;;
    429) return 1 ;;
    403) [ -z "$limited" ] || return 1 ;;
    3?? | 4??) ;;
    *) return 1 ;;
  esac
  echo "error HTTP $code $1 $2: $body" >&2
  return 3
}
fail() { # <終了コード>: 401 (2) なら auth の行、恒久的な失敗 (3) なら error の行を出し、そのコードで終わる
  case $1 in
    2) echo "auth GitHub のトークンが無効 (401)。gh auth login してから起動し直す" ;;
    3) echo "error 引数か権限が誤っている (直前の行が GitHub の応答)" ;;
  esac
  exit "$1"
}
rest() { # <API パス (クエリ可)> <jq フィルタ>: 全ページを取り、各ページに jq を当てる
  local page=1 body sep='?'
  case $1 in *'?'*) sep='&' ;; esac
  while :; do
    body=$(req GET "$api/$1${sep}per_page=100&page=$page") || return
    jq -r "$2" <<<"$body" || return 1
    [ "$(jq 'if type == "array" then length else (.check_runs | length) end' <<<"$body")" -eq 100 ] || return 0
    page=$((page + 1))
  done
}
gql() { # <PR の接続のフィールド (after: $cursor を取る)> <接続のノードごとの jq フィルタ>: 全ページを取る
  local cursor=null body conn
  local q="query(\$owner:String!,\$name:String!,\$pr:Int!,\$cursor:String){repository(owner:\$owner,name:\$name){pullRequest(number:\$pr){$1}}}"
  while :; do
    body=$(req POST "$api/graphql" "$(jq -n --arg q "$q" --arg o "${repo%/*}" --arg n "${repo#*/}" --argjson p "$pr" --argjson c "$cursor" '{query: $q, variables: {owner: $o, name: $n, pr: $p, cursor: $c}}')") || return
    conn=$(jq '.data.repository.pullRequest | to_entries[0].value' <<<"$body") || return 1
    jq -r ".nodes[] | $2" <<<"$conn" || return 1
    [ "$(jq -r .pageInfo.hasNextPage <<<"$conn")" = true ] || return 0
    cursor=$(jq .pageInfo.endCursor <<<"$conn")
  done
}

if [ "$cmd" = reply-resolve ]; then
  [ $# -eq 5 ] || { echo "usage: pr.sh reply-resolve <owner>/<repo> <n> <comment-id> <body>" >&2; exit 2; }
  id=$4 text=$5
  # jq のフィルタに埋め込むので、整数に限る
  [[ $id =~ ^[0-9]+$ ]] || { echo "pr.sh: コメントの id は整数: $id" >&2; exit 2; }
  thread=$(gql 'reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id comments(first:1){nodes{databaseId}}}}' \
    "select(.comments.nodes[0].databaseId == $id) | .id") || fail $?
  [ -n "$thread" ] || { echo "pr.sh: レビューコメント $id を先頭に持つスレッドが無い" >&2; exit 1; }
  # 返信の後の resolve が失敗してやり直しても返信を重ねないように、スレッドに自分の同じ本文の返信があれば返信しない (間に他の返信があっても見つける)
  me=$(req POST "$api/graphql" '{"query":"{viewer{login}}"}' | jq -r .data.viewer.login) || fail $?
  if [ -z "$me" ] || [ "$me" = null ]; then echo "error トークンの持ち主 (GraphQL の viewer) が分からないので、返信の重複を判定できない"; exit 3; fi
  posted=$(rest "repos/$repo/pulls/$pr/comments" \
    ".[] | select(.in_reply_to_id == $id and .user.login == $(jq -n --arg m "$me" '$m') and .body == $(jq -n --arg t "$text" '$t')) | .id") || fail $?
  if [ -z "$posted" ]; then
    req POST "$api/repos/$repo/pulls/$pr/comments/$id/replies" "$(jq -n --arg b "$text" '{body: $b}')" > /dev/null || fail $?
  fi
  res=$(req POST "$api/graphql" "$(jq -n --arg t "$thread" '{query: "mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}", variables: {t: $t}}')") || fail $?
  jq -e '.data.resolveReviewThread.thread.isResolved' <<<"$res" > /dev/null || { echo "pr.sh: resolve できない: $res" >&2; exit 1; }
  exit 0
fi
[ "$cmd" = watch ] || { echo "pr.sh: 知らないサブコマンド: $cmd" >&2; exit 2; }

dir=$4 interval=${5:-60}
# バックオフで倍にする (上限 900) ので、整数の算術があふれない 1〜900 に限る
if ! [[ $interval =~ ^[1-9][0-9]{0,2}$ ]] || [ "$interval" -gt 900 ]; then echo "pr.sh: 間隔は 1〜900 の整数の秒数: $interval" >&2; exit 2; fi
state=$dir/state
mkdir -p "$dir" || exit
poll() { # 現状を「キー<TAB>版<TAB>イベント文」の行で出し、説明を $dir/body.new に置く。イベント文が空の行は版だけを追う
  local pr_json sha roots
  pr_json=$(req GET "$api/repos/$repo/pulls/$pr") || return
  jq -r .body <<<"$pr_json" > "$dir/body.new" || return 1
  jq -r '"pr\t\(.state)\tpr \(.state) merged=\(.merged) \(.html_url)", "title\t\(.title | gsub("\t"; " "))\ttitle \(.title | gsub("\t"; " "))"' <<<"$pr_json" || return 1
  sha=$(jq -r .head.sha <<<"$pr_json") || return 1
  # push の直後は前の commit の Completed が残るので、Commit が今の head のときだけ Completed として出す
  rest "repos/$repo/issues/$pr/comments" "\"$sha\" as \$head | "'.[] |
    if .user.login == "chatgpt-codex-connector[bot]" and (.body | startswith("<!-- codex-pull-request-review-summary -->")) then
      (first(.body | capture("`(?<c>[0-9a-f]{7,40})`").c) // "") as $c |
      if (.body | test("\\*\\*Completed\\*\\*")) and $c != "" and ($head | startswith($c)) then
        "ic:\(.id)\tcompleted \($c)\tcodex-review completed \($c) \(.html_url)"
      else "ic:\(.id)\tother \($c)\t" end
    elif .user.login == "chatgpt-codex-connector[bot]" and (.body | startswith("You have reached your Codex usage limits for code reviews.")) then
      "ic:\(.id)\t\(.updated_at)\t"
    else "ic:\(.id)\t\(.updated_at)\tcomment \(.user.login) \(.html_url)" end' || return
  # resolve の有無は GraphQL にしか無いので、unresolved のスレッドの先頭のコメントの id だけを取り、コメントは REST で全ページ取る (返信の in_reply_to_id は先頭を指す)
  roots=$(gql 'reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{databaseId}}}}' \
    'select(.isResolved | not) | .comments.nodes[0].databaseId') || return
  rest "repos/$repo/pulls/$pr/comments" "[${roots//$'\n'/,}] as \$roots | .[] | select((.in_reply_to_id // .id) as \$r | \$roots | any(. == \$r)) | \"rc:\\(.id)\\t\\(.updated_at)\\treview-comment \\(.user.login) \\(.html_url)\"" || return
  # 本文のある COMMENTED の review と、レビュアーごとに最後に提出した (submittedAt が最大の) COMMENTED 以外の review が CHANGES_REQUESTED ならそれを出す。
  # APPROVED と上書きされた review は出さない。PENDING は提出前の下書きなので、最後の判定に入れない
  gql 'reviews(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{databaseId state body submittedAt updatedAt url author{login}}}' \
    '"\(.state)\t\(.author.login)\t\(.body != "")\t\(.submittedAt)\trv:\(.databaseId)\t\(.state) \(.updatedAt)\treview \(.state) \(.author.login) \(.url)"' |
    awk -F'\t' -v OFS='\t' '
      $1 == "COMMENTED" { if ($3 == "true") print $5, $6, $7; next }
      $1 == "PENDING" { next }
      !($2 in at) || $4 > at[$2] { at[$2] = $4; last[$2] = $5 OFS $6 OFS $7; state[$2] = $1 }
      END { for (a in last) if (state[a] == "CHANGES_REQUESTED") print last[a] }' || return
  rest "repos/$repo/commits/$sha/check-runs?filter=all" '.check_runs[] | select(.conclusion | IN("failure", "timed_out", "cancelled", "action_required", "startup_failure")) | "cr:\(.id)\t\(.conclusion)\tci-failure \(.name) \(.conclusion) \(.html_url)"' || return
  rest "repos/$repo/commits/$sha/statuses" '.[] | select(.state == "failure" or .state == "error") | "st:\(.id)\t\(.state)\tci-failure \(.context) \(.state) \(.target_url)"' || return
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
    # 以後の周期で出す対象は、起動の前からあるものも出す (基準に黙って入れると二度と出ない)。タイトルと説明は変化だけが対象
    events=$(printf '%s\n' "$cur" | awk -F'\t' '$3 != "" && $1 != "pr" && $1 != "title" { print "open " $3 }'; closed_line "$cur")
  elif [ "$rc" = 0 ]; then
    events=$(diff_events "$cur")
    if [ -n "$events" ]; then
      # レビューコメントと Codex の summary の編集は続けて来るので、窓を置いてまとめる
      sleep $((interval < 10 ? interval : 10))
      # 取り直しが失敗したら、この周期は確定しない (body.new だけが次の版に進んでいる)
      if next=$(poll); then cur=$next events=$(diff_events "$cur"); else rc=$?; fi
    fi
    case $events in *"changed pr closed"*) ;; *) closed=$(closed_line "$cur") && events=${events:+$events$'\n'}$closed ;; esac
    events=${events%$'\n'}
  fi
  if [ "$rc" = 2 ] || [ "$rc" = 3 ]; then
    fail "$rc"
  elif [ "$rc" != 0 ]; then
    delay=$((delay * 2 > 900 ? 900 : delay * 2))
  else
    delay=$interval
    # 出せたときだけ記録する (記録の前に止まれば、次の起動で同じものをもう一度出す)
    if [ -n "$events" ]; then printf '%s\n' "$events" || exit 1; fi
    printf '%s\n' "$cur" > "$state"
    mv "$dir/body.new" "$dir/body"
    [ -z "$events" ] || exit 0
  fi
  sleep "$delay"
done
