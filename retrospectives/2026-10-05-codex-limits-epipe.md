# 振り返り: codex-limits.sh の printf の write error を stderr に出さない

読者: 次に codex-limits.sh や、SIGPIPE を無視して pipe・FIFO に書くスクリプトを触る実装セッション。

## 良かったこと

- PR #33 (文書だけの変更) の CI が落ちたのを、その PR の変更と切り離して原因を追った。落ちたのは main にある test-codex-limits.ts の「codex が PATH に無い」例で、stderr の 1 行目に bash の `printf: write error: Broken pipe` が理由より先に出ていた。

## 直したこと

- `f83d594` codex-limits.sh の最初の `printf` の stderr を捨てる。理由は app-server の出力の read の EOF で出す。bash は SIGPIPE を無視していると閉じた FIFO への書き込みで write error を stderr に書く (canon: `facts/shell/bash-printf-epipe-with-sigpipe-ignored`)。

## 残っていること

- この失敗は、読み手 (app-server を起動する子) が閉じる時刻と printf の時刻の前後に依る。手元の macOS では 100 回回して 0 回、CI の ubuntu-24.04 では 2 回続けて出た。検査で必ず起こす形は作れていない。test-codex-limits.ts の振り返りで両方が通った変異 M18 (`trap '' PIPE` を消す) と同じく、時刻の依存を固定する手段 (書き込みの前に読み手が閉じたことを待つ偽の codex など) が要る。
