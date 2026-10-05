# 2026-10-05: test-agent-sync を TypeScript に移した振り返り

読者: 次に `scripts/test-*.sh` を TypeScript (Deno) に移す実装セッション。前提知識は AGENTS.md の「このリポの検証」と「このリポのスクリプトの言語」。

## 状況

- `scripts/test-agent-sync.sh` は `verify.sh` の律速だった (手元の macOS で単独 89 秒)。sync.sh の約 145 回の起動が、1 つの下流のリポ・ロック・`$tmp/err.txt` を共有していて、並行にできなかった。
- このリポの test と開発用のスクリプトを TypeScript (Deno) に揃える方針を決め、AGENTS.md に規則として書いた。この PR はその最初の移植。
- 移した後の形:
  - 検査ごとに下流のリポを作るか、共有の元 (初回の後・v2 の後・古いパスを足した後) を `cp -Rp` で写して使う。sync.sh の同時の起動が同じリポのロックに当たらない。
  - 上流は最初に全ての commit (v1・v2・衝突の tree・名前が `-` で始まる tree) を作り、後は読むだけ。
  - 子プロセスには `clearEnv` で PATH と test の変数だけを渡す。sh の「`git rev-parse --local-env-vars` の変数を unset するループ」が要らない。
  - 子プロセスの数は `navigator.hardwareConcurrency` で絞り、検査は全部を最初に始める。
- 時間 (秒、手元の macOS 18 コア、Claude Code の sandbox の外):

| 対象 | 移す前 | 移した後 |
| --- | --- | --- |
| agent-sync の test を単独で | 89 | 20〜21 |
| `./verify.sh` の中の agent-sync の段 | 93〜96 (`2026-10-05-fast-verify.md`) | 24〜25 |
| `./verify.sh` 全体 | 93〜96 (同) | 93〜99 (3 回) |

- `./verify.sh` 全体の律速は `scripts/test-pr.ts` (93〜99 秒) に移った。全体の時間は変わっていない。
- Claude Code の sandbox の中の `./verify.sh` は 84 秒で通った。agent-sync の段は 3 秒で、初回の描画が「OS の sandbox を適用できない」で落ち、描画を伴う検査を飛ばした理由を出した。`CI=1` では落ちることも確かめた。

## 良かったこと

- 移す前に、sync.sh の安全の性質ごとの変異を作り、古い sh と新しい ts の両方が落ちることを確かめてから sh を消した (下の表)。変異の無い sync.sh では両方が通った。
- 変異を回す途中で、前提の検査 (初回) が落ちたときに ts が未処理の reject で止まる不具合を見つけた (`derive`)。落ちること自体は正しかったが、理由が出ない形だった。
- 変異の 1 つ (M22) は、最初の書き方では pipefail の下で SIGPIPE を起こし、狙いと逆の「常に落ちる」変異になっていた。どの検査が捕えたかを両方のログで見比べたので、正しく直せた。

## 直したこと

- `7a7c26f` sh の全ての fixture と検査を ts に移した。
- `4c9c5a3` verify.sh の段を替えて sh を消し、AGENTS.md に言語の方針を書いた。
- `240cdad` レビューの指摘を直した。
  - Deno.Command は相対パスのコマンドを絶対パスにして起動するので、sync.sh の `$0` が常に絶対パスだった。sh は `./.agent-sync/sync.sh` で起動していて、here の解決を壊す変異 (M24) を捕えていたが、ts は通した。`env` を通して `$0` を保つ。
  - 下流を検査ごとに写すようにしたので、落ちた起動が `.git` の下に残すものを後の検査が見なくなった。`expectFail` で `.git` の下 (index と objects を除く) を前後で比べる。この検査は sh より強い (M25 は sh では通る)。
- `3b09605` AGENTS.md の TypeScript で書く理由を、1 文に詰めず項目に分けた。
- `6a44c49` 二回目のレビューの指摘を直した。
  - Deno.Command の契約 (相対パスの絶対化・clearEnv と env・PATH の引き・stdin の既定) を canon の `facts/deno/command-spawn` に残し、依る行から引いた。ソースと macOS の実測で確かめた。
  - env を通す回避に外せる条件を書いた。env 自身も `env.PATH` で引かれるので、PATH を差し替える検査は env のあるディレクトリを残す。
  - 先頭に入力と環境の定義域 (読む環境変数、TMPDIR の定義域、UTF-8 の locale が無いときの扱い) と、並行の検査が共有する状態を宣言した。TMPDIR が定義域の外なら最初に落ちる。
  - 後始末は、ディレクトリの mode を戻してから消す。mode 111 の検査の最中に Ctrl-C を受けると、finally が走らず `removeSync` が PermissionDenied で一時ディレクトリを残した。
- `d47f7ab` 先頭は GIT_CONFIG* が通ると書いていたが、見ていたのは GIT_CONFIG_COUNT だけだった。GIT_CONFIG_PARAMETERS と GIT_CONFIG の fixture を足した (sync.sh の拒否から GIT_CONFIG_PARAMETERS だけを外す変異で落ちる)。

## 変異と結果

sync.sh を 1 か所ずつ壊し、sh (`7a7c26f`) と ts を回した。ts は最後の `240cdad` でも全部を回し直した。「捕えた検査」は ts の最初の失敗 (sh も M25 以外は同じ検査で落ちた)。

