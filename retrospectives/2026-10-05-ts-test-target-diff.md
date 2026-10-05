# 2026-10-05: test-target-diff の例を TypeScript に移した振り返り

読者: 次に `verify.sh` の検査の段を TypeScript (Deno) に移す実装セッション。前提知識は AGENTS.md の「このリポの検証」と「このリポのスクリプトの言語」、`2026-10-05-ts-test-codex-limits.md`。

## 状況

- `scripts/test-target-diff.sh` は、1 つの clone の状態 (ブランチ・未追跡の項目・config) を順に積み上げる筋書きで、44 の照合 (`expect` 35 と `fails` 9) を 1 本ずつ回していた。同じ target-diff.sh の model based test (`scripts/test-target-diff.ts`) は verify.sh の別の段だった。
- 移した後の形:
  - 例を `scripts/test-target-diff.ts` に足して 1 本にした。例とモデルは同じ target-diff.sh を相手にするので、子の起動 (`exec`)、git、出力の読み取り (`parseOutput`・`readDiff`)、成功した出力の検査 (`checkOutput`) を共有する。例を全部最初に始め、モデル (fast-check。試行は 1 つずつ) と並行に回すので、1 本にしても単独の時間はモデルだけのときより 1〜2 秒長いだけ (下の表)。
  - 例は 44 (`fixture` の呼び出し 34 と、表 `targets` 7・`shapes` 3 の行を数えた)。例ごとに一時リポを作る。元の履歴 (`${tmp}/src` とその bare の `${tmp}/origin.git`) は準備で 1 つ作って読むだけにし、origin を書き換える例 (PR・消えたリモートブランチ・origin の HEAD) は src から自分の bare を作る。
  - gh の stub は 1 つの実行ファイルを例とモデルで共有し、応答・応答の前に回すもの・受けた引数を、例ごとの GH_CASE の下に置く。macOS は新しく作った実行ファイルの初回の exec を直列に待たせる (canon: `facts/macos/first-exec-of-new-executable`) ので、stub を例ごとに書かない。
  - 子の環境は `clearEnv` と baseEnv (PATH・HOME・TMPDIR・`LC_ALL=C`・GIT_CONFIG_GLOBAL・GIT_CONFIG_SYSTEM・author と committer と日時) と、呼ぶごとに足す TMPDIR・PATH・GH_CASE・git の設定だけ。stdin は null。
  - target-diff.sh は run を `pwd -P` で解決して出し、git の `rev-parse --show-toplevel`・`--path-format=absolute` も解決したパスを出す。deno の許可は symlink を解決せずに綴りで照合する (canon: `facts/deno/permission-paths-not-resolved`) ので、出力のパスは `local` で tmp の綴りに戻してから読む。symlink は `ln` で作る。
  - verify.sh の段の許可は `--allow-run=git,bash,/bin/bash,ln --allow-env=PATH,TMPDIR,TARGET_DIFF_RUNS,FC_SEED --allow-read="${TMPDIR:-/tmp}" --allow-write="${TMPDIR:-/tmp}"`。移す前のモデルの段は env・read・write を絞っていなかった (symlink を deno で作っていた)。
- 時間 (秒、手元の macOS 18 コア、Claude Code の sandbox の中):

| 対象 | 移す前 | 移した後 |
| --- | --- | --- |
| 単独 | sh 9.05〜9.67 (2 回)、モデル 10.36〜11.06 (2 回) | 11.89〜13.09 (3 回) |
| 単独、`TARGET_DIFF_RUNS=1` (例とモデルの 1 試行) | — | 3.39 (2 回) |
| `./verify.sh` の中の段 | sh 13、モデル 14 (1 回) | 13〜15 (2 回) |
| `./verify.sh` 全体 (1 回) | — (律速は `scripts/test-pr.ts` の 90) | 85 (律速は `scripts/test-pr.ts` の 85) |

- 段の律速はモデルの 25 試行。例 (とモデルの 1 試行) は約 3.4 秒で、モデルと並行に回る。

## 良かったこと

- 移す前に target-diff.sh の性質ごとの変異を作り、古い sh と新しい ts の両方を回してから sh を消した (下の表)。変異の無いものでは両方が通った。
- 最初に全部を回したとき、両方が通る変異が 3 つあった。どれも原因を調べてから回し直した:
  - M29: 変異の作り方の誤り。`tree=` を後でもう一度代入するので効いていなかった。
  - M03: origin の HEAD が無い例が、変異の下でもレビュー対象が空で止まっていた。止まることだけを見る例は、別の理由で止まると何も検査しない。
  - M37: 絶対パスの path は sh がモデルの生成器に任せていたが、seed 42 の 25 試行ではモデルが捕えなかった。
- 変異は M00〜M37 の 38 を 4 つずつ並行に回し、全ての変異で sh と ts を丸ごと回した。

## 直したこと

