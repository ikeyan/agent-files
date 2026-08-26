# agent-files
skills, AGENTS.md等のファイル置き場。
skills は Claude plugin としてインストールして参照する (下記)。

外部依存の確定仕様と事故は repo ごとに持たず canon (`ikeyan/canon`) に集める (書くのは canon だけ)。

## Claude plugin として使う

このリポは Claude Code プラグインも兼ねる。`.claude-plugin/` に `plugin.json` (このリポ自身のプラグイン本体) と `marketplace.json` を置いてある。`marketplace.json` は `ikeyan` marketplace として複数プラグインを配布する:

- `ikeyan-skills` (`source: "./"`) — このリポ自身。スキル集。
- `codex-cc-bridge` (`source: github ikeyan/codex-cc-bridge`) — 別リポジトリを参照。Claude Code から Codex を常駐 app-server 経由で使う橋。

```
/plugin marketplace add ikeyan/agent-files
/plugin install ikeyan-skills@ikeyan
/plugin install codex-cc-bridge@ikeyan
/reload-plugins
```

セッション中にインストールした場合、`/reload-plugins` を実行するまでスキルは読み込まれない。

インストールするとスキルは `/ikeyan-skills:<name>` で名前空間付き呼び出しになる。

このリポ自身の中では `.claude/skills` → `skills/` の symlink により素の名前で live ロードされる (編集が即反映される dogfood 用)。plugin も入れた環境でこのリポを開くと素の名前と名前空間付きの二重ロードになる。

