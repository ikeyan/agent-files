# 2026-10-06: verify.sh の検査の段を TypeScript に移した振り返り

読者: 次に `./verify.sh` の段を触る実装セッション。前提知識は AGENTS.md の「このリポの検証」と「このリポのスクリプトの言語」、`2026-10-05-fast-verify.md` (並行の runner を shell で作ったとき)。

## 状況

- 移す前の `verify.sh` は、状態を揃える段の後に、検査の段を `set -m` の subshell で並行に回し、段ごとの出力を一時ディレクトリのファイルに残してから決めた順で出していた。止めるときは EXIT trap で段のプロセスグループに TERM を送っていた。
- 移した後の形:
  - 状態を揃える段は `verify.sh` に残した。symlink を deno で作るには、パスを付けない read・write の許可が要る (canon: `facts/deno/permission-paths-not-resolved`)。残した段:
    - hooks/pre-push の写し
    - `.claude/skills` の symlink
    - core.hooksPath の検査
    - VERIFY_READONLY
  - 検査の段は `scripts/run-checks.ts` に移した。`verify.sh` は最後に `exec deno run --allow-run --allow-env=TMPDIR scripts/run-checks.ts "$status"` で替わる。引数は状態を揃える段の結果 (0 か 1) で、検査が全部通っても 1 なら exit 1。
    - exec にしたのは、`verify.sh` の pid だけに届く SIGHUP・SIGINT・SIGTERM を runner が直接受けるため。bash が deno を前景で待つ形では、SIGTERM で bash だけが死に、deno と段が残る (bash の子の deno に pid を書かせ、bash にだけ SIGTERM を送って確かめた)。
    - 段の子は `Deno.Command` の `detached: true` で起動する。deno 2.9.7 の `spawn()` は子で `setsid` する (`ext/process/lib.rs` の `create_command`) ので、子はそれぞれ自分のプロセスグループの先頭になる。perl の `getpgrp` で、pgid が子の pid になることを確かめた。`outputSync()` では `detached` が効かず、子は親のグループに残った。止めるときは `Deno.kill(-pid, …)` でグループに送る。`Deno.kill` は `--allow-run` をパスで絞ると NotCapable になるので、runner の `--allow-run` は絞らない (deno を起こせる時点で絞っても意味は無い。canon: `facts/deno/command-spawn` の「Deno.kill」)。
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

- 古い runner を消す前に、検査の段の test を stub に替えた一時の clone を作り、古い `verify.sh` と新しい形の両方を同じ条件で回した (下の「同等性」)。
  - stub は段ごとに決めた時間だけ待ち、stdout と stderr に段の名前を出し、決めた exit code で終わる。
  - PATH の先頭の `deno` と `shellcheck` の wrapper が呼び出しを記録する。
- 同等性の確認の道具が runner の壊れを捕えることを、runner の変異で確かめた (下の「runner の変異」)。
- 最初に回したシグナルの確認で、古い `verify.sh` が SIGINT で止まらず、段の孫が残った。原因は確認の道具の側で、`&` で起動した非対話の bash の子は SIGINT を無視した状態で始まり、bash はそれを trap できない (bash(1) の `trap`: 「Signals ignored upon entry to the shell cannot be trapped or reset」)。perl で SIGINT を既定に戻してから起動し直すと、両方が止まった。新しい形 (deno の `Deno.addSignalListener`) は、無視した状態で始まっても SIGINT を受けて止まった。

## 直したこと

移したものは `ce4eb22` に入れた。

- 検査の段を `scripts/run-checks.ts` に移し、`verify.sh` の検査の段 (`check_files`・`run_shellcheck`・`step`・出力のループ・SC2329 の disable) を消した。
- `scripts/test-pre-push.ts` を新しい落ち方に合わせた (上の「状況」)。
- AGENTS.md の「このリポの検証」に exec と止め方を書き、「このリポのスクリプトの言語」から移す対象を消して、`verify.sh` の入口と状態を揃える段を対象外に足した。README は検査の段に触れていないので変えていない。

