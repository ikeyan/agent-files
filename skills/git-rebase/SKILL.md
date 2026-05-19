---
name: git-rebase
description: Perform git interactive rebase and complex history rewrites safely, with user review before anything touches the branch. Use this skill whenever the user asks to rebase, squash, reorder, split, reword, fixup, or otherwise rewrite git commit history — including `git rebase -i`, squash merges, commit splitting, message rewording, or any multi-commit cleanup before push. Also use this skill when the user wants history cleaned up, commits combined, or a branch reshaped before merging, even if they don't explicitly say "rebase". The skill works around the fact that Claude cannot drive a terminal editor interactively by driving `GIT_SEQUENCE_EDITOR` and `GIT_EDITOR` through files, so the rebase todo list can be reviewed before execution; it also provides a scripted-rebase pattern for rewrites that go beyond what interactive rebase can express (splitting a commit, reassigning files between commits, substantially rewriting messages).
---

# Git Rebase

Claude は端末上の対話的なエディタ（`git rebase -i` が起動する vim など）を操作できない。そのため interactive rebase 相当の操作を行うときは、`GIT_SEQUENCE_EDITOR` / `GIT_EDITOR` を経由して todo リストやコミットメッセージをファイル化し、ユーザーにレビューしてもらってから実行する。

rebase は履歴を書き換える破壊的操作なので、**必ず実行前にユーザーが diff を見て承認**できる形にする。この点が徹底されていればロールバックも効くため、安心して使える。

## どちらの手法を使うか

rebase 系の作業は次の2つに大別される。どちらを使うかは最初に判断する。迷ったらまず interactive rebase を試し、足りなければ script rebase に切り替える。

### Interactive Rebase（このファイル下半分）

`git rebase -i` の pick / squash / reword / fixup / drop / 並び替えで表現できる操作。具体的には:

- 連続する数コミットを squash して 1 コミットにまとめたい
- コミットメッセージを reword したい
- コミットの並びを入れ替えたい
- いらないコミットを drop したい

### Script Rebase（このファイル最下部）

interactive rebase の命令語では表現しきれない操作。具体的には:

- 1 つのコミットを複数に分割したい
- ファイル単位で別々のコミットに振り分け直したい
- 複数コミットのメッセージを全面的に書き直したい
- 複雑な並び替え + squash + 内容の再構成を同時にやりたい

---

# Interactive Rebase

`git rebase -i` を直接起動するのではなく、`GIT_SEQUENCE_EDITOR` をダミーエディタとして使い、todo リストをファイルに吸い出し → ユーザーレビュー → 編集済みファイルを適用、という3段階で進める。

## 手順

### 1. todo リストをファイルに書き出す

```bash
GIT_SEQUENCE_EDITOR="cp \$1 /tmp/rebase-todo.txt && false" git rebase -i <base>
```

`cp` で git が渡してきた todo ファイルをコピーし、`&& false` でエディタが失敗したように見せて rebase 本体を中断させる。これで todo リストだけが `/tmp/rebase-todo.txt` に残り、作業ツリーは操作前の状態のまま保たれる。

### 2. todo ファイルをユーザーに見せる

```bash
cat /tmp/rebase-todo.txt
```

何コミットが対象か、どういう順序か、ユーザーに具体像を把握してもらう。

### 3. 原本をコピーして編集し、レビューしてもらう

```bash
cp /tmp/rebase-todo.txt /tmp/rebase-todo-edited.txt
```

`Edit` ツールで `/tmp/rebase-todo-edited.txt` を編集する（pick → squash、並び替え、drop など）。そのあと diff をユーザーに見せて承認を取る。`/tmp/rebase-todo.txt` は原本として残し、編集しない。

### 4. 承認後、原本が変わっていないことを確認して rebase 実行

```bash
GIT_SEQUENCE_EDITOR="
  diff -q \$1 /tmp/rebase-todo.txt || { echo 'todo changed, aborting'; exit 1; };
  cp /tmp/rebase-todo-edited.txt \$1
" git rebase -i <base>
```

git が今回生成した todo と、手順1で保存した原本を `diff -q` で比較する。一致していれば「ユーザーがレビューしたのと同じ操作」だと確信できるので、編集済みファイルを適用する。一致しなければ（例えば base までの間に新しいコミットが入った等）その場で中断する。

### 5. squash 時のコミットメッセージ編集が必要な場合

`squash` や `reword` を含むと、rebase 中に `GIT_EDITOR` が起動してコミットメッセージ編集を求められる。この場合も同じパターンで、`GIT_EDITOR` にファイル経由のダミーエディタを渡す:

```bash
GIT_EDITOR="cp \$1 /tmp/commit-msg.txt && false" ...
```

で吸い出し、編集してレビュー、`cp /tmp/commit-msg-edited.txt \$1` で戻す、という流れを重ねる。

## 失敗したときの戻し方

rebase 中にコンフリクトで止まった場合:

```bash
git rebase --abort
```

すでに rebase が終わってしまって結果が気に入らない場合:

```bash
git reset --hard ORIG_HEAD
```

rebase 直前の tip は `ORIG_HEAD` に保存されている。不安なら操作前に `OLD_TIP=$(git rev-parse HEAD)` で明示的に控えておくとより確実。

