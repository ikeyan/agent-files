# 手段: gh

gh 2.98.0 で `--help` と実行を確認したもの。「未実測」と書いたものだけ確認していない。

- **ブランチの push**: `git push -u <remote> <branch>`。作り直したブランチの上書きは pr-workflow の「ブランチの更新」。
- **PR の作成**: `gh pr create --base <既定ブランチ> --title <title> --body-file <file>`。下書きは `--draft`、作らずに内容を確かめるなら `--dry-run`。
- **PR の説明の更新**: `gh pr edit <n> --body-file <file>`。draft の切り替えは `gh pr edit` でなく `gh pr ready` (`--undo` で draft へ戻す)。
- **コメントの読み取り**:
  - `gh pr view <n> --comments` — PR 本文とコメント。
  - `gh api --paginate <endpoint>` — REST。
  - `gh api graphql` — スレッドの `isResolved` / `isOutdated` はここでしか取れない。
- **返信**: `gh api --method POST repos/<owner>/<repo>/pulls/<n>/comments/<id>/replies -f body=<text>`。`<id>` はスレッド先頭のレビューコメントの数値 id (`#discussion_r…` の数字)。返信への返信はできない。
- **resolve**: `gh api graphql -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}' -f threadId=<PRRT_…>`。
- **CI**:
  - 現れている check の一覧: `gh pr checks <n> --json name,bucket,link`
  - `gh pr checks` は check が 1 件も無いと `no checks reported` で exit 1 になる (`--json` / `--watch` でも)。CI の失敗とも完了とも扱わない (CI が無いのか未登録なのか区別できない。`canon: facts/gh/pr-checks-zero-checks-and-exit-codes`)。
  - 現れている check が全部終端になるまで待つ: `gh pr checks <n> --watch` (待ち時間は有界にする。push 直後は前のコミットの check を見ることがある。後から登録された check を拾うかは未実測)
  - 特定の check が push したコミットで終端になるまで待つ。`gh pr checks` は push 直後に前のコミットの check を返すことがあるので、SHA を指定して Checks API を読む:

    ```sh
    refs=$(git ls-remote <remote> "refs/heads/<branch>") || exit 1
    sha=$(printf '%s\n' "$refs" | awk -v r="refs/heads/<branch>" '$2 == r { print $1 }')
    [ -n "$sha" ] || { echo "<remote> に <branch> が無い"; exit 1; }
    end=$((SECONDS + <秒数>))
    until statuses=$(gh api --paginate -X GET "repos/<owner>/<repo>/commits/$sha/check-runs" -f check_name='<check>' --jq '.check_runs[].status') &&
      [ -n "$statuses" ] && ! command grep -qvx completed <<<"$statuses"; do
      [ $SECONDS -lt $end ] || { echo "timeout"; exit 1; }
      sleep 15
    done
    gh api --paginate -X GET "repos/<owner>/<repo>/commits/$sha/check-runs" -f check_name='<check>' --jq '.check_runs[] | "\(.name) \(.app.slug) \(.conclusion) \(.html_url)"'
    ```

    - SHA は `git ls-remote` で読み、ref 名が完全一致する行を採る。ローカルの `HEAD`・remote-tracking ref・API の PR の head からは取らない。自分が push していない PR も、その head ブランチを同じように読む (fork なら fork 側の remote)。
    - 同じ名前の run は全部が `completed` になるまで待つ。
    - 判定の `command grep` を `grep` に戻さない (Bash ツールの `grep` は `-q` と `-v` の併用で終了コードが逆になる)。
    - 旧来の commit status で報告する CI は、この API でなく `gh api repos/<owner>/<repo>/commits/$sha/status` の該当する context を見る。
    - 根拠: `canon: facts/gh/pr-checks-zero-checks-and-exit-codes`、`canon: facts/claude-code/bash-tool-grep-wrapper-qv-exit-code`
  - ログ: Actions の check は `link` の URL から `<jobId>` を取って `gh run view --job <jobId> --log-failed` (`canon: facts/gh/pr-checks-link-to-run-logs`)。Actions 以外の check は `link` の URL を見る。
