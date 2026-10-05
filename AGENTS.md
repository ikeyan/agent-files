# コーディング指針

## ワークフロー

- 作業が論理単位に達したら確認を取らず自律的にコミットする。指示待ちしない。
- 実装は subagent に出す (superpowers の subagent-driven-development)。subagent のモデルは役割をこなせる最も弱いものを選び、上限は Opus (`model: opus`)。レビューは review-perspectives の表のモデル。model は毎回明示する (省略すると親のモデルを継ぐ)。
- コミット前にレビューする。判定対象は diff でなく結果のファイル — 変更箇所をファイル全体 (先頭コメント含む) の文脈で、その変更を見ていない初見読者として読み、本 AGENTS.md の指針に沿わなければ修正してからコミットする。
- 人から伝えられた観測や指摘を写すときは、出来事の有無だけでなく修飾語 (自動で・常に・だけ・即時に) も別の命題として検証する。
- レビュー指摘の修正も初回実装と同じ規律を通す (外部依存の契約確認・検証)。レビュー起点のコードは未検証のまま積み上がりやすい。自分のレビューでも外部のレビュー (Codex 等) でも同じ。
  - 指摘が canon の目録の次元に当たるなら、同じ次元の他の値も同じコミットで閉じ、生成器のあるスクリプトでは生成器にも足す (目録に無い次元は先に目録に足す)。閉じる場所は、その次元に触れる操作 (外部依存を呼ぶ行) の側。症状を観測した側 (テストの helper・呼び出し元) で閉じると、製品の呼び出しが開いたまま残る。
  - 同じ箇所へのコードの挙動の指摘は review-perspectives の `findings.md` で数える:
    - 2 回目: 定義域を閉じてから直す。
    - 3 回目以降か、機構の作り直しを要する指摘: 修正の連鎖を止め、契約確認 → 実測 → 再設計に戻る。再設計は同じ機構の別の読み方でなく、機構の種類を変える (プラットフォームが設定無しで提供する形を先に探す)。
- 作業中に見つけたゴミは、拾っても悪影響が無いと確かめられれば拾う。ゴミは、自分や前のセッションが残した一時ディレクトリ・作業ディレクトリ・worktree・ブランチ、終わった系列の作業ファイル、古い記述など。
  - 持ち主や使用中かが分からないもの、他人のものは、そのまま残して報告する。
  - 拾ったものは報告に書く。
- PR の振り返りは、merge の前に `retrospectives/<日付>-<対象>.md` としてその PR に入れる。close する PR は別の PR で残す。
  - 書くこと: 良かったこと、直したこと (commit を添える)、残っていること。
  - 読者は次の実装セッション。
  - 振り返りの commit へのレビューの指摘も同じ PR で直し、重要なものは振り返りに足す。
- push の前に review-perspectives スキルでレビュー→修正を反復し、終了条件を満たしてから push する。終了条件は「実害シナリオつき correctness 指摘の消滅」。cleanup 指摘のゼロは目指さない (高強度のレビューはゼロに収束しない)。却下した指摘は理由を明文化し、次のレビューへ除外条件として引き継ぐ。修正とレビューが済み、続けて行う作業が無ければ push する。

## 設計

- セキュリティの前提: 利用者の環境 (OS・ネットワーク・環境変数・同じホストの他のプロセス) は信頼する。守るのは利用者とエージェントの誤り (誤った相手への送信、平文でホストの外へ出すこと、トークンの残存)。前提を減らしても得るものは少なく、開発コストだけが上がる。
- 管理対象の数は保守コストに直結する (管理するリソース・ソース中のコメント・ソース自体の複雑さ)。常に減らす方向を選ぶ。
- 設計時は現在のソース上の対応関係でなく、プラットフォーム自体 (OS・プロトコル・Google 等) の不変制約を第一に考える。最初の問いは「プラットフォームは設定無しで何をするか」。既定を曲げる設定 knob は、その knob の定義域 (scope・優先順位・環境・パスの解決) を丸ごと抱えるので、既定の置き場や挙動で済むなら knob を足さない。OSS が対象なら PR を送って拡張するのも選択肢。
- 外部依存 (自分が書いていないもの — CLI・ライブラリ・カーネル・API) の挙動に依存するコードは、契約を一次情報で確認してから書く。記憶で断定しない。確定済みの契約は canon (`ikeyan/canon` の `facts/<topic>/`) を引く。外部コマンドを呼ぶ行は、そのコマンドが引数の他に読むもの (環境変数・設定ファイル・時刻・locale) の目録を canon で引き、無ければ作ってから書く。指摘で目録の漏れが見つかったら、修正より先に目録を直す。入力と環境の定義域は仕様 (先頭の宣言) に書き、既定は最も狭いもの (他の CLI が採る形)。テスト用の形 (fake に向ける平文の URL 等) は製品の knob に混ぜず別の変数にする。外部依存の有限の列挙 (exit code、環境変数) は最初の版で全部を規則で分類する。状態を持つ仕組みは、実装の前に同一性の表 (対象・鍵・等しいとみなす条件) を先頭に書く。広げるのは 1 つの操作の契約で全域を覆えるときだけで、値ごとの guard を足さない。定義域が開いた入力 (自由な文字列、外部システムの状態) は canon の目録の次元を生成器で回すテストで固定する。
- リポ全体を検証する単一コマンドを用意し、変更時は必ず通す (テスト・lint・型・フォーマット・各種 validator を 1 つの入口に集約)。何を含めるかはリポごとに一度決める設計判断。単一コマンドの緑は必要条件で十分条件ではない。
- 検査が模擬していない実行時契約 — 実行主体と権限・環境変数・呼び出し元 (orchestrator) — に触れる変更は、その経路を実条件で最低 1 回実測する。全周の再構築でなく変更点に標的を絞った実行プローブでよく、実物が使えなければ同等条件の再現で代替する。実測で確定した契約は可能なら検査として定着させる。

