# 2026-10-05: Claude Code の sandbox の中で verify を回す許可の振り返り

読者: 次に `.claude/settings.json` か `./verify.sh` の通信先を触る実装セッション。

## 状況

- 利用者が手元で足していた sandbox の network の許可のうち、`www.schemastore.org` と `dl.deno.land` をコミットした。`api.github.com` は Codex の指摘で外した。
- この許可のある sandbox の中で `./verify.sh` を回し、hook の写しの違い (古い clone の既知の失敗) 以外が通ることを確かめた。`test-agent-sync.sh` は OS の sandbox を入れ子にできないので、描画を伴う検査を理由を出して飛ばした。

## 良かったこと

- 空の `DENO_DIR` で `deno check` を sandbox の中で回し、npm の取得 (`registry.npmjs.org`) が既定の許可で通ることを確かめてから、許可を足さずに済ませた。

## 直したこと

- 許可をリポに入れた (`88a06a0`)。
- `api.github.com` を事前に許すと、`GH_TOKEN` を受け継いだ sandbox の全てのコマンドが承認なしに GitHub の API へ出られ、verify には要らない (PR の test は手元の偽の API を相手にする) という Codex の指摘で外した (`757caff`)。GitHub への通信は従来どおり承認か sandbox の外で行う。

## 残っていること

- `dl.deno.land` が要るかは、許可を外した sandbox で実測していない (deno の更新の確認のため残した)。
