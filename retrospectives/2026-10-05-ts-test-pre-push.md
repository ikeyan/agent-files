# 2026-10-05: test-pre-push を TypeScript に移した振り返り

読者: 次に `scripts/test-*.sh` を TypeScript (Deno) に移す実装セッション。前提知識は AGENTS.md の「このリポの検証」と「このリポのスクリプトの言語」、`2026-10-05-ts-test-agent-sync.md`。

## 状況

- `scripts/test-pre-push.sh` は 1 つの clone・`$tmp/who`・verify.sh を回すリポを順に使い回す筋書きで、並行にできなかった。
- 移した後の形:
  - 検査ごとに一時リポジトリ (clone と push 先の bare、または verify.sh を回すリポ) を作り、全部を最初に始める。子プロセスの数は `navigator.hardwareConcurrency` で絞る。
  - 子の環境は `clearEnv` で明示する。PUSH_OK と VERIFY_READONLY を呼び出し元から引き継がない (sh の `unset PUSH_OK` と `env -u VERIFY_READONLY` が要らない)。
  - verify.sh は `env ./verify.sh` で使い方の形のまま起動する (canon: `facts/deno/command-spawn`)。
  - verify.sh の段の許可は `--allow-run=git,env --allow-env=PATH,TMPDIR --allow-read --allow-write`。read・write は symlink を作るので絞れない。
  - verify.sh を回すリポに scripts/ が無いことは変えていない。shellcheck の版が違うときの検査は、`scripts/test-pre-push.ts` の段が deno の `Module not found` で exit 1 になることを見る (sh では exit 127)。
- 時間 (秒、手元の macOS 18 コア):

| 対象 | 移す前 (sh) | 移した後 (ts) |
| --- | --- | --- |
| 単独 (Claude Code の sandbox の中、3 回) | 4.6〜5.0 | 5.5〜6.4 |
| 単独 (sandbox の外、3 回) | 4.5 | 5.4 |
| `./verify.sh` の中の段 (sandbox の中、2 回) | 5〜7 (`2026-10-05-fast-verify.md`) | 9〜10 |
| `./verify.sh` 全体 (sandbox の中、2 回) | 93〜96 (同) | 89 |

- 速くはならなかった。30 の検査がそれぞれ準備のリポを作り直し、verify.sh の起動は 13 回から 16 回に増えた。また、並行に回した `git push` が 1 回 1.3〜3 秒かかる (単独では 0.03〜0.17 秒)。CPU は 135% 程度で、原因は調べていない。全体の律速は `scripts/test-pr.ts` のままで、全体の時間は変わらない。

## 良かったこと

- 移す前に hooks/pre-push と verify.sh の性質ごとの変異を作り、古い sh と新しい ts の両方を回してから sh を消した (下の表)。変異の無いものでは両方が通った。
- 先頭の性質の一覧を変異の表と突き合わせたので、一覧に書いてあるのにどちらの test も見ていない性質が 2 つ見つかった (V12・V16)。
- 中断の後始末を実測した。プロセスグループへの SIGINT を 0.5 秒で送ると、子が一時ディレクトリに書いている最中の `removeSync` が `Directory not empty` で落ち、一時ディレクトリが残った。

## 直したこと

`19d1a31` に全部を入れた (sh を消す前の作業で直したもの)。

- sh の全ての検査を ts に移し、verify.sh の段を替えて sh を消した。AGENTS.md の列挙のファイル名を直した。
- sh に無かった検査を足した。
  - linked worktree で回した verify.sh が、写しを worktree の git dir でなく common git dir の hooks に置く。先頭の「common git dir の hooks へ写す」は sh でも書いていたが、verify.sh を linked worktree で回す検査が無かった。
  - 現行と同じ実行可能な pre-push があれば、verify.sh は示さず写し直さない (VERIFY_READONLY=1 でも)。sh の先頭は「何もしない」と書いていたが、その場合の出力も inode も見ていなかった。
