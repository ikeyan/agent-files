# 2026-10-05: test-cleanup-branch を TypeScript に移した振り返り

読者: 次に `scripts/test-*.sh` を TypeScript (Deno) に移す実装セッション。前提知識は AGENTS.md の「このリポの検証」と「このリポのスクリプトの言語」、`2026-10-05-ts-test-pre-push.md`。

## 状況

- `scripts/test-cleanup-branch.sh` は 5 つのリポを順に作り、1 つのリポ (r5) で断る場合を続けて回す筋書きだった。
- 移した後の形:
  - 検査ごとに一時リポジトリを作り、全部を最初に始める。子プロセスの数は `navigator.hardwareConcurrency` で絞る。
  - 子の環境は `clearEnv` と baseEnv (`LC_ALL=C` を含む) だけ。中断では子に SIGTERM を送り、終わってから一時ディレクトリを消す (`test-pre-push.ts` と同じ)。
  - cleanup-branch.sh は `$0` を見ない (usage の名前は固定の文字列) ので、`env` を通さず絶対パスで起動する。
  - verify.sh の段の許可は `--allow-run=git,skills/setup-repo/pr-workflow/cleanup-branch.sh --allow-env=PATH,TMPDIR --allow-read="${TMPDIR:-/tmp}" --allow-write="${TMPDIR:-/tmp}"`。symlink を作らないので read・write を TMPDIR に絞れた。
- 時間 (秒、手元の macOS 18 コア、Claude Code の sandbox の中):

| 対象 | 移す前 (sh) | 移した後 (ts) |
| --- | --- | --- |
| 単独 (3 回) | 0.46 | 0.37〜0.44 |
| `./verify.sh` の中の段 (1 回) | — | 1 |
| `./verify.sh` 全体 (1 回) | — | 86 (律速は `scripts/test-pr.ts` の 85) |

- 検査は 7 から 13 に増えたが、cleanup-branch.sh は新しく書く実行ファイルでないので、macOS の初回の exec の待ち (canon: `facts/macos/first-exec-of-new-executable`) は積まれない。

## 良かったこと

- 移す前に cleanup-branch.sh の性質ごとの変異を作り、古い sh と新しい ts の両方を回してから sh を消した (下の表)。変異の無いものでは両方が通った。
- 断る場合を、work を生きた linked worktree が checkout し、ディレクトリが消えた登録もあるリポで回すようにした。sh は worktree の無いリポで断らせていたので、断る前に detach・prune する変異 (M06・M10) を見逃していた。
- 変異を回した結果を読んで、消せなかったときに「他のブランチが変わった」と誤った二次の理由を出していたのを直した (work の行を前後とも除いて比べる)。

## 直したこと

`9759ef3` に入れた (レビュー後の修正を除く)。

- sh の全ての検査を ts に移し、verify.sh の段を替えて sh を消した。AGENTS.md の列挙のファイル名を直した。
- sh に無かった検査を足した:
  - 断るときに、ブランチに加えて次を変えない。cleanup-branch.sh の先頭は「何も変えずに断る」と書いている。
    - worktree の登録 (`git worktree list --porcelain` の前後)
    - work を checkout している worktree
  - 断る理由の文言 (先端の不一致・ブランチが無い・40 桁の 16 進数でない・usage)。sh は非 0 だけを見ていたので、形の検査を外しても先端の比較で断られて通っていた (M08)。
  - 引数の数が違うとき。
  - 名前が同じ接頭辞の別のブランチ (`work-x`) を checkout している worktree を detach しない。他のブランチの ref を変えない。
  - ディレクトリが消えた locked な登録が checkout していれば落ちてブランチを変えない。cleanup-branch.sh の先頭に書いてあるが、検査が無かった。
- TMPDIR の定義域。一時ディレクトリは解決しないパスのまま使い、文字の定義域は `Deno.realPath` で解決したパスで確かめる。
  - deno の `--allow-write` は symlink を解決せずにパスで照合する。macOS の `/tmp` は `/private/tmp` への symlink なので、解決したパスで書くと TMPDIR に絞った許可が NotCapable で落ちた。
  - git は worktree のパスを解決して記録し (`git worktree list` は `/private/tmp/…` を出す)、cleanup-branch.sh はそのパスを `git -C` に渡すので、文字の定義域は解決したパスについてのもの。