| 変異 | 壊したもの | sh | ts | 捕えた検査 |
| --- | --- | --- | --- | --- |
| M00 | (無し) | 通る | 通る | — |
| M01 | 同一性: 利用者の編集を拒まない (`elif false`) | 落ちる | 落ちる | 置き先: 利用者の編集 (未コミット) |
| M02 | 同一性: rec を見ない | 落ちる | 落ちる | v2 (前回の結果を置き直せない) |
| M03 | 同一性: new を見ない | 落ちる | 落ちる | 初回 (手で写した sync.sh を引き取れない) |
| M04 | 古いパス: 編集されたものも消す | 落ちる | 落ちる | 古いパス: 編集 (未コミット) |
| M05 | 古いパスを消さない | 落ちる | 落ちる | v2: codex-limits.sh が残った |
| M06 | 作業ツリーの綴りの別名を見ない (`case_clash`) | 落ちる | 落ちる | 置き先: 大文字小文字だけ違う利用者のファイル |
| M07 | 上流の tree の別名を見ない | 落ちる | 落ちる | 上流のパスの衝突 file-file |
| M08 | 描画の出力の名前の定義域を見ない (改行) | 落ちる | 落ちる | 描画の出力のファイル名に改行 |
| M09 | 上流のパスの改行を見ない | 落ちる | 落ちる | 上流のパスの衝突 newline |
| M10 | mode だけ違うとき既存の inode を chmod する | 落ちる | 落ちる | 置き先: hard link で mode だけ違う |
| M11 | GIT_* を拒まない | 落ちる | 落ちる | GIT_ALTERNATE_OBJECT_DIRECTORIES が設定されている |
| M12 | `LC_ALL=C` を外す | 落ちる | 落ちる | locale en_US.UTF-8・TMPDIR に文字 é |
| M13 | 作業ディレクトリの文字を見ない | 落ちる | 落ちる | TMPDIR に文字 tab |
| M14 | sandbox を適用できないの判定から文言を外す | 落ちる | 落ちる | 文言の無い起動側の失敗は描画の失敗 |
| M15 | ロックを `mkdir -p` で取る | 落ちる | 落ちる | ロックが取られている (他の起動のロックを消した) |
| M16 | `.agent-sync/` の下を全部許す | 落ちる | 落ちる | 一覧の行 `.agent-sync/answers.yaml` |
| M17 | 別の置き先の親のディレクトリを見ない | 落ちる | 落ちる | 一覧の行 `foo` と `foo/bar` |
| M18 | `--object-format=sha1` を外す | 落ちる | 落ちる | GIT_DEFAULT_HASH=sha256 |
| M19 | `--template=` を外す | 落ちる | 落ちる | GIT_TEMPLATE_DIR |
| M20 | fetch の `GIT_TERMINAL_PROMPT=0` を外す | 落ちる | 落ちる | fetch の GIT_TERMINAL_PROMPT |
| M21 | archetect の版を見ない | 落ちる | 落ちる | archetect の版 |
| M22 | `.agent-sync/sync.sh` を置かない描画を拒まない | 落ちる | 落ちる | agent-sync の部品を合成していない |
| M23 | EXIT trap が一時ファイルを消さない | 落ちる | 落ちる | mv の失敗 (2 つ目): 一時ファイルが残った |
| M24 | here を `pwd -P` で解決しない | 落ちる | 落ちる (`240cdad` から) | OS の sandbox を適用できない (場所の検査で落ちる) |
| M25 | ロックを取った後に `.git/config` を書く | 通る | 落ちる | 落ちた sync.sh が .git の下を変えた |

## 残っていること

- 次に移すもの: `scripts/test-pre-push.sh`、`scripts/test-target-diff.sh` (できれば `scripts/test-target-diff.ts` と 1 つにする)、`scripts/test-codex-limits.sh`、`scripts/test-cleanup-branch.sh`、`verify.sh` の検査の段。
- 移すときは、この PR と同じく変異を作って新旧の両方で落ちることを確かめてから古いものを消す。どの検査が捕えたかも見る (M22 のように変異が狙いと違うことがある)。
- Deno.Command は相対パスのコマンドを絶対パスにして起動する。`$0` を見るスクリプトを使い方の形で起動するには `env` を通す。契約は canon の `facts/deno/command-spawn`。測ったのは deno 2.9.7・macOS 26.6.2 (arm64) だけで、CI (ubuntu、deno v2.x) は測っていない。
- ts の中の shim (sandbox-exec・bwrap・git・awk・uname・mv・archetect) は shell の文字列で、shellcheck が見ない。
- `--allow-run` を絞れない (sync.sh の写しと shim を一時ディレクトリから起動する) ので、Deno の許可は子プロセスに対しては効かない。
- sandbox の外へ出ようとする probe の部品は、固定のパス (`$tmp/outside`、`$tmp/secret.txt`) を上流に書き込む。描画するのは 1 つの検査だけなので並行でも当たらないが、2 つ目を足すなら検査ごとの上流が要る。
- 文字の分類と同一性の表は固定の表で回し、fast-check は使わなかった。行は canon の目録の値そのもので、生成しても増える値が無い。
- CI (ubuntu-latest、bwrap) での時間はまだ見ていない。
