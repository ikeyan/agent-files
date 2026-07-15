# Codex cloud

- setup script は agent フェーズとは別の bash session で走り、`export` した環境変数は agent に残らない。永続化は `~/.bashrc` か環境設定で行う。`[docs]` https://developers.openai.com/codex/cloud/environments (ページ直接取得は 403 のため検索エンジン経由の引用で確認、2026-07-15)
- setup script 実行後のコンテナ状態はタスク間でキャッシュされ、キャッシュから開始するタスクでは setup script の代わりに maintenance script が走る。`[docs]` 同上
- プロセスはコンテナスナップショットに含まれないと推定されるため、setup script で起動した daemon はキャッシュ開始のタスクでは動いていない前提を置く。daemon の起動は setup と maintenance の両方 (= 同一スクリプトを両欄に設定) で行う。(推定 — キャッシュヒット時の実測は未実施、2026-07-15)
