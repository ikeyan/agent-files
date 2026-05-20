---
paths:
  - "**/*.md"
---

## 文書 (Markdown) の書き方

- ハードラップしない。段落・箇条書きの各項目は途中で改行せず1行で書き、折り返しはレンダラに任せる。frontmatter の `description` も折り畳みスカラ (`>`) を使わず1行で書く。
- 論理構造をインラインの散文に埋め込まない。列挙・手順・階層・分類・対応関係は、見出し・箇条書き・番号付きリスト・表として表現する。文中の「A、B、C を…」「〜の場合は…、それ以外は…」は構造化の信号。

### 悪い例: ハードラップし、手順を散文に埋めている

```markdown
このスキルはまずリポジトリを fork し、次に README・CONTRIBUTING・
DEVELOPERS・pull_request_template を読み、最後にプロジェクトの
ガイドラインに沿った PR を起草する。
```

### 良い例: 1行で書き、構造は markdown 構造で

```markdown
このスキルは次を行う。

1. リポジトリを fork する
2. README / CONTRIBUTING / DEVELOPERS / pull_request_template を読む
3. プロジェクトのガイドラインに沿った PR を起草する
```
