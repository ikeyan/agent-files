# Codex cloud

- setup script は agent フェーズとは別の bash session で走り、`export` した環境変数は agent に残らない。永続化は `~/.bashrc` か環境設定 (environment variables 欄) で行う。`[docs]` https://developers.openai.com/codex/cloud/environments (2026-07-15 確認)
- コンテナ状態は最大 12 時間キャッシュされ、キャッシュから再開するタスクでは setup script の代わりに maintenance script (optional) が走る。setup script・maintenance script・環境変数・secrets の変更はキャッシュを無効化する。`[docs]` 同上
- ただし現状はキャッシュが再利用されず、メッセージごとに毎回フル環境構築 (言語 runtime 構成 + setup script + maintenance script) が走る。maintenance script を設定する意味はキャッシュ修復まで無い。`[empirical]` https://github.com/openai/codex/issues/25086 の報告と自環境での観測が一致 (2026-07-15 確認、open issue につき修復されたら要再確認)
- sandbox コンテナ内では新規 proc mount が許可されず、OCI isolation の nested container 作成 (build の RUN を実行する crun) が ``mount `proc` to `proc`: Operation not permitted`` で失敗する。build は `BUILDAH_ISOLATION=chroot` で回避できる (podman.md)。コンテナの実行 (`docker run` / `compose up`) が同じ理由で失敗するかは未検証。`[empirical]` codex cloud 実機の setup ログ (2026-07-15 観測)