レビューの指摘で `scripts/run-checks.ts` を直した:

- 中断が始まったら、通常の経路は出力せず、中断の経路の終わり (`Deno.exit`) を待つ。それまでは、中断が子を待つ間に全段が決着すると、通常の経路が全段を「落ちた」で出して exit 1 しえた。
- 2 回目のシグナルで、残っている段のグループに SIGKILL を送ってすぐ終わる。それまでは、SIGTERM を受けても子を待つ段があると、何回送っても終わらなかった。
- SIGHUP も受ける (exit 129)。それまでは端末を閉じると runner だけが死に、setsid した段は孤児で残った。シグナルと終了コードの対応は `signals` の 1 つの表にした。
- 段の子の stdin への書き込みが `Deno.errors.BrokenPipe` で投げても (子が先に終わった)、子を回収してグループを止め、子の status と stderr を段の結果にする。子が exit 0 なら、読み終える前に閉じたことを示して exit 1 にする。それまでは EPIPE の stack が段の結果になり、子は回収されなかった。BrokenPipe は実測して canon (`facts/deno/command-spawn`) に足した。
- グループへの `Deno.kill` の `EPERM` (`PermissionDenied`) を、`ESRCH` と同じく「止めるものが無い」として扱う。macOS は、終わりかけのものだけのグループに送るとまれに `EPERM` を返す (先頭に SIGKILL を送った直後のグループで 1000 回に 2〜5 回。canon: `facts/deno/command-spawn` の「Deno.kill」)。それまでは、中断の経路で投げると終了コードがシグナルの値にならず、通常の経路では段の結果が stack になりえた。
- git ls-files が落ちたときに out を空にする処理を `gitFiles` の 1 か所にし、終了コードを結果と引数から 1 回で求める。
- 日本語名のファイル (47 件) が検査から外れていた。`git ls-files` を `-z` 無しで回していたので、git が名前を `"\343\201..."` と quote して出し、`scripts/verify.ts` の `.md` で終わる名前の絞り込みに掛からなかった (移す前の `verify.sh` から)。`-z` で出して NUL で分ける形にした (canon: `facts/git/path-output-quoting`)。
- 名前の次元を `scripts/run-checks.ts` の先頭の定義域で閉じた (git の名前についての 2 回目の指摘)。次元は canon の `facts/git/path-output-quoting` と `facts/git/untracked-entry-kinds` から挙げた。
  - `-` で始まる名前は、`./` を前置して shellcheck と deno check に渡す。`-x.sh` は shellcheck が option と読んで usage を出し、検査されなかった。`--` は使わない: shellcheck 0.11.0 は `--` の後を位置引数にするが、deno 2.9.7 の `deno check` は `--` の後の名前を無視して cwd 全体を検査した (canon: `facts/deno/check-double-dash`、`facts/shellcheck/leading-dash-file-names`)。
  - 改行を含む名前は、`gitFiles` が理由と名前 (JSON.stringify) を出して、その一覧を使う段を落とす。それまでは先頭コメントで「含まない」と宣言するだけで、verify.ts へ渡す 1 行 1 件の入力で名前が割れた。
  - 非 ASCII・引用符・バックスラッシュ・タブ・空白は処理する。作業ツリーに無い追跡ファイルとリンク先の無い symlink は、コマンドが名前の無いことを知らせて落ちる。
  - 一時の clone で、`-x.sh`・空白を含む `.ts`・`-bad.md`・改行を含む `.md`・壊れた symlink を置いて段の挙動を確かめた。
