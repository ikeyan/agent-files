# 手段: gh

gh 2.98.0 で `--help` と実行を確認したもの。「未実測」と書いたものだけ確認していない。このリポでは PR #12 で push・PR 作成・説明更新・check 待ち・失敗ログ取得を、PR #13 でレビューコメントへの返信と resolve を通した。

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
  - 現れている check が全部終端になるまで待つ: `gh pr checks <n> --watch` (待ち時間は有界にする。push 直後は前のコミットの check を見ることがある。後から登録された check を拾うかは未実測)
  - 特定の check が現れて終端になるまで待つ。push 直後の `gh pr checks` は前のコミットの check を返すことがあり、そのまま待つと古い結果で終端と誤判定する。head の SHA を指定して Checks API を見る:

    ```sh
    sha=$(git rev-parse HEAD)
    end=$((SECONDS + <秒数>))
    until gh api --paginate "repos/<owner>/<repo>/commits/$sha/check-runs" --jq '.check_runs[] | select(.name == "<check>") | .status' | grep -qx completed; do
      [ $SECONDS -lt $end ] || { echo "timeout"; exit 1; }
      sleep 15
    done
    gh api --paginate "repos/<owner>/<repo>/commits/$sha/check-runs" --jq '.check_runs[] | select(.name == "<check>") | .conclusion'
    ```

    check がまだ 0 件でも出力が空になるだけなのでループは回り続ける。旧来の commit status (`gh api repos/<owner>/<repo>/commits/$sha/status`) はこの API に出ない。根拠と実測: `canon: facts/gh/pr-checks-zero-checks-and-exit-codes`
  - ログ: Actions の check は `link` の URL から `<jobId>` を取って `gh run view --job <jobId> --log-failed` (`canon: facts/gh/pr-checks-link-to-run-logs`)。Actions 以外の check は `link` の URL を見る。
- **PR の watch** (コメントの作成・編集、review、CI の失敗、PR の close を待つ): 次を `$TMPDIR/watch-pr.sh` に保存し、Monitor ツールで `bash $TMPDIR/watch-pr.sh <owner>/<repo> <n> $TMPDIR/pr-<n>.state` を回す (`timeout_ms` は上限の 30 分)。stdout の 1 行が 1 通知になる。

    ```bash
    repo=$1 pr=$2 state=$3 interval=${4:-60}
    token=${GH_TOKEN:-$(gh auth token)}
    get() { # <API パス> <jq フィルタ>: 全ページを取り、各ページに jq を当てる
      local page=1 body
      while :; do
        body=$(curl -fsS --max-time 30 -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" "https://api.github.com/$1?per_page=100&page=$page") || return 1
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
      get "repos/$repo/commits/$sha/check-runs" '.check_runs[] | select(.conclusion | IN("failure", "timed_out", "cancelled", "action_required", "startup_failure")) | "cr:\(.id)\t\(.conclusion)\tci-failure \(.name) \(.conclusion) \(.html_url)"' || return 1
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

  - HTTP は `gh api` でなく `curl` で送り、`gh` はトークンを取るのにだけ使う。Monitor は Bash と同じサンドボックス内で動き、macOS ではサンドボックス内の `gh api` が TLS 検証に失敗する (`SSL_CERT_FILE` を指定しても変わらない)。`curl` と `jq` が要る。
  - 状態ファイルは前回見た内容。初回は基準を作るだけで、コメントや CI の失敗は出さない (開始時点で既にあるものも出ない)。
  - 終了条件: PR が閉じられたら 1 行出して終わる。開始時点で閉じていた場合も 1 行出して終わる。Monitor が 30 分で失効したら、同じ状態ファイルで起動し直す。止まっていた間の変化もその時点で出る。
  - 間隔は既定 60 秒。1 周に 6 リクエスト前後なので 1 時間に 360 程度で、認証済みの上限 (5,000/時) に収まる。
  - API の取得に失敗し始めたら 1 行出し、同じ間隔で再試行を続ける。失敗が続いても繰り返しは出さない。
