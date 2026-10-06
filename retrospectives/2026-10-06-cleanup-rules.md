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
  - 作ったものは作った本人が消し、subagent の分は親が消す。他人が残したものは、中身を確かめて不要と分かったときだけ消す。
  - 単一検証コマンドの項に、自動で列挙できるコードのゴミを足した。
  - 入力と環境の定義域の文に、OS の版・外部コマンドや依存の版の範囲を足した。
- `91b8410`: skills を直した。
  - setup-repo に、コードのゴミを列挙する道具 (`dead-code-tools.md`。毎回は要らないので別ファイル) を足した。knip は `canon: facts/knip` の契約、SC2034 と `deno lint` の `no-unused-vars` は実測。
  - review-perspectives の「削減は連鎖する」に、常に true / false になる条件を足した。版で変わる分岐は「一時的な回避策には解除条件を残す」に任せる。
  - writing-comments に、版・環境で結果が変わる分岐のコメントへ固定になる条件を書く、を足した。
- `ed160d6`: pr-workflow の watch の一時ディレクトリ (`watch-pr.*`。#37 の時点で 13 個溜まっていた) を、PR が close か merge されたら消す手順を足した。
- `cbb787b`: `scripts/run-checks.ts` に `deno lint` の段 (`no-unused-vars` だけ) を足し、AGENTS.md の「このリポの検証」に載せた。
  - deno 2.9.7 の `deno lint` も、`*`・`?` を含む引数を glob として展開する。`--` は効く。名前の述語は `deno check` と同じで足りた。

## 残っていること

- `deno lint` は未使用の export・module・依存を見ない。それを列挙するのは knip などで、このリポの TypeScript は入れていない (入れる判断をしていない)。
- recommended の残り 9 件は直していない (足したのは `no-unused-vars` だけ)。
- 版で決まる分岐の固定条件は、書かれているかをレビュー (観点) が見るだけで、検査は無い。
- 作ったものを消す規律は書いただけで、検査はしていない。
- `deno lint` の contract (読む設定ファイル・環境変数) の目録は canon に無い。この段は `deno.json` を cwd から読むが、その `lint` 設定は空。
- この環境の sandbox 内の `./verify.sh` は agent-sync の fixture を飛ばす。全部の検査は適用できる環境で回す。
