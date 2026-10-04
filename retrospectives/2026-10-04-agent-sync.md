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
| generated にあるパスを、利用者が変えていても上書き・削除した | HEAD から (mode を除いて) 変わっている・追跡していない・無視されていれば手順 3 で落ちる (`dfbb1d2`) |
| 同じ作業ツリーの sync.sh の同時の起動が、手順 4 で交わりうる | `<git dir>/agent-sync.lock` を mkdir で取る (`dfbb1d2`) |
| archetect の標準出力が sync.sh の標準出力に混ざる | 標準エラーへ回し、標準出力を `git status --short` だけにした (`dfbb1d2`) |
| archetect の版と TMPDIR の定義域が宣言になかった | 版は 3.6.1 だけ、TMPDIR は解決済みの作業パスの文字を宣言し、test で固定した (`dfbb1d2`) |
| trap が mktemp の後の cd・pwd の後だった。ldd・otool の出力を単語分割していた | trap を直後に置いた。1 行ずつ読む (`dfbb1d2`、`0d50b9c`) |
| 止まる経路 (引数・yaml の source・入力の欠け・generated・symlink・OS など) の test が無かった | fixture を足した (`dfbb1d2`) |
| 実行可能でない `hooks/pre-push.local` を黙って無視した。作業ツリーの無い push が理由を示さず落ちた | どちらも理由を示して止める (`67456ab`) |
| CI の sysctl と、SANDBOX_RUNTIME=1 の飛ばす分岐に外せる条件が無かった | 隣に書いた (`dfbb1d2`、`0d50b9c`) |
| pr-workflow の `repo.md` のテンプレートに、実体のパスからたどる読者への案内が無かった。このリポの実測の欄が「記録していない。」だった | 写したら消す案内を足し、「なし」にした (`ca07bf6`) |
| `SANDBOX_RUNTIME=1` の事前拒否は入れ子の可否の代理の検査で、Claude Code が入れ子を許しても拒み続け、Linux の bwrap の入れ子は未測定だった (レビュー 2 回目の指摘) | 拒否と test の飛ばす分岐を消し、描画の失敗に終了状態と「OS の sandbox を適用できない」を添えた。test は実際に OS の sandbox を適用する probe が通らないときだけ飛ばす (CI では落とす)。sandbox-exec は `env -i` の下で PATH を引かず shim が効かなかったので `command -v` の絶対パスで呼ぶ (`7e951c1`) |
| `GIT_DIR` などが残る環境 (hook・`git rebase --exec`) で、手順 1 の `git -C` が利用者のリポジトリに当たりうる | `git rev-parse --local-env-vars` (GIT_CONFIG* を除く) が 1 つでも設定されていれば最初に落とす。変数ごとの fixture を同じ一覧から生成する。canon に目録と hook に渡る変数の実測を足した (`7e951c1`、canon `86628a7`) |
| bash 3.2 の glob の範囲 (`[A-Za-z]`) は UTF-8 の locale で非 ASCII を通す (awk・sed は通さない)。LC_ALL=C は sort・comm にしか付けていなかった | 起動の最初に `export LC_ALL=C` する 1 か所に集め、コマンドごとの指定を消した。UTF-8 の locale での通過と非 ASCII の拒否の fixture を足した。外すと `sort -c` も落ちることを確かめた (`7e951c1`、canon `86628a7`) |
| 手順 4 の cp・chmod・mv の失敗で、作業ツリーの一時ファイル (`.agent-sync.XXXXXX`) が残った | 取得する資源を先頭に列挙し、現在の一時ファイルを `wt_tmp` に持たせて EXIT trap で消す。mv の shim で途中失敗させる fixture (`eeb5552`) |
| generated にあるパスを「HEAD と違えば利用者の変更」としたため、前回の結果の commit 前の再起動と、手順 4 の途中で落ちた後の再起動が拒まれ、収束しなかった | 「HEAD とも今回置くものとも違うときだけ」に変え、状態ごとの扱いを先頭の表にして行ごとに fixture を足した。commit 前の連続起動と、途中失敗の後の起動し直しが初回と同じ作業ツリーになる fixture も足した (`eeb5552`) |
| `foo` と `foo/bar` の両方を置く一覧が手順 3 を通り、手順 4 で途中まで当たった。`.agent-sync/` の下へ上流が sync.sh の入力を書けた | 別の置き先の親のディレクトリと、`.agent-sync/sync.sh`・`.agent-sync/render.sb` 以外の `.agent-sync/` の下を手順 3 で止める (generated のパスにも同じ規則) (`b4e7435`) |
| pre-push の `git rev-parse --show-toplevel 2>/dev/null` が git のエラーを隠し、どの原因でも bare と断じた | stderr を見せ、メッセージは原因を決めつけない。走る場所 (main・linked worktree・サブディレクトリ・bare・.git の中) を宣言し、linked worktree・サブディレクトリ・.git の中の fixture を足した (`2670e74`) |
| setup-repo の「編集しない。」が直前の文の帰結の重複だった | 消した (`062fa2d`) |
| 3 回目のレビューが、同じ箇所 (生成物の同一性・test の skip・取り出し) に点の指摘を重ねた。generated の判定は HEAD との差を代理にしており、利用者が生成物を編集して commit すると黙って消された・上書きされた。test の probe は実際の描画と別の操作だった。`git checkout` は core.autocrlf で配るスクリプトの shebang を CRLF にする | 機構の種類を変えた (`fe8420f`): (1) generated を `<パス><TAB><置いたバイトの id>` にして、判定を git の状態でなく中身の id だけにした (git hash-object --no-filters)。(2) 取り出しを checkout から ls-tree -r -z と cat-file blob にした (git の設定・属性に依らない)。(3) skip を probe でなく最初の実際の描画の失敗 (sync.sh の固定の文言) で決める。canon に checkout と cat-file・hash-object の実測、sandbox-exec の入れ子の失敗、文字の分類の目録を足した (canon `e7449da`) |
| 一覧を 1 つも出さない描画が成功し、generated の全てが古いパスとして消え、sync.sh 自身も消えた。別のリポの sync.sh を cwd で起動すると、root は cwd・render.sb は `$0` から決まり食い違った | 描画が `.agent-sync/sync.sh` を置かなければ、`$0` がカレントの作業ツリーの `.agent-sync/` のものでなければ、手順 3 の前に落とす (`fe8420f`) |
| 置き先・source の名前・TMPDIR の検査が、悪い例 1 つだけの test だった | 文字の分類 (タブ・制御文字・空白・shell の特殊文字・é・あ・ｚ) のループにした (`fe8420f`) |
| pre-push の注記の重複 (「(main のは使わない)」「無視せず」)、README が render.sb を挙げない、repo.md の導入文 | 直した (`2c33721`) |
| 4 回目のレビュー: 上流の tree に `README.md` と `readme.md` (または `Foo` と `foo/x`) があると、大文字小文字を区別しないファイルシステムで後の blob が先のものを黙って上書きし、一覧が指した中身が別のものになって記録した id も一致し続けた。File と dir の衝突は理由なく失敗した | 取り出しの前に全パスを検査し、衝突とパスの改行を理由を示して落とす。git のオブジェクトを直接作った上流の fixture (`03e361f`) |
| 相対の `TMPDIR` で作業ディレクトリが cwd (リポの中) にできた | 絶対パスだけを許し最初に落とす (`03e361f`) |
| 排他を握ったまま `git fetch` が端末で資格情報を問い合わせうる | fetch にだけ `GIT_TERMINAL_PROMPT=0` を付け、公開の https だけを対象と宣言した。`GIT_ASKPASS` があると `GIT_TERMINAL_PROMPT=0` でも askpass が問い合わせうることを実測して canon に足した (`03e361f`、canon `cd2080d`) |
| awk の区間 `{40}` は mawk 1.3.4-20200724 より前では既定で使えず、2 回目に全ての id を拒みうる | `length` と文字クラスに書き直し、区間を拒む awk の shim で回す fixture を足した。mawk の CHANGES で対応版を確かめて canon に足した (`03e361f`、canon `cd2080d`) |
| 下流が repo.md を作り忘れると、エージェントが push 先を推測しうる | pr-workflow の SKILL.md に、repo.md が無いか未記入なら push も PR の作成もせず止まる 1 文を足した (`93e21c1`) |
| AGENTS.md の「必要なもの」の最後の項目だけラベルが無かった | 「ネットワーク:」を付けた (`f54fe71`) |
| CI の shellcheck (ubuntu の apt) が、手元の 0.11.0 に無い SC2015 (`A && B \|\| C`) を出した。PR #21 に続いて 2 度目 | `{ A && B; } \|\| C` に直した (`d819eef`) |
| 5 回目のレビュー (Codex): 大文字小文字を区別しないファイルシステムで、置き先 `readme.md` が利用者の `README.md` に、途中の `docs/` が `Docs/` に当たり、中身が同じなら通って記録され、後の sync の `rm` が利用者の別の綴りのファイルを消しうる。古いパスと途中のディレクトリも同じ | 既存の成分の綴りを、親の一覧 (find) と完全一致で突き合わせる `case_clash` を、置き先と古いパスの検査の 1 か所に足し、手順 3 で落とす (区別するファイルシステムでは別のファイルとして通す)。fixture は一時ディレクトリの大文字小文字の区別を 1 度検出して分け、直す前に全て落ちることを確かめた (`5cc3e0a`、canon `4d8611b`) |
| 5 回目のレビューの修正への指摘: `case_clash` は find の失敗を空 (衝突なし) として通した。上流の大文字小文字だけの改名は、前回の出力を「利用者のファイル」として落とし続けた。置き先の重複検査は、ディレクトリの綴りが違う `Docs/b.md` と `docs/a.md` を通した | 一覧が取れなければ文言を出して落とし、改名は宣言して前回の出力と示す文言にし、ディレクトリの綴りは全置き先で揃える検査を手順 3 の awk に足した。fixture は直す前に全て落ちることを確かめた (`ca6c1ba`) |
| 6 回目のレビュー (Codex): 描画の出力の一覧が find の既定の改行区切りで、改行を含むファイル名 (信頼しない Lua が io.open で作れる) が `foo` と `bar` に割れ、一覧の `-` の行が両方を宣言すれば突き合わせを通り、手順 4 が古いパスを消してから chmod で落ちた | 出力を `-print0` で走査し、全てのパスを名前の定義域に照らして手順 3 の最初に落とす。一覧は形式上の行区切りで、改行を含む行は既存の定義域の検査が落とす。改行のファイル名を描画する fixture を足した (`89ab06e`) |
| 同: 古いパスの削除後に空になった親を rmdir し、sync が置く前からあった利用者の空のディレクトリが消えた | ディレクトリを消さない。generated がファイルしか記録せず、空のディレクトリの出どころが分からないため。置き先にあるディレクトリは空でも落ちる (利用者のもの)。ヘッダに宣言し、fixture を足した (`89ab06e`) |
| 7 回目のレビュー (Codex): 置き先が別のパスとの hard link で、中身が同じで mode だけ違うと、手順 4 が既存の inode に chmod し、共有する管理外のパスの mode を変えた | 既存の inode を書き換えない。mode が違えば一時ファイル + rename で置き直し、同じなら触らない。インプレースの chmod を無くし、ヘッダの同一性に宣言した。fixture は直す前に落ちることを確かめた (`29f7d47`) |

