# 2026-10-06: ゴミの扱いの規律の置き換えの振り返り

読者: 次の実装セッション。前提知識は AGENTS.md の「ワークフロー」と、`2026-10-06-test-pr-cleanup.md`。

## 状況

- `2026-10-06-test-pr-cleanup.md` (#37) で、AGENTS.md に「見つけたゴミを、拾っても悪影響が無いと確かめられれば拾う」を足した。
- ユーザーの指摘で、ゴミが 2 種類あると明示された。この PR は、その項を置き換えて種類ごとの規律にする。
  - 不要ファイル・ブランチ・タグ: 他人が消すには中身の精査が要るので、作った本人 (subagent の分は親) が消す。
  - コードのゴミ: 自動で列挙できるものは検査に入れる。版や環境で決まる分岐は、前提とする環境の範囲と固定になる条件を書いて、不要かを後で判定できるようにする。

## 良かったこと

- `deno lint` の測定を先にして、段に足すか決めた。recommended 全部は 9 件 (`require-await` 6、`prefer-const` 1、`no-import-prefix` 2) で、`no-unused-vars` は 0 件だった。
- `--rules-tags= --rules-include=no-unused-vars` が recommended を外して 1 規則だけにすることを、`prefer-const` に当たるファイルが通ることと、未使用の変数が落ちることの両方で実測した。
- 段が落とすことを、未追跡の `scripts/zz-probe.ts` (未使用の変数) で実測した (確かめた後に消した)。

## 直したこと

- `7572b12`: AGENTS.md のゴミの項を置き換えた。
  - 作ったものは作った本人が消す。他人が残したものは、中身を確かめて不要と分かったときだけ消す。
  - 入力と環境の定義域の文に、OS の版・外部コマンドや依存の版の範囲を足した。
- `91de903`: ユーザーの訂正 2 点を直した。
  - 消す責任は寿命の持ち主にある。最初は「subagent が作ったものは親が消す」と書いたが、subagent が自分のために作ったものは subagent が消し、subagent より長く生きるもの (親が後で使う worktree・ブランチ・レビューの run ディレクトリ) だけを親が消す。
  - コードのゴミの列挙は、AGENTS.md の単一検証コマンドの項でなく、setup-repo の「単一検証コマンドを用意する」の項 (各リポに確かめるチェック) に置いた。AGENTS.md の設計の項に足した文は外した。
- `91b8410`: skills を直した。
  - setup-repo に、コードのゴミを列挙する道具 (`dead-code-tools.md`。毎回は要らないので別ファイル) と、列挙する検査が単一検証コマンドに入っているかのチェックを足した。knip は `canon: facts/knip` の契約、SC2034 と `deno lint` の `no-unused-vars` は実測。
  - review-perspectives の「削減は連鎖する」に、常に true / false になる条件を足した。版で変わる分岐は「一時的な回避策には解除条件を残す」に任せる。
  - writing-comments に、版・環境で結果が変わる分岐のコメントへ固定になる条件を書く、を足した。
- `ed160d6`: pr-workflow の watch の一時ディレクトリ (`watch-pr.*`。#37 の時点で 13 個溜まっていた) を、PR が close か merge されたら消す手順を足した。
- `cbb787b`: `scripts/run-checks.ts` に `deno lint` の段 (`no-unused-vars` だけ) を足し、AGENTS.md の「このリポの検証」に載せた。
  - deno 2.9.7 の `deno lint` も、`*`・`?` を含む引数を glob として展開する。`--` は効く。名前の述語は `deno check` と同じで足りた。
- canon に `facts/deno/lint-file-args-and-rules` (glob の展開・`--rules-tags=` の空の値・cwd の `deno.json` の `lint` 設定との相互作用・`_` の無視) と `facts/shellcheck/sc2034-unused-variable` を足し (canon `adbc74e`)、`run-checks.ts` と `dead-code-tools.md` から引いた。`--rules-tags=` の空の値は文書に無く実測のみ。先頭コメントに「`lint` が空であることを前提にする」を足した。
- `dead-code-tools.md` の「AGENTS.md 設計指針」への参照を外した。setup-repo は他のリポへ配るので、配布先に同じ節があるとは限らない。

## 残っていること

- `deno lint` は未使用の export・module・依存を見ない。それを列挙するのは knip などで、このリポの TypeScript は入れていない (入れる判断をしていない)。
- recommended の残り 9 件は直していない (足したのは `no-unused-vars` だけ)。
- 版で決まる分岐の固定条件は、書かれているかをレビュー (観点) が見るだけで、検査は無い。
- 作ったものを消す規律は書いただけで、検査はしていない。
- この環境の sandbox 内の `./verify.sh` は agent-sync の fixture を飛ばす。全部の検査は適用できる環境で回す。