- **PR の watch** (コメントの作成・編集、review、CI の失敗、PR の close を待つ): Monitor ツールで回す。stdout の 1 行が 1 通知になる。`curl` と `jq` が要る。
  1. watch ごとに専用のディレクトリを作り、出力されたパスを `<dir>` として使う: `mktemp -d -p "${TMPDIR:-/tmp}" watch-pr.XXXXXX`。共有の `/tmp` に固定名で置かない (`canon: facts/shell/mktemp-tmpdir-handling-bsd-vs-gnu`)。
  2. 次を `<dir>/watch-pr.sh` に保存し、Monitor ツールで `bash <dir>/watch-pr.sh <owner>/<repo> <n> <dir>/state` を回す (`timeout_ms` は上限の 30 分)。

    ```bash
    repo=$1 pr=$2 state=$3 interval=${4:-60}
    token=${GH_TOKEN:-$(gh auth token)}
    [ -n "$token" ] || { echo "error GitHub のトークンが無い。GH_TOKEN を設定するか gh auth login する"; exit 1; }
    get() { # <API パス (クエリ可)> <jq フィルタ>: 全ページを取り、各ページに jq を当てる
      local page=1 body sep='?'
      case $1 in *'?'*) sep='&' ;; esac
      while :; do
        body=$(printf 'Authorization: Bearer %s\n' "$token" | curl -fsS --max-time 30 -H @- -H "Accept: application/vnd.github+json" "https://api.github.com/$1${sep}per_page=100&page=$page") || return 1
        jq -r "$2" <<<"$body" || return 1
        [ "$(jq 'if type == "array" then length else (.check_runs // .statuses | length) end' <<<"$body")" -eq 100 ] || return 0
        page=$((page + 1))
      done
    }
    poll() { # 現状を「キー<TAB>版<TAB>イベント文」の行で出す。API が 1 つでも失敗したら 1 を返す
      local head sha
      head=$(get "repos/$repo/pulls/$pr" '"\(.head.sha)\tpr\t\(.state)\tpr \(.state) merged=\(.merged) \(.html_url)"') || return 1
      sha=${head%%$'\t'*}
      printf '%s\n' "${head#*$'\t'}"
      get "repos/$repo/issues/$pr/comments" '.[] | "ic:\(.id)\t\(.updated_at)\tcomment \(.user.login) \(.html_url)"' || return 1
      get "repos/$repo/pulls/$pr/comments" '.[] | "rc:\(.id)\t\(.updated_at)\treview-comment \(.user.login) \(.html_url)"' || return 1
      get "repos/$repo/pulls/$pr/reviews" '.[] | "rv:\(.id)\t\(.state)\treview \(.state) \(.user.login) \(.html_url)"' || return 1
      get "repos/$repo/commits/$sha/check-runs?filter=all" '.check_runs[] | select(.conclusion | IN("failure", "timed_out", "cancelled", "action_required", "startup_failure")) | "cr:\(.id)\t\(.conclusion)\tci-failure \(.name) \(.conclusion) \(.html_url)"' || return 1
      get "repos/$repo/commits/$sha/status" '.statuses[] | select(.state == "failure" or .state == "error") | "st:\(.id)\t\(.state)\tci-failure \(.context) \(.state) \(.target_url)"' || return 1
    }
    failing=
    while :; do
      if ! cur=$(poll); then
        [ -n "$failing" ] || echo "error GitHub API の取得に失敗した。$interval 秒ごとに再試行する"
        failing=1
      else
        failing=
        events=
        if [ -f "$state" ]; then
          events=$(printf '%s\n' "$cur" | awk -F'\t' 'NR == FNR { seen[$1] = $2; next } !($1 in seen) { print "new " $3; next } seen[$1] != $2 { print "changed " $3 }' "$state" -)
        fi
        [ -z "$events" ] || printf '%s\n' "$events"
        printf '%s\n' "$cur" > "$state"
        case $cur in
          *$'pr\tclosed\t'*)
            # 開始時点で閉じていた・初回の周期で閉じた場合も、終わる理由を 1 行出す
            case $events in *"pr closed"*) ;; *) printf '%s\n' "$cur" | awk -F'\t' '$1 == "pr" { print "changed " $3 }' ;; esac
            exit 0
            ;;
        esac
      fi
      sleep "$interval"
    done
    ```

  - HTTP を `gh api` に書き換えない、トークンを `curl` の引数に載せない、CI の失敗の取得から `filter=all` を外さない。根拠: `canon: facts/claude-code/monitor-runs-in-sandbox-gh-tls`、`canon: facts/shell/process-args-visible-via-ps`、`canon: facts/github/check-runs-filter-latest-hides-reruns`
  - 状態ファイルは前回見た内容。初回は基準を作るだけで何も出さない (開始時点で既にあるものも出ない)。
  - 終了条件: PR が閉じられたら (開始時点で閉じていた場合も) 1 行出して終わる。Monitor が 30 分で失効したら、同じ `<dir>` の状態ファイルで起動し直す。止まっていた間の変化もその時点で出る。
  - 間隔は既定 60 秒。API の取得に失敗し始めたら 1 行出し、同じ間隔で再試行を続ける。
