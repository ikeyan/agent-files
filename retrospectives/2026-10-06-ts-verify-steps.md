# 2026-10-06: verify.sh の検査の段を TypeScript に移した振り返り

読者: 次に `./verify.sh` の段を触る実装セッション。前提知識は AGENTS.md の「このリポの検証」と「このリポのスクリプトの言語」、`2026-10-05-fast-verify.md` (並行の runner を shell で作ったとき)。

## 状況

- 移す前の `verify.sh` は、状態を揃える段の後に、検査の段を `set -m` の subshell で並行に回し、段ごとの出力を一時ディレクトリのファイルに残してから決めた順で出していた。止めるときは EXIT trap で段のプロセスグループに TERM を送っていた。
- 移した後の形:
  - 状態を揃える段 (hooks/pre-push の写し、`.claude/skills` の symlink、core.hooksPath の検査、VERIFY_READONLY) は `verify.sh` に残した。symlink を deno で作るには、パスを付けない read・write の許可が要る (canon: `facts/deno/permission-paths-not-resolved`)。
  - 検査の段は `scripts/run-checks.ts` に移した。`verify.sh` は最後に `exec deno run --allow-run --allow-env=TMPDIR scripts/run-checks.ts "$status"` で替わる。引数は状態を揃える段の結果 (0 か 1) で、検査が全部通っても 1 なら exit 1。
    - exec にしたのは、`verify.sh` の pid だけに届く SIGINT・SIGTERM を runner が直接受けるため。bash が deno を前景で待つ形では、SIGTERM で bash だけが死に、deno と段が残る (bash の子の deno に pid を書かせ、bash にだけ SIGTERM を送って確かめた)。
    - 段の子は `Deno.Command` の `detached: true` で起動する。deno 2.9.7 の `spawn()` は子で `setsid` する (`ext/process/lib.rs` の `create_command`) ので、子はそれぞれ自分のプロセスグループの先頭になる。perl の `getpgrp` で、pgid が子の pid になることを確かめた。`outputSync()` では `detached` が効かず、子は親のグループに残った。止めるときは `Deno.kill(-pid, "SIGTERM")` でグループに送る。`Deno.kill` は `--allow-run` をパスで絞ると NotCapable になるので、runner の `--allow-run` は絞らない (deno を起こせる時点で絞っても意味は無い)。
    - 出力はファイルでなく pipe で受ける。段の子が終わったら、そのグループに残ったものに SIGTERM を送る。残ったものが pipe を開いたままにすると、pipe を読み終えられず段が終わらないため (下の表の「出力を開いたまま残る孫」)。
    - 段の deno の許可は移す前と同じ。段ごとに子の deno を起動する。
  - `scripts/verify.ts` (JSON と Markdown の検査) は runner に吸収せず、1 つの段のまま残した。
    - 許可が違う (`--allow-read=.` と `--allow-net=www.schemastore.org`)。吸収すると runner に net と read を足すことになる。
    - npm の依存 (ajv・markdown-it・github-slugger) を持つ。吸収すると runner の起動が依存の解決を待ち、scripts/ の無いリポでの落ち方も依存に左右される。
    - 段は子プロセスなので、グループごと止められ、出力を分けて受けられる。runner の中で回すと、どちらにも別の仕組みが要る。
    - 名前は `run-checks.ts` にした。`verify-*.ts` だと `verify.ts` と接頭辞で紛れる。
  - `git ls-files | deno run … scripts/verify.ts` の bash のパイプは、runner が `git ls-files` の出力を deno の stdin に書く形にした。
  - 見出しの所要時間は整数の秒から小数 1 桁の秒にした (`performance.now()`)。
- `scripts/test-pre-push.ts` の追随:
  - scripts/ の無いリポで回す verify.sh は、検査の段 (`scripts/run-checks.ts`) が `Module not found` で起動できずに exit 1 で落ちる (canon: `facts/deno/run-missing-module`)。`verify.sh が写す` の検査でこの落ち方を照合する。
  - `shellcheck の版が違う verify.sh` の検査は、リポに `scripts/run-checks.ts` だけを置く。shellcheck の段だけが版の違いで落ち、`scripts/test-pre-push.ts` の段は `Module not found` で落ちる (この test を呼び返さない)。版の検査が runner に移ったので、runner の無いリポでは版の検査を確かめられない。
