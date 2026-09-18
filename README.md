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

このリポ自身の中では `.claude/skills/` から素の名前で live ロードされる (編集が即反映される dogfood 用)。plugin も入れた環境でこのリポを開くと素の名前と名前空間付きの二重ロードになる。

`.claude/skills/` の中身は 2 種類:

- `skills/<name>` への symlink — plugin として配るスキル。
- 実体のディレクトリ — このリポ専用で、配らないスキル (`pr-workflow`)。plugin が配るのは `skills/` 配下だけなので、専用スキルはここに実体で置く。`skills/` と同名の実体を置くと、配布スキルをこのリポでだけ差し替えられる。

対応関係は `./verify.sh` が見る。`skills/` にスキルを足した・消したときの symlink の作り忘れと残骸はその場で直す。CI は `VERIFY_READONLY=1` で直さずに落とす。symlink 先の誤りと実体側の `SKILL.md` 欠落は、どちらのモードでも違反として報告する。

## builtin の `/code-review` を review-perspectives に向ける

レビューの入口は review-perspectives に一本化する。builtin の `/code-review` とその別名 `/review` は、同名の個人スキルで置き換える (plugin のスキルは名前空間が付くので builtin を置き換えない。`code-review` の個人スキルは別名 `/review` を置き換えないので、`review` も置く)。

```sh
mkdir -p ~/.claude/skills/code-review ~/.claude/skills/review
cp user-skills/code-review/SKILL.md ~/.claude/skills/code-review/SKILL.md
sed 's/^name: code-review$/name: review/' user-skills/code-review/SKILL.md > ~/.claude/skills/review/SKILL.md
```

個人スキルは次のセッションから効く。他の plugin が持つレビュー用スキル (`engineering:code-review` 等) は、`~/.claude/settings.json` の `permissions.deny` に `Skill(<名前>)` と `Skill(<名前> *)` を足して止める。deny が止めるのは Claude の Skill ツール呼び出しで、ユーザーが打つ `/<名前>` は止めない。

