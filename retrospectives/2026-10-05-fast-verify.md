# 2026-10-05: verify.sh を速くした振り返り

読者: 次に `./verify.sh` の段や `scripts/test-pr.ts` の回し方を触る実装セッション。前提知識は AGENTS.md の「このリポの検証」。

## 状況

- 手元 (macOS、18 コア) の `./verify.sh` は 582 秒かかっていた。`scripts/test-pr.ts` だけで 439 秒で、そのうち CPU 時間は 68 秒ほどだった。残りは待ち時間で、原因は 2 つ:
  - pr.sh が周期の間とまとめの窓で本物の `sleep` を呼んでいた。
  - p4 と同じ秒の上限の検査が、reset の時刻まで実時間で待っていた。
- 最初の版は待ちを並行に回して隠した (`test-pr.ts` の試行を分割し、`verify.sh` の段を並行に回す)。レビューで原因の機構を直すよう指摘され、時刻を仮想にして待ちを消した。
- 手元の時間 (秒):

| 段 | main | 並行にした版 (`656d0cd`) | 今 |
| --- | --- | --- | --- |
| `scripts/test-pr.ts` | 439 | 30〜33 | 77〜81 (順に回す) |
| `scripts/test-agent-sync.sh` | 88 | 95〜97 | 93〜96 |
| `scripts/test-codex-limits.sh` | 30 | 30〜31 | 30 |
| `scripts/test-pre-push.sh` | 19 | 24〜27 | 5〜7 |
| `scripts/test-target-diff.ts` | 11 | 12〜16 | 12 |
| `scripts/test-target-diff.sh` | 10 | 12〜14 | 11〜12 |
| shellcheck | (先に回す) | (先に回す) | 2 |
| 全体 | 582 | 97〜98 | 93〜96 |

- 今の版を 3 回続けて回して全部通った (この後の 2 回のうち 1 回は、残っていることの test-target-diff.sh で落ちた)。

## 良かったこと

- wall の時間と CPU 時間を分けて測ったので、`test-pr.ts` の時間のほとんどが待ちだと分かった。並行にする前にこれを原因として扱っていれば、分割と `PR_JOBS` は要らなかった。
- 仮想の時刻にした後、pr.sh を reset の前に POST するように壊すと固定の検査が落ちることを確かめた。待ちを消しても「reset の前に POST しない」の検査は効いている。
- 再帰の止め方を変えた後、verify.sh を回すリポに `scripts/test-pre-push.sh` を置くように壊すと新しい検査が落ちることを確かめた。

## 直したこと

- `test-pr.ts` の時刻を仮想にした (`eb34ba4`、`674b64c`):
  - pr.sh の PATH の先頭の偽の bin に、待たずに返る `sleep` を足した。bash は `sleep` と `date` を PATH で引く (canon: facts/shell/bash-sleep-date-resolved-via-path)。
  - 偽の `date` は常に試験が決めた時刻を返す。時刻は T0 から始まり、試験が `Fake.setNow` で進めたときだけ進む。`+%s` 以外の引数では落ちる。
  - p4 と同じ秒の上限の検査は、reset の前の周期で何も出さないことを確かめてから時刻を reset に進める。
  - pr.sh の周期は、前から fake が受けた要求 (starts・ends) で数えていたので、偽の sleep が待たなくてもモデルとの照合は変わらない。
- 順に回しても 77〜81 秒になり、全体の律速 (`test-agent-sync.sh`) より短いので、最初の版の並行の仕組みを消した (`eb34ba4`):
  - fast-check の `seed` と `path: "i"` で i 件目の試行を取り出す分割 (`7f16067`)。fast-check の内部の振る舞いに頼っていた。
  - seed の自前の決め方と `PR_JOBS`。
  - FC_SEED の意味と回し方は main と同じに戻った。