## 残っていること

- CI は未実測。`.github/workflows/verify.yml` で archetect (release の sha256 で固定) と bubblewrap を入れ、`kernel.apparmor_restrict_unprivileged_userns=0` で AppArmor の制限を外したが、ubuntu-latest (24.04、x86_64) で次が成り立つかは確かめていない:
  - sysctl の後に bwrap が user namespace を作れること。通らなければ、`/usr/share/apparmor/extra-profiles/bwrap-userns-restrict` を読み込む形を試す。
  - `ldd` が出す共有ライブラリだけで archetect が namespace の中で動くこと (Debian trixie arm64 では動いた)。
  - archetect の linux の release は glibc 2.39 を要る (Debian bookworm では動かなかった)。ubuntu-latest が上がっても満たすかは、上がったときに CI で分かる。
- OS の sandbox を適用できない環境 (Claude Code の sandbox の中など) の `./verify.sh` は、最初の描画が「OS の sandbox を適用できない」で落ちたとき、描画を伴う残りの検査を飛ばす (理由を stderr に出す)。sync.sh・部品・render.sb を変えたら、sandbox の外で `scripts/test-agent-sync.sh` を回す。
- パスの文字を POSIX の可搬なファイル名の文字に絞った。日本語のファイル名 (review-perspectives の観点など) を配るなら、Unicode の正規化で同じになる名前の重複も検査に足してから広げる。
- 当てる手順 (手順 4) はトランザクションでない。検査は全部先に済ませるが、ファイルシステムの失敗では途中まで当たる。
- 実際の下流のリポへの導入と、GitHub の HTTPS から sha で取る経路はまだ回していない (test は insteadOf で手元のリポに向ける)。
- `render.sb` の KEG は archetect の実行ファイルの 2 つ上のディレクトリで、Homebrew の Cellar では keg だが、`/usr/local/bin` に置いた archetect では `/usr/local` 全体の読み取りを許す。
- 2 回目のレビューの修正の実測と未測定:
  - Linux (bwrap) の描画は、この環境 (macOS) で動かしていない。CI が最初の実測になる。通らなければ CI は落ちる。
  - Linux の bwrap が入れ子の sandbox の中で動くかも未測定。
  - sandbox-exec の入れ子が exit 71 で落ちるのは、Claude Code の Bash の sandbox の中で probe が `Operation not permitted` で落ちる形で確かめた (描画の test は飛ばして理由を出す)。
  - bash の glob の範囲の locale 依存は macOS の bash 3.2 だけ測った。Linux の bash 5 は未測定で、`LC_ALL=C` の固定はどちらでも害が無いので測らずに入れた。
