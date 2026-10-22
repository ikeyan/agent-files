# 2026-10-21: worktree の作成の失敗で残るブランチの後始末の振り返り

読者: 次の実装セッション。前提知識は review-perspectives の手順 2 と、`canon: facts/claude-code/agent-worktree-isolation-lifecycle`。

## 状況

- review-perspectives の手順 2 は担当を Agent ツールの `isolation: "worktree"` で並列に起動する。まれに `Failed to create worktree` が返り、その担当は起動せず、ブランチ `worktree-agent-<id>` だけが worktree の無いまま残る。
- ユーザーが残った 3 本 (2026-10-17、Claude Code 2.1.299) を見つけて消し、再発しないための改善を頼んだ。この PR は、手順 2 に起動し直しと後始末を足す。

## 良かったこと

- 手を入れる前に、git 単体で失敗を再現した (`canon: facts/git/concurrent-worktree-add-race`)。
- Claude Code がどの終わり方で worktree とブランチを消すかを実測し、後始末が要るのは作成の失敗だけと絞った (`canon: facts/claude-code/agent-worktree-isolation-lifecycle`)。
- ブランチを消して失うコミットの数え方を、手順に書く前に fixture で固定した。`--exclude` の書き方の誤りがここで見つかった (`canon: facts/git/rev-list-exclude-unique-commits`)。

## 直したこと

- `c805821`: 手順 2 に、担当ごとに 1 回だけ起動し直すことと、残ったブランチの後始末を足した。
- `121eb86`: Codex の指摘。`git branch -D` が失敗しても消したと報告していたのを直した。
- canon に、上の 3 つの fact を足した (canon `5d7ec42`)。Claude Code の issue の報告と、手元の版ごとの発生も足した (canon `a9ae37f`)。
- 上流の報告は anthropics/claude-code#104026。同じ症状の #34645 は close され lock されている。

## 残っていること

- Claude Code での失敗の頻度が git 単体の並行より高い理由は分かっていない。
- 担当は並列に起動するので、作成の失敗は起き続ける。直列に起動すると、担当の数だけターンが増える。
- 後始末を書いたのは review-perspectives だけ。他のスキルや手作業で worktree の subagent を並列に起動したときは、ブランチは残る。
- android-emulator-mcp に、2026-10-19 の失敗のブランチ `worktree-agent-a04449b1bc3e144ae` が残っている (他に無いコミットは 0)。
- 外部へ報告するときに先に既存の issue を探す、という規律はどこにも書いていない。この PR では、探す前にフィードバックの下書きを作った。
