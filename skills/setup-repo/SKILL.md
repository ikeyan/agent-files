---
name: setup-repo
description: Use when creating a new repository, bringing an existing repository up to the standard architecture, or auditing a repository's setup against it.
---

# リポジトリ標準アーキテクチャ

リポジトリが満たすべき宣言的要件。新規セットアップでは全項目を導入し、既存リポの監査では各項目の充足を確認して差分を埋める。言語・目的に依存する箇所は「そのリポで等価な手段」を選んでよいが、要件自体は満たすこと。

## 1. Claude 設定

- `.claude/settings.json` で ikeyan marketplace とスキル plugin を宣言する:

```json
{
  "extraKnownMarketplaces": {
    "ikeyan": { "source": { "source": "github", "repo": "ikeyan/agent-files" } }
  },
  "enabledPlugins": { "ikeyan-skills@ikeyan": true }
}
```

- optional: お気に入りスキルを `enabledPlugins` に足すことをユーザーにおすすめする (今のところ `superpowers@claude-plugins-official`)。
- superpowers を有効にする場合、`.superpowers/` を `.gitignore` に足す。
- `AGENTS.md` を用意する (ikeyan/agent-files のものを見本に)。AGENTS.md はリポごとに最適化する対象で、コピーしたまま放置しない。
- `CLAUDE.md` の内容は `@AGENTS.md` の 1 行のみ。

## 2. セキュリティ

### 外部依存のサプライチェーン攻撃対策

- 対象を固定する:
  - パッケージマネージャーなら lock ファイル
  - Dockerfile の `FROM` に書くイメージなら sha256 digest
- インストール・アップグレード時の対策を行う:
  - 依存関係のライフサイクルスクリプトを明示的にホワイトリスト管理する (bun にはデフォルトのホワイトリストがあるが、明示して最小化する)
  - minimum-release-age を最低 1 日、推奨 3 日にする