---

# Script Rebase

コミットの分割・ファイル単位の振り分け・大幅なメッセージ書き換えなど、interactive rebase の命令語では表現しきれない操作が必要な場合は、操作全体を 1 つのシェルスクリプトとして書き出し、ユーザーにレビューしてもらってから実行する。

スクリプト化する理由は2つある:

1. 操作が複数ステップに渡るので、全体を俯瞰できる形でレビューしないと安全性を保証しにくい
2. 同じスクリプトを再実行すれば再現できるので、途中で失敗しても切り戻しや再挑戦がしやすい

## スクリプトの構成

以下の要素を含める。

1. **前提条件チェック** — ブランチ名、ワーキングツリーがクリーンであること、そして **HEAD のコミットハッシュが事前に想定したものと一致すること** を検証する。期待ハッシュ（`EXPECTED_TIP`）をスクリプト冒頭にハードコードしておき、実際の `git rev-parse HEAD` と照合する。これにより、スクリプトを書いた時点と実行時点の間に新しいコミットが追加された・別ブランチに移動した・別マシンで状態が違う、といったズレを機械的に検知して即座に中断できる。条件を満たさなければ非ゼロで終了する（`set -euo pipefail` と明示的 `if` の組み合わせでよい）。
2. **ロールバック手段の記録** — 操作前の tip を `OLD_TIP=$(git rev-parse HEAD)` で保存し（前提チェックを通っていれば `OLD_TIP == EXPECTED_TIP`）、失敗時は `git reset --hard $OLD_TIP` で戻せることをスクリプトの冒頭コメントに明記する。
3. **操作本体** — `git reset --mixed <base>` でコミットを崩し、必要なファイルだけ `git add` して `git commit -F -` で再構成する。コミットメッセージはヒアドキュメント（`<<'EOF' ... EOF`）でスクリプト内にインラインで書いておくと、レビュー時にメッセージもまとめて確認できる。
4. **整合性検証** — 最後に `git diff --stat --exit-code "$OLD_TIP" HEAD` でツリーが操作前と一致することを確認する。不一致なら非ゼロで終了する。これで「コミットの切り方は変わったが最終的な成果物は同じ」を機械的に保証できる。
5. **push はスクリプトに含めない** — `git push --force-with-lease` は履歴が他者に影響する破壊的操作なので、スクリプトの完了後にユーザーの判断で別途実行してもらう。

## 使い方

1. スクリプトをリポジトリルートに書き出す（例: `rebase-into-three-commits.sh`）
2. ユーザーにスクリプト全体をレビューしてもらう（短いので1画面に収めると読みやすい）
3. 承認後 `bash rebase-into-three-commits.sh` で実行する
4. 完了後、スクリプトは不要になるので削除するか、`.gitignore` 済みの作業ディレクトリに退避する

## テンプレート例

```bash
#!/usr/bin/env bash
# Rebase feature-branch into 3 clean commits.
# Rollback: git reset --hard $OLD_TIP  (OLD_TIP is printed at the start)

set -euo pipefail

# --- 1. 前提条件チェック ---
# スクリプトを書いた時点での tip。実行時にこの値と一致しなければ中断する。
EXPECTED_TIP="deadbeefcafe1234567890abcdef1234567890ab"
EXPECTED_BRANCH="feature-branch"

[[ "$(git rev-parse --abbrev-ref HEAD)" == "$EXPECTED_BRANCH" ]] \
  || { echo "wrong branch: expected $EXPECTED_BRANCH, got $(git rev-parse --abbrev-ref HEAD)"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean"; exit 1; }

ACTUAL_TIP=$(git rev-parse HEAD)
[[ "$ACTUAL_TIP" == "$EXPECTED_TIP" ]] \
  || { echo "HEAD mismatch: expected $EXPECTED_TIP, got $ACTUAL_TIP"; exit 1; }

OLD_TIP=$ACTUAL_TIP
echo "OLD_TIP=$OLD_TIP  (rollback: git reset --hard $OLD_TIP)"

# --- 2. 操作本体 ---
BASE=origin/main
git reset --mixed "$BASE"

git add path/to/feature-a/
git commit -F - <<'EOF'
feat(feature-a): add A

details ...
EOF

git add path/to/feature-b/
git commit -F - <<'EOF'
feat(feature-b): add B

details ...
EOF

git add -A
git commit -F - <<'EOF'
chore: cleanup and tests
EOF

# --- 3. 整合性検証 ---
git diff --stat --exit-code "$OLD_TIP" HEAD
echo "OK: tree matches $OLD_TIP"
```

このテンプレートはあくまで骨格なので、実際のタスクに合わせて `EXPECTED_TIP` / `EXPECTED_BRANCH` / add 対象 / メッセージを書き換える。重要なのは「`EXPECTED_TIP` との一致確認 → `OLD_TIP` 記録 → 再構成 → `git diff --exit-code` で一致確認」の四点セットを崩さないこと。`EXPECTED_TIP` はユーザーにスクリプトを見せる直前に `git rev-parse HEAD` で取得した値を埋め込む。
