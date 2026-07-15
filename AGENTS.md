# コーディング指針

## ワークフロー

- 作業が論理単位に達したら確認を取らず自律的にコミットする。指示待ちしない。
- コミット前にレビューする。判定対象は diff でなく結果のファイル — 変更箇所をファイル全体 (先頭コメント含む) の文脈で、その変更を見ていない初見読者として読み、本 AGENTS.md の指針に沿わなければ修正してからコミットする。
- 各コミット後は自動で `git push` する。

## 設計

- 管理対象の数は保守コストに直結する (管理するリソース・ソース中のコメント・ソース自体の複雑さ)。常に減らす方向を選ぶ。
- 設計時は現在のソース上の対応関係でなく、プラットフォーム自体 (OS・プロトコル・Google 等) の不変制約を第一に考える。OSS が対象なら PR を送って拡張するのも選択肢。
- リポ全体を検証する単一コマンドを用意し、変更時は必ず通す (テスト・lint・型・フォーマット・各種 validator を 1 つの入口に集約)。何を含めるかはリポごとに一度決める設計判断。

## コメントの書き方

- デフォルトはコメントなし。有能な読者がコメントなしで混乱する、またはコードが壊れていると誤解する場合だけコメントを書く。
- 書くときは制約・結論だけを1〜2行で書く。導出や推論の連鎖は書かない。
- 言語機能の説明はしない（lookbehind、ジェネレータ、演算子の挙動など）。読者は言語を知っている前提。
- 自分の思考過程をコメントにしない。レビューで指摘された旧実装の説明や、検討して却下した代替案も書かない。最終的に残るのは「現在のコードがなぜこの形でなければならないか」の制約だけ。
- 対象コードより長くなったコメントは大抵書きすぎ。一度疑う。「対象コード」はそのコメントが注釈する単位で測る (インラインなら隣接文/ブロック、関数ヘッダなら関数、ファイル先頭のアーキテクチャ/セキュリティ・ヘッダならファイル全体)。
- コメントを足す前に、それが変更の説明 (why-changed) でないか確認する。why-changed はコミットメッセージにのみ書く。コメント候補がコミットメッセージと一文でも重なる、または既存のファイル先頭コメントと内容が重なるなら、そのコメントは追加しない。
- 外部システムの観測可能な挙動 (OS・デーモン・API の振る舞い等) を主張するコメントは書かず、落ちるテストで固定する。コメントは陳腐化しても落ちないが、テストは落ちる。自コードの仕様説明はコメントで良い。

### 悪い例: 言語機能と思考過程をそのまま書いている

```sh
# Lookbehind asserts the prefix without consuming it, so the
# replacement only needs to be the new version. sed has no
# lookarounds, hence perl.
perl -i -pe 's|(?<="packageManager": "bun\@)[^"]+|'"$tag"'|' package.json
```

### 良い例: コメントなし

```sh
perl -i -pe 's|(?<="packageManager": "bun\@)[^"]+|'"$tag"'|' package.json
```

### 悪い例: 結論に至るまでの因果を全部書いている

```yaml
# On pull_request_target github.ref resolves to the base branch,
# so without a PR-specific suffix every PR's sync would land in
# the same group and cancel-in-progress would clobber siblings.
group: sync-${{ github.workflow }}-pr-${{ github.event.pull_request.number }}
```

### 良い例: 制約を1行

```yaml
# pull_request_targetでgithub.refはbase branchになるためPR番号で一意化
group: sync-${{ github.workflow }}-pr-${{ github.event.pull_request.number }}
```

## 文書 (Markdown) の書き方

REVIEW.md の「自然言語の書き方」に従う。
