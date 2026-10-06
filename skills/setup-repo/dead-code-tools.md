# コードのゴミを列挙する道具

言語ごとに、未使用の変数・import・export・module・依存を列挙する道具。単一検証コマンドに含め、指摘がゼロであることを通す条件にする。

| 言語 | 道具 | 列挙するもの |
| --- | --- | --- |
| TypeScript / Node | knip (`canon: facts/knip`) | 未使用の export・ファイル・依存 |
| TypeScript (Deno) | `deno lint` の `no-unused-vars` (`canon: facts/deno/lint-file-args-and-rules`) | 未使用の変数・import (export は見ない) |
| shell | shellcheck の SC2034 (`canon: facts/shellcheck/sc2034-unused-variable`) | 未使用の変数 |

- 表に無い言語は、そのリポで等価な道具を選ぶ。
- 道具が列挙できないもの (環境・版で決まる分岐) は、コードが前提とする環境の版の範囲を仕様に書き、分岐のコメントに固定になる条件を書く ([writing-comments](../writing-comments/SKILL.md))。
