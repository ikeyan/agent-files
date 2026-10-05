# 2026-10-06: test-pr.ts の中断後始末と、ゴミを拾う規律の振り返り

読者: 次の実装セッション。前提知識は AGENTS.md の「ワークフロー」と、`2026-10-06-ts-verify-steps.md` の「残っていること」。

## 状況

- `2026-10-06-ts-verify-steps.md` の「残っていること」に、`scripts/test-pr.ts` が中断で TMPDIR に `pr-pbt.*` を残す、とあった。runner の猶予の実測で見つけたもの。
- 同じ測定で `pr-pbt.*` を 2 つ残し、そのとき TMPDIR には前の作業のゴミ (終わった系列の作業ディレクトリ、merge 済みの PR の watch の一時ディレクトリ) もあった。ゴミを拾う規律が AGENTS.md に無かったので足した。

## 良かったこと

- 中断の測定を、起動から観測まで 1 回の Bash 呼び出しの中で行った (Claude Code の sandbox は呼び出しをまたぐ kill を EPERM にする)。sandbox の中では `pgrep`・`ps` が使えず子が残るかを見られないので、この測定は sandbox の外で回した。
- 後始末の形を、他の test (`scripts/test-cleanup-branch.ts` など) に揃えた。test-pr.ts の一時ディレクトリは `tmpRoot` 1 つの下に全部あるので、消すのは 1 か所で済んだ。

## 直したこと

- `015173d`: `scripts/test-pr.ts` が SIGINT・SIGTERM で中断しても一時ディレクトリを残さない。
  - 子 (pr.sh を回す bash と curl の検査) を `track` に集め、中断で SIGTERM を送って終わるのを待ち、`Deno.exit` が発火する unload で `tmpRoot` を消して 130・143 で終わる。fake の GitHub は自分のプロセスの中にあるので、終われば止まる。
  - 子を spawn する 3 か所 (Proc、curl の検査 2 つ) を揃えた。検査は `output()` から `spawn()` に変えたので `stdin: "null"` を明示した (canon: `facts/deno/command-spawn`。`output()` の既定は null、`spawn()` は inherit)。
  - 実測 (起動 4 秒後に送信): SIGTERM は exit 143、SIGINT は exit 130。どちらも 0.02 秒で終わり (runner の猶予 2 秒に収まる)、`pr-pbt.*`・pr.sh・deno は残らなかった。
  - `2026-10-06-ts-verify-steps.md` の「残っていること」から、この項を消した。
- `566e47e`: AGENTS.md のワークフローに、ゴミを拾う規律を足した。拾っても悪影響が無いと確かめられれば拾い、確かめられないもの (持ち主や使用中かが分からない、他人のもの) は拾わずに報告し、拾ったことも報告に書く。
- この作業の前に拾ったゴミ (悪影響が無いことを確かめて消した):
  - `.git/review-perspectives` の、終わった系列の作業ディレクトリ 4 つ。
  - TMPDIR の、merge 済みの PR の `watch-pr.*` 13 個。
  - 中断の測定で残った `pr-pbt.*` 2 つ。

## 残っていること

- 子の bash が起動した curl などの孫は、bash が SIGTERM で死ぬと親を失う。curl は短時間で終わり、runner が段のグループに送る SIGTERM も孫に届くので、今は残っていないが、孫を待つ仕組みは無い。
- SIGKILL (runner の猶予を過ぎたとき) では後始末が走らず、`pr-pbt.*` は残る。今の中断は 0.02 秒で終わるので起きていない。
- ゴミを拾う規律は AGENTS.md に書いただけで、検査はしていない。
