# 2026-10-05: test-codex-limits を TypeScript に移した振り返り

読者: 次に `scripts/test-*.sh` を TypeScript (Deno) に移す実装セッション。前提知識は AGENTS.md の「このリポの検証」と「このリポのスクリプトの言語」、`2026-10-05-ts-test-cleanup-branch.md`。

## 状況

- `scripts/test-codex-limits.sh` は、応答しない例 (30 秒の timeout を待つ) だけを裏で回し、残りの 6 例を順に回す形だった。
- 移した後の形:
  - 検査ごとに一時ディレクトリ (`${tmp}/f/<n>`) を作り、codex-limits.sh の TMPDIR と偽の codex の CASE をその下に置く。全部を最初に始め、子プロセスの数は `navigator.hardwareConcurrency` で絞る。応答しない例は最初に始め、他の例と並行に回る。
  - 偽の codex は codex-limits.sh が PATH で引いて起動する実行ファイルなので、ts の中の bash の文字列のまま。準備で 1 つ書き、全ての検査が読むだけ。
  - codex か jq を欠いた PATH (要るコマンドへの symlink を集めたディレクトリ) は bash の子で作る。deno で symlink を作ると read・write の許可をパスに絞れない。
  - 子の環境は `clearEnv` と baseEnv (PATH・HOME・TMPDIR・`LC_ALL=C`) と、検査ごとの CASE・TMPDIR・PATH だけ。stdin は null (codex-limits.sh は stdin を読まず、app-server とは自分で作った FIFO でやりとりする)。
  - codex-limits.sh は `$0` を見ない (理由の接頭辞は固定の文字列) ので、絶対パスで直接起動する。
  - verify.sh の段の許可は `--allow-run=bash,skills/setup-repo/pr-workflow/codex-limits.sh --allow-env=PATH,TMPDIR --allow-read="${TMPDIR:-/tmp}" --allow-write="${TMPDIR:-/tmp}"`。
- 時間 (秒、手元の macOS 18 コア、Claude Code の sandbox の中):

| 対象 | 移す前 (sh) | 移した後 (ts) |
| --- | --- | --- |
| 単独 | 30.05〜30.41 (2 回) | 30.28〜30.29 (3 回) |
| `./verify.sh` の中の段 (1 回) | — | 31 |
| `./verify.sh` 全体 (1 回) | — | 98 (律速は `scripts/test-pr.ts` の 98) |

- どちらも応答しない例の 30 秒が律速で、時間は変わらない。例は 7 (sh の `run` 6 と、手で回す `none`) から 9 (ts の `fixture`) に増えた。偽の codex は 1 つの inode なので、macOS の初回の exec の待ち (canon: `facts/macos/first-exec-of-new-executable`) は 1 回分しか積まれない。

## 良かったこと

- 移す前に codex-limits.sh の性質ごとの変異を作り、古い sh と新しい ts の両方を回してから sh を消した (下の表)。変異の無いものでは両方が通った。
- 応答しない例を飛ばす一時的な ts は作らず、全ての変異で ts を丸ごと回した。8 変異ずつ並行に回し、全部で約 3 分だった。
- 変異の結果を読み、stderr の 1 行目を関数で照合した失敗の文言が関数のソースを出していたのを、正規表現で照合する形に直した。

## 直したこと

`51a13a8` に入れた。

- sh の全ての検査を ts に移し、verify.sh の段を替えて sh を消した。AGENTS.md の列挙のファイル名を直した。
- sh に無かった検査を足した:
  - 応答しない例が 30 秒の timeout を待つ (29 秒以上かかる)。sh は文言だけを見ていて、timeout を 10 秒に縮める変異 (M08) を通した。
  - codex の stderr を捨てる。偽の codex が stderr にログを出し、成功の例は stderr が空であることを見る。sh の偽物は stderr に何も出さず、sh は `none` (codex が PATH に無い) で bash の `command not found` が見えることでだけ捕えていた (M12)。
  - 応答が JSON でないとき、exit 2 で stderr の 1 行目が jq の理由。codex-limits.sh の先頭に書いてあるが、検査が無かった。
  - rateLimits に窓も項目も無いとき、全部が - になる。
  - 応答しない例の他は 5 秒以内に終わる。sh は jq が無い例だけで見ていた。
- 偽の codex は、入力が閉じても終わらない (読み終えたら `exec sleep 60`)。sh の偽物は入力が閉じると終わったので、app-server を止めない変異 (M10) を捕えるのは応答しない例だけだった。ts では全ての例が捕える。
- app-server が残っているかは、pid が 2 秒のうちに消えるかで見る。codex-limits.sh の `kill` は終わりを待たない。
- 準備の失敗 (要るコマンドが PATH に無い・symlink を作れない) は例外にして、どのコマンドが無いかを出して exit 1 で落ちる。`in` が無いとき (app-server が 1 行も受けていない) と中身が違うときで、失敗の文言を分けた。
- 引数を渡したとき、TMPDIR が相対パスのとき、TMPDIR に空白を含めたときに、理由を出して exit 1 で落ちることを確かめた。
- 中断の後始末を実測した。deno への SIGTERM (起動から 2 秒)、deno への SIGINT (2 秒)、プロセスグループへの SIGINT (0.3・2 秒) のどれでも exit 143・130 で終わり、一時ディレクトリも応答しない例の偽の codex (`sleep 60`) も残らなかった。
  - deno は子の codex-limits.sh に SIGTERM を送るだけで、偽の codex は codex-limits.sh の EXIT trap が止める。bash は SIGTERM で終わるときも EXIT trap を回す (canon: `facts/shell/bash-exit-trap-runs-on-fatal-signal`。macOS の /bin/bash 3.2.57 と Homebrew の bash 5.3.20 で実測)。
  - job control の無い bash の `&` で起動したものは SIGINT を無視する (bash(1) の SIGNALS) ので、プロセスグループへの SIGINT でも偽の codex はこの経路で止まる。

