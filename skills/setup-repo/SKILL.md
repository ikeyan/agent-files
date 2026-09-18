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

- フォーマッター・リンター・静的解析器を入れる (oxfmt, oxlint, typescript 等、言語や目的に応じて)。
- テストの仕組みを用意する (外部依存の挙動も内部ロジックも)。property testing・table driven test を活用する。
- 単一検証コマンドを用意する (AGENTS.md 設計指針)。上記すべてを 1 つの入口に集約する。
- レビューは review-perspectives skill で行う。観点は plugin で配られる。
  - テストフレームワーク・ランタイム・リポ自身の終了ハンドラや資源の型の名前を、`review-perspectives/<観点>.md` に書く (review-perspectives の [repo-supplement.md](../review-perspectives/repo-supplement.md))。
  - managed Code Review (Claude GitHub App) を使うリポでは、効かせたい観点をルートの `REVIEW.md` に書く。managed Code Review はルートの `REVIEW.md` しか読まない (`canon: facts/claude-code/review-md-consumers`)。
  - 使わないリポには `REVIEW.md` とその同期チェックを置かず、既存のリポにあれば消す。

## 4. 検証済み事実台帳

- 外部依存の確定仕様と事故は repo に置かず canon (`ikeyan/canon`) に集める。規約と confidence タグの定義は canon の `_index.md` が正本。判断は [organizing-agent-docs](../organizing-agent-docs/SKILL.md)。
- canon とリポ内の知識ベース (wiki/) の管理ツールは **plasma-wiki** (PyPI) の `wiki` CLI。index と相互リンクは `wiki update` が生成するので手で書かない (`wiki init` で新設、`wiki lint` で検査)。リポが wiki/ を持つなら dev 依存に plasma-wiki を宣言し、`wiki lint` を単一検証コマンドに含める。未インストールなら `uvx --from plasma-wiki wiki ...` で動く。

## 5. CI

- CI で単一検証コマンドを回す。

## 6. PR / ブランチ運用

- リポ固有の PR・ブランチ運用を `.claude/skills/pr-workflow/` に置く。既定の [pr-workflow/](pr-workflow/SKILL.md) をディレクトリごとコピーする (方針の [SKILL.md](pr-workflow/SKILL.md) だけを読み、使う手段 [gh.md](pr-workflow/gh.md) / [github-mcp-server.md](pr-workflow/github-mcp-server.md) / [cc-web-github-mcp.md](pr-workflow/cc-web-github-mcp.md) だけを開く構成)。
- コピーしたらそのリポに合わせて編集する:
  - 方針は既定を採る。リポごとに変えるならユーザーに確認する。
  - 手段のファイルは全部残す (同じリポを cc-web と local の両方から触る)。setup した環境で 1 回実測して通らなかった手段・実測できなかった手段には未実測と書き添える (AGENTS.md「実行時契約の実測」)。
  - 「このリポの値」の `<…>` を埋める:
    - push 先: 書き込めることを実測で確かめた remote (fork 運用では `origin` と限らない)。
    - 寄稿規約: 規約が書いてあるファイルを指す。中身は写さない (`CONTRIBUTING.md` から読めるので)。文書に無いがこのリポで通っている規約だけ本文に書く。無ければ「なし」。
  - リポで使っていない仕組み (Codex Review 等) の項目は削る。
  - 何を本文に書くかは [authoring-skills](../authoring-skills/SKILL.md) に従う。
- push 単位の方針は pr-workflow skill だけに書き、AGENTS.md に重ねない。
