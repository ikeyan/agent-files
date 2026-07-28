# POSIX shell / 標準ユーティリティ

## `&&` と `||` の結合 — `A || B && C` は `(A || B) && C`

`[docs]` POSIX Shell Command Language 2.9.3 AND-OR List: 「The operators "&&" and "||" shall have equal precedence and shall be evaluated with left associativity.」<https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html>

「失敗したときだけ条件付きで何かする」を `A || B && C` と書くと、`A` が成功したときも `(A || B)` が真になり `C` に到達する。意図どおりにするには `A || { B && C; }` とグループ化する。

`[empirical]` 2026-07-28 実測 (macOS 26.5.2 の `/bin/sh`、および `node:24-slim` の `sh` で同結果)。`diff -q s1 "$L" >/dev/null || [ -n "$WARN" ] && echo warn` を 4 通りで実行:

| 入力 | exit | 出力 |
| --- | --- | --- |
| 同期・`WARN` 無 | 0 | `warn` ← 誤出力 |
| 同期・`WARN` 有 | 0 | `warn` ← 誤出力 |
| drift・`WARN` 無 | 1 | なし |
| drift・`WARN` 有 | 0 | `warn` |

`{ }` を足した `… || { [ -n "$WARN" ] && echo warn; }` では同期時の 2 ケースが出力なしになる。

## `TMPDIR` は設定されている保証がない

`[docs-silent]` POSIX の shell 変数 (2.5.3) に `TMPDIR` は含まれない。設定は環境側の慣習。

`[docs-silent]` GitHub Actions の既定の環境変数一覧に `TMPDIR` は無い。一時ディレクトリとして文書化されているのは `RUNNER_TEMP`。<https://docs.github.com/en/actions/reference/workflows-and-actions/variables>

`[empirical]` 2026-07-28 実測:

| 環境 | `TMPDIR` |
| --- | --- |
| macOS 26.5.2 | `/var/folders/…/T/` (launchd が設定) |
| `node:24-slim` (node v24.18.0) | unset |

未設定のまま `"$TMPDIR/foo"` と書くと `/foo` に展開され、root で動くコンテナでは黙って成功する。`${TMPDIR:-/tmp}` とフォールバックを書く。

## `mktemp` の `TMPDIR` 尊重は BSD と GNU で異なる

`[empirical]` 2026-07-28 実測。`TMPDIR` を既定と違うディレクトリに設定して `mktemp -u` を実行:

| 呼び方 | BSD (macOS 26.5.2) | GNU coreutils (`node:24-slim`) |
| --- | --- | --- |
| 引数なし | `TMPDIR` を**無視**し Darwin のユーザ一時ディレクトリ | `TMPDIR` に従う |
| `-t <prefix>` | `TMPDIR` を**無視** | `TMPDIR` に従う |
| `-p <dir>` | `<dir>` (`TMPDIR` と食い違うときも `-p` が優先) | 同左 |
| `mktemp "<dir>/foo.XXXXXX"` | `<dir>` | `<dir>` |

一時ファイルを特定のディレクトリに置きたいなら、`TMPDIR` を設定して `mktemp` に任せるのではなく `-p` で渡す。`-p` は BSD の man にも `mktemp [-d] [-p tmpdir] [-q] [-t prefix] [-u] template ...` として載っており、両実装で使える。

これは書き込み先を制限したサンドボックス下で問題になる。macOS の Claude Code サンドボックスは `$TMPDIR` を含む限られたパスしか書き込みを許さず、Darwin のユーザ一時ディレクトリはそこに入らないため、引数なしの `mktemp` は `Operation not permitted` で落ちる (実測)。

`mktemp` を使う理由は `TMPDIR` の解決ではなく、**予測可能な固定パスへの書き込みを避けること**にある。共有ホストの `/tmp` に固定名で `curl -o` すると、先に同名の symlink を置かれたときに追従する。

## `trap … EXIT` は呼び出し側の EXIT trap を置き換える

`[empirical]` 2026-07-28 実測 (macOS 26.5.2 の `/bin/sh`)。EXIT trap を設定済みのシェルに `trap 'rm -f "$f"' EXIT` を素で埋め込むと、元の trap は発火しなくなり、変数 `f` も上書きされる。`( )` で囲むと元の trap が発火し、`f` も保たれ、一時ファイルは subshell 終了時に消え、終了ステータス (0/1/2 で確認) もそのまま伝わる。

スニペットとして配る shell 片が EXIT trap を張るなら `( )` で囲む。trap の本体は単一引用符なので `$f` の展開はシェル終了時であり、囲まないと後続のコードが `f` を再利用したときに無関係なファイルを消しうる。

## BSD sed はブロック内の `q` の後に `;` を要求する

`[empirical]` 2026-07-28 実測。`sed -n '/^source: /{s///p;q}'` は GNU sed 4.9 (`node:24-slim`) では通るが、BSD sed (macOS 26.5.2) では失敗する:

```
sed: 1: "/^source: /{s///p;q
": extra characters at the end of q command
```

`q` の後に `;` を置いた `sed -n '/^source: /{s///p;q;}'` は両方で通る。Linux の CI でしか実行していないと露見しない。
