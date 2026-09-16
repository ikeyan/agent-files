---
name: pr-workflow
description: Use when pushing a branch, creating a pull request or editing its description, responding to review comments, or checking CI.
---

# PR / ブランチ運用

## このリポの値

- push 先: `<remote>`
- 寄稿規約: <PR テンプレート・ブランチ命名・コミットメッセージ規約・DCO sign-off / CLA>

## 手段

- `gh`: `gh pr view --comments` (通常コメントと review を混ぜた時系列)、`gh api` (REST)、`gh api graphql`、`gh pr checks --watch`、`gh pr edit`。
- GitHub MCP (cc-web): `pull_request_read` (`get_comments` / `get_review_comments` / `get_reviews` / `get_check_runs` / `get_status`)、`add_reply_to_pull_request_comment`、`resolve_review_thread`、`update_pull_request`、`subscribe_pr_activity`。

## 方針

- **作業の開始**: 最新のブランチを取得し、差分がない状態で全ての検証を行う。検証結果が成功していることを確認してから作業を始める。
- **ブランチの更新**: push 先の作業ブランチへ `git push -u <remote> <branch>`。他人のブランチの履歴は書き換えない (base の取り込みは merge)。マージ済み PR のブランチには積まず、既定ブランチから同名で作り直す。remote に旧ブランチが残っていると push は non-fast-forward で拒否される。自分のブランチなら `git fetch <remote> <branch>` し、fetch した oid が、そのブランチを head とするマージ済み PR の head SHA と一致する (= マージ後に何も積まれていない) ことを PR 情報で確認してから、`git push --force-with-lease=<branch>:<fetch した oid> <remote> <branch>` で上書きする。値を省いた `--force-with-lease` は、作り直したブランチが旧 tip を含まないため fetch の前後どちらでも `stale info` で拒否される (git 2.43 で実測)。コミットの祖先関係 (`merge-base --is-ancestor`) はマージ済みの判定に使えない (squash / rebase マージでは旧 tip が既定ブランチの祖先にならない)。
- **コミットごとに push するか**: しない。push は作業の区切り (レビュー依頼・指示された時点) でまとめる。
- **PR の作成**: 頼まれたときだけ作る。寄稿規約に従う。
- **PR の説明**: 最新の HEAD に関連することだけを書く。push するたびに更新するので、計測結果を書くなら計測スクリプトを用意する。
  - 書くこと (寄稿規約に PR テンプレートがあればその構成に収め、無ければ次の 3 つを見出しにする):
    - Purpose: What you did to try to achieve, what you expected, and what you got instead.
    - Assumptions: Any assumptions or premises you made that reviewers should be aware of.
      - ex. Requires a specific undocumented feature to exist.
    - Verifications:
      - 検証コマンド等を簡潔に記載する。
      - 追加・変更したテスト内容。ステップではなく、テストの目的を書く。
      - 全てのテストが成功したかどうか。
      - ベースブランチで検証が失敗していることが分かっていて、ユーザーがそれを認識している場合は、その旨を記載する。
  - 書かないこと:
    - diff を読めば分かるファイル単位の説明。
    - エージェント環境固有の事情。その環境自体が PR の主題でなければ、PR でなくユーザーに説明する。
    - HEAD に直接関連しない過去の行為 (「試した」「最初は〜にしていた」「入れてから消した」)。システムを主語にした現在形の制約に書き直せない文は不要な情報。
  - 目的と diff からレビュアーが確実に抱く疑問には答える。それ以上は予測で先回りせず、レビュアーが聞いたらスレッドで答える。
  - 読者が canon を読めない PR 先 (公開リポ等) では canon を参照せず、その fact の内容を説明に写す。
  - 本文の主張と diff を一致させる。
  - 正確にしすぎて冗長になっている表現は、リポオーナーやレビュアーがすっと分かる範囲で丸めてよい。
  - 列挙はカンマ区切りでなく箇条書きにする。
  - コードブロックが GitHub 上で意図どおり描画されるかをプレビューで確認する (heredoc 内のバックスラッシュ等のエスケープが本文に残ることがある)。
