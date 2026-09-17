# 手段: cc-web の GitHub MCP

Claude Code on the web に組み込まれた GitHub MCP (`mcp__github__`)。github-mcp-server とは別の実装で、`resolve_review_thread` や `subscribe_pr_activity` は github-mcp-server に無い。セッションに紐づいたリポ以外は読めない。2026-09-16 に cc-web のセッションで schema を確認した。

- **ブランチの push**: 作業ツリーの git で行う (`git push -u <remote> <branch>`)。HTTPS + `GIT_ASKPASS` で push 権があることを `git push --dry-run` で確認済み (ref 単位の protection は未検証)。`create_or_update_file` / `push_files` は GitHub 側でコミットを作るので、ローカルの履歴とずれる。作り直したブランチの上書きは pr-workflow の「ブランチの更新」。
- **PR の作成**: `create_pull_request`
- **PR の説明の更新**: `update_pull_request`
- **コメントの読み取り**: `pull_request_read` の `get_comments` (通常コメント) / `get_review_comments` (スレッド単位。スレッド id `PRRT_…` を含む) / `get_reviews` (approve / request changes の本文)。最後のページまで読む。
- **返信**: `add_reply_to_pull_request_comment`。`commentId` は `#discussion_r…` の数値 id で、スレッドの `PRRT_…` ではない。イベントの `comment_id` はそのまま渡せる。
- **resolve**: `resolve_review_thread` (`owner` / `repo` / `threadId`)。`pull_request_review_write` の method `resolve_thread` でもよい。`PRRT_…` はイベントの payload に無いので `get_review_comments` で取り直す。
- **CI**: 成功を見届けるときは、pr-workflow の「CI の確認」どおり必要な check を特定し、push したコミットの SHA を指定して結果を読む (`send_later` の check-in 等で再読する)。
  - `get_check_runs` では判定しない。結果に run ごとのコミットの SHA が無く、呼び出しの内部で PR の head を読むので、push 直後は前のコミットの run を返しうる (API の PR の head は push 後しばらく古いことがある)。時刻で絞っても、キュー待ちや `needs:` で後から始まった前のコミットの run と区別できない。
  - push したコミットの SHA を `git ls-remote <remote> "refs/heads/<branch>"` で読み (ref 名が完全一致する行を採る)、その SHA を指定して Checks API を読む。`gh` があれば gh.md の「CI」の手順。無ければトークンで `curl` から `https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs?check_name=<check>` を読み、全ページについて、その名前の run が 1 件以上あり全部が `completed` になるまで待つ。トークンが無ければ、確かめられなかったとユーザーに報告する。
  - 旧来の commit status で報告する CI (外部 CI 等) も `get_status` では判定しない (cc-web の `get_status` は `sha` を返さなかった)。トークンで `curl` から `https://api.github.com/repos/<owner>/<repo>/commits/<sha>/status` を読み、該当する context を見る。
  - 失敗の詳細は `get_job_logs` を `run_id`・`failed_only=true`・大きめの `tail_lines` で取る (`job_id` 指定で `tail_lines` が小さいと後片付けのログしか映らない)。`get_check_run` (`checkRunId`) は名前・結論・URL を返すが、Actions の job が annotation を書かない限り `output` (title / summary / text) は空。
- **イベント**: `subscribe_pr_activity` (`owner` / `repo` / `pullNumber`)。実測での配送 (`canon: facts/claude-code/subscribe-pr-activity-events`):
  - 届く: レビューコメントの作成 (自分が書いたものも)、通常コメントの編集 (`issue_comment.edited`)、review (本体と指摘ごとのコメントが別イベント)、CI の失敗 (check run ごとに毎回)、CI の成功 (head の SHA ごとに 1 回だけの check suite のロールアップ。check suite が 1 つのリポでの測定)、draft 化・ready・close・reopen (close は merge せずに閉じた場合だけ測定。merge の通知は未確認)。
  - 届かない: push、label などのメタデータの変更、merge conflict (harness の指示文は届くと書くが届かない)。
  - CI の成功はイベントで待たない。成功のイベントは `conclusion` を持たず、特定した check を見直すきっかけにすぎない。成功のイベントは旧来の commit status を対象にせず、既に成功を配送したコミットには再び届かず (再実行でも、そのコミットへの force push でも)、失敗のあと同じコミットで初めて緑になる場合は未確認。
  - push は `pull_request_read` の `get` で head の SHA を取り直して比べる。CI のイベントの `head_sha` はヒントにしかならない (CI が走らない push や、既に成功を配送した SHA への force push ではイベント自体が来ない)。コンフリクトは `get` の `mergeable_state` を見る。
  - close で購読は解除され、reopen で再購読される。PR Steward が watch 中の PR ではイベントが届かない (tool の結果にその旨が出る)。
