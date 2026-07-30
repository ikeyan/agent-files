# agent-files
skills, AGENTS.md等のファイル置き場。
skills は Claude plugin としてインストールして参照する (下記)。

外部依存の確定仕様と事故は repo ごとに持たず canon (`ikeyan/canon`) に集める。`docs/verified-facts/` は移設が済むまで残る read-only の旧台帳 (書くのは canon だけ)。

## Claude plugin として使う

このリポは Claude Code プラグインも兼ねる。`.claude-plugin/` に `plugin.json` (プラグイン本体) と `marketplace.json` (`source: "./"` の単一プラグイン marketplace) を置いてある。

```
/plugin marketplace add ikeyan/agent-files
/plugin install ikeyan-skills@ikeyan
/reload-plugins
```

セッション中にインストールした場合、`/reload-plugins` を実行するまでスキルは読み込まれない。

インストールするとスキルは `/ikeyan-skills:<name>` で名前空間付き呼び出しになる。

このリポ自身の中では `.claude/skills` → `skills/` の symlink により素の名前で live ロードされる (編集が即反映される dogfood 用)。plugin も入れた環境でこのリポを開くと素の名前と名前空間付きの二重ロードになる。

