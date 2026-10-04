# 2026-10-04: agent-sync の最初の版の振り返り

読者: 次に agent-sync (sync.sh・部品・その test) を触る実装セッション。前提知識は AGENTS.md、setup-repo の 7 節、`canon: facts/archetect`。

## 状況

- 各リポへ置くファイルを、手で写して編集する形から、agent-sync で配る形にした。
  - ルートの `archetype.yaml` (catalog) と `components/` に、部品 `agent-sync`・`pre-push`・`pr-workflow` を置いた。部品は置くファイルの一覧 (`.agent-sync/files/<部品名>`) だけを出し、中身は `skills/setup-repo/agent-sync/sync.sh` が固定した版の上流からそのまま写す。
  - `sync.sh` は、git で固定した sha を取り、archetect を OS の sandbox (macOS は `render.sb`、Linux は bwrap) で描画し、定義域を全部検査してから当てる。
  - 配るファイルを編集しない代わりの置き場として、`hooks/pre-push.local` と `.claude/skills/pr-workflow/repo.md` を作った。このリポの pr-workflow も同じ形 (SKILL.md は symlink、値は repo.md) にした。
- 検証:
  - `scripts/test-agent-sync.sh` を macOS (sandbox-exec) で Claude Code の sandbox の外で回して通した。Linux (bwrap) は Debian trixie arm64 の privileged container の非 root で回して通した。
  - `./verify.sh` は新しい clone で sandbox の外で通した。
- push と PR はまだ。

## 良かったこと

- 試作 (`sync.sh`・`render.sb`・Debian container での実測) と canon の `facts/archetect` を下敷きにしたので、archetect の契約 (locals・`--offline`・`Existing.Error`・既定値の無い問いの失敗) を記憶で書かずに済んだ。`Existing.Error` は書く前に実物で確かめた。
- 安全性の性質ごとに、検査を外すと test が落ちることを確かめた (負のプローブ): 置き先の重複・古いパスの削除・`SANDBOX_RUNTIME=1` の拒否・利用者のファイル・mode の復元・パスの文字の定義域・部品の `Existing.Error`・`render.sb` を開けた sandbox。
- 試作で手で確かめていた「上流の Lua は sandbox の外へ書けず、外を読めず、プロセスを起動できない」を、test の probe 部品として定着させた。

## 直したこと

| 問題 | 直した先 |
| --- | --- |
| 試作の `find … \| grep -q .` は、pipefail の下で grep が先に終わると find が SIGPIPE で落ち、通常のファイルでない出力を見逃しうる | `[ -z "$(find …)" ]` にした (`1b10cc7`) |
| 試作の `rmdir -p` は作業ツリーのルートより上まで辿りうる | ルートの手前で止まる loop にした (`1b10cc7`) |
| 試作はファイルをその場で上書きしており、動いている `sync.sh` 自身も書き換える | 同じディレクトリの一時ファイルに書いて rename し、全体を `main` の中に置いた (`1b10cc7`) |
| 試作は追跡している全てのファイルを描画に渡し、作業ツリーで消した追跡ファイルがあると tar が落ちる | 渡すのを `archetype/` と `answers.yaml` の、追跡しているか無視されていないファイルに絞った (`1b10cc7`) |
| 試作の部品は `Existing.Overwrite` で、同じ出力のパスを後勝ちにする | 部品は `Existing.Error`。下流の archetype を先に描画する test で、部品側の拒否を固定した (`1b10cc7`) |
| 試作の otool の pipeline は、非システムの dylib が無いと `grep -v` が 1 で終わり pipefail で落ちる | awk で絞るようにした (`1b10cc7`) |
| `.claude/skills/pr-workflow/` に、`pr.sh` が同じディレクトリに探す `codex-limits.sh` が無かった | symlink を足した (`eb636ec`) |

## 残っていること

- CI は未実測。`.github/workflows/verify.yml` で archetect (release の sha256 で固定) と bubblewrap を入れ、`kernel.apparmor_restrict_unprivileged_userns=0` で AppArmor の制限を外したが、ubuntu-latest (24.04、x86_64) で次が成り立つかは確かめていない:
  - sysctl の後に bwrap が user namespace を作れること。通らなければ、`/usr/share/apparmor/extra-profiles/bwrap-userns-restrict` を読み込む形を試す。
  - `ldd` が出す共有ライブラリだけで archetect が namespace の中で動くこと (Debian trixie arm64 では動いた)。
  - archetect の linux の release は glibc 2.39 を要る (Debian bookworm では動かなかった)。ubuntu-latest が上がっても満たすかは、上がったときに CI で分かる。
- Claude Code の sandbox の中の `./verify.sh` は描画を伴う検査を飛ばす (stderr に出す)。sync.sh・部品・render.sb を変えたら、sandbox の外で `scripts/test-agent-sync.sh` を回す。
- パスの文字を POSIX の可搬なファイル名の文字に絞った。日本語のファイル名 (review-perspectives の観点など) を配るなら、Unicode の正規化で同じになる名前の重複も検査に足してから広げる。
- 当てる手順 (手順 4) はトランザクションでない。検査は全部先に済ませるが、ファイルシステムの失敗では途中まで当たる。
- 実際の下流のリポへの導入と、GitHub の HTTPS から sha で取る経路はまだ回していない (test は insteadOf で手元のリポに向ける)。
- `render.sb` の KEG は archetect の実行ファイルの 2 つ上のディレクトリで、Homebrew の Cellar では keg だが、`/usr/local/bin` に置いた archetect では `/usr/local` 全体の読み取りを許す。