- 段の先頭が終わった後のグループを、空にしてから段を終える形にした (中断と通常の経路の両方への指摘)。点で直さず、1 つの操作 (`emptyGroup`) で両方の経路を覆った: 先頭が終わったらグループに SIGTERM を送り、出力の pipe が閉じるか猶予 (2 秒) が過ぎたら SIGKILL を送る。
  - それまでは、1 回目のシグナルで先頭だけを待って終わるので、SIGTERM を無視する子孫が残り、2 回目のシグナルを受ける者がいなくなった。通常の経路でも、SIGTERM を無視して pipe を開いたままの孫がいると段が終わらなかった。
  - 1 回目の中断の経路の定義域を、グループの状態 (先頭が SIGTERM で終わる・終わらない × 子孫が残らない・SIGTERM で終わる・無視する) で先頭コメントに列挙した。
  - 各グループに SIGTERM を高々 1 回送る。それまでは中断のときに 2 回届いていた (中断の SIGTERM と、先頭が終わった後の SIGTERM)。段の子孫の `run-checks.ts` (`scripts/test-pre-push.ts` が回す verify.sh) は、2 回目を 2 回目のシグナルと読んで、自分の段を待たずに終わる。
- UTF-8 として不正な名前を落とす (git の名前についての 3 回目の指摘)。名前の次元を値ごとに足すのをやめ、「UTF-8 として正しく改行を含まない名前だけを処理し、他は理由と名前を出して落とす」を 1 つの契約にした。
  - それまでは既定の `TextDecoder` で一覧全体を decode していたので、不正なバイトが U+FFFD になり、index だけにある `bad-\xff.sh` と U+FFFD を含む `bad-�.sh` が同じ名前に潰れ、前者が検査から外れた。
  - NUL で分けた名前ごとに `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })` で decode する。`ignoreBOM` が無いと、名前ごとの decode が U+FEFF で始まる名前の先頭を落とす (WHATWG Encoding の decode は呼ぶたびに BOM seen を戻す)。落とす名前は、バイトを `\xHH` に escape して出す。
  - macOS の APFS は不正な名前のファイルを作れない (EILSEQ) が、`git update-index --cacheinfo` で index に入れると `ls-files --cached` に出る。canon の `facts/git/path-output-quoting` に足した。
- `*`・`?` を含む名前を落とす (git の名前についての 4 回目の指摘)。`gitFiles` の受け入れを 1 つの述語 (`accepted`: UTF-8 として正しく、改行と `*`・`?` を含まない) にまとめ、先頭コメントの名前の節をその述語を主に書き直した。
  - それまでは `./x*.ts` を deno check に渡し、deno 2.9.7 がそれを glob として展開して、git が無視するファイルまで検査した。
  - 集合は deno v2.9.7 の `libs/config/glob/mod.rs` と実測で決めた。`*`・`?` だけが展開され、エスケープの手段は無い。`[`・`]` は deno が文字どおりに置き換え、`{`・`}` は glob crate が解釈しない (指摘は `[` も展開すると書いていたが、`./a[1].ts` は `a[1].ts` だけを検査した)。canon の `facts/deno/check-file-args-glob` に足した。
  - deno check に名前を渡さず、引数なしで deno 自身に探させる形は採らなかった。deno.json が無いと .gitignore を見ず、`.claude/worktrees` の下の .ts まで検査するので、exclude の設定 (knob) が要る。
