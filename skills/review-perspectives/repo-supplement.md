# リポ固有の検索対象

観点の検出手順が列挙する対象 (資源の獲得と解放、テストの setup と teardown、終了ハンドラ) は、テストフレームワーク・ランタイム・リポ自身の関数で名前が違う。観点ファイルは全リポ共通なので、名前はリポ側の `review-perspectives/<観点>.md` に置き、レビュアーには観点ファイルと一緒に渡す。

## 書くもの

1 行に 1 つ、grep できる名前か型。用途の説明は書かない (観点ファイルが説明する)。

- 使うテストフレームワークの setup / teardown の API と、テスト単位で片付けを登録する API。
- ランタイムの終了ハンドラと、スコープ終端で解放する仕組み。
- リポ自身が持つ、終了ハンドラを登録する関数、資源を包む型、dispose / close を持つクラス。これらを呼ぶ箇所・作る箇所が列挙の対象になる。

## 例: TypeScript (vitest + Node.js)

```text
# review-perspectives/テストの setup は teardown で戻す.md
beforeAll, afterAll, beforeEach, afterEach (vitest)
hook から返した cleanup 関数 (vitest)
onTestFinished (vitest)
test.extend の fixture (vitest)
aroundEach, aroundAll (vitest)
setupFiles (vitest.config)
```

```text
# review-perspectives/獲得した資源は失敗経路でも解放する.md
process.on("exit"), process.on("beforeExit")
using, await using, Symbol.dispose, Symbol.asyncDispose, DisposableStack, AsyncDisposableStack
FinalizationRegistry
src/lifecycle.ts の registerShutdownHandler (リポ自身の終了ハンドラ)
```

他のランタイムのテスト API: `Deno.test.beforeAll` / `beforeEach` / `afterEach` / `afterAll`、`@std/testing/bdd`、`node:test` の `before` / `after` / `beforeEach` / `afterEach` と `t.before` / `t.after`、`bun:test` の `beforeAll` / `beforeEach` / `afterEach` / `afterAll` / `onTestFinished` と `--preload`。
