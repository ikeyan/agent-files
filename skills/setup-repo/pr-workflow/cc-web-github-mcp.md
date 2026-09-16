# 手段: cc-web の GitHub MCP

Claude Code on the web に組み込まれた GitHub MCP (`mcp__github__`)。github-mcp-server とは別の実装で、`resolve_review_thread` や `subscribe_pr_activity` は github-mcp-server に無い。セッションに紐づいたリポ以外は読めない。2026-09-16 に cc-web のセッションで schema を確認した。

- **ブランチの push**: 作業ツリーの git で行う (`git push -u <remote> <branch>`)。HTTPS + `GIT_ASKPASS` で push 権があることを `git push --dry-run` で確認済み (ref 単位の protection は未検証)。`create_or_update_file` / `push_files` は GitHub 側でコミットを作るので、ローカルの履歴とずれる。作り直したブランチの上書きは pr-workflow の「ブランチの更新」。
- **PR の作成**: `create_pull_request`
- **PR の説明の更新**: `update_pull_request`
- **コメントの読み取り**: `pull_request_read` の `get_comments` (通常コメント) / `get_review_comments` (スレッド単位。スレッド id `PRRT_…` を含む) / `get_reviews` (approve / request changes の本文)。最後のページまで読む。
- **返信**: `add_reply_to_pull_request_comment`。`commentId` は `#discussion_r…` の数値 id で、スレッドの `PRRT_…` ではない。
- **resolve**: `resolve_review_thread` (`owner` / `repo` / `threadId`)。`pull_request_review_write` の method `resolve_thread` でもよい。
- **CI**: `pull_request_read` の `get_check_runs` (Checks API) と `get_status` (Commit Status API。旧来の status context は `get_check_runs` に出ない)。どちらも 0 件を未着と区別できないので、必要な check が現れるまで再読する (`send_later` の check-in 等)。単一 check の詳細は `get_check_run` (`checkRunId`)、ログは `get_job_logs`。
- **イベント**: `subscribe_pr_activity` (`owner` / `repo` / `pullNumber`)。届くのはコメント・CI の失敗・成功した check-suite のロールアップと schema にあるが、cc-web-sandbox-signals skill は CI 成功が届かないと記録しており食い違っている。未確定なので成功が届く前提で待たない。PR Steward が watch 中のリポではイベントが届かない (tool の結果にその旨が出る)。
