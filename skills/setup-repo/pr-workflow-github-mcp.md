# 手段: GitHub MCP

tool 名は MCP サーバごとに違う。以下は 2 つのサーバで確かめたもので、括弧が無い名前は両方に同じ名前である。実際に使える名前は手元のツール一覧で確かめる。

- **ブランチの push**: 作業ツリーの git で行う (`git push -u <remote> <branch>`)。MCP の `create_or_update_file` / `push_files` は GitHub 側でコミットを作るので、ローカルの履歴とずれる。作り直したブランチの上書きは `canon: facts/git/force-with-lease-recreated-branch`。
- **PR の作成**: `create_pull_request`
- **PR の説明の更新**: `update_pull_request`
- **コメントの読み取り**: `pull_request_read` の `get_comments` (通常コメント) / `get_review_comments` (スレッド id `PRRT_…` と `is_resolved`) / `get_reviews` (approve / request changes の本文)。`page` / `after` で最後のページまで読む。
- **返信**: `add_reply_to_pull_request_comment`。`commentId` は `#discussion_r…` の数値 id で、スレッドの `PRRT_…` ではない。
- **resolve**: api.githubcopilot.com では `pull_request_review_write` の method `resolve_thread` (`threadId` に `PRRT_…`)。cc-web では `resolve_review_thread`。
- **CI**: `pull_request_read` の `get_check_runs` (Checks API) と `get_status` (Commit Status API。required checks には旧来の status context もあり、`get_check_runs` には出ない)。どちらも 0 件を未着と区別できないので、必要な check が現れるまで再読する (`send_later` の check-in 等)。
- **イベント**: `subscribe_pr_activity` (cc-web のみ)。CI の失敗は届くが成功は届かない。届く種類の制限は cc-web-sandbox-signals skill。