- 時間 (秒、手元の macOS 18 コア、Claude Code の sandbox の中。agent-sync の描画の検査は飛ぶ。移す前は 1 回、移した後は 3 回):

| 対象 | 移す前 | 移した後 |
| --- | --- | --- |
| `./verify.sh` 全体 | 88 | 87〜91 |
| 律速の `scripts/test-pr.ts` の段 | 87 | 87.2〜89.8 |
| `scripts/test-pre-push.ts` の段 | 10 | 7.0〜8.0 |

- 全体の時間は変わらない。律速は `scripts/test-pr.ts` のまま。`scripts/test-pre-push.ts` は shellcheck の検査で runner と 8 つの deno を余分に起動する。

## 良かったこと

- 古い runner を消す前に、検査の段の test を stub に替えた一時の clone を作り、古い `verify.sh` と新しい形の両方を同じ条件で回した (下の「同等性」)。stub は段ごとに決めた時間だけ待ち、stdout と stderr に段の名前を出し、決めた exit code で終わる。PATH の先頭の `deno` と `shellcheck` の wrapper が呼び出しを記録する。
- 同等性の確認の道具が runner の壊れを捕えることを、runner の変異で確かめた (下の「runner の変異」)。
- 最初に回したシグナルの確認で、古い `verify.sh` が SIGINT で止まらず、段の孫が残った。原因は確認の道具の側で、`&` で起動した非対話の bash の子は SIGINT を無視した状態で始まり、bash はそれを trap できない (bash(1) の `trap`: 「Signals ignored upon entry to the shell cannot be trapped or reset」)。perl で SIGINT を既定に戻してから起動し直すと、両方が止まった。新しい形 (deno の `Deno.addSignalListener`) は、無視した状態で始まっても SIGINT を受けて止まった。

## 直したこと

`ce4eb22` に全部を入れた。

- 検査の段を `scripts/run-checks.ts` に移し、`verify.sh` の検査の段 (`check_files`・`run_shellcheck`・`step`・出力のループ・SC2329 の disable) を消した。
- `scripts/test-pre-push.ts` を新しい落ち方に合わせた (上の「状況」)。
- AGENTS.md の「このリポの検証」に exec と止め方を書き、「このリポのスクリプトの言語」から移す対象を消して、`verify.sh` の入口と状態を揃える段を対象外に足した。README は検査の段に触れていないので変えていない。

## 同等性

一時の clone (検査の段の test を stub に替えたもの) で、古い `verify.sh` (`c49cb81`) と新しい形を回した。出力は所要時間と一時ディレクトリのパスを置き換えて比べた。「同じ」は、新しい形で増えたファイル (`scripts/run-checks.ts`) による差 (deno check の `Check scripts/run-checks.ts` の行と、verify.ts に渡すファイルの数の 1 つの差) の他に違いが無いこと。