- 次の修正を `957c44f` で足した (レビューで決まったもの):
  - 断る場合に、引数が 0 個と 3 個を足した。
  - 名前に `/` を含むブランチ (`feature/work`) を linked worktree が checkout している場合が、消えて同じ commit で detach されることを足した。
  - locked な登録の検査が終了コードしか見ていなかった。実測では detach の `git -C` が `fatal: cannot change to '<登録のパス>': No such file or directory` (exit 128) で落ちる。この文言で落ちること、断る理由の文言でないこと、ブランチと worktree の登録が前後で変わらないことを見る。locked の登録を残したまま別の理由で落とす変異は、この検査が捕える。
  - `tmp` と `resolved` の 2 つのパスの役割がコメントから読めるようにした。
- 引数を渡したとき、TMPDIR が相対パスのとき、TMPDIR に空白を含めたときに、理由を出して exit 1 で落ちることを確かめた。SIGINT (起動から 0.2・0.25 秒) で exit 130 になり、一時ディレクトリが残らないことも確かめた。

## 変異と結果

cleanup-branch.sh を 1 か所ずつ壊し、sh (`2bdb5d6` の `scripts/test-cleanup-branch.sh`) と ts (`9759ef3`) を一時コピーで回した。「捕えた検査」は ts の最初の失敗 (sh も落ちたものは同じ性質の検査で落ちた)。

| 変異 | 壊したもの | sh | ts | 捕えた検査 |
| --- | --- | --- | --- | --- |
| M00 | (無し) | 通る | 通る | — |
| M01 | detach しない | 落ちる | 落ちる | main worktree が checkout (消せなかった) |
| M02 | 別の commit (`HEAD~1`) へ detach する | 落ちる | 落ちる | main worktree が checkout (HEAD が元の commit でない) |
| M03 | main worktree (一覧の最初) を detach しない | 落ちる | 落ちる | main worktree が checkout (消せなかった) |
| M04 | `git worktree prune` しない | 落ちる | 落ちる | ディレクトリが消えた登録が checkout (消せなかった) |
| M05 | 先端の一致を見ない | 落ちる | 落ちる | 断る: 先端が違う (断らなかった) |
| M06 | ブランチが無ければ tip に expected を入れて先へ進む | 通る | 落ちる | 断る: ブランチが無い (理由を示さない、worktree の登録が変わった) |
| M07 | expected の形を見ず `git rev-parse` で解決する | 落ちる | 落ちる | 断る: 短縮形の sha (断らなかった) |
| M08 | expected の形を見ない | 通る | 落ちる | 断る: 短縮形の sha (理由を示さない) |
| M09 | `branch -D` を `-d` にする | 落ちる | 落ちる | linked worktree が checkout (消せなかった) |
| M10 | 先端の一致を detach・prune の後で見る | 通る | 落ちる | 断る: 先端が違う (worktree の登録が変わった) |
| M11 | ブランチを接頭辞で照合する | 通る | 落ちる | 他のブランチの worktree (work-x が detach された) |
| M12 | 引数の数を見ない | 通る | 落ちる | 断る: 引数が 1 つ (usage を示さない) |
| M13 | prune の前に全ての登録を unlock する | 通る | 落ちる | ディレクトリが消えた locked な登録が checkout (落ちなかった) |
| M14 | 大文字の 16 進数を受け、小文字にして比べる | 落ちる | 落ちる | 断る: 大文字の sha (断らなかった) |

## 残っていること

- 次に移すもの:
  - `scripts/test-target-diff.sh` (できれば `scripts/test-target-diff.ts` と 1 つにする)
  - `scripts/test-codex-limits.sh`
  - `verify.sh` の検査の段
- deno の許可は symlink を解決せずにパスで照合する (canon: `facts/deno/permission-paths-not-resolved`)。`Deno.realPath` した一時ディレクトリを使う test は、TMPDIR に絞った許可では落ちる。`test-pre-push.ts`・`test-agent-sync.ts` は symlink を作るので read・write を絞っておらず、この形に揃えても絞れない。
- worktree のパスの文字 (空白・改行など) の検査は無い。cleanup-branch.sh は `git worktree list --porcelain -z` で読むので扱えるはずだが、TMPDIR の定義域で外している。
- 入口の止まる経路 (引数・TMPDIR の相対・文字) と SIGINT の後始末は手で確かめただけで、検査は無い。
- 中断で子を待つ仕組みは `scripts/test-agent-sync.ts` には無いまま。
- cleanup-branch.sh は呼び出し元の `GIT_DIR` などを継承すると先頭に書いているが、この test は子の環境を空から作るので、その経路は回していない (sh でも回していなかった)。hook や `rebase --exec` から呼ばれる形を検査するなら、`GIT_DIR` を別のリポに向けても `-C` の先のリポだけが変わることを見る。