- 3 回目のレビューの修正の実測と未測定 (`fe8420f`):
  - 実測した: `git hash-object --no-filters` が autocrlf・属性に依らず中身そのものの id を返すこと、symlink は先の中身の id になること、`git checkout` が autocrlf=true で CRLF にして `cat-file blob` は LF のままなこと (canon `e7449da`)。sandbox-exec が Claude Code の sandbox の中で exit 71 と `sandbox_apply: Operation not permitted` になること。検査を外すと、取り出し・合成の検査・cwd の検査・利用者の変更の検査のそれぞれで fixture が落ちること。
  - 未測定: Linux の bwrap が OS の sandbox を適用できないときの終了状態と文言。sync.sh は stderr の `bwrap: ` で始まる行で判定していて、bubblewrap のソースの書式に基づくが実測していない (CI が最初の実測)。判定を外れた失敗は「描画が exit N で終わった」として落ちるので、見逃しても止まる。
  - 手順 4 の途中で落ちた後、入力 (sha) を変えて起動すると、generated に載っていない置き済みのファイルは今回置くものと違えば利用者のファイルとして落ちる (手で消す)。generated を先に書く形は、記録と実体のずれる窓を移すだけなので採らなかった。
  - generated の id は git のオブジェクトの形式 (sha1・sha256) で決まる。リポの形式を変えると、全ての生成物が利用者の変更として落ちる (未実測の経路)。
  - 取り出し (ls-tree と cat-file を blob ごとに起動) の所要時間は、大きい上流では未測定。
- 4 回目のレビューで、実害のシナリオが無い・変更が大きいので、この PR では採らなかった設計の案:
  - sync.sh と render.sb を部品の一覧から切り離し、固定した上流からの専用の自己更新の手順にする。`.agent-sync/` の置いてよい 2 つの許可リストと、「`.agent-sync/sync.sh` を置かない描画は落とす」検査が要らなくなる。
  - このリポの `.claude/skills/pr-workflow/` を、`skills/setup-repo/pr-workflow/` への symlink でなく agent-sync が置く実体の写しにする。テンプレートの repo.md の「実体のパスからたどる読者への案内」の行が要らなくなる。
- 手元の shellcheck (0.11.0) と CI の shellcheck (ubuntu の apt) の版の差が閉じていない。CI だけが出す指摘が 2 度出た (PR #21、本 PR の `d819eef`)。版を固定するか、手元と CI を揃える。
