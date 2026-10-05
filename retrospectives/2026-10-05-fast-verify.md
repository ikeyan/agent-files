# 2026-10-05: verify.sh を並行に回して速くした振り返り

読者: 次に `./verify.sh` の段や `scripts/test-pr.ts` の回し方を触る実装セッション。前提知識は AGENTS.md の「このリポの検証」。

## 状況

- 手元 (macOS、18 コア) の `./verify.sh` は 582 秒かかっていた。`scripts/test-pr.ts` だけで 439 秒で、その内訳は固定の検査 195 秒、p5 133 秒、p2・p4 が 48 秒ずつ。pr.sh が実際に間隔を sleep するので、CPU 時間は 68 秒ほどしかない。
- 並行にした後の手元の時間 (秒):

| 段 | 前 | 後 |
| --- | --- | --- |
| `scripts/test-pr.ts` | 439 | 31〜33 |
| `scripts/test-agent-sync.sh` | 88 | 96〜97 |
| `scripts/test-codex-limits.sh` | 30 | 30〜31 |
| `scripts/test-pre-push.sh` | 19 | 24〜26 |
| `scripts/test-target-diff.ts` | 11 | 13〜16 |
| `scripts/test-target-diff.sh` | 10 | 12〜13 |
| 全体 | 582 | 97〜98 |

- 3 回続けて回して全部通った。`PR_JOBS=4` (CI の runner の CPU の数) でも通り、`test-pr.ts` が 106 秒、全体が 108 秒。`PR_RUNS=40 PR_JOBS=36` の `test-pr.ts` 単体も通った (45 秒)。

## 良かったこと

- 性質の試行を fast-check の `seed` と `path: "i"` で 1 件ずつ取り出した。同じ seed なら順に回したときと同じ例になることを、fast-check 4.10.2 の `pathWalk`・`lazyToss` を読み、値の一致を実測して確かめてから使った。FC_SEED の意味は変わらない。
- `scripts/test-pre-push.sh` が clone で回す verify.sh は、shellcheck が落ちることで自身を呼び返さずに止まっている。並行にする前にこの依存に気づき、shellcheck を並行の段の前に残した。

## 直したこと

- `test-pr.ts` の固定の検査と性質の各試行を、同時に `PR_JOBS` 件まで回す (`7f16067`)。落ちた単位は fast-check が `cause` に入れた元の失敗と一緒に全部を示す。
- `verify.sh` の shellcheck の後の段を並行に回し、落ちた段を全部示す (`0efe5da`)。段は `set -m` で自分のプロセスグループに入れ、止まるときにグループごと TERM を送る。非対話の shell の裏の段は SIGINT を無視するので、これが無いと Ctrl-C の後に pr.sh が残る。
- AGENTS.md に検査の順序と `PR_JOBS` を書いた (`205a035`)。

## 残っていること

- 全体は `scripts/test-agent-sync.sh` (96 秒) が律速。145 回の sync.sh の起動 (`expect_fail`) が 50 秒ほどを占めるが、同じ下流のリポとロック・`$tmp/err.txt` を共有しているので、並行にするには例ごとにリポを分ける作り直しが要る。今回は手を付けていない。
- `test-codex-limits.sh` の 30 秒は codex-limits.sh の timeout を待つ時間で、短くするには製品の timeout を変えることになる。
- CI (ubuntu-latest、4 vCPU) での時間はまだ見ていない。`PR_JOBS=4` の手元の測定どおりなら、`test-pr.ts` と `test-agent-sync.sh` がどちらも 100 秒前後になる。
- `test-pr.ts` が SIGTERM で止まると一時ディレクトリ (`pr-pbt.*`) が `$TMPDIR` に残る。順に回していたときも同じ。
