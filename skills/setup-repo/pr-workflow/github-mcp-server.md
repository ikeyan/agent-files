# 手段: GitHub MCP Server

GitHub 公式の MCP サーバ (github/github-mcp-server)。リモート版は `https://api.githubcopilot.com/mcp/` で、tool 名には接続名の接頭辞が付く。2026-09-16 に local CLI から接続して schema を確認した。

- **ツールセット**: 既定の URL で使えるのは context / repos / issues / pull_requests / users のツールセット。CI のログ (`get_job_logs`) やワークフローの操作 (`actions_*`) は `actions` ツールセットにあり、既定では使えない。要るなら `https://api.githubcopilot.com/mcp/x/actions` (全部入りは `/x/all`) を MCP サーバとして追加する (README と docs/remote-server.md)。
- **ブランチの push**: 作業ツリーの git で行う (`git push -u <remote> <branch>`)。`create_or_update_file` / `push_files` は GitHub 側でコミットを作るので、ローカルの履歴とずれる。作り直したブランチの上書きは pr-workflow の「ブランチの更新」。
- **PR の作成**: `create_pull_request`
- **PR の説明の更新**: `update_pull_request`
- **コメントの読み取り**: `pull_request_read` の `get_comments` (通常コメント) / `get_review_comments` (スレッド単位。スレッド id `PRRT_…` を含む) / `get_reviews` (approve / request changes の本文)。最後のページまで読む (`get_review_comments` は `after`、他は `page` / `perPage`)。
- **返信**: `add_reply_to_pull_request_comment`。`commentId` は `#discussion_r…` の数値 id で、スレッドの `PRRT_…` ではない。
- **resolve**: `pull_request_review_write` の method `resolve_thread` (`threadId` に `PRRT_…`)。
- **CI**: 成功を見届けるときは、pr-workflow の「CI の確認」どおり必要な check を特定し、push したコミットの SHA を指定して結果を読む。
  - `get_check_runs` では判定しない。結果に run ごとのコミットの SHA が無く、呼び出しの内部で PR の head を読むので、push 直後は前のコミットの run を返しうる (API の PR の head は push 後しばらく古いことがある)。時刻で絞っても、キュー待ちや `needs:` で後から始まった前のコミットの run と区別できない。
  - push したコミットの SHA を `git ls-remote <remote> "refs/heads/<branch>"` で読み (ref 名が完全一致する行を採る)、その SHA を指定して Checks API を読む。`gh` があれば gh.md の「CI」の手順。無ければトークンで `curl` から `https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs` を読む。check 名は URL に直接書かず `--get --data-urlencode "check_name=<check>"` で渡し (空白や `&` を含む名前が URL を壊す)、トークンは引数でなく標準入力から `-H @-` で渡す。全ページについて、その名前の run が 1 件以上あり全部が `completed` になるまで待つ。トークンが無ければ、確かめられなかったとユーザーに報告する。
  - 旧来の commit status で報告する CI (外部 CI 等) は `get_status` の該当する context で見る。結果の `sha` が push したコミットの SHA と一致するときだけ使う (github-mcp-server の `get_status` は `sha` を返す。2026-09-17 に確認)。最上位の `state` は判定に使わない (status が 0 件だと緑でも `pending` になる)。
  - ログは `actions` ツールセットの `get_job_logs`。
- **イベント**: 購読の仕組みは無い。待つなら gh.md の「PR の watch」を使う (MCP の tool は Monitor のループから呼べない)。GitHub のトークンが要るので、`gh` が無い環境では `GH_TOKEN` を設定する。