- インストール時にスキャンする。いずれか:
  - ラッパー方式の [sfw](https://github.com/SocketDev/sfw-free) (多くのパッケージマネージャーに対応)
  - bun なら `install.security.scanner`
- インストール作業は install-deps skill で行う。上記の常設スキャン設定とは独立の、インストール直前の新着パッケージ audit の層で、audit の仕様は install-deps 側を正とする。
- Dependabot 等でバージョン更新を管理する
- 例外: 供給元が中央集権的に品質管理されている (apt (not PPA) 等)、または ikeyan/agent-files 自身 (本標準の trust root) の場合、リスクが緩和されていると判断するなら unpinned でもよい

### セキュリティモデル

- リポのセキュリティモデルを README.md に書く。複雑なら別ファイル (例: `docs/security-model.md`) に書き README から参照する。

## 3. 検証

- REVIEW.md を ikeyan/agent-files からコピーする。
- フォーマッター・リンター・静的解析器を入れる (oxfmt, oxlint, typescript 等、言語や目的に応じて)。
- テストの仕組みを用意する (外部依存の挙動も内部ロジックも)。property testing・table driven test を活用する。
- 単一検証コマンドを用意する (AGENTS.md 設計指針)。上記すべてと REVIEW.md の同期チェックを 1 つの入口に集約する。
  - 同期チェックは frontmatter の `source:` (raw URL) を取得して diff する:

    ```sh
    (f=$(mktemp -p "${TMPDIR:-/tmp}"); trap 'rm -f "$f"' EXIT; curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 --retry-connrefused "$(sed -n '/^source: /{s///p;q;}' REVIEW.md)" -o "$f" && { diff -u "$f" REVIEW.md || { [ -n "$WARN" ] && echo 'REVIEW.md: 上流と違う'; }; })
    ```

  - PR の CI では `WARN=1` を渡して drift を警告に留め、別リポとの同期 drift という PR と無関係なエラーで CI を落とさない。取得失敗と `source:` 欠落は `WARN` によらず落とす。
  - スニペットの各要素は省くと壊れる。根拠 (canon の shell facts):
    - `( )`: `canon: facts/shell/trap-exit-replaces-callers-handler`
    - `mktemp -p`: `canon: facts/shell/mktemp-tmpdir-handling-bsd-vs-gnu`
    - `{ }`: `canon: facts/shell/and-or-list-left-associative`
    - `q;`: `canon: facts/shell/bsd-sed-block-q-requires-semicolon`
  - `curl` のフラグは検証入口の待ち時間を有界にし、一過性の失敗で落ちないようにする。

## 4. 検証済み事実台帳

- 外部依存の確定仕様と事故は repo に置かず canon (`ikeyan/canon`) に集める。規約と confidence タグの定義は canon の `_index.md` が正本。判断は [organizing-agent-docs](../organizing-agent-docs/SKILL.md)。
- canon とリポ内の知識ベース (wiki/) の管理ツールは **plasma-wiki** (PyPI) の `wiki` CLI。index と相互リンクは `wiki update` が生成するので手で書かない (`wiki init` で新設、`wiki lint` で検査)。リポが wiki/ を持つなら dev 依存に plasma-wiki を宣言し、`wiki lint` を単一検証コマンドに含める。未インストールなら `uvx --from plasma-wiki wiki ...` で動く。

## 5. CI

- CI で単一検証コマンドを回す。

## 6. PR / ブランチ運用

- リポ固有の PR・ブランチ運用を `.claude/skills/pr-workflow/SKILL.md` に書く。description は「ブランチを push する・PR を作る/説明を直す・レビューコメントに対応する・CI を確認する」場面で発火する 1 行にする。
- 書く内容は下の各項目の**方針**と、それを実行する**手段** (コマンド・ツール名)。方針は既定を採り、リポごとに変えるならユーザーに確認する。手段はそのリポの実環境 (cc-web か local か、`gh` の有無、GitHub MCP の有無) で 1 回実測して通ったものだけを書き、実測できなかった手段は未実測と明記する (AGENTS.md「実行時契約の実測」)。候補:
  - `gh` がある環境: `gh pr view --comments` (通常コメントと review を混ぜた時系列)、`gh api` (REST)、`gh api graphql`、`gh pr checks --watch --fail-fast`、`gh pr edit`。
  - cc-web (GitHub MCP): `pull_request_read` (`get_comments` / `get_review_comments` / `get_reviews` / `get_check_runs`)、`add_reply_to_pull_request_comment`、`resolve_review_thread`、`update_pull_request`、`subscribe_pr_activity`。

### 項目と既定

- **ブランチの更新**: 書き込み可能な remote (fork 運用では `origin` と限らない。実測で確定したもの) の作業ブランチへ `git push -u <remote> <branch>`。他人のブランチの履歴は書き換えない (base の取り込みは merge)。マージ済み PR のブランチには積まず、既定ブランチから同名で作り直す。
- **コミットごとに push するか**: しない。push は作業の区切り (レビュー依頼・指示された時点) でまとめる。この方針は pr-workflow skill だけに書き、AGENTS.md に重ねない。
- **PR の作成**: 頼まれたときだけ作る。テンプレート (`.github/pull_request_template.md` 等) があればそれに従う。
- **PR の説明**: 現在の状態だけを書く。
  - 書くのは目的、diff と既存コードだけからは必要性が読めない要素についてその理由 (根拠は実測か canon の fact)、実行した検証コマンドとその結果。
  - 書かないのは diff を読めば分かるファイル単位の説明、エージェント環境固有の事情、書き手の過去の行為が主語の文 (「試した」「最初は〜にしていた」「入れてから消した」)。システムを主語にした現在形の制約に書き直せない文は不要な情報。
  - 読者が canon を読めない PR 先 (公開リポ等) では canon を参照せず、その fact の内容を説明に写す。
  - 予測で先回りせず、レビュアーが聞いたらスレッドで答える。
  - 本文と diff の主張を一致させる (「同一アカウントの場合だけ X する」と書いて無条件に X するコードにしない)。
- **コメントの読み方**: 2 種類あり取得経路が違う。
  - 通常コメント (issue comment、会話タブ): REST `issues/{n}/comments` / MCP `get_comments`。resolve の概念がない。
  - レビューコメント (review comment、diff 上のスレッド): スレッド単位の `isResolved` / `isOutdated` は GraphQL (`pullRequest.reviewThreads`) にしかなく、REST `pulls/{n}/comments` は個々のコメントの平坦な列で resolved 状態を持たない。MCP `get_review_comments` はスレッド id (`PRRT_…`) と `is_resolved` を返す。approve / request changes の本文は review (`get_reviews`)。
  - 未対応の指摘 = `isResolved: false` のスレッド全部 (outdated でも) + 対応を求める内容を持ち、まだ返信していない通常コメントと review 本文。各レビュアーの最新 review が `REQUEST_CHANGES` ならその本文は必ず含む (スレッドを持たない指摘はここにしか現れない)。情報だけの bot コメントと `APPROVED` の本文は含まない。review 本文への返信は PR の通常コメントで行う。
- **Codex Review (chatgpt-codex-connector) の読み方** (本リポ #11 で 2026-09-12 に実測): PR 作成・push 直後に通常コメント (先頭が `<!-- codex-pull-request-review-summary -->`、見出し `Codex Review Summary`、状態表 🔄 Running) が投稿され、完了時に同じコメントが ✅ Completed へ上書きされる。指摘があれば review (本文が `💡 Codex Review` で始まる) が投稿され、指摘は review comment のスレッド。指摘なしなら 👍 reaction のみ。Running の段階は完了ではないので Completed か review を待つ。cc-web では上書き (`issue_comment.edited`) も review の投稿も subscribe_pr_activity のイベントとして届く。
- **コメント対応後**: 対応したスレッドに返信 (対応コミットの SHA と要点。却下なら理由) してから resolve する。返信は REST `pulls/{n}/comments/{id}/replies` / MCP `add_reply_to_pull_request_comment`、resolve は GraphQL `resolveReviewThread(threadId)` / MCP `resolve_review_thread` (REST に resolve は無い)。通常コメントは返信のみ。
- **push 後の CI 確認**: 成功か失敗の終端状態まで見届ける。cc-web では失敗は `subscribe_pr_activity` のイベントで届くが成功は届かない (cc-web-sandbox-signals) ので、成功は `get_check_runs` の再読 (`send_later` の check-in 等) で確認する。それ以外の環境では `gh pr checks --watch --fail-fast` で終わるまで待つ (待ち時間は有界にする。`--watch` なしは pending で exit 8 になり終端を保証しない)。
- **cc-web 以外でも PR コメントを watch するか**: しない。cc-web では `subscribe_pr_activity` でイベントが届く (届く種類の制限は cc-web-sandbox-signals)。watch するなら手段 (ポーリング間隔・終了条件) を書く。
