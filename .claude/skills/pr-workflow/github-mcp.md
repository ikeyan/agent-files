# 手段: GitHub MCP

このリポの作業は local CLI から行うので、使うのは api.githubcopilot.com 系 (`get_me` で疎通を確認済み)。cc-web から触るときのために両方を残してある。tool 名と品揃えはサーバごとに違う。cc-web には 3 系統 (`mcp__github__`、`mcp__https_api_githubcopilot_com_mcp__`、`mcp__Claude_Code_Remote__`) が同居し、local CLI からは copilot 系が使える (2026-09-16 実測)。以下は接続中のサーバのツール一覧で名前を確かめてから使う。

- **ブランチの push**: 作業ツリーの git で行う (`git push -u <remote> <branch>`)。cc-web でも HTTPS + `GIT_ASKPASS` で push 権があることを `git push --dry-run` で確認済み (ref 単位の protection は未検証)。MCP の `create_or_update_file` / `push_files` は GitHub 側でコミットを作るので、ローカルの履歴とずれる。作り直したブランチの上書きは pr-workflow の「ブランチの更新」。
- **PR の作成**: `create_pull_request`
- **PR の説明の更新**: `update_pull_request`
- **コメントの読み取り**: `pull_request_read` の `get_comments` (通常コメント) / `get_review_comments` (スレッド id `PRRT_…` と `is_resolved`) / `get_reviews` (approve / request changes の本文)。`page` / `after` で最後のページまで読む。
- **返信**: `add_reply_to_pull_request_comment`。`commentId` は `#discussion_r…` の数値 id で、スレッドの `PRRT_…` ではない。
- **resolve**: `pull_request_review_write` の method `resolve_thread` (`threadId` に `PRRT_…`。どのサーバにもある)。`mcp__github__` には単体の `resolve_review_thread` / `unresolve_review_thread` もある。
- **CI**: `pull_request_read` の `get_check_runs` (Checks API) と `get_status` (Commit Status API。required checks には旧来の status context もあり、`get_check_runs` には出ない)。どちらも 0 件を未着と区別できないので、必要な check が現れるまで再読する (cc-web なら `send_later` の check-in 等)。ログは `mcp__github__get_job_logs`、単一 check の詳細は `mcp__github__get_check_run` (copilot 系には無い)。
- **イベント**: `subscribe_pr_activity` (cc-web のみ。`owner` / `repo` / `pullNumber`)。届くのはコメント・CI の失敗・成功した check-suite のロールアップと schema にあるが、cc-web-sandbox-signals skill は CI 成功が届かないと記録しており食い違っている。未確定なので成功が届く前提で待たない。PR Steward が watch 中のリポではイベントが届かない (tool の結果にその旨が出る)。