- `collect` の出力の Promise に、作った直後に空の catch を付けた。`emptyGroup` の race に渡るまでに reject すると、unhandled rejection で runner が落ち、setsid した段が残りえた。
- `scripts/verify.ts` が stdin を `ignoreBOM: true` で decode する。既定の `TextDecoder` は、一覧の先頭の名前が U+FEFF で始まると、それを BOM として落とした (リンク切れを持つ U+FEFF で始まる .md を 1 件だけ渡すと、直す前は「ファイルが無い」、直した後はリンク切れを報告した)。

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
| SIGHUP を verify.sh の pid へ・プロセスグループへ (端末を閉じる) | 同上 | exit 129。残らない | 同じ (直す前の runner は exit 129 で、段の deno と孫が残った) |
| SIGTERM を無視する子を持つ段に、SIGTERM・SIGINT・SIGHUP を 2 回 | 段の stub は SIGTERM を受けると子の終わりを待ち、子 (`trap "" TERM; exec sleep 300`) は SIGTERM を無視する。1 回目の 3 秒後に 2 回目を送る | 1 回目ですぐ 143・130・129 で終わり、段の deno と子が残る | 1 回目では待つ。2 回目から 0.007〜0.012 秒で 143・130・129 で終わり、残らない (直す前の runner は 2 回目でも終わらず、確認の道具が 20 秒で SIGKILL した。SIGHUP では 1 回目で死に、段が残った) |
| 段がシグナルですぐ終わる | 段の stub (listener 無しの deno) を 1.5 秒待つ形にし、起動から 1.6〜2.1 秒にグループへ送る。SIGINT・SIGTERM・SIGHUP を 20 回ずつ | 測っていない | 終わる前に届いた 14・15・15 回は全部 130・143・129 で、段の見出しを出さない。残りは送る前に終わっていた (exit 0)。直す前の runner も 0.8〜2.0 秒の 14 回ずつで同じだった (競合は再現していない) |
| 段の子が stdin を読まずに終わる | 未追跡のファイルを 3000 足して git ls-files の出力を 254725 バイトにし、`scripts/verify.ts` の stub を読まずに exit 5・exit 0 で終わらせる | 測っていない | exit 5 は `落ちた (exit 5、…)` と stub の stderr。exit 0 は `落ちた (exit 1、…)` と stub の stderr と「読み終える前に閉じた」。直す前の runner はどちらも `落ちた (exit 1、…)` と `BrokenPipe` の stack |
| shellcheck の版が違う | 0.9.0 を名乗る shellcheck を PATH の先頭に置く | shellcheck の段だけが版の違いで落ち、他の段は回って通る。exit 1 | 同じ |
| git が知っている .ts が無い | `.gitignore` に `*.ts` を書き、index から外す | `deno check` を呼ばずに通る | 同じ |
| git が知っている .sh と hooks/pre-push が無い | 同様に外す | shellcheck は `--version` だけを呼んで通る | 同じ |
| scripts/ の無いリポ | verify.sh と hooks/pre-push だけのリポ | hook を写し、shellcheck と deno check は通り、7 つの段が `Module not found` で落ちる。exit 1 | hook を写し、`scripts/run-checks.ts` が `Module not found` で落ちる。exit 1 |
| VERIFY_READONLY=1 | `.claude/skills` の symlink を 1 つ消し、hook の無い clone で回す | hook と symlink を直さずに示し、検査は全部通って exit 1 | 同じ |
| VERIFY_READONLY 無し | 同上 | hook を写し、symlink を作る | 同じ |
| 出力を開いたまま残る孫 | 段の stub が `sleep 300 &` を残して終わる | 4 秒で終わる。孫は残る | 4 秒で終わる。孫は残らない |
| 段の先頭が SIGTERM で終わり、子孫が SIGTERM を無視する | 段の stub (listener 無しの deno) の子が `trap "" TERM; exec sleep 300`。SIGTERM・SIGINT・SIGHUP を 1 回 | 測っていない | 143・130・129 で、子が pipe を開いていれば 2.0 秒 (猶予) で、開いていなければ 0.013 秒で終わる。子は残らない。直す前の runner は 0.012 秒で終わり、子が残った |
| 中断で子孫が受ける SIGTERM の数 | 段の stub (listener 無しの deno) の子が、SIGTERM を受けるたびにファイルに 1 行書いて動き続ける。SIGTERM・SIGINT・SIGHUP を 1 回 | 測っていない | 1 回。子は残らない。直す前の runner は 2 回で、子が残った |
| SIGTERM を無視して残る孫 (通常の経路) | 段の stub が `trap "" TERM; sleep 300 &` を残して終わる | 測っていない | pipe を開いた孫は 2.8 秒で、開いていない孫 (`>/dev/null 2>&1`) は 1.1 秒で verify.sh が終わる。孫は残らない。直す前の runner は、前者で孫が終わるまで (300 秒) 段が終わらず、後者で孫が残った |
| glob のメタ文字を含む名前 | `xa.ts`・`x*.ts`・`a[1].ts`・`{b}.ts` を置き、型エラーの `xz-ignored.ts` を `.git/info/exclude` に書く。別に `x*.ts` を `q?.ts` に替える | 測っていない | deno check と verify.ts の段が、理由と `x*.ts` (`q?.ts`) を出して落ちる。`*`・`?` を含む名前を消すと、deno check は `a[1].ts`・`{b}.ts`・`xa.ts` を検査し、`xz-ignored.ts` を検査せずに通る。直す前の runner は `./x*.ts` を `xz-ignored.ts` まで展開し、その型エラーで deno check の段が落ちた |
| UTF-8 として不正な名前 | index だけに `bad-\xff.sh` を入れ、作業ツリーに U+FFFD を含む `bad-�.sh` と U+FEFF で始まる `bom.sh` を置く | 測っていない | shellcheck と verify.ts の段が、理由と `bad-\xff.sh` を出して落ちる。直す前の runner は 2 つの名前を `bad-�.sh` に潰して verify.ts に 2 回渡し、shellcheck の段は `bad-\xff.sh` を検査せずに進んだ。U+FEFF で始まる名前は、どちらも shellcheck にそのまま渡った (その名前で SC2086 を出した) |

