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
- インストール作業自体は install-deps skill で行う (インストール直前の新着パッケージ audit)。閾値等が本節と重ならないよう、audit の仕様は install-deps 側を正とする。
- Dependabot 等でバージョン更新を管理する
- 例外: 供給元が中央集権的に品質管理されている (apt (not PPA) 等)、または ikeyan/agent-files 自身 (本標準の trust root) の場合、リスクが緩和されていると判断するなら unpinned でもよい

### セキュリティモデル

- リポのセキュリティモデルを README.md に書く。複雑なら別ファイル (例: `docs/security-model.md`) に書き README から参照する。

## 3. 検証

- REVIEW.md を ikeyan/agent-files からコピーする。
- フォーマッター・リンター・静的解析器を入れる (oxfmt, oxlint, typescript 等、言語や目的に応じて)。
- テストの仕組みを用意する (外部依存の挙動も内部ロジックも)。property testing・table driven test を活用する。
- 単一検証コマンドを用意する (AGENTS.md 設計指針)。上記すべてと REVIEW.md の同期チェックを 1 つの入口に集約する。
  - 同期チェックはこの skill の `check-sync.sh` (frontmatter の `source:` と比較する)。対象リポにはコピーせず、curl で実行する (unpinned はセキュリティ節の trust root 例外):

    ```sh
    curl -fsSL https://raw.githubusercontent.com/ikeyan/agent-files/main/skills/setup-repo/check-sync.sh -o /tmp/check-sync.sh && bash /tmp/check-sync.sh REVIEW.md
    ```

  - ただし PR の CI では `--warn` を付け、別リポとの同期 drift という PR と無関係なエラーで CI を落とさない。

## 4. 検証済み事実台帳

- `docs/verified-facts/` を用意する。規約は ikeyan/agent-files の `docs/verified-facts/README.md` を参照する (コピーせず、トピックファイルだけを置く)。

## 5. CI

- CI で単一検証コマンドを回す。
