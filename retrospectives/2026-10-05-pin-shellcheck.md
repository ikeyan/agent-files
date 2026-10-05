# 2026-10-05: shellcheck の版を手元と CI で揃えた振り返り

読者: このリポで次に CI や verify.sh の道具の版を触る実装セッション。前提知識は AGENTS.md の「このリポの検証」、`canon: facts/shellcheck`。

## 状況

- SC2015 (`A && B || C`) が手元の `./verify.sh` で出ず、CI だけで 2 回落ちた (PR #21、PR #25 の `d819eef`)。手元は Homebrew の shellcheck 0.11.0、CI は ubuntu-24.04 runner image (20260927.320) 同梱の 0.9.0-1 で、版が違った。
- 0.9.0 と 0.11.0 を同じ入力に当てると、C が `{ }` のブロックか `continue` のときだけ 0.9.0 が SC2015 を出し、0.11.0 は出さない (canon に記録)。

## 良かったこと

- 「版が違う」という推測を、両方の版の darwin 版で実測してから直した。依頼の最小の入力 (`|| exit 1`、`|| echo x`) では 0.9.0 も出さないことが分かり、出る条件 (C が `{ }` か `continue`) を canon に正しく残せた。
- 0.11.0 の sha256 は GitHub の release asset の `.digest` と、取得したバイトの `shasum` で突き合わせた。

## 直したこと

| 問題 | 直した先 |
| --- | --- |
| 手元と CI の shellcheck の版が違った | verify.sh が 0.11.0 だけを通す。CI は同じ版を sha256 検証つきで `/usr/local/bin` に入れる (`76cfa8b`) |

## 残っていること

- 版は verify.sh と verify.yml の 2 か所にある。食い違えば CI の verify.sh が版の検査で落ちるので、片方だけの更新は見つかる。
- 0.9.0 の darwin 版は x86_64 だけで、arm64 の Mac では `arch -x86_64` (Rosetta) で動かした。
- Homebrew の shellcheck が 0.11.0 から進んだとき、手元は verify.sh の版の検査で落ちる。そのときは版を上げる (verify.sh・verify.yml の URL と sha256)。
