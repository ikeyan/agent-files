# Claude Code

- `enabledPlugins` は boolean map (`"plugin-name@marketplace-name": true/false`)。文字列配列ではない。`[docs]` https://code.claude.com/docs/en/settings (Plugin settings, 2026-07-14 確認)
- marketplace 経由の plugin は install 時に `~/.claude/plugins/cache` へコピーされ、in-place ロードされない。source の編集は `/plugin update` まで反映されない。`[docs]` https://code.claude.com/docs/en/plugins-reference (2026-07-14 確認)
- plugin は `rules/` を component としてサポートしない — plugin 内の `rules/*.md` はインストールされてもロードされない。rules がロードされるのは project の `.claude/rules/` と `~/.claude/rules/` のみ。`[docs]` https://code.claude.com/docs/en/plugins-reference (2026-07-09 確認)
- 外部ソース plugin を project settings で enable しても他ユーザーには自動インストールされない。各ユーザーが install/trust を求められる (v2.1.195+)。`[docs]` https://code.claude.com/docs/en/settings (enabledPlugins の Note, 2026-07-14 確認)
- Claude Code on the web は `.claude/settings.json` 宣言の plugin をセッション開始時に marketplace から自動インストールする (`/plugin` コマンド自体は端末専用で cc-web に無い)。`[docs]` https://code.claude.com/docs/en/claude-code-on-the-web (2026-07-14 確認)
- Claude Code on the web の環境設定 (network allowlist 含む) を更新する API/CLI は無く、web UI のみ。`[docs-silent]` https://code.claude.com/docs/en/claude-code-on-the-web (プログラマティックな手段の記載なし、2026-07-14 確認)
