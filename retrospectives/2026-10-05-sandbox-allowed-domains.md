# 2026-10-05: Claude Code の sandbox の中で verify を回す許可の振り返り

読者: 次に `.claude/settings.json` か `./verify.sh` の通信先を触る実装セッション。

## 状況

- 利用者が手元で足していた sandbox の network の許可 (`www.schemastore.org`・`dl.deno.land`・`api.github.com`) をコミットした。
- この許可のある sandbox の中で `./verify.sh` を回し、hook の写しの違い (古い clone の既知の失敗) 以外が通ることを確かめた。`test-agent-sync.sh` は OS の sandbox を入れ子にできないので、描画を伴う検査を理由を出して飛ばした。

## 良かったこと

- 空の `DENO_DIR` で `deno check` を sandbox の中で回し、npm の取得 (`registry.npmjs.org`) が既定の許可で通ることを確かめてから、許可を足さずに済ませた。

## 直したこと

- 許可をリポに入れた (`88a06a0`)。

## 残っていること

- `dl.deno.land` と `api.github.com` が要るかは、許可を外した sandbox で実測していない (前者は deno の更新の確認、後者は pr-workflow の `pr.sh` のため)。