## このリポの検証

- 単一検証コマンドは `./verify.sh`。CI も同じものを回す。含むもの:
  - shellcheck
  - `deno check`
  - review-perspectives の `target-diff.sh` の、例の fixture と model based test (`scripts/test-target-diff.ts`。fast-check。並行に回す)
  - `hooks/pre-push` の fixture (`scripts/test-pre-push.ts`)
  - pr-workflow の `cleanup-branch.sh` の fixture (`scripts/test-cleanup-branch.ts`)
  - pr-workflow の `pr.sh` の、fake GitHub を相手にした model based test (`scripts/test-pr.ts`。fast-check)
  - pr-workflow の `codex-limits.sh` の、偽の codex を相手にした fixture (`scripts/test-codex-limits.ts`)
  - agent-sync の `sync.sh` の、このリポの catalog から作った手元の上流を相手にした fixture (`scripts/test-agent-sync.ts`。検査ごとに下流のリポを分けて並行に回す):
    - OS の sandbox を適用できない環境 (別の sandbox の中など) では、最初の描画が sync.sh の「OS の sandbox を適用できない」で落ちるので、描画を伴う残りの検査を飛ばして理由を stderr に出す。
    - 全部を検査するには、適用できる環境で回す。
    - CI では落とす。
  - JSON の構文と schema
  - Markdown のリポ内リンク
  - `.claude/skills` と `skills/` の対応
- `./verify.sh` は次をその場で揃える。CI は `VERIFY_READONLY=1` で直さず落とす。
  - `.claude/skills` の symlink のずれを直す。
  - common git dir の `hooks` の pre-push:
    - 無ければ `hooks/pre-push` を写す。
    - `hooks/pre-push` と違えば、上書きせず落ちて置き換えのコマンドを示す。
- `./verify.sh` は `core.hooksPath` が hook をよそへ向けていれば落ちる (設定は書かない)。
- `./verify.sh` は状態を揃えてから `scripts/run-checks.ts` を exec し、検査の段を全部並行に回す。全部を待ってから段ごとに決めた順で出す:
  - 通った段: 標準出力を stdout へ、標準エラーを stderr へ。
  - 落ちた段: 両方を stderr へ。落ちた段は全部示す。
  - SIGHUP・SIGINT・SIGTERM では、段が起こした子孫 (pr.sh など) も止める。最初の 1 回で段に SIGTERM を送り、段の先頭が終わって出力が閉じるまで (上限 2 秒) 待ってから、残るものを SIGKILL で止めて終わる。2 回目以降は何もしない。
- 必要なもの:
  - 共通のツール: `shellcheck` (0.11.0 だけ。違えば `./verify.sh` が落ちる)、`deno`、`curl` (7.84 以降)、`jq` (1.6 以降)、`archetect` (3.6.1)。
  - macOS: `sandbox-exec`、`otool`。
  - Linux: `bwrap`、`ldd` (非特権の user namespace が要る)。
  - ネットワーク: `www.schemastore.org` への到達。

## このリポのスクリプトの言語

- このリポの中でだけ動く test と開発用のスクリプトは TypeScript (Deno) で書く。
  - 理由:
    - 型の検査ができる。
    - stack trace が読める。
    - fast-check の生成器が使える。
    - 並行に書きやすい。
    - 子プロセスの環境を明示できる。
    - test の言語が 1 つになり、言語の境界が減る。
- 次は対象外で、shell のまま:
  - 他のリポへ配るスクリプト (`skills/` の下と `hooks/pre-push`): agent-sync の `sync.sh`、pr-workflow の `pr.sh`・`cleanup-branch.sh`・`codex-limits.sh`、review-perspectives の `target-diff.sh` など。
  - deno が入る前に動く環境の準備: `setup-cc-web.sh`・`setup-codex-cloud.sh`。
  - `verify.sh` の入口と状態を揃える段: `.claude/skills` の symlink を作るのに、deno はパスを付けない read・write の許可を要る。

## コメントの書き方

[skills/writing-comments](skills/writing-comments/SKILL.md) に従う (スキルとして全リポジトリの実装セッションへ配布される)。

## 文書 (Markdown) の書き方

review-perspectives の次の観点に従う。

- [ハードラップしない](skills/review-perspectives/perspectives/ハードラップしない.md)
- [論理構造を散文に埋め込まない](skills/review-perspectives/perspectives/論理構造を散文に埋め込まない.md)
- [読者を想定して書く](skills/review-perspectives/perspectives/読者を想定して書く.md)
