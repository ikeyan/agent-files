# PR / ブランチ運用: このリポの値

[SKILL.md](SKILL.md) が読む、このリポ固有の値。SKILL.md と手段のファイルは、他のリポへ agent-sync で配る `skills/setup-repo/pr-workflow/` への symlink。このリポに固有のものはこのファイルだけに書く。

## 値

- push 先: `origin` (2026-09-16 に push して確認)
- 寄稿規約: 文書は無い。コミットメッセージは日本語 1 行目に `<対象>: <何をしたか>`、本文で理由を述べる。既定ブランチは `main`。
- CI: `verify` (`.github/workflows/verify.yml`。`./verify.sh` を回す。pull_request と main への push で無条件に走る)

## 手段の実測

なし

## 方針の差分

- **PR コメントの watch**: PR を作った・push したら常に回す。cc-web では `subscribe_pr_activity`、それ以外は手段ファイルの「PR の watch」を使う。
