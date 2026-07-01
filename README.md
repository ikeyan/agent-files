# agent-files
skills, AGENTS.md等のファイル置き場。
skills は、 claude code on the web では環境起動時にコピーされ、他のclaude codeでは .claude/skills からsymlink等で参照される。

`rules/` は AGENTS.md / CLAUDE.md から `@rules/...` で取り込む共有ルール置き場で、他のリポジトリからも同じファイルを参照する想定。

## Claude plugin として使う

このリポは Claude Code プラグインも兼ねる。`.claude-plugin/` に `plugin.json` (プラグイン本体) と `marketplace.json` (`source: "./"` の単一プラグイン marketplace) を置いてある。

```
/plugin marketplace add ikeyan/agent-files
/plugin install ikeyan-skills@ikeyan
```

インストールするとスキルは `/ikeyan-skills:<name>` で名前空間付き呼び出しになる。web の `setup.sh` symlink とプラグインインストールは別チャネルなので、同一環境で両方有効にするとスキルが二重 (素の名前と名前空間付き) で読み込まれる。

