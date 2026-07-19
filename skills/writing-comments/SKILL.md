---
name: writing-comments
description: Use when writing or editing code comments — including the urge to explain a tricky one-liner (regex, perl/sed, CLI flags), document why an approach was chosen, or annotate a workaround. Also applies when reviewing your own diff before commit.
---

# コメントの書き方

書いてよいコメントは 1 種類だけ: **「現在のコードがなぜこの形でなければならないか」の制約を 1〜2 行で述べたもの**。デフォルトはコメントなし — 有能な読者がコメントなしで混乱する、またはコードが壊れていると誤解する場合だけ書く。自コードの仕様・インターフェースの説明 (usage 行など) はコメントで良い。

## 書く前の判定

- 導出や推論の連鎖 (「A だから B、ゆえに C」) → 書かない。残すのは結論の制約だけ。
- 言語機能の説明 (lookbehind、ジェネレータ、演算子の挙動など) → 書かない。読者は言語を知っている前提。
- タスク指示や会話に書かれていた理由づけ (「X は Y 非対応なので Z を使う」等) をコメントへ転記しない。それは指示の echo であって、コードの制約ではない。
- 自分の思考過程・検討して却下した代替案・レビューで指摘された旧実装の説明 → 書かない。
- 次の行がやることの実況 (「fail closed にする」「env 経由で渡す」等、コードを読めば分かること) → 書かない。
- 変更の説明 (why-changed) はコミットメッセージにのみ書く。コメント候補がコミットメッセージや既存のファイル先頭コメントと一文でも重なるなら、そのコメントは追加しない。
- 外部システムの観測可能な挙動 (OS・デーモン・API の振る舞い等) を主張するコメントは書かず、落ちるテストで固定する。コメントは陳腐化しても落ちないが、テストは落ちる。
- 対象コードより長くなったコメントは大抵書きすぎ。一度疑う。「対象コード」はそのコメントが注釈する単位で測る (インラインなら隣接文/ブロック、関数ヘッダなら関数、ファイル先頭のアーキテクチャ/セキュリティ・ヘッダならファイル全体)。

## 悪い例: 言語機能と思考過程をそのまま書いている

```sh
# Lookbehind asserts the prefix without consuming it, so the
# replacement only needs to be the new version. sed has no
# lookarounds, hence perl.
perl -i -pe 's|(?<="packageManager": "bun\@)[^"]+|'"$tag"'|' package.json
```

## 良い例: コメントなし

```sh
perl -i -pe 's|(?<="packageManager": "bun\@)[^"]+|'"$tag"'|' package.json
```

## 悪い例: 結論に至るまでの因果を全部書いている

```yaml
# On pull_request_target github.ref resolves to the base branch,
# so without a PR-specific suffix every PR's sync would land in
# the same group and cancel-in-progress would clobber siblings.
group: sync-${{ github.workflow }}-pr-${{ github.event.pull_request.number }}
```

## 良い例: 制約を1行

```yaml
# pull_request_targetでgithub.refはbase branchになるためPR番号で一意化
group: sync-${{ github.workflow }}-pr-${{ github.event.pull_request.number }}
```