- `scripts/test-pre-push.sh` が clone で回す verify.sh の再帰を構造で断った (`fbf716c`):
  - 最初の版は、clone に置いた shellcheck の落ちるファイルで verify.sh が止まることに頼り、shellcheck を並行の段の前に残していた。#27 から版の違う shellcheck では先へ進むので、その手元では再帰が際限なく続く。
  - verify.sh を回すリポを、verify.sh と hooks/pre-push だけを commit したものにした。scripts/ が無いので検査の段は起動できずに落ちる。
  - 版 0.9.0 を名乗る偽の shellcheck で verify.sh を回し、`scripts/test-pre-push.sh` の段が exit 127 で落ちることを確かめる検査を足した。
  - shellcheck を並行の段の 1 つにした。
- test の git の自動 maintenance を止めた (`f5758e1`): push や commit をしたリポを直後に clone・読み取りする 5 つの test の `GIT_CONFIG_GLOBAL` を、`gc.auto=0` と `maintenance.auto=false` を書いた一時ファイルにした。`GIT_CONFIG_COUNT` は test ごとに自前の設定で上書きされるので使わない。
- レビューの指摘を直した (`e838dd1`、`a5e8966`、`e6dcff8`):
  - 自動 maintenance の停止が 5 つの test に散っていたのを、commit した `scripts/test-gitconfig` 1 つにまとめ、原因と確かめていないこと・外す条件を書いた。
  - `verify.sh` の SC2329 の disable を 1 つにして外す条件を書き、出力の経路の長い 1 文を箇条書きにした。
  - 偽の `sleep` の引数を非負整数 1 つに限った。待つ秒数そのものは検査しない。
- `verify.sh` の段の標準出力と標準エラーを分けた (`c0337dd`)。最初の版は 1 つのファイルにまとめ、通った段の警告 (stderr) を stdout に出していた。
- AGENTS.md の検査の順序と `PR_JOBS` の記述を、今の形に直した (`7b81473`)。

## 残っていること

- 全体は `scripts/test-agent-sync.sh` (93〜96 秒) が律速。145 回の sync.sh の起動 (`expect_fail`) が 50 秒ほどを占めるが、同じ下流のリポとロック・`$tmp/err.txt` を共有しているので、並行にするには例ごとにリポを分ける作り直しが要る。
- `test-pr.ts` の残りの時間は pr.sh の周期ごとの curl・jq・awk の起動 (CPU) で、待ちではない。律速になったら、p1〜p5 の `fc.assert` と固定の検査を `Promise.all` で並行に回す (fast-check の公開の API だけで済む)。
- 偽の `sleep` は引数が非負整数 1 つかだけを見るので、pr.sh が待つ秒数 (間隔、失敗時の倍、まとめの窓の `min(間隔, 10)`) は検査に入っていない。本物の `sleep` だった頃も検査していなかった。
- `test-codex-limits.sh` の 30 秒は codex-limits.sh の timeout を待つ時間で、`test-pr.ts` と同じ種類の待ち。短くするには製品の timeout を変えることになる。
- CI (ubuntu-latest、4 vCPU) での時間はまだ見ていない。
- `scripts/test-target-diff.sh` の clone の失敗 (5 回に 1 回、exit 128) は、自動 maintenance の疑いに対する防御を入れただけで、既定の閾値での原因は確かめていない。閾値を下げた再現は 201 回中 2 回で同じ文言で落ち、`receive.autogc=false` では 301 回中 0 回だった (canon: facts/git/auto-maintenance-races-local-clone)。一方、既定の閾値のままの `test-target-diff.sh` 13 回では gc の子が 1 回も走らなかった。手を入れた後の `./verify.sh` は 6 回続けて通ったが、元の頻度 (1/5〜1/6) では再発しないことの証拠として弱い。再発したら、`GIT_TRACE` を付けて回し、clone が落ちた時点で背景の gc 以外に objects を消すものが無いか調べる。
- `test-pr.ts` が SIGTERM で止まると一時ディレクトリ (`pr-pbt.*`) が `$TMPDIR` に残る。main でも同じ。