- 中断では子に SIGTERM を送り、子が終わるのを待ってから消す。中断の後は新しい子を起こさない。プロセスグループへの SIGINT (0.3〜2.5 秒) と deno だけへの SIGINT (0.3〜1.5 秒) で、一時ディレクトリが残らないことを確かめた。
- `.git` の中からの push の検査は git 自身の英語のエラーを見るので、`LC_ALL=C` にした (この commit ではその push だけ。下の修正で baseEnv へ移した)。clearEnv で LANG が無いと、Homebrew の bash 5.3 は macOS の言語の設定 (ja-JP) で訳した (「行 140」)。git 2.55.0 は訳さなかったが、契約ではない。
- 自分のレビューで、bare リポジトリの検査の `git for-each-ref ""` が何も出さないことに気づいた (空の pattern は全ての ref でなく何にも合わない)。remote に ref ができたかの検査が常に通っていた。pattern を渡さない形にした。
- core.hooksPath の検査は、`git config --get` が設定の無いときに exit 1 になるのを例外にせず、書き換えたと示す。

レビューの修正 (`edcab49`)。

- TMPDIR に空白・`%`・非 ASCII があると、`shellcheck の版が違う verify.sh` の検査が file URL との照合で誤って落ちた。deno が URL のパスを percent-encode するため (canon: `facts/deno/run-missing-module`)。解決済みの一時ディレクトリが `A-Z a-z 0-9 . _ / -` だけであることを調べ、外れていれば理由を出して落ちる (`test-agent-sync.ts` と同じ定義域)。先頭の定義域の行も直した。TMPDIR に空白を含めて実測し、理由を出して exit 1 で落ちる。
- `LC_ALL=C` を baseEnv に置いた。clearEnv で locale の環境変数が無くても macOS では bash などがシステムの言語で訳すため (canon: `facts/shell/gettext-macos-system-language`)。`.git` の中からの push だけの上書きを消した。
- `pre-push.local の呼び出し`: 最後の `git rev-parse` の `.catch(() => "")` を外した (git の失敗は例外として理由に出る)。引数と stdin の記録が無いとき (pre-push.local が呼ばれなかったとき) は、「null」でなくそう示す。
- `core.hooksPath` の最後の失敗に stderr を含めた。`seq` をやめ、検査のディレクトリ番号を `reports.length - 1` から導いた。`install` の JSDoc を消した。

## 変異と結果

hooks/pre-push と verify.sh を 1 か所ずつ壊し、sh (`a30f60d` の `scripts/test-pre-push.sh` と verify.sh) と ts (`19d1a31`) を回した。変異は両方の verify.sh の同じ箇所に当てた。「捕えた検査」は ts の最初の失敗 (sh も V07・V15・V17 以外は同じ検査で落ちた)。