- `scripts/test-pre-push.ts` は、古い形では古い版が、新しい形では直した版が通った。
- グループを空にする形に直した後、上の表の他の行を回し直した。シグナル・2 回のシグナル・stdin を読まない子・出力の順を含め、結果は直す前と同じだった (段がシグナルですぐ終わる行は、終わる前に届いた 15・15・16 回が全部 130・143・129)。stub に替えた出力は、直す前の runner と、所要時間を除いて一致した。

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
- 次の runner の性質を常に回る検査は無い:
  - 並行
  - 出力の順と経路
  - 止め方
  - 状態を揃える段の結果の引き継ぎ

  この振り返りの確認は一時の道具で、リポに入れていない。入れるなら、runner の段の定義を差し替えられる形 (stub に向けた段の表) が要る。
- `scripts/test-pre-push.ts` の shellcheck の検査は、runner と 8 つの deno を起動する。段が増えればこの検査も重くなる。
- 古い `verify.sh` と新しい形で、シグナルの挙動が違うところ:
  - 非対話の bash から `./verify.sh &` で回したときの SIGINT: 古い形は無視し、新しい形は受けて止まる。
  - 1 回目のシグナル: 古い形は段のグループに TERM を送ってすぐ終わり、新しい形は段が終わるのを待つ。2 回目は新しい形もすぐ終わる。
- グループを空にする操作の、まだ閉じていないところ:
  - 自分で setsid してグループを抜けた子孫は止められない。それが pipe を開いたままだと段が終わらない。
  - pipe を開いていない子孫は、pipe が閉じた時点で猶予なしに SIGKILL を受ける。SIGTERM で片付けを始めていても、片付けは終わらない。
- UTF-8 として不正な名前を Linux の作業ツリーに作って測っていない (macOS では index に入れて測った)。

## 次の実装セッションへ

- git の名前の次元への指摘が 4 回続いた (`-` で始まる・改行・UTF-8 として不正・glob のメタ文字)。外部コマンドへ名前を渡す行は、最初から受け入れる名前の集合を 1 つの述語で決め、外れる名前は理由を出して落とす。値ごとに対処を足すと、次の値で同じ指摘が来る。
