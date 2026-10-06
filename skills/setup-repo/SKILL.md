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
- テストの仕組みを用意する (外部依存の挙動も内部ロジックも)。入力の定義域で書き方を分ける:
  - 有限集合に閉じた入力: table driven test で列挙する。
  - 定義域が開いた入力と外部システムの状態: canon の目録 (`facts/<topic>/`) の次元ごとに値を生成する property based / model based test (fast-check 等) で回す。生成器は最初は使うリポの `scripts/` に置き、2 つ目のリポが使うときに canon へ移す。テストが相手にする外部システム:
    - 手元で動く (git 等): 実物
    - 手元で動かない (GitHub API 等): 状態機械の fake
- 単一検証コマンドを用意する (AGENTS.md 設計指針)。上記すべてを 1 つの入口に集約する。
  - そのエコシステムの道具が列挙できる、使われない変数・import・export・module・依存の検査が入っている。道具が列挙しないものは、そのリポで別の検査を足すか、起きない理由 (例: export を持たない) を書く。道具ごとの列挙するもの・しないものは [dead-code-tools.md](dead-code-tools.md)。
- push は `hooks/pre-push` (agent-sync の pre-push 部品で配る。7 節) で、push のコマンドに `PUSH_OK=1` が付いていないものを止める (付け方は [pr-workflow/SKILL.md](pr-workflow/SKILL.md) の「push の手順」)。単一検証コマンドで `hooks/pre-push` を common git dir (`git rev-parse --git-common-dir`) の `hooks` へ写す。写す先に `hooks/pre-push` と違う pre-push があれば (旧版でも)、このリポのものかを中身から決められないので、上書きせず落として置き換えのコマンドを示す。`core.hooksPath` が hook をよそへ向けていれば落とす。common git dir の `hooks` は linked worktree も共有し、checkout で消えない。`core.hooksPath` で作業ツリーの `hooks/` を指すと、`hooks/` の無い commit を checkout した worktree から hook 無しで push が通る。
- push の前のリポ固有の検査は、実行可能な `hooks/pre-push.local` に書く。`hooks/pre-push` は配るものなので書き足さない。`hooks/pre-push` は `PUSH_OK=1` の判定の後、`hooks/pre-push.local` に同じ引数と stdin で替わり、その終了コードが push の可否になる。`hooks/pre-push.local` が実行可能な通常のファイルでなければ、無視せず push を止める。
- レビューは review-perspectives skill で行う。観点は plugin で配られる。
  - テストフレームワーク・ランタイム・リポ自身の終了ハンドラや資源の型の名前を、ルートの `review-perspectives/<観点>.md` に書く (review-perspectives の [repo-supplement.md](../review-perspectives/repo-supplement.md))。
  - リポの中で経緯を置くパス (標準は `retrospectives/`) を、ルートの `review-perspectives/経緯と無いことの宣言を書かない.md` に書く (同じく repo-supplement.md)。
  - managed Code Review (Claude GitHub App) を使うリポでは、効かせたい観点をルートの `REVIEW.md` に書く。managed Code Review はルートの `REVIEW.md` しか読まない (`canon: facts/claude-code/review-md-consumers`)。
  - 使わないリポには `REVIEW.md` とその同期チェックを置かず、既存のリポにあれば消す。

## 4. 検証済み事実台帳

- 外部依存の確定仕様と事故は repo に置かず canon (`ikeyan/canon`) に集める。規約と confidence タグの定義は canon の `_index.md` が正本。判断は [organizing-agent-docs](../organizing-agent-docs/SKILL.md)。
- canon とリポ内の知識ベース (wiki/) の管理ツールは **plasma-wiki** (PyPI) の `wiki` CLI。index と相互リンクは `wiki update` が生成するので手で書かない (`wiki init` で新設、`wiki lint` で検査)。リポが wiki/ を持つなら dev 依存に plasma-wiki を宣言し、`wiki lint` を単一検証コマンドに含める。未インストールなら `uvx --from plasma-wiki wiki ...` で動く。

## 5. CI

- CI で単一検証コマンドを回す。

## 6. PR / ブランチ運用

- リポ固有の PR・ブランチ運用を `.claude/skills/pr-workflow/` に置く。方針の [SKILL.md](pr-workflow/SKILL.md) だけを読み、使う手段 [gh.md](pr-workflow/gh.md) / [github-mcp-server.md](pr-workflow/github-mcp-server.md) / [cc-web-github-mcp.md](pr-workflow/cc-web-github-mcp.md) だけを開く構成。
- `repo.md` 以外のファイルは agent-sync の pr-workflow 部品で配る (7 節)。手段のファイルは全部置く (同じリポを cc-web と local の両方から触る)。
- リポごとに違うものは `repo.md` に書く。[テンプレート](pr-workflow/repo.md) を一度写し、`<…>` を埋める (agent-sync は `repo.md` を置かない):
  - 値:
    - push 先: 書き込めることを実測で確かめた remote (fork 運用では `origin` と限らない)。
    - 寄稿規約: 規約が書いてあるファイルを指す。中身は写さない (`CONTRIBUTING.md` から読めるので)。文書に無いがこのリポで通っている規約だけ本文に書く。無ければ「なし」。
  - 手段の実測: setup した環境で 1 回実測して通らなかった手段・実測できなかった手段 (AGENTS.md「実行時契約の実測」)。
  - 方針の差分: 方針は既定を採る。リポごとに変えるならユーザーに確認して書く。リポで使っていない仕組み (Codex Review 等) もここに書く。
  - 何を本文に書くかは [authoring-skills](../authoring-skills/SKILL.md) に従う。