`3f0e6b4` に入れた。

- sh の全ての照合を例に移し、verify.sh の段を替えて sh を消した。AGENTS.md の列挙と、`scripts/test-gitconfig` のコメントの消したファイルへの参照を直した。
- sh に無かった検査を足した:
  - gh に PR 番号と `-R <origin の URL>` を渡す (stub が受けた引数を書く)。target-diff.sh の先頭は gh の既定のリポジトリが origin と違う形を処理すると書いているが、検査が無かった (M05)。
  - linked worktree から回した work が、common git dir の `review-perspectives/` の下。sh は `clone/.git/` の下かだけを見ていて、`.git/worktrees/lw/` の下を通した (M33)。
  - origin の HEAD が無い例と、commit の無い入れ子のリポジトリの例を、対象が空でない作業ツリーで回す。sh は対象が空でも止まる状態で回していて、止まる理由を外す変異 (M03・M36) を通した。
  - 絶対パスの path で、target-diff.sh の理由を出して止まる (M37)。
  - 全ての成功について、出力の 6 行が揃い、run が TMPDIR の下、repo が対象を指定したら run の下・しなければチェックアウトのルート。
  - 止まるときに、stdout が空で run と worktree を残さない (sh は worktree を 1 か所で見ていた)。target-diff.sh 自身の理由 (レビュー対象が空・fork が無い) は文言も見る。
- モデルも同じ機構に乗せた:
  - 子の環境を `clearEnv` と baseEnv にした。移す前は呼び出し元の環境を全部引き継ぎ、hook から呼ばれれば GIT_DIR なども子に渡っていた。
  - `LC_ALL=C` を置いた。fetch の衝突をやり直す判定は git の文言 (`cannot lock ref` など) を照合するので、locale に依らせない (canon: `facts/shell/gettext-macos-system-language`)。
  - TARGET_DIFF_RUNS と FC_SEED が外れたときの終了コードを、2 から他の test の定義域と同じ 1 にした。
  - target.diff のコミットとファイルを、集合でなく並べ替えた配列で比べる (同じものが 2 度出れば落ちる)。
  - 試行ごとの一時ディレクトリを消す失敗を `.catch(() => {})` で隠していたのを、例外にした。
  - 「絶対パスは git が止める」というコメントを直した (止めるのは target-diff.sh)。
- 理由を出して exit 1 で落ちることを確かめた: 引数を渡したとき、TMPDIR が相対パスのとき、TMPDIR に空白を含めたとき、`TARGET_DIFF_RUNS=0`、`FC_SEED=x`。
- 中断の後始末を確かめた。次のどれでも exit 130 (SIGINT)・143 (SIGTERM) で終わり、一時ディレクトリが残らなかった。

  | 信号 | 送り先 | 送った時刻 (起動から) |
  | --- | --- | --- |
  | SIGINT | deno | 1・3 秒 |
  | SIGTERM | deno | 1・3 秒 |
  | SIGINT | プロセスグループ | 0.5・2・5 秒 |

## 変異と結果

target-diff.sh を 1 か所ずつ壊し、sh (`9accb16` の `scripts/test-target-diff.sh`) と ts (`3f0e6b4`、`FC_SEED=42`) を一時コピーで回した。「捕えた検査」は ts の最初の失敗 (sh も落ちたものは、M13・M25 以外は同じ性質の検査で落ちた。M13 は sh では tree の検査、M25 は sh では worktree が残る検査で落ちた)。

