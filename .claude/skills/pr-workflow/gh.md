# 手段: gh

gh 2.98.0 で `--help` と実行を確認したもの。「未実測」と書いたものだけ確認していない。このリポでは PR #12 で push・PR 作成・説明更新・check 待ち・失敗ログ取得を、PR #13 でレビューコメントへの返信と resolve を通した。

- **ブランチの push**: `git push -u <remote> <branch>`。作り直したブランチの上書きは pr-workflow の「ブランチの更新」。
- **PR の作成**: `gh pr create --base <既定ブランチ> --title <title> --body-file <file>`。下書きは `--draft`、作らずに内容を確かめるなら `--dry-run`。
- **PR の説明の更新**: `gh pr edit <n> --body-file <file>`。draft の切り替えは `gh pr edit` でなく `gh pr ready` (`--undo` で draft へ戻す)。
- **コメントの読み取り**:
  - `gh pr view <n> --comments` — PR 本文とコメント。
  - `gh api --paginate <endpoint>` — REST。
  - `gh api graphql` — スレッドの `isResolved` / `isOutdated` はここでしか取れない。
- **返信**: `gh api --method POST repos/<owner>/<repo>/pulls/<n>/comments/<id>/replies -f body=<text>`。`<id>` はスレッド先頭のレビューコメントの数値 id (`#discussion_r…` の数字)。返信への返信はできない。
- **resolve**: `gh api graphql -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}' -f threadId=<PRRT_…>`。
- **CI**:
  - 現れている check の一覧: `gh pr checks <n> --json name,bucket,link`
  - 現れている check が全部終端になるまで待つ: `gh pr checks <n> --watch` (待ち時間は有界にする。後から登録された check を拾うかは未実測)
  - 特定の check が現れて終端になるまで待つ。`gh pr checks` は check が 0 件だと `--json` でも `--watch` でも exit 1 なので、判定は exit コードでなく出力の有無で行う (`--jq` は該当名が無くても exit 0 で空を返す):

    ```sh
    end=$((SECONDS + <秒数>))
    until gh pr checks <n> --json name,bucket --jq '.[] | select(.name == "<check>") | .bucket' | grep -qxv pending; do
      [ $SECONDS -lt $end ] || { echo "timeout"; exit 1; }
      sleep 15
    done
    ```

    根拠と実測: `canon: facts/gh/pr-checks-zero-checks-and-exit-codes`
  - ログ: Actions の check は `link` の URL から `<jobId>` を取って `gh run view --job <jobId> --log-failed` (`canon: facts/gh/pr-checks-link-to-run-logs`)。Actions 以外の check は `link` の URL を見る。
