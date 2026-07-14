# agent-files
skills, AGENTS.md等のファイル置き場。
skills は Claude plugin としてインストールして参照する (下記)。

`rules/` は AGENTS.md / CLAUDE.md から `@rules/...` で取り込む共有ルール置き場で、他のリポジトリからも同じファイルを参照する想定。

## Claude plugin として使う

このリポは Claude Code プラグインも兼ねる。`.claude-plugin/` に `plugin.json` (プラグイン本体) と `marketplace.json` (`source: "./"` の単一プラグイン marketplace) を置いてある。

```
/plugin marketplace add ikeyan/agent-files
/plugin install ikeyan-skills@ikeyan
/reload-plugins
```

セッション中にインストールした場合、`/reload-plugins` を実行するまでスキルは読み込まれない。

インストールするとスキルは `/ikeyan-skills:<name>` で名前空間付き呼び出しになる。