| 変異 | 壊したもの | sh | ts | 捕えた検査 |
| --- | --- | --- | --- | --- |
| M00 | (無し) | 通る | 通る | — |
| M01 | unborn HEAD を扱わない (HEAD の commit が無ければ落ちる) | 落ちる | 落ちる | unborn HEAD (止まった) |
| M02 | 空の判定を patch でなく target.diff (log を含む) で見る | 落ちる | 落ちる | 一致しない path (止まらない) |
| M03 | origin の HEAD を決められなければ main に向ける | 通る | 落ちる | origin の HEAD が既定ブランチを指していない (止まらない) |
| M04 | path を `git add -A` にも渡す | 落ちる | 落ちる | path (削除されたファイル) (止まった) |
| M05 | gh に `-R` で origin を渡さない | 通る | 落ちる | base を取り込んだ PR (gh に origin を渡していない) |
| M06 | PR の分岐点を、今の origin の base と head の merge-base にする | 落ちる | 落ちる | base を取り込んだ PR (マージ後に止まった) |
| M07 | gh の応答の後に base を fetch しない | 落ちる | 落ちる | base が最初の fetch の後、gh の応答までに進んだ PR (止まった) |
| M08 | fork の PR の系列に owner を足さない | 落ちる | 落ちる | fork からの PR (同じリポジトリの PR と work を共有) |
| M09 | fork の系列の区切りを `/` にする | 落ちる | 落ちる | fork からの PR (owner/branch と同名のブランチと work を共有) |
| M10 | fork を削除した PR で止まらない | 落ちる | 落ちる | fork を削除した PR (止まらない) |
| M11 | PR のタイトルと説明を target.diff に入れない | 落ちる | 落ちる | base を取り込んだ PR (PR の説明が無い) |
| M12 | 出力に形式外の行 (`base=`) を足す | 落ちる | 落ちる | 今のチェックアウト (形式外の行) |
| M13 | 出力から `tree=` を落とす | 落ちる | 落ちる | 今のチェックアウト (tree の行が無い) |
| M14 | git の hook を止めない | 落ちる | 落ちる | リポジトリの hook (hook.txt が混ざる) |
| M15 | core.fsmonitor を止めない | 落ちる | 落ちる | core.fsmonitor のコマンド (fsmonitor.txt が混ざる) |
| M16 | patch を plumbing でなく porcelain の `git diff` で作る | 落ちる | 落ちる | diff の出力を変える git の設定 (対象が空で止まった) |
| M17 | GIT_LITERAL_PATHSPECS を外す | 落ちる | 落ちる | path (pathspec の記号を含む名前) |
| M18 | shallow を unshallow しない | 落ちる | 落ちる | shallow (共通の祖先が無い) |
| M19 | fetch の refspec を省く | 落ちる | 落ちる | --single-branch (origin/main が無い) |
| M20 | 既定ブランチに入った revision を first-parent で辿らない | 落ちる | 落ちる | マージ済みの topic (対象が空で止まった) |
| M21 | first-parent の線上で revision 自身を分岐点にしうる | 落ちる | 落ちる | root commit (対象が空で止まった) |
| M22 | HEAD を origin のブランチとして引く | 落ちる | 落ちる | revision の HEAD (origin/HEAD でない) |
| M23 | work のディレクトリ名に名前をそのまま使う | 落ちる | 落ちる | 消えたブランチの中のファイル名のブランチ (mkdir で止まった) |
| M24 | run を固定のパスにする | 落ちる | 落ちる | 並行実行 (生成物を共有) |
| M25 | 止まったときに run を消さない | 落ちる | 落ちる | 一致しない path (run が残る) |
| M26 | 止まったときに worktree を prune しない | 落ちる | 落ちる | 一致しない path (worktree が残る) |
| M27 | rules に名前を入れない | 落ちる | 落ちる | rules (名前の変更で変わらない) |
| M28 | rules にリポ固有の検索対象を入れない | 落ちる | 落ちる | rules (追加で変わらない) |
| M29 | tree を HEAD の tree にする | 落ちる | 落ちる | tree (未追跡の追加で変わらない) |
| M30 | 本来の index を使う | 落ちる | 落ちる | 今のチェックアウト (本来の index が変わった) |
| M31 | run を解決しない (相対の TMPDIR で相対のまま) | 落ちる | 落ちる | 相対 TMPDIR (止まった) |
| M32 | 空の path の配列を bash 3.2 で展開できない形にする | 落ちる | 落ちる | bash 3.2 (出力が無い) |
| M33 | work に git-common-dir でなく git-dir を使う | 通る | 落ちる | linked worktree (work が本体の .git の下でない) |
| M34 | origin のブランチを対象に解決しない | 落ちる | 落ちる | リモートだけのブランチ (止まった) |
| M35 | fetch に `--prune` を付けない | 落ちる | 落ちる | origin から消えたブランチは対象に解決しない (止まらない) |
| M36 | `git add -A` の失敗を無視する | 通る | 落ちる | commit の無い入れ子のリポジトリ (止まらない) |
| M37 | 絶対パスの path で止まらない | 通る | 落ちる | 絶対パスの path (止まらない) |

## 残っていること

- 次に移すもの: `verify.sh` の検査の段。
- 段の時間はモデルの 25 試行が決める。fast-check の試行は 1 つずつ回るので、試行を並行にするなら縮小 (shrink) の扱いを決めてから。
- モデルの fetch の衝突をやり直す判定は、git の文言 (`cannot lock ref`、`.lock': File exists`、`shallow file has changed`) の照合に依る。canon (`facts/git/repository-shapes` の並行実行) にあるのは `cannot lock ref` だけで、残りの 2 つは canon に無い。git の文言が変われば、モデルが「止まった」で落ちて知らせる。
- 止まる例のうち git が理由を出すもの (origin の HEAD が無い・origin 無し・消えたリモートブランチ・commit の無い入れ子のリポジトリ) は、文言を見ていない (git の版で変わりうる)。理由を外す変異は、対象が空でない作業ツリーで回すことで捕える (M03・M36)。
- gh の stub (ts の中の sh の文字列) は shellcheck が見ない。
- canon の `facts/git/auto-maintenance-races-local-clone` は、実測の手順として消した `scripts/test-target-diff.sh` を引いている。