| 性質 | 確かめ方 | 古い verify.sh | 新しい形 |
| --- | --- | --- | --- |
| 1 つの段が落ちる | `scripts/test-pr.ts` の stub を exit 1 にする | exit 1。落ちた段は見出しと stdout・stderr を stderr へ、他の段の stdout は stdout へ | 同じ |
| 2 つの段が落ちる | `scripts/test-target-diff.ts` を exit 2、`scripts/verify.ts` を exit 3 にする | exit 1。両方を `落ちた (exit 2、…)`・`落ちた (exit 3、…)` で示す | 同じ |
| 出力の順 | 段の終わる順を、決めた順の逆にする (先の段ほど長く待つ) | 決めた順 | 同じ |
| SIGINT を verify.sh の pid へ | 段の stub が起こした孫 (`sleep 300`) の pid を記録し、送ってから 1 秒後に見る | exit 130。段の deno も孫も残らない | 同じ |
| SIGTERM を verify.sh の pid へ | 同上 | exit 143。残らない | 同じ |
| SIGINT をプロセスグループへ (端末の Ctrl-C) | 同上 | exit 130。残らない | 同じ |
| shellcheck の版が違う | 0.9.0 を名乗る shellcheck を PATH の先頭に置く | shellcheck の段だけが版の違いで落ち、他の段は回って通る。exit 1 | 同じ |
| git が知っている .ts が無い | `.gitignore` に `*.ts` を書き、index から外す | `deno check` を呼ばずに通る | 同じ |
| git が知っている .sh と hooks/pre-push が無い | 同様に外す | shellcheck は `--version` だけを呼んで通る | 同じ |
| scripts/ の無いリポ | verify.sh と hooks/pre-push だけのリポ | hook を写し、shellcheck と deno check は通り、7 つの段が `Module not found` で落ちる。exit 1 | hook を写し、`scripts/run-checks.ts` が `Module not found` で落ちる。exit 1 |
| VERIFY_READONLY=1 | `.claude/skills` の symlink を 1 つ消し、hook の無い clone で回す | hook と symlink を直さずに示し、検査は全部通って exit 1 | 同じ |
| VERIFY_READONLY 無し | 同上 | hook を写し、symlink を作る | 同じ |
| 出力を開いたまま残る孫 | 段の stub が `sleep 300 &` を残して終わる | 4 秒で終わる。孫は残る | 4 秒で終わる。孫は残らない |

- `scripts/test-pre-push.ts` は、古い形では古い版が、新しい形では直した版が通った。

## runner の変異

`scripts/run-checks.ts` を壊し、上の確認の道具で回した。

| 変異 | 壊したもの | 結果 |
| --- | --- | --- |
| R1 | シグナルで、グループでなく直接の子にだけ SIGTERM を送る | 捕えない。子が終わった後のグループへの SIGTERM が孫も止めるため |
| R2 | 子が終わった後のグループへの SIGTERM を消す | 出力を開いたまま残る孫で、孫が終わるまで (確認の道具が 30 秒で止めた) 段が終わらない |
| R3 | 落ちた段の stdout を stdout へ出す | 1 つの段が落ちる確認で、出力が古い形と違う |
| R4 | 終わった順で出す | 出力の順の確認で、出力が古い形と違う |
| R5 | R1 と R2 の両方 | シグナルの 3 つの確認で、`bash -c` の孫 (`sleep 300`) が残る |

`scripts/test-pre-push.ts` が捕える変異 (この test の一時のコピーで回した):

| 変異 | 壊したもの | 捕えた検査 |
| --- | --- | --- |
| T1 | runner が shellcheck の版を見ない | shellcheck の版が違う verify.sh (版の違いを示さない) |
| T2 | verify.sh が runner を起動せずに終わる | verify.sh が写す (検査の段を起動できずに落ちていない) |
| T3 | runner から `scripts/test-pre-push.ts` の段を消す | shellcheck の版が違う verify.sh (この test の段が起動できずに落ちていない) |

## 残っていること

- test・開発用のスクリプトの TypeScript への移植は、これで終わった。
- runner の性質 (並行・出力の順と経路・止め方・状態を揃える段の結果の引き継ぎ) を常に回る検査は無い。この振り返りの確認は一時の道具で、リポに入れていない。入れるなら、runner の段の定義を差し替えられる形 (stub に向けた段の表) が要る。
- `scripts/test-pre-push.ts` の shellcheck の検査は、runner と 8 つの deno を起動する。段が増えればこの検査も重くなる。
- runner は段の子の出力を pipe で受けるので、段の孫が SIGTERM を無視して pipe を開いたまま残ると、段が終わらない。今の段では起きていない (`./verify.sh` は 3 回とも全部の段の後に終わった)。
- 非対話の bash から `./verify.sh &` で回すと、古い `verify.sh` は SIGINT を無視したが、新しい形は受けて止まる。端末から回すときと、SIGTERM の挙動は同じ。
