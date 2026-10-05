# 振り返り: 下流の jq の下限を 1.6 と書く

読者: 次に、配るスクリプトが前提にする外部コマンドの版を扱う実装セッション。

## 良かったこと

- PR #32 で Codex が jq 1.6 の parse error の文言を指摘したのを受け、下流で実際に使う版 (Raspberry Pi OS bookworm の 1.6) を利用者に確かめてから下限を決めた。Debian の各版の jq は sources.debian.org で確かめ、canon (`facts/jq/parse-error-prefix`) に足した。

## 直したこと

- `cdb9dfb` README の「agent-sync で配る」に jq 1.6 以上と理由を書き、AGENTS.md の「必要なもの」に版を書いた。`scripts/test-codex-limits.ts` の parse error の照合に、下限を 1.7 に上げたときの TODO を置いた。
- Codex の指摘で、下限を配る側の前提の宣言 (`pr.sh`・`codex-limits.sh` の先頭と `gh.md`) にも書いた。README はこのリポの読者にしか届かず、agent-sync で受け取るリポには配る側の宣言だけが届く。

## 残っていること

- 配るスクリプトが使う他の外部コマンド (`curl`・`codex`・`mktemp` 等) の版の下限は README に書いていない。下流の環境で版の違いが問題になったら、同じ形で足す。
