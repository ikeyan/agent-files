# 2026-10-06: test-pr.ts の中断後始末と、ゴミを拾う規律の振り返り

読者: 次の実装セッション。前提知識は AGENTS.md の「ワークフロー」と、`2026-10-06-ts-verify-steps.md` の「残っていること」。

## 状況

- `2026-10-06-ts-verify-steps.md` の「残っていること」に、`scripts/test-pr.ts` が中断で TMPDIR に `pr-pbt.*` を残す、とあった。runner の猶予の実測で見つけたもの。
- 同じ測定で `pr-pbt.*` を 2 つ残し、そのとき TMPDIR には前の作業のゴミ (終わった系列の作業ディレクトリ、merge 済みの PR の watch の一時ディレクトリ) もあった。ユーザーの依頼「ゴミが落ちていて、拾っても悪影響の可能性がなければ拾う」で、ゴミを拾う規律を AGENTS.md に足した。

## 良かったこと

- 中断の測定を、起動から観測まで 1 回の Bash 呼び出しの中で行った (Claude Code の sandbox は呼び出しをまたぐ kill を EPERM にする)。sandbox の中では `pgrep`・`ps` が使えず子が残るかを見られないので、この測定は sandbox の外で回した。
- 後始末の形を、他の test (`scripts/test-cleanup-branch.ts` など) に揃えた。test-pr.ts の一時ディレクトリは `tmpRoot` 1 つの下に全部あるので、消すのは 1 か所で済んだ。

## 直したこと

- `015173d`: `scripts/test-pr.ts` が SIGINT・SIGTERM で中断しても一時ディレクトリを残さない。
  - 子 (pr.sh を回す bash と curl の検査) を `track` に集め、中断で SIGTERM を送って終わるのを待ち、`Deno.exit` が発火する unload で `tmpRoot` を消して 130・143 で終わる。fake の GitHub は自分のプロセスの中にあるので、終われば止まる。
  - 子を spawn する 3 か所 (Proc、curl の検査 2 つ) を揃えた。検査は `output()` から `spawn()` に変えたので `stdin: "null"` を明示した (canon: `facts/deno/command-spawn`。`output()` の既定は null、`spawn()` は inherit)。
  - 実測 (起動 4 秒後に送信): SIGTERM は exit 143、SIGINT は exit 130。どちらも 0.02 秒で終わり (runner の猶予 2 秒に収まる)、`pr-pbt.*`・pr.sh・deno は残らなかった。
  - `2026-10-06-ts-verify-steps.md` の「残っていること」から、この項を消した。
- `566e47e`: AGENTS.md のワークフローに、ゴミを拾う規律を足した。
  - 拾っても悪影響が無いと確かめられれば拾う。
  - 確かめられないもの (持ち主や使用中かが分からない、他人のもの) は、そのまま残して報告する (`e66056b` で「拾わずに」から直した)。
  - 拾ったことも報告に書く。
- この作業の前に拾ったゴミ (悪影響が無いことを確かめて消した):
  - `.git/review-perspectives` の、終わった系列の作業ディレクトリ 4 つ。
  - TMPDIR の、merge 済みの PR の `watch-pr.*` 13 個。
  - 中断の測定で残った `pr-pbt.*` 2 つ。
- `936b510`: レビューで確定した、`scripts/test-pr.ts` の中断の穴を直した。
  - 中断が子の終わりを待つ間に、SIGTERM で死んだ子のせいで性質が落ちると、通常の経路が先に fast-check の失敗を出して exit 1 で終わり、130・143 にならないことがあった。入口の catch で、中断中なら解決しない `interruption` を待ってから投げる。
  - シグナルの受け取りを `interruption ??=` で冪等にした。SIGINT・SIGTERM が何回・どの順で来ても、終了コードは最初のシグナルで決まる (`scripts/run-checks.ts` と同じ形)。
  - cleanup を `tmpRoot` 未設定なら何もしない形にして、`tmpRoot` を作る前に登録した。`tmpRoot` は同期で作るので、シグナルは作る前か置いた後にしか入らない。
  - cleanup が NotFound 以外を投げると finally で本体の失敗を上書きしていたので、stderr に出して終了コードは変えない。
  - 先頭コメントの後始末に、処理するもの・しないものを書いた。
  - 実測 (sandbox の外の 1 回の Bash 呼び出しで、起動の 3〜5 秒後に送信): SIGTERM 1 回・SIGINT 1 回・短い間隔の 2 回 (TERM→INT、INT→TERM) を各 5 回。終了コードはどれも最初のシグナルの値 (143・130)、fast-check の失敗は出ず、`pr-pbt.*` と子は残らなかった。
- `e66056b`: AGENTS.md のゴミの項を「そのまま残して報告する」に直した。

## 残っていること

- 孫 (bash が起こす curl など) は待たない。bash が SIGTERM で死ぬと親を失うが、curl は短時間で終わり、runner が段のグループに送る SIGTERM も孫に届くので、実測では残らなかった。
- SIGHUP・SIGKILL は後始末なしで終わり、`pr-pbt.*` が残る (runner の猶予を過ぎた SIGKILL を含む)。今の中断は 0.02 秒で終わるので起きていない。
- 消せなかった一時ディレクトリは stderr に出すだけで、終了コードは変えない。
- ゴミを拾う規律は AGENTS.md に書いただけで、検査はしていない。