## 変異と結果

codex-limits.sh を 1 か所ずつ壊し、sh (`5ed41ea` の `scripts/test-codex-limits.sh`) と ts (`51a13a8`) を一時コピーで回した。「捕えた検査」は ts の最初の失敗 (sh も M08・M18 以外は同じ性質の検査で落ちた)。

| 変異 | 壊したもの | sh | ts | 捕えた検査 |
| --- | --- | --- | --- | --- |
| M00 | (無し) | 通る | 通る | — |
| M01 | 出力の名前と usedPercent の区切りをタブから空白にする | 落ちる | 落ちる | 全部の値 (stdout) |
| M02 | resetsAt の null を - にしない | 落ちる | 落ちる | null の値と窓 (stdout) |
| M03 | reached の行を出さない | 落ちる | 落ちる | 全部の値 (stdout) |
| M04 | error を exit 2 にする | 落ちる | 落ちる | error (終了コード) |
| M05 | error の message を stdout に出す | 落ちる | 落ちる | error (stdout が空でない) |
| M06 | 応答の前に終わったときも「30 秒以内に応答しない」と出す | 落ちる | 落ちる | 何も返さずに終わる (stderr) |
| M07 | timeout でも「応答の前に終わった」と出す | 落ちる | 落ちる | 応答しない (stderr) |
| M08 | timeout を 10 秒にする | 通る | 落ちる | 応答しない (30 秒の timeout を待っていない) |
| M09 | read に timeout を付けない | 落ちる | 落ちる | 応答しない (偽の codex の `sleep 60` の後に「応答の前に終わった」) |
| M10 | EXIT trap で app-server を止めない | 落ちる | 落ちる | 応答しない (app-server が残っている)。ts は他の 6 例も落ちる |
| M11 | EXIT trap で一時ディレクトリを消さない | 落ちる | 落ちる | 応答しない (一時ディレクトリが残っている) |
| M12 | codex の stderr を捨てない | 落ちる | 落ちる | 応答しない (stderr の 1 行目が偽の codex のログ)。sh は codex が PATH に無い例の `command not found` で落ちた |
| M13 | id 2 でなく id 1 以外の最初の行 (通知) を応答とする | 落ちる | 落ちる | 全部の値 (stdout) |
| M14 | jq が落ちても次の行を待つ | 落ちる | 落ちる | 応答が JSON でない (30 秒かかった) |
| M15 | jq の stderr を捨てる | 落ちる | 落ちる | 応答が JSON でない (stderr の 1 行目が空) |
| M16 | initialize の clientInfo の name を変える | 落ちる | 落ちる | 全部の値 (app-server に送った行) |
| M17 | codex を `app-server` 無しで起動する | 落ちる | 落ちる | 応答しない (応答の前に終わった) |
| M18 | `trap '' PIPE` を消す | 通る | 通る | — (下の「残っていること」) |
| M19 | 最初の行で読むのをやめる (通知を挟む応答を待たない) | 落ちる | 落ちる | 全部の値 (stdout が空) |
| M20 | initialized を送らない | 落ちる | 落ちる | 全部の値 (app-server に送った行) |
| M21 | `.error.message` を `jq -e` 無しで読む (成功の応答も error とする) | 落ちる | 落ちる | 全部の値 (終了コード 1、`codex-limits.sh: null`) |

## 残っていること

- 次に移すもの:
  - `scripts/test-target-diff.sh` (`scripts/test-target-diff.ts` と 1 つにする)
  - `verify.sh` の検査の段
- `trap '' PIPE` (app-server が先に終わったときに SIGPIPE で黙って止まらない) は検査できていない (M18 はどちらも通った)。codex-limits.sh は FIFO を開いた直後に 3 行を書くので、偽の codex が起動して読み手を閉じるより先に書き終わるためと見ているが、確かめていない。読み手が閉じてから書く順は、偽の codex の側からは作れない。
- 応答しない例の 30 秒が、この段と変異の検査の時間の下限。codex-limits.sh の timeout は固定で、短くする knob は無い (足すなら定義域ごと抱える)。
- 偽の codex (ts の中の bash の文字列) は shellcheck が見ない。
- 応答が JSON でない例は、jq が理由を `jq: ` で始めて出すこと (手元の jq 1.8.2 で実測) に依る。jq の文言が変われば、この検査が落ちて知らせる。
- app-server を止めない変異では、偽の codex (`sleep 60`) が test の後も最大 60 秒残る。test は残っていることを示すだけで、pid を kill しない (pid の再利用で別のプロセスに当たりうるため)。
