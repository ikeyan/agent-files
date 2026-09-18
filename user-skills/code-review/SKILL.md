---
name: code-review
description: Use when reviewing code changes — a diff, a branch, a PR, or "review this before I push". Runs the review-perspectives skill.
---

# コードレビュー

Skill ツールで `review-perspectives` を起動し、その手順でレビューする。plugin で入れた環境では名前が `ikeyan-skills:review-perspectives` になる。

- 引数 (PR 番号・ブランチ名・パス) を受け取っていたら、review-perspectives の手順 1 のレビュー対象をそれに置き換える。
- `review-perspectives` が一覧に無ければ、ikeyan-skills plugin が入っていないことをユーザーに伝えて止まる。他のレビュー用スキル (`engineering:code-review` 等) で代用しない。