| 変異 | 壊したもの | sh | ts | 捕えた検査 |
| --- | --- | --- | --- | --- |
| M00 | (無し) | 通る | 通る | — |
| M01 | pre-push: PUSH_OK を見ない | 落ちる | 落ちる | PUSH_OK 無しで push が通った |
| M02 | pre-push: PUSH_OK が空でなければ通す | 落ちる | 落ちる | PUSH_OK=0 で push が通った |
| M03 | pre-push: 許可を `.git/ok` に残し、次の push も通す | 落ちる | 落ちる | PUSH_OK=1 の push の後、PUSH_OK 無しが通った |
| M04 | pre-push: pre-push.local を呼ばない | 落ちる | 落ちる | pre-push.local が 1 で終わったのに push が通った |
| M05 | pre-push: pre-push.local に引数を渡さない | 落ちる | 落ちる | pre-push.local の引数が remote 名と URL でない |
| M06 | pre-push: pre-push.local の stdin を /dev/null にする | 落ちる | 落ちる | pre-push.local の stdin に ref の行が無い |
| M07 | pre-push: pre-push.local の終了コードを捨てる | 落ちる | 落ちる | pre-push.local が 1 で終わったのに push が通った |
| M08 | pre-push: 実行可能な通常のファイルでない pre-push.local で exit 0 | 落ちる | 落ちる | pre-push.local: 実行可能でない (push が通った) |
| M09 | pre-push: 通常のファイルかを見ない | 落ちる | 落ちる | pre-push.local: ディレクトリ (問題を示さない) |
| M10 | pre-push: 壊れた symlink を無いものとして扱う | 落ちる | 落ちる | pre-push.local: 壊れた symlink (push が通った) |
| M11 | pre-push: 作業ツリーのルートを得られなければ cwd を使う | 落ちる | 落ちる | bare リポジトリから push が通った |
| M12 | pre-push: `--show-toplevel` の stderr を捨てる | 落ちる | 落ちる | .git の中からの push で git 自身のエラーが見えない |
| M13 | pre-push: pre-push.local を main worktree から探す | 落ちる | 落ちる | linked worktree のルートからの push が main を呼んだ |
| M14 | pre-push: `exec` をやめ、呼んだ後に `exit 0` | 通る | 通る | — (`set -e` の下で同じ挙動の変異) |
| V01 | verify.sh: 写さない | 落ちる | 落ちる | verify.sh が写す |
| V02 | verify.sh: 検査が全部通ったときだけ最後に写す | 落ちる | 落ちる | verify.sh が写す |
| V03 | verify.sh: VERIFY_READONLY=1 でも無ければ写す | 落ちる | 落ちる | VERIFY_READONLY=1 で pre-push が無い |
| V04 | verify.sh: 別の pre-push を上書きする | 落ちる | 落ちる | 旧版の hook (normal) |
| V05 | verify.sh: VERIFY_READONLY=1 では写しを見ない | 落ちる | 落ちる | VERIFY_READONLY=1 で pre-push が無い |
| V06 | verify.sh: 実行可能かを見ない | 落ちる | 落ちる | 現行版と同じ中身で実行可能でない写し |
| V07 | verify.sh: 違反の pre-push を chmod +x する | 落ちる | 落ちる | 現行版と同じ中身で実行可能でない写し (mode を変えた) |
| V08 | verify.sh: 壊れた symlink を在るものとして扱う | 落ちる | 落ちる | 壊れた symlink の pre-push |
| V09 | verify.sh: 在るかを `-f` で見る (ディレクトリを無いものとする) | 落ちる | 落ちる | ディレクトリの pre-push |
| V10 | verify.sh: core.hooksPath を見ない | 落ちる | 落ちる | core.hooksPath (設定元を示さない) |
| V11 | verify.sh: core.hooksPath を unset する | 落ちる | 落ちる | core.hooksPath (書き換えた) |
| V12 | verify.sh: worktree の git dir の hooks に写す | 通る | 落ちる | linked worktree で回した verify.sh |
| V13 | verify.sh: VERIFY_READONLY を読まない | 落ちる | 落ちる | VERIFY_READONLY=1 で pre-push が無い |
| V14 | verify.sh: shellcheck の版を見ない | 落ちる | 落ちる | shellcheck の版が違う verify.sh (版の違いを示さない) |
| V15 | verify.sh: この test の段を消す | 落ちる | 落ちる | shellcheck の版が違う verify.sh (段が起動できずに落ちていない) |
| V16 | verify.sh: 現行と同じ写しも違反にする | 通る | 落ちる | 現行と同じ実行可能な pre-push (示した) |
| V17 | verify.sh: 現行と同じ写しを置き直す | 落ちる | 落ちる | 現行と同じ実行可能な pre-push (置き直した)。sh は実行可能でない写しを実行可能にしたことで捕えた |

## 残っていること

- 次に移すもの:
  - `scripts/test-target-diff.sh` (できれば `scripts/test-target-diff.ts` と 1 つにする)
  - `scripts/test-codex-limits.sh`
  - `scripts/test-cleanup-branch.sh`
  - `verify.sh` の検査の段
- 並行に回した `git push` が遅い原因 (上の時間) は調べていない。速さが要るようになったら、push の待ちが何かを測ってから直す。
- shellcheck の版が違うときの検査は、deno が無いモジュールを `Module not found "file://…"` と示して exit 1 で終わること (deno 2.9.7 で実測) に依る。deno の文言が変われば、この検査が落ちて知らせる。
- 中断で子を待つ仕組みは `scripts/test-agent-sync.ts` には無い (mode を戻してから消すだけ)。同じ消し残しが起きうる。
- locale は baseEnv の `LC_ALL=C` に置いた。他の検査も、子の文言を見る検査を足すときはこの前提に乗る。