- **コメントの読み方**: 2 種類あり取得経路が違う。どの経路でもコレクションは最後のページまで読み切る (`gh api --paginate`、GraphQL の `pageInfo`、MCP の `page` / `after`)。1 ページ目だけでは未対応の指摘を見落とす。
  - 通常コメント (issue comment、会話タブ): REST `issues/{n}/comments` / MCP `get_comments`。resolve の概念がない。
  - レビューコメント (review comment、diff 上のスレッド): スレッド単位の `isResolved` / `isOutdated` は GraphQL (`pullRequest.reviewThreads`) にしかなく、REST `pulls/{n}/comments` は個々のコメントの平坦な列で resolved 状態を持たない。MCP `get_review_comments` はスレッド id (`PRRT_…`) と `is_resolved` を返す。approve / request changes の本文は review (`get_reviews`)。
  - 未対応の指摘 = `isResolved: false` のスレッド全部 (outdated でも) + 対応を求める内容を持ち、まだ返信していない通常コメントと review 本文。各レビュアーについて、`COMMENTED` を除いた最新の review (`APPROVED` / `CHANGES_REQUESTED`。dismiss されたものは除く) が `CHANGES_REQUESTED` ならその本文は必ず含む (スレッドを持たない指摘はここにしか現れない。後続の `COMMENTED` review は change request を解除しない)。情報だけの bot コメントと `APPROVED` の本文は含まない。review 本文への返信は PR の通常コメントで行う。
- **Codex Review (chatgpt-codex-connector) の読み方** (ikeyan/agent-files #11 で 2026-09-12 に実測): PR 作成・push 直後に通常コメント (先頭が `<!-- codex-pull-request-review-summary -->`、見出し `Codex Review Summary`、状態表 🔄 Running) が投稿され、完了時に同じコメントが ✅ Completed へ上書きされる。指摘があれば review (本文が `💡 Codex Review` で始まる) が投稿され、指摘は review comment のスレッド。指摘なしなら 👍 reaction のみ。完了の判定は、状態表の Commit 列 (review なら本文の Reviewed commit) が現在の head と一致し、かつ Completed であること。push 直後は前の commit の Completed と前の review が残っているので、head の一致を見ずに完了と判断しない。cc-web では上書き (`issue_comment.edited`) も review の投稿も subscribe_pr_activity のイベントとして届く。
- **コメント対応後**: 対応したスレッドに返信 (対応コミットの SHA と要点。却下なら理由) してから resolve する。返信は REST `pulls/{n}/comments/{id}/replies` / MCP `add_reply_to_pull_request_comment`、resolve は GraphQL `resolveReviewThread(threadId)` / MCP `resolve_review_thread` (REST に resolve は無い)。通常コメントは返信のみ。
- **push 後の CI 確認**: 既定は失敗の検知だけ。cc-web では失敗は `subscribe_pr_activity` のイベントで届く (成功は届かない。cc-web-sandbox-signals)。
  - 成功を見届けるのは理由があるときだけ (ユーザーに指示された、CI 自体を変更していて成功時のログが要る等)。その理由から必要な check を特定し、それが現在の head に現れて終端状態になるまで有界に待つ。head に走る check 全部が揃ったことを知る手段は無いので (workflow ごとに登録時刻が違い、path filter・条件付き job・matrix・`workflow_run` で head ごとに変わる)、「全部緑」を確認対象にはしない。
  - check の一覧は CI 設定や required checks から推測せず、現在の head に現れているものを読む (organization / enterprise の ruleset が注入する workflow はリポの設定にも required checks にも現れない)。
  - 待つ手段: `gh pr checks --watch` (待ち時間は有界にする。`--watch` なしは pending で exit 8 になり終端を保証しない)。cc-web では `get_check_runs` (Checks API) と `get_status` (Commit Status API。required checks には旧来の status context もあり、`get_check_runs` には出ない) の再読 (`send_later` の check-in 等)。
  - push 直後は check がまだ作られていないことがあり、`gh pr checks` は check が 0 件だと `--watch` でも即座に `no checks reported` で exit 1 する (cli/cli `pkg/cmd/pr/checks/checks.go` の `populateStatusChecks`)。`get_check_runs` / `get_status` の 0 件も未着と区別できない。
- **cc-web 以外でも PR コメントを watch するか**: しない。cc-web では `subscribe_pr_activity` でイベントが届く (届く種類の制限は cc-web-sandbox-signals)。watch するなら手段 (ポーリング間隔・終了条件) を書く。
