# 手段: GitHub MCP Server

GitHub 公式の MCP サーバ (github/github-mcp-server)。リモート版は `https://api.githubcopilot.com/mcp/` で、tool 名には接続名の接頭辞が付く。2026-09-16 に local CLI から接続して schema を確認した。

- **ツールセット**: 既定の URL で使えるのは context / repos / issues / pull_requests / users のツールセット。CI のログ (`get_job_logs`) やワークフローの操作 (`actions_*`) は `actions` ツールセットにあり、既定では使えない。要るなら `https://api.githubcopilot.com/mcp/x/actions` (全部入りは `/x/all`) を MCP サーバとして追加する (README と docs/remote-server.md)。
- **ブランチの push**: 作業ツリーの git で行う (`git push -u <remote> <branch>`)。`create_or_update_file` / `push_files` は GitHub 側でコミットを作るので、ローカルの履歴とずれる。作り直したブランチの上書きは pr-workflow の「ブランチの更新」。
- **PR の作成**: `create_pull_request`
- **PR の説明の更新**: `update_pull_request`
- **コメントの読み取り**: `pull_request_read` の `get_comments` (通常コメント) / `get_review_comments` (スレッド単位。スレッド id `PRRT_…` を含む) / `get_reviews` (approve / request changes の本文)。最後のページまで読む (`get_review_comments` は `after`、他は `page` / `perPage`)。
- **返信**: `add_reply_to_pull_request_comment`。`commentId` は `#discussion_r…` の数値 id で、スレッドの `PRRT_…` ではない。
- **resolve**: `pull_request_review_write` の method `resolve_thread` (`threadId` に `PRRT_…`)。
- **CI**: `pull_request_read` の `get_check_runs` (Checks API) と `get_status` (Commit Status API。旧来の status context は `get_check_runs` に出ない)。どちらも 0 件を未着と区別できないので、必要な check が現れるまで再読する。ログは `actions` ツールセットの `get_job_logs`。
- **イベント**: 購読の仕組みは無い。待つなら gh.md の「PR の watch」を使う (MCP の tool は Monitor のループから呼べない)。
