# コーディング指針

## ワークフロー

- 作業が論理単位に達したら確認を取らず自律的にコミットする。指示待ちしない。
- 実装は subagent に出す (superpowers の subagent-driven-development)。subagent のモデルは役割をこなせる最も弱いものを選び、上限は Opus (`model: opus`)。レビューは review-perspectives の表のモデル。model は毎回明示する (省略すると親のモデルを継ぐ)。
- コミット前にレビューする。判定対象は diff でなく結果のファイル — 変更箇所をファイル全体 (先頭コメント含む) の文脈で、その変更を見ていない初見読者として読み、本 AGENTS.md の指針に沿わなければ修正してからコミットする。
- レビュー指摘の修正も初回実装と同じ規律を通す (外部依存の契約確認・検証)。レビュー起点のコードは未検証のまま積み上がりやすい。自分のレビューでも外部のレビュー (Codex 等) でも同じ。
  - 指摘が canon の目録の次元に当たるなら、同じ次元の他の値も同じコミットで閉じ、生成器のあるスクリプトでは生成器にも足す (目録に無い次元は先に目録に足す)。閉じる場所は、その次元に触れる操作 (外部依存を呼ぶ行) の側。症状を観測した側 (テストの helper・呼び出し元) で閉じると、製品の呼び出しが開いたまま残る。
  - 同じ箇所へのコードの挙動の指摘は review-perspectives の `findings.md` で数える:
    - 2 回目: 定義域を閉じてから直す。
    - 3 回目以降か、機構の作り直しを要する指摘: 修正の連鎖を止め、契約確認 → 実測 → 再設計に戻る。
- PR が終わったら (merge か close)、振り返りを `retrospectives/<日付>-<対象>.md` に残す。良かったこと・直したこと (commit を添える)・残っていること。読者は次の実装セッション。
- push の前に review-perspectives スキルでレビュー→修正を反復し、終了条件を満たしてから push する。終了条件は「実害シナリオつき correctness 指摘の消滅」。cleanup 指摘のゼロは目指さない (高強度のレビューはゼロに収束しない)。却下した指摘は理由を明文化し、次のレビューへ除外条件として引き継ぐ。修正とレビューが済み、続けて行う作業が無ければ push する。

## 設計

- 管理対象の数は保守コストに直結する (管理するリソース・ソース中のコメント・ソース自体の複雑さ)。常に減らす方向を選ぶ。
- 設計時は現在のソース上の対応関係でなく、プラットフォーム自体 (OS・プロトコル・Google 等) の不変制約を第一に考える。OSS が対象なら PR を送って拡張するのも選択肢。
- 外部依存 (自分が書いていないもの — CLI・ライブラリ・カーネル・API) の挙動に依存するコードは、契約を一次情報で確認してから書く。記憶で断定しない。確定済みの契約は canon (`ikeyan/canon` の `facts/<topic>/`) を引く。入力と環境の定義域は仕様 (先頭の宣言) に書き、既定は最も狭いもの (他の CLI が採る形)。広げるのは 1 つの操作の契約で全域を覆えるときだけで、値ごとの guard を足さない。定義域が開いた入力 (自由な文字列、外部システムの状態) は canon の目録の次元を生成器で回すテストで固定する。
- リポ全体を検証する単一コマンドを用意し、変更時は必ず通す (テスト・lint・型・フォーマット・各種 validator を 1 つの入口に集約)。何を含めるかはリポごとに一度決める設計判断。単一コマンドの緑は必要条件で十分条件ではない。
- 検査が模擬していない実行時契約 — 実行主体と権限・環境変数・呼び出し元 (orchestrator) — に触れる変更は、その経路を実条件で最低 1 回実測する。全周の再構築でなく変更点に標的を絞った実行プローブでよく、実物が使えなければ同等条件の再現で代替する。実測で確定した契約は可能なら検査として定着させる。

## このリポの検証

- 単一検証コマンドは `./verify.sh`。CI も同じものを回す。含むもの:
  - shellcheck
  - `deno check`
  - review-perspectives の `target-diff.sh` の fixture (`scripts/test-target-diff.sh`) と model based test (`scripts/test-target-diff.ts`。fast-check)、`hooks/pre-push` の fixture (`scripts/test-pre-push.sh`)
  - pr-workflow の `pr.sh` の、fake GitHub を相手にした model based test (`scripts/test-pr.ts`。fast-check)
  - pr-workflow の `codex-limits.sh` の、偽の codex を相手にした fixture (`scripts/test-codex-limits.sh`)
  - JSON の構文と schema
  - Markdown のリポ内リンク
  - `.claude/skills` と `skills/` の対応
- `./verify.sh` は `.claude/skills` の symlink のずれと `core.hooksPath` (main worktree の `hooks` の絶対パスであるべき) をその場で直す。CI は `VERIFY_READONLY=1` で直さず落とす。
- 必要なもの: `shellcheck`、`deno`、`curl` (7.84 以降)、`jq`、`www.schemastore.org` への到達。

## コメントの書き方

[skills/writing-comments](skills/writing-comments/SKILL.md) に従う (スキルとして全リポジトリの実装セッションへ配布される)。

## 文書 (Markdown) の書き方

review-perspectives の次の観点に従う。

- [ハードラップしない](skills/review-perspectives/perspectives/ハードラップしない.md)
- [論理構造を散文に埋め込まない](skills/review-perspectives/perspectives/論理構造を散文に埋め込まない.md)
- [読者を想定して書く](skills/review-perspectives/perspectives/読者を想定して書く.md)