- push 単位の方針は pr-workflow skill だけに書き、AGENTS.md に重ねない。

## 7. agent-sync (ikeyan/agent-files のファイルの配布)

- ikeyan/agent-files が配るファイルは各リポで編集しない。agent-sync で固定した版から当て、人が `git diff` で確かめてコミットする。リポごとの違いは、リポが持つファイルか、リポの archetype が自分で描画するファイルに置く。
- 部品 (ikeyan/agent-files のルートの `archetype.yaml` の catalog):

| 部品 | 置くもの | リポが持つもの |
| --- | --- | --- |
| `agent-sync` | `.agent-sync/sync.sh`・`.agent-sync/render.sb` | `.agent-sync/archetype/`・`.agent-sync/answers.yaml` |
| `pre-push` | `hooks/pre-push` | `hooks/pre-push.local` (3 節) |
| `pr-workflow` | `.claude/skills/pr-workflow/` の `repo.md` 以外 | `.claude/skills/pr-workflow/repo.md` (6 節) |

- リポの `.agent-sync/`:
  - `archetype/archetype.yaml`: catalog に ikeyan/agent-files を commit の sha (40 桁) で固定する。sha の書き換えが更新。
  - `archetype/archetype.lua`: 使う部品を `catalog.render` で合成する。リポ自身が描画するファイルは `archetype/content/` に置き、`content/.agent-sync/files/<名前>` の一覧に `-<TAB><置き先><TAB><mode>` の行で載せる (一覧の形は [sync.sh](agent-sync/sync.sh) の先頭)。`if_exists` は `Existing.Error` にする (重なりを後勝ちにしない)。
  - `answers.yaml`: 問いの答え。問いが無ければ `{}`。
  - `generated`: sync.sh が置いたものの一覧。1 行 1 件 `<パス><TAB><置いたバイトの id>` (`git hash-object --no-filters` の id)。sync.sh が書き換え、前回の結果か利用者の変更かの判定と、古いパスを消すのに使う。初回は空のファイル。
  - `sync.sh`・`render.sb`: agent-sync 部品が置く。

```yaml
# .agent-sync/archetype/archetype.yaml
description: このリポが使う ikeyan/agent-files の部品
catalog:
  agent-files:
    source: https://github.com/ikeyan/agent-files.git#<40 桁の sha>
```

```lua
-- .agent-sync/archetype/archetype.lua
local context = Context.new()
context:merge(catalog.render("agent-files/agent-sync", context))
context:merge(catalog.render("agent-files/pre-push", context))
context:merge(catalog.render("agent-files/pr-workflow", context))
return context
```

- 起動: リポの中で `.agent-sync/sync.sh`。
  - 描画を OS の sandbox に入れるので、別の sandbox の中 (Claude Code の Bash の sandbox など。sandbox-exec が exit 71) では「OS の sandbox を適用できない」で落ちる。Claude は `dangerouslyDisableSandbox` で起動する (ユーザーの許可が要る)。
  - そのリポの `.agent-sync/sync.sh` を、そのリポの中で起動する (別のリポの sync.sh は落ちる)。
  - 要るもの: `git`、`archetect` (3.6.1 だけ。違えば落ちる。`canon: facts/archetect`)、macOS では `sandbox-exec` と `otool` (Xcode Command Line Tools)、Linux では `bwrap` と `ldd` と非特権の user namespace (Ubuntu 23.10 以降は AppArmor が制限する)。
  - 落ちたら作業ツリーは変わらない (当てている途中のファイルシステムの失敗を除く)。置き先に generated に無い違うファイル (利用者のファイル) があれば落ちるので、中身を `repo.md` などリポが持つファイルへ移してから消す。
  - 置き先・古いパスの中身が、generated に記録した id (前回置いたもの) とも今回置くものとも違えば、利用者の変更として落ちる。commit 済みでも同じ。git の状態は見ないので、前回の結果が未コミットでも続けて起動できる。生成物を直したくなったら、置く元 (上流・リポの archetype) を直す。
- 初回: 固定する sha の `skills/setup-repo/agent-sync/sync.sh` と `render.sb` を `.agent-sync/` へ手で写し (`sync.sh` は mode 755)、上の `archetype/`・`answers.yaml`・空の `generated` を作って起動する。写した `sync.sh` と `render.sb` は置くものと同じバイトなので、そのまま引き取られる。
- 更新: `archetype.yaml` の sha を書き換えて起動し、`git diff` を確かめてコミットする。`sync.sh` 自身の更新も同じ diff に出て、次の起動から効く。
