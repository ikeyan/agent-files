# 手段: gh

- **ブランチの push**: `git push -u <remote> <branch>`。作り直したブランチの上書きは `canon: facts/git/force-with-lease-recreated-branch`。
- **PR の作成**: `gh pr create --base <既定ブランチ> --title <title> --body-file <file>`
- **PR の説明の更新**: `gh pr edit <n> --body-file <file>`
- **コメントの読み取り**:
  - `gh pr view <n> --comments` — 通常コメントと review を混ぜた時系列。
  - `gh api --paginate <endpoint>` — REST。
  - `gh api graphql` — スレッドの `isResolved` / `isOutdated` はここでしか取れない。
- **返信**: `gh api --method POST repos/<owner>/<repo>/pulls/<n>/comments/<id>/replies -f body=<text>`
- **resolve**: `gh api graphql` の `resolveReviewThread(input: {threadId: <PRRT_…>})`
- **CI**:
  - 現れている check の一覧: `gh pr checks <n> --json name,bucket,link`
  - 現れている check が全部終端になるまで待つ: `gh pr checks <n> --watch` (待ち時間は有界にする)
  - 特定の check が現れて終端になるまで待つループ、check が 0 件のときの挙動と exit コード: `canon: facts/gh/pr-checks-zero-checks-and-exit-codes`
  - 失敗したステップのログ: `gh run view --log-failed` (GitHub Actions)。Actions 以外の check は `--json link` の URL を見る。
