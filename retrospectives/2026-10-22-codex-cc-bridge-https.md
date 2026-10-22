# 2026-10-22: codex-cc-bridge を HTTPS の url source から取る振り返り

読者: 次の実装セッション。

## 状況

- ユーザーが `/plugin` で ikeyan marketplace を更新したところ、`1 plugin failed to update` になった。
- `claude plugin update codex-cc-bridge@ikeyan` を CLI で走らせると、clone が `git@github.com: Permission denied (publickey)` で落ちていた。ssh-agent に鍵が無かった。
- marketplace 自体 (https で clone) と、marketplace の中にある ikeyan-skills は更新できていた。

## 良かったこと

- `CLAUDE_CONFIG_DIR` を一時ディレクトリにし、`GIT_SSH_COMMAND=false` で SSH を使えなくして、変更前と変更後の marketplace で `claude plugin install` を比べた。利用者の設定と plugin の状態を変えずに、github source が SSH で clone することと、url source の HTTPS なら鍵なしで入ることを確かめられた。

## 直したこと

- `c9ae4bd`: codex-cc-bridge の source を `github` から `url` (`https://github.com/ikeyan/codex-cc-bridge.git`) にした。

## 残っていること

- codex-cc-bridge の `plugin.json` は `"version": "0.1.0"` を固定しているので、clone が通っても version を変えるまで更新されない。ユーザーの判断で固定のまま。
- github source が SSH で clone することは公式ドキュメントに書かれていない。canon の `facts/claude-code/` にまだ足していない。
