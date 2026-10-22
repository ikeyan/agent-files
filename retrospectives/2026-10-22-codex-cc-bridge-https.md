# 2026-10-22: codex-cc-bridge を HTTPS の url source から取る振り返り

読者: 次の実装セッション。

## 状況

- ユーザーが `/plugin` で ikeyan marketplace を更新したところ、`1 plugin failed to update` になった。
- `claude plugin update codex-cc-bridge@ikeyan` を CLI で走らせると、clone が `git@github.com: Permission denied (publickey)` で落ちていた。ssh-agent に鍵が無かった。
- marketplace 自体 (https で clone) と、marketplace の中にある ikeyan-skills は更新できていた。

## 良かったこと

- 利用者の設定と plugin の状態を変えずに、変更前と変更後の marketplace を比べた。
  1. `CLAUDE_CONFIG_DIR` を一時ディレクトリにする。
  2. `GIT_SSH_COMMAND=false` で SSH を使えなくする。
  3. 変更前と変更後の marketplace で `claude plugin install codex-cc-bridge@ikeyan` を走らせる。
- 分かったこと:
  - github source は SSH で clone する (変更前は失敗した)。
  - url source の HTTPS は鍵なしで clone できる (変更後は成功した)。

## 直したこと

- `c9ae4bd`: codex-cc-bridge の source を `github` から `url` (`https://github.com/ikeyan/codex-cc-bridge.git`) にした。

## 残っていること

- codex-cc-bridge の `plugin.json` は `"version": "0.1.0"` を固定しているので、clone が通っても version を変えるまで更新されない。ユーザーの判断で固定のまま。
- github source が SSH で clone することは公式ドキュメントに書かれていない。canon の `facts/claude-code/` にまだ足していない。
- `./verify.sh` の `scripts/test-codex-limits.ts` が 1 回、2 時間 23 分止まったまま終わらなかった (2026-10-22)。止めて単独で走らせ直すと 60 秒以内に通り、次の `./verify.sh` も通った。原因は調べていない。
