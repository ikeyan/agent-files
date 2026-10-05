/**
 * test-target-diff.ts — skills/review-perspectives/target-diff.sh を検査する。verify.sh から呼ぶ。2 つの部分を並行に回す:
 * - 例: 決めた履歴の一時リポで、target-diff.sh の先頭が受け付けると宣言する形を 1 つずつ固定する。生成に向かない形 (unborn HEAD、打ち消し合うコミット、origin の HEAD 無し、消した path、PR の head と base、gh の応答までに base が進む競合、相対の TMPDIR、bash 3.2) もここで見る。
 * - モデル: 履歴の操作列と環境の形を fast-check で生成し、履歴のモデルから「対象のコミット集合」と「対象のファイル集合」を計算して、target.diff と照合する。
 *
 * 全ての成功した実行で見ること: 出力は work・run・repo・diff・tree・rules の 6 行だけ。run は TMPDIR の下。repo は、対象を指定したら run の下、しなければチェックアウトのルート。
 *
 * 例で検査すること:
 * - 今のチェックアウト: 分岐点から先のコミット、未コミットの変更、未追跡の全種 (- 始まり・pathspec の記号を含む名前、リンク (mode 120000)、commit のある入れ子のリポジトリ (gitlink))。本来の index を変えない。linked worktree・サブディレクトリ・unborn HEAD・--single-branch・shallow・別の remote を追う shallow からも同じ
 * - 対象の解決: 手元だけ・リモートだけのブランチ、マージ済みの topic、それから積んだブランチ、merge commit、root commit、fast-forward でマージ済みのブランチ (最後の 1 コミット)、HEAD、revision の式
 * - PR 番号 (gh の stub が head と base を返す): base を取り込んだ PR は取り込んだコミットを含まず、マージ後も同じ。PR の説明が target.diff に入る。gh に origin を -R で渡す。fork の PR は同じブランチ名の同一リポの PR とも、owner/branch という名前のブランチとも work が別。gh の応答までに base が進んでも通る
 * - path: ディレクトリ、記号を含む名前、サブディレクトリからでもルートからの相対、ルートに戻る ..、ディレクトリへのリンク、コミットで削除したファイル
 * - 出力を変える git の設定・リポジトリの hook・core.fsmonitor のコマンドが結果を変えない。相対の TMPDIR、macOS 標準の bash 3.2 でも通る
 * - tree は未追跡の追加と内容の変更で変わり、rules はリポ固有の検索対象の追加と名前の変更で変わる
 * - work: 実行ごとに run は別。linked worktree からも本体の .git の下で、revision の式の .. で外に出ない。消えたブランチの exclusions.md と重ならない
 * - 止まる (stdout は空で、run と worktree を残さない): 絶対パスの path、一致しない path、staged だけの変更、commit の無い入れ子のリポジトリ、打ち消し合うコミット、origin の HEAD が無い、消えたリモートブランチ、origin 無し、fork を削除した PR。target-diff.sh 自身の理由 (レビュー対象が空・fork が無い) は文言も見る
 *
 * モデル (スクリプトの先頭の仕様を集合で書いたもの)。生成する次元は canon の `facts/git/repository-shapes` の目録の行で、目録の行を足したらここの生成器にも次元を足す:
 * - 出力を変える git の設定は diff.external・GIT_EXTERNAL_DIFF・textconv・color.diff・diff.noprefix を生成する。log.showSignature は unsigned commit では検証結果の行が出ず観測できないので生成しない (例でも扱わない)。
 * - 作業ツリーの項目は、対象無しの checkout に限り稀に tracked submodule の中の未コミットの変更 (dirtySubmodule) も生成し、target-diff.sh の対象外の宣言 (submodule の中身は見ない) を確かめる。
 * - 各コミットは 1 つのファイルを足す (merge commit は足さない)。commit c の内容 = c の祖先 (c を含む) のファイル。
 * - 対象のコミット集合:
 *   - 対象無し: anc(HEAD) \ anc(origin の既定ブランチ)。
 *   - ブランチ・revision r が既定ブランチに入っていない: anc(r) \ anc(既定ブランチ)。merge-base が 1 つに決まらない履歴は対象外 (git が任意の 1 つを返す)。
 *   - r が既定ブランチに入っている: 既定ブランチの first-parent の線上で最寄りの、r 自身でない祖先 b について anc(r) \ anc(b)。無ければ anc(r)。
 *   - PR 番号: anc(head) \ anc(base の tip)。
 * - path を付けたら、その path の内容がどの親とも違うコミットだけ (merge commit は、両側がその path のファイルを持ち込むときだけ)。絶対パス・ルートの外に出る `..`・空文字列の path は止まる。
 * - 対象のファイル集合: 上のコミットのファイル + (対象無しなら) 作業ツリーの変更と未追跡の項目 (.gitignore で無視されたものを除く)。
 * - ファイル集合が空なら止まる (merge commit だけの範囲を含む)。止まったら run ディレクトリと worktree を残さない。
 * - 同じ入力を同時に 2 つ走らせても、fetch の衝突 (cannot lock ref、shallow.lock の File exists、または shallow file has changed since we read it) でやり直せば同じ結果になる。
 * - tree= は作業ツリーの内容 (未追跡を含む) と mode で変わり、rules= は規則の内容と名前で変わる。
 * ネットワークは使わない (origin も gh も手元の偽物)。
 *
 * このスクリプトの入力と環境の定義域:
 * - 引数は取らない。渡されれば理由を出して落ちる。
 * - 読む環境変数は PATH・TMPDIR・TARGET_DIFF_RUNS (モデルの試行数。既定 25 で、先頭が 0 でない 10 進の正の整数の綴りの安全な整数)・FC_SEED (モデルを再現する seed。-2147483648〜2147483647 の整数) だけ。値が外れれば理由を出して落ちる。
 * - /bin/bash (macOS の bash 3.2。無ければ bash 3.2 の例だけ飛ばして理由を stderr に出す)。
 * - PATH に git・bash と、target-diff.sh が呼ぶ dirname・mkdir・mktemp・rm・paste・cat、gh の stub が呼ぶ sh、準備の ln があること。
 * - TMPDIR (未設定か空なら /tmp) は絶対パスで、作った一時ディレクトリの綴りと解決済みのパスが A-Z a-z 0-9 . _ / - だけであること。外れていれば理由を出して落ちる。
 * - 後始末は、終わったときに一時ディレクトリを消す。SIGINT・SIGTERM では子に SIGTERM を送り、子が終わってから消す (子が書いている最中に消すと消し残す)。
 *
 * 並行の検査が共有する、変わりうる状態。これ以外は例ごとの `${tmp}/f/<n>`・モデルの試行ごとの `${tmp}/pbt/<名前>` の下に置き (target-diff.sh の TMPDIR と、gh の stub が読み書きする GH_CASE も)、新しく共有するものを足すときも検査ごとのパスにする:
 * - HOME (`${tmp}/home`)。
 * - 例の元の履歴 (`${tmp}/src` と、その bare の clone の `${tmp}/origin.git`) と gh の stub (`${tmp}/bin/gh`): 準備で作った後は読むだけ。origin を書き換える例は `${tmp}/src` から自分の bare を作る。
 *
 * 子の環境は baseEnv と、呼ぶごとに足すもの (TMPDIR・PATH・GH_CASE・git の設定) だけ (clearEnv。canon: facts/deno/command-spawn)。hook や rebase --exec から呼ばれても、呼び出し元の GIT_DIR などを子に渡さない。
 */
import fc from "fast-check";

const here = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");
const self = "test-target-diff.ts";
const script = `${here}/skills/review-perspectives/target-diff.sh`;
const dec = new TextDecoder();

if (Deno.args.length) {
  console.error(`${self}: 引数は取らない (${Deno.args.join(" ")})`);
  Deno.exit(1);
}

const runsRaw = Deno.env.get("TARGET_DIFF_RUNS");
// 綴りの検査だけでは、桁の多い数が Number() で Infinity や丸めた値になる。fast-check は numRuns をそのまま使い、seed は 32 ビットの整数に寄せる (canon: facts/fast-check/seed-and-numruns)
const numRuns = runsRaw === undefined ? 25 : Number(runsRaw);
if (runsRaw !== undefined && (!/^[1-9]\d*$/.test(runsRaw) || !Number.isSafeInteger(numRuns))) {
  console.error(`${self}: TARGET_DIFF_RUNS は 1 以上の整数: ${runsRaw}`);
  Deno.exit(1);
}
const seedEnv = Deno.env.get("FC_SEED");
if (seedEnv !== undefined && (!/^-?\d+$/.test(seedEnv) || (Number(seedEnv) | 0) !== Number(seedEnv))) {
  console.error(`${self}: FC_SEED は 32 ビットの符号付き整数: ${seedEnv}`);
  Deno.exit(1);
}

const tmpdirEnv = Deno.env.get("TMPDIR") ?? "";
if (tmpdirEnv && !tmpdirEnv.startsWith("/")) {
  console.error(`${self}: TMPDIR (${tmpdirEnv}) が絶対パスでない`);
  Deno.exit(1);
}
const tmp = await Deno.makeTempDir({ dir: tmpdirEnv || "/tmp", prefix: "target-diff-test." });
const cleanup = () => {
  try {
    Deno.removeSync(tmp, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
};
addEventListener("unload", cleanup);
addEventListener("unhandledrejection", cleanup);
/** 動いている子。中断では、子が一時ディレクトリに書き終える (終わる) のを待ってから消す。 */
const children = new Set<Deno.ChildProcess>();
let interrupted = false;
const interrupt = async (code: number) => {
  interrupted = true;
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      // 既に終わっている
    }
  }
  await Promise.allSettled([...children].map((c) => c.status));
  Deno.exit(code);
};
Deno.addSignalListener("SIGINT", () => interrupt(130));
Deno.addSignalListener("SIGTERM", () => interrupt(143));

// tmp は解決しないまま使う: deno の --allow-read・--allow-write は symlink を解決せずにパスの綴りで照合し、verify.sh は TMPDIR の綴りで許可を渡す (canon: facts/deno/permission-paths-not-resolved)。
// パスの文字 (空白・改行など) による違いは検査していないので、子に渡す綴りと解決したパスの両方が検査した形のときだけ回す。
const resolved = await Deno.realPath(tmp);
for (const p of [tmp, resolved]) {
  if (!/^\/[A-Za-z0-9._\/-]*$/.test(p)) {
    console.error(`${self}: TMPDIR (${tmpdirEnv}) の下に作った一時ディレクトリ ${p} が A-Z a-z 0-9 . _ / - だけの形でない。TMPDIR を直す`);
    Deno.exit(1);
  }
}
/**
 * target-diff.sh (`pwd -P`) と git (canon: facts/git/worktree-add-records-resolved-path) が出す解決済みのパスを、許可を受けた tmp の綴りに戻す。
 * deno の許可は symlink を解決せずに綴りで照合する (canon: facts/deno/permission-paths-not-resolved) ので、解決済みのパスのままでは読めない。
 * 外せる条件: deno が許可の照合でパスを解決するようになったとき、または verify.sh が TMPDIR を解決した綴りで渡すようになったとき。
 */
const local = (p: string) => (p === resolved || p.startsWith(`${resolved}/`) ? tmp + p.slice(resolved.length) : p);

const baseEnv: Record<string, string> = {
  PATH: Deno.env.get("PATH") ?? "",
  HOME: `${tmp}/home`,
  TMPDIR: tmp,
  // 照合する git の文言 (fetch の衝突) を locale に依らせない。clearEnv で locale の環境変数が無くても、macOS では GNU gettext を使うプログラムがシステムの言語で訳す (canon: facts/shell/gettext-macos-system-language)
  LC_ALL: "C",
  GIT_CONFIG_GLOBAL: `${here}/scripts/test-gitconfig`,
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

// ---- 子プロセス ----

interface Run {
  code: number;
  out: string;
  err: string;
}

/** 同時に動かす子プロセスの数の上限。検査を全部並行に始め、ここで絞る。 */
const limit = Math.max(1, navigator.hardwareConcurrency);
let active = 0;
const waiters: (() => void)[] = [];

async function exec(cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string> } = {}): Promise<Run> {
  while (active >= limit) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    if (interrupted) throw new Error("中断した");
    const child = new Deno.Command(cmd, {
      args,
      cwd: o.cwd,
      env: { ...baseEnv, ...o.env },
      // canon: facts/deno/command-spawn — clearEnv は env だけを子に渡す。spawn() の stdin の既定は inherit
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    children.add(child);
    const r = await child.output().finally(() => children.delete(child));
    return { code: r.code, out: dec.decode(r.stdout), err: dec.decode(r.stderr) };
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/** 準備と観測の git。落ちれば例外。検査側の git が hook と fsmonitor を走らせて作業ツリーを変えないように止める。 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: exit ${r.code} — ${r.err}`);
  return r.out.trim();
}

/**
 * `Deno.symlink` はパスを付けない read・write の許可を要る (canon: facts/deno/permission-paths-not-resolved) ので、許可を TMPDIR に絞るため ln で作る。
 * 外せる条件: Deno.symlink がパスを絞った許可で通るようになったとき。
 */
async function symlink(target: string, path: string) {
  const r = await exec("ln", ["-s", target, path]);
  if (r.code !== 0) throw new Error(`ln -s ${target} ${path}: exit ${r.code} — ${r.err}`);
}

async function commitFile(cwd: string, file: string, subject = file) {
  if (file.includes("/")) await Deno.mkdir(`${cwd}/${file.slice(0, file.lastIndexOf("/"))}`, { recursive: true });
  await Deno.writeTextFile(`${cwd}/${file}`, `${file}\n`);
  await git(cwd, "add", "--", file);
  await git(cwd, "commit", "-q", "-m", subject);
}

const entries = async (dir: string) => (await Array.fromAsync(Deno.readDir(dir))).length;

// ---- target-diff.sh の出力 ----

interface Output {
  work: string;
  run: string;
  repo: string;
  diff: string;
  tree: string;
  rules: string;
}
const keys = ["work", "run", "repo", "diff", "tree", "rules"] as const;

/** 出力の 6 行を読む。パスは local で tmp の綴りにする。 */
function parseOutput(stdout: string): Output {
  const o: Record<string, string> = {};
  for (const line of stdout.split("\n").filter((l) => l !== "")) {
    const m = /^(work|run|repo|diff|tree|rules)=(.*)$/.exec(line);
    if (!m) throw new Error(`出力に形式外の行がある: ${line}`);
    if (m[1] in o) throw new Error(`出力に ${m[1]} の行が重複している: ${stdout}`);
    o[m[1]] = m[2];
  }
  const missing = keys.filter((k) => !(k in o));
  if (missing.length) throw new Error(`出力に ${missing.join(" ")} の行が無い: ${stdout}`);
  return { work: local(o.work), run: local(o.run), repo: local(o.repo), diff: local(o.diff), tree: o.tree, rules: o.rules };
}

/** target.diff の全文と、コミットの件名とファイル (重複は残す)。 */
async function readDiff(path: string): Promise<{ text: string; commits: string[]; files: string[] }> {
  const text = await Deno.readTextFile(path);
  const lines = text.split("\n");
  const commits: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^commit [0-9a-f]+$/.test(lines[i])) commits.push(lines[i + 2]);
    const m = /^diff --git a\/(.*) b\//.exec(lines[i]);
    if (m) files.push(m[1]);
  }
  return { text, commits, files };
}

const show = (s: Iterable<string>) => `[${[...s].sort().join(" ")}]`;
const same = (a: Iterable<string>, b: Iterable<string>) => show(a) === show(b);

/** target-diff.sh が成功したときの出力を検査し、出力を返す。tmpdir は子の TMPDIR の絶対パス (tmp の綴り)。 */
async function checkOutput(r: Run, cwd: string, args: string[], tmpdir: string): Promise<Output> {
  if (r.code !== 0) throw new Error(`止まった (exit ${r.code}): ${r.err}`);
  const o = parseOutput(r.out);
  if (!o.run.startsWith(`${tmpdir}/`)) throw new Error(`run が TMPDIR (${tmpdir}) の下でない: ${o.run}`);
  if (args.length && args[0] !== "--") {
    if (!o.repo.startsWith(`${o.run}/`)) throw new Error(`対象を指定したのに repo が run の下でない: ${o.repo}`);
  } else {
    const top = local(await git(cwd, "rev-parse", "--show-toplevel"));
    if (o.repo !== top) throw new Error(`対象無しなのに repo がチェックアウトのルート (${top}) でない: ${o.repo}`);
  }
  return o;
}

// ---- 例の単位 ----

interface Ctx {
  dir: string;
  fail(msg: string): void;
}
const reports: string[][] = [];
const pending: Promise<unknown>[] = [];

/** 例を始める。独立に並行で回り、落ちた理由を登録の順で最後に出す。dir/tmp を target-diff.sh の TMPDIR にする。 */
function fixture(name: string, body: (t: Ctx) => Promise<void>) {
  const failures: string[] = [];
  reports.push(failures);
  const dir = `${tmp}/f/${reports.length - 1}`;
  pending.push((async () => {
    await Deno.mkdir(`${dir}/tmp`, { recursive: true });
    await body({ dir, fail: (m) => failures.push(`${name}: ${m}`) });
  })().catch((e) => failures.push(`${name}: 例外 — ${e instanceof Error ? e.stack : e}`)));
}

interface Invoke {
  env?: Record<string, string>;
  /** 子の TMPDIR の絶対パス (tmp の綴り)。env.TMPDIR が相対のときに渡す。 */
  tmpdir?: string;
  bash?: string;
}

/** cwd で target-diff.sh を回す。止まったら違反にして null を返す。 */
async function targetDiff(t: Ctx, cwd: string, args: string[], o: Invoke = {}): Promise<Output | null> {
  const tmpdir = o.tmpdir ?? `${t.dir}/tmp`;
  const r = await exec(o.bash ?? "bash", [script, ...args], { cwd, env: { TMPDIR: tmpdir, ...o.env } });
  try {
    return await checkOutput(r, cwd, args, tmpdir);
  } catch (e) {
    t.fail(`target-diff.sh ${args.join(" ")} (${cwd}): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** target.diff のファイルとコミットの件名が期待どおりか。 */
async function expect(t: Ctx, o: Output | null, files: string[], commits: string[]) {
  if (o === null) return null;
  const got = await readDiff(o.diff);
  if (!same(got.files, files)) t.fail(`diff のパスが違う — 期待 ${show(files)} 実際 ${show(got.files)}`);
  if (!same(got.commits, commits)) t.fail(`コミットが違う — 期待 ${show(commits)} 実際 ${show(got.commits)}`);
  return got;
}

/** target-diff.sh が止まり、stdout が空で、run と worktree を残さないこと。reason を渡せば stderr に含むこと。 */
async function fails(t: Ctx, cwd: string, args: string[], o: { env?: Record<string, string>; reason?: string } = {}) {
  const tmpdir = `${t.dir}/tmp`;
  const [n0, w0] = [await entries(tmpdir), await git(cwd, "worktree", "list")];
  const r = await exec("bash", [script, ...args], { cwd, env: { TMPDIR: tmpdir, ...o.env } });
  const label = `target-diff.sh ${args.join(" ")} (${cwd})`;
  if (r.code === 0) return t.fail(`${label}: 止まらない — ${r.out}`);
  if (r.out !== "") t.fail(`${label}: stdout が空でない — ${r.out}`);
  if (o.reason !== undefined && !r.err.includes(o.reason)) t.fail(`${label}: 理由 (${o.reason}) を示さない — ${r.err.trimEnd()}`);
  if (await entries(tmpdir) !== n0) t.fail(`${label}: 止まったのに run が残る`);
  if (await git(cwd, "worktree", "list") !== w0) t.fail(`${label}: 止まったのに worktree が残る`);
}

const workOf = (o: Output | null) => o?.work ?? null;

// ---- 例の準備 ----

// 履歴:
//   main: a → b → M (topic の t1・t2 を --no-ff でマージ) → ff1 → ff2 (ff を fast-forward でマージ)
//   stacked: topic から s1
//   remote-only: main から r1
const src = `${tmp}/src`;
const origin = `${tmp}/origin.git`;
await Deno.mkdir(src);
await git(src, "init", "-q", "-b", "main");
await commitFile(src, "a.txt");
await commitFile(src, "b.txt");
await git(src, "checkout", "-q", "-b", "topic");
await commitFile(src, "t1.txt");
await commitFile(src, "t2.txt");
await git(src, "checkout", "-q", "-b", "stacked");
await commitFile(src, "s1.txt");
await git(src, "checkout", "-q", "main");
await git(src, "merge", "-q", "--no-ff", "-m", "M", "topic");
await git(src, "checkout", "-q", "-b", "ff");
await commitFile(src, "ff1.txt");
await commitFile(src, "ff2.txt");
await git(src, "checkout", "-q", "main");
await git(src, "merge", "-q", "--ff-only", "ff");
await git(src, "checkout", "-q", "-b", "remote-only");
await commitFile(src, "r1.txt");
await git(src, "checkout", "-q", "main");
await git(tmp, "clone", "-q", "--bare", src, origin);
const root = await git(origin, "rev-list", "--max-parents=0", "main");
const merge = await git(origin, "rev-list", "--merges", "--max-count=1", "main");

// gh の代わり。target-diff.sh が PATH で引いて起動する実行ファイルなので sh で書く。macOS の初回の exec の待ち (canon: facts/macos/first-exec-of-new-executable) を 1 回にするため、全ての例で 1 つを共有し、例ごとの応答は GH_CASE の下に置く:
// - args: 受けた引数を書く
// - pre.sh: 応答の前に回す (無ければ空)
// - out: 応答 (gh pr view --json … --jq … の出力)
await Deno.mkdir(`${tmp}/bin`);
const ghPath = `${tmp}/bin:${baseEnv.PATH}`;
await Deno.writeTextFile(`${tmp}/bin/gh`, '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$GH_CASE/args"\nsh "$GH_CASE/pre.sh" || exit 1\ncat "$GH_CASE/out"\n', { mode: 0o755 });

/** gh の stub が返す応答を置き、target-diff.sh に渡す環境を返す。 */
async function gh(t: Ctx, name: string, fields: { name: string; head: string; base: string; baseRefName: string; cross: boolean; owner: string }, pre?: string) {
  const dir = `${t.dir}/gh-${name}`;
  await Deno.mkdir(dir);
  const tsv = [fields.name, fields.head, fields.base, fields.baseRefName, String(fields.cross), fields.owner].join("\t");
  await Deno.writeTextFile(`${dir}/out`, `${tsv}\npull request: T\n\nPR-BODY\n`);
  await Deno.writeTextFile(`${dir}/pre.sh`, pre ?? "");
  return { PATH: ghPath, GH_CASE: dir };
}

/** dir/clone に origin の clone を作り、今のチェックアウトの状態にする: 手元だけのブランチ local-only (l1)、checkout した feature (f1)、未コミットの変更 (a.txt)、未追跡の全種 (- 始まり、リンク、入れ子のリポジトリ、サブディレクトリ、pathspec の記号を含む名前)。 */
async function workspace(t: Ctx, from = origin) {
  const clone = `${t.dir}/clone`;
  await git(t.dir, "clone", "-q", from, clone);
  await git(clone, "checkout", "-q", "-b", "local-only");
  await commitFile(clone, "l1.txt");
  await git(clone, "checkout", "-q", "main");
  await git(clone, "checkout", "-q", "-b", "feature");
  await commitFile(clone, "f1.txt");
  await Deno.writeTextFile(`${clone}/a.txt`, "changed\n");
  await Deno.writeTextFile(`${clone}/--stat`, "x\n");
  await Deno.mkdir(`${clone}/sub`);
  await Deno.writeTextFile(`${clone}/sub/u.txt`, "u\n");
  await symlink("sub", `${clone}/linkdir`);
  await Deno.writeTextFile(`${clone}/sub/[b].txt`, "b\n");
  await Deno.writeTextFile(`${clone}/:c.txt`, "c\n");
  await git(clone, "init", "-q", "nested");
  await git(`${clone}/nested`, "commit", "-q", "--allow-empty", "-m", "n");
  return clone;
}
const checkoutFiles = ["--stat", ":c.txt", "a.txt", "f1.txt", "linkdir", "nested", "sub/[b].txt", "sub/u.txt"];

/** origin を書き換える例のための、自分の bare の origin。 */
async function ownOrigin(t: Ctx) {
  const o = `${t.dir}/origin.git`;
  await git(t.dir, "clone", "-q", "--bare", src, o);
  return o;
}

// ---- 例: 今のチェックアウト ----

fixture("今のチェックアウト", async (t) => {
  const clone = await workspace(t);
  const got = await expect(t, await targetDiff(t, clone, []), checkoutFiles, ["f1.txt"]);
  if (got && !/^new file mode 120000$/m.test(got.text)) t.fail("リンクが 120000 で出ない");
  if (got && !/^\+Subproject commit /m.test(got.text)) t.fail("入れ子のリポジトリが gitlink で出ない");
  if ((await exec("git", ["diff", "--cached", "--quiet"], { cwd: clone })).code !== 0) t.fail("本来の index が変わった");
});

fixture("bash 3.2", async (t) => {
  try {
    await Deno.stat("/bin/bash");
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    console.error(`${self}: /bin/bash が無いので bash 3.2 の例を飛ばす`);
    return;
  }
  const clone = await workspace(t);
  await expect(t, await targetDiff(t, clone, [], { bash: "/bin/bash" }), checkoutFiles, ["f1.txt"]);
});

fixture("path (ディレクトリ)", async (t) => {
  const clone = await workspace(t);
  await expect(t, await targetDiff(t, clone, ["--", "sub"]), ["sub/[b].txt", "sub/u.txt"], []);
});

fixture("path (pathspec の記号を含む名前)", async (t) => {
  const clone = await workspace(t);
  await expect(t, await targetDiff(t, clone, ["--", "sub/[b].txt", ":c.txt"]), [":c.txt", "sub/[b].txt"], []);
});

fixture("tree", async (t) => {
  const clone = await workspace(t);
  const t0 = (await targetDiff(t, clone, ["--", "sub"]))?.tree;
  await Deno.writeTextFile(`${clone}/sub/v.txt`, "v\n");
  const t1 = (await targetDiff(t, clone, ["--", "sub"]))?.tree;
  if (t0 && t1 && t0 === t1) t.fail("未追跡ファイルの追加で変わらない");
  await Deno.writeTextFile(`${clone}/sub/v.txt`, "w\n");
  const t2 = (await targetDiff(t, clone, ["--", "sub"]))?.tree;
  if (t1 && t2 && t1 === t2) t.fail("内容の変更で変わらない");
});

fixture("rules", async (t) => {
  const clone = await workspace(t);
  const r0 = (await targetDiff(t, clone, ["--", "sub"]))?.rules;
  await Deno.mkdir(`${clone}/review-perspectives`);
  await Deno.writeTextFile(`${clone}/review-perspectives/x.md`, "s\n");
  const r1 = (await targetDiff(t, clone, ["--", "sub"]))?.rules;
  if (r0 && r1 && r0 === r1) t.fail("リポ固有の検索対象の追加で変わらない");
  await Deno.rename(`${clone}/review-perspectives/x.md`, `${clone}/review-perspectives/y.md`);
  const r2 = (await targetDiff(t, clone, ["--", "sub"]))?.rules;
  if (r1 && r2 && r1 === r2) t.fail("リポ固有の検索対象の名前の変更で変わらない");
});

fixture("linked worktree (detached なので名前は短い id)", async (t) => {
  const clone = await workspace(t);
  await git(clone, "worktree", "add", "-q", "--detach", `${t.dir}/lw`, "feature");
  const o = await targetDiff(t, `${t.dir}/lw`, []);
  await expect(t, o, ["f1.txt"], ["f1.txt"]);
  if (o && !o.work.startsWith(`${clone}/.git/review-perspectives/`)) t.fail(`作業ディレクトリが本体の .git の下でない — ${o.work}`);
});

fixture("並行実行 (同じ対象を 2 回回しても生成物は別)", async (t) => {
  const clone = await workspace(t);
  const first = await targetDiff(t, clone, ["--", "sub"]);
  const second = await targetDiff(t, clone, ["--", "a.txt"]);
  if (!first || !second) return;
  if (first.run === second.run || first.diff === second.diff) t.fail(`生成物を共有している — ${first.run}`);
  await expect(t, first, ["sub/[b].txt", "sub/u.txt"], []);
});

fixture("サブディレクトリからの path (対象なし)", async (t) => {
  const clone = await workspace(t);
  await expect(t, await targetDiff(t, `${clone}/sub`, ["--", "sub/u.txt"]), ["sub/u.txt"], []);
});

fixture("リポジトリの中のディレクトリへのリンク", async (t) => {
  const clone = await workspace(t);
  await expect(t, await targetDiff(t, clone, ["--", "linkdir"]), ["linkdir"], []);
});

fixture("unborn HEAD (initial commit の前、origin はある)", async (t) => {
  const repo = `${t.dir}/unborn`;
  await git(t.dir, "init", "-q", "-b", "fresh", repo);
  await git(repo, "remote", "add", "origin", origin);
  await Deno.writeTextFile(`${repo}/x.txt`, "x\n");
  await expect(t, await targetDiff(t, repo, []), ["x.txt"], []);
});

// ---- 例: 対象の指定 ----

const targets: [string, () => string, string[], string[]][] = [
  ["手元だけのブランチ", () => "local-only", ["l1.txt"], ["l1.txt"]],
  ["リモートだけのブランチ", () => "remote-only", ["r1.txt"], ["r1.txt"]],
  ["マージ済みの topic", () => "topic", ["t1.txt", "t2.txt"], ["t1.txt", "t2.txt"]],
  ["topic から積んだブランチ", () => "stacked", ["s1.txt"], ["s1.txt"]],
  ["root commit", () => root, ["a.txt"], ["a.txt"]],
  ["fast-forward でマージ済みのブランチ (最後の 1 コミットだけ)", () => "origin/ff", ["ff2.txt"], ["ff2.txt"]],
  ["revision の HEAD (origin/HEAD でない)", () => "HEAD", ["f1.txt"], ["f1.txt"]],
];
for (const [name, target, files, commits] of targets) {
  fixture(name, async (t) => {
    const clone = await workspace(t);
    await expect(t, await targetDiff(t, clone, [target()]), files, commits);
  });
}

fixture("merge commit", async (t) => {
  const clone = await workspace(t);
  for (const run of ["1 回目", "同じ対象の 2 回目"]) {
    const o = await targetDiff(t, clone, [merge]);
    await expect(t, o, ["t1.txt", "t2.txt"], ["M", "t1.txt", "t2.txt"]);
    if (o && await git(o.repo, "rev-parse", "HEAD") !== merge) t.fail(`${run}: repo が対象を指していない`);
  }
});

fixture("diff の出力を変える git の設定", async (t) => {
  const clone = await workspace(t);
  const env = { GIT_EXTERNAL_DIFF: "true", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "diff.noprefix", GIT_CONFIG_VALUE_0: "true", GIT_CONFIG_KEY_1: "color.diff", GIT_CONFIG_VALUE_1: "always" };
  await expect(t, await targetDiff(t, clone, ["topic"], { env }), ["t1.txt", "t2.txt"], ["t1.txt", "t2.txt"]);
});

fixture("リポジトリの hook", async (t) => {
  const clone = await workspace(t);
  await Deno.mkdir(`${t.dir}/hooks`);
  await Deno.writeTextFile(`${t.dir}/hooks/post-checkout`, "#!/bin/sh\necho hook > hook.txt\n", { mode: 0o755 });
  await git(clone, "config", "core.hooksPath", `${t.dir}/hooks`);
  await expect(t, await targetDiff(t, clone, ["topic"]), ["t1.txt", "t2.txt"], ["t1.txt", "t2.txt"]);
});

fixture("core.fsmonitor のコマンド", async (t) => {
  const clone = await workspace(t);
  await Deno.writeTextFile(`${t.dir}/fsmonitor`, "#!/bin/sh\necho x > fsmonitor.txt\n", { mode: 0o755 });
  await git(clone, "config", "core.fsmonitor", `${t.dir}/fsmonitor`);
  await expect(t, await targetDiff(t, clone, ["topic"]), ["t1.txt", "t2.txt"], ["t1.txt", "t2.txt"]);
  await expect(t, await targetDiff(t, clone, ["--", "sub"]), ["sub/[b].txt", "sub/u.txt"], []);
});

fixture("相対 TMPDIR", async (t) => {
  const clone = await workspace(t);
  await Deno.mkdir(`${clone}/rel-tmp`);
  await expect(t, await targetDiff(t, clone, ["topic"], { env: { TMPDIR: "rel-tmp" }, tmpdir: `${clone}/rel-tmp` }), ["t1.txt", "t2.txt"], ["t1.txt", "t2.txt"]);
});

/** clone に origin/main から subch を作り、sub/s.txt を足すコミットを積んで checkout したままにする。 */
async function subch(clone: string) {
  await git(clone, "checkout", "-q", "-b", "subch", "origin/main");
  await commitFile(clone, "sub/s.txt");
}

fixture("サブディレクトリからの path (対象あり)", async (t) => {
  const clone = await workspace(t);
  await subch(clone);
  await expect(t, await targetDiff(t, `${clone}/sub`, ["subch", "--", "sub/s.txt"]), ["sub/s.txt"], ["sub/s.txt"]);
});

fixture("ルートの中に戻る ..", async (t) => {
  const clone = await workspace(t);
  await subch(clone);
  await expect(t, await targetDiff(t, clone, ["subch", "--", "sub/../sub/s.txt"]), ["sub/s.txt"], ["sub/s.txt"]);
});

fixture("revision の式に .. が入っても作業ディレクトリは .git/ の下", async (t) => {
  const clone = await workspace(t);
  await subch(clone);
  await git(clone, "commit", "-q", "--allow-empty", "-m", "aa/bb/cc/escape");
  const o = await targetDiff(t, clone, ["HEAD^{/../../escape}", "--", "sub/s.txt"]);
  await expect(t, o, ["sub/s.txt"], ["sub/s.txt"]);
  if (o && !o.work.startsWith(`${clone}/.git/review-perspectives/`)) t.fail(`作業ディレクトリが .git の外 — ${o.work}`);
});

fixture("消えたブランチの中のファイル名のブランチ", async (t) => {
  const clone = await workspace(t);
  await git(clone, "branch", "-q", "gone", "origin/topic");
  const gone = workOf(await targetDiff(t, clone, ["gone"]));
  if (gone === null) return;
  await Deno.writeTextFile(`${gone}/exclusions.md`, "");
  await git(clone, "branch", "-q", "-D", "gone");
  await git(clone, "branch", "-q", "gone/exclusions.md", "origin/topic");
  const o = await targetDiff(t, clone, ["gone/exclusions.md"]);
  await expect(t, o, ["t1.txt", "t2.txt"], ["t1.txt", "t2.txt"]);
  if (o && o.work === gone) t.fail("作業ディレクトリを共有している");
});

fixture("path (削除されたファイル)", async (t) => {
  const clone = await workspace(t);
  await git(clone, "checkout", "-q", "-b", "del", "origin/main");
  await git(clone, "rm", "-qf", "a.txt");
  await git(clone, "commit", "-qm", "rm a.txt");
  await expect(t, await targetDiff(t, clone, ["del", "--", "a.txt"]), ["a.txt"], ["rm a.txt"]);
});

// ---- 例: clone の形 ----

const shapes: [string, string[], string[], string[], string[]][] = [
  ["--single-branch", ["--single-branch", "--branch", "stacked", origin], [], ["s1.txt"], ["s1.txt"]],
  ["shallow", ["--depth", "1", "--branch", "stacked", `file://${origin}`], [], ["s1.txt"], ["s1.txt"]],
  ["shallow で対象が既定ブランチの tip", ["--depth", "1", "--branch", "main", `file://${origin}`], ["main"], ["ff2.txt"], ["ff2.txt"]],
];
for (const [name, cloneArgs, args, files, commits] of shapes) {
  fixture(name, async (t) => {
    await git(t.dir, "clone", "-q", ...cloneArgs, `${t.dir}/clone`);
    await expect(t, await targetDiff(t, `${t.dir}/clone`, args), files, commits);
  });
}

fixture("shallow で今のブランチが別の remote を追う", async (t) => {
  const clone = `${t.dir}/clone`;
  await git(t.dir, "clone", "-q", "--depth", "1", "--branch", "stacked", `file://${origin}`, clone);
  await git(clone, "remote", "add", "upstream", `${t.dir}/no-such.git`);
  await git(clone, "config", "branch.stacked.remote", "upstream");
  await expect(t, await targetDiff(t, clone, []), ["s1.txt"], ["s1.txt"]);
});

// ---- 例: PR 番号 ----

/**
 * 自分の origin に、base を進めて head に取り込んだ PR 1 を作る:
 *   prbase: origin/main から b1
 *   prhead: origin/main から p1 → prbase をマージ (M2) → p2。refs/pull/1/head に push する
 */
async function prRepo(t: Ctx) {
  const o = await ownOrigin(t);
  const clone = await workspace(t, o);
  await git(clone, "checkout", "-q", "-b", "prhead", "origin/main");
  await commitFile(clone, "p1.txt");
  await git(clone, "checkout", "-q", "-b", "prbase", "origin/main");
  await commitFile(clone, "b1.txt");
  await git(clone, "push", "-q", "origin", "prbase");
  await git(clone, "checkout", "-q", "prhead");
  await git(clone, "merge", "-q", "-m", "M2", "prbase");
  await commitFile(clone, "p2.txt");
  await git(clone, "push", "-q", "origin", "prhead:refs/pull/1/head");
  const pr = { name: "prhead", head: await git(clone, "rev-parse", "prhead"), base: await git(clone, "rev-parse", "prbase"), baseRefName: "prbase", cross: false, owner: "o" };
  await git(clone, "checkout", "-q", "feature");
  return { clone, origin: o, pr };
}
const prFiles = ["p1.txt", "p2.txt"];
const prCommits = ["M2", "p1.txt", "p2.txt"];

fixture("base を取り込んだ PR", async (t) => {
  const { clone, origin: o, pr } = await prRepo(t);
  const env = await gh(t, "same", pr);
  const got = await expect(t, await targetDiff(t, clone, ["1"], { env }), prFiles, prCommits);
  if (got && !/^PR-BODY$/m.test(got.text)) t.fail("PR の説明が target.diff に無い");
  const args = await Deno.readTextFile(`${env.GH_CASE}/args`);
  if (!args.startsWith("pr view 1 ") || !args.includes(` -R ${o} `)) t.fail(`gh に PR 番号と origin (-R) を渡していない — ${args.trimEnd()}`);
  // PR をマージする。GitHub は baseRefOid をマージの時点で止めるので、応答は変えない
  await git(clone, "checkout", "-q", "prbase");
  await git(clone, "merge", "-q", "--no-ff", "-m", "M3", "prhead");
  await git(clone, "push", "-q", "origin", "prbase");
  await git(clone, "checkout", "-q", "feature");
  await expect(t, await targetDiff(t, clone, ["1"], { env }), prFiles, prCommits);
});

// fork からの PR (isCrossRepository) は head の owner を系列に加え、同じ head・base commit・同じブランチ名の同一リポジトリの PR と作業ディレクトリを分ける。
fixture("fork からの PR", async (t) => {
  const { clone, pr } = await prRepo(t);
  const sameRepo = workOf(await targetDiff(t, clone, ["1"], { env: await gh(t, "same", pr) }));
  const fork = await targetDiff(t, clone, ["1"], { env: await gh(t, "fork", { ...pr, cross: true, owner: "fork" }) });
  await expect(t, fork, prFiles, prCommits);
  if (fork && fork.work === sameRepo) t.fail("同じリポジトリの PR と作業ディレクトリを共有している");
  // owner:branch の区切りは : (ブランチ名に使えない。git-check-ref-format(1) の規則 4) なので、同じ owner/branch がそのままブランチ名として存在しても系列は別 (base の解決がブランチと PR で違うので diff の中身までは揃わない。見るのは work が分かれることだけ)
  await git(clone, "branch", "-q", "fork/prhead", "prhead");
  const branch = workOf(await targetDiff(t, clone, ["fork/prhead"]));
  if (fork && branch === fork.work) t.fail("owner/branch と同名のブランチと作業ディレクトリを共有している");
});

// isCrossRepository は true のまま、headRepositoryOwner が null で owner の列が空
fixture("fork を削除した PR", async (t) => {
  const { clone, pr } = await prRepo(t);
  await fails(t, clone, ["1"], { env: await gh(t, "gone", { ...pr, cross: true, owner: "" }), reason: "の head のリポジトリ (fork) が無い" });
});

// base ブランチが、clone の最初の fetch と gh の応答の間に進む競合。応答の baseRefOid は clone にまだ無いが、応答の後の明示的な fetch で取れて merge-base が引ける (gh の stub が呼ばれた時点で origin を進め、進めた後の commit を返す)
fixture("base が最初の fetch の後、gh の応答までに進んだ PR", async (t) => {
  const o = await ownOrigin(t);
  const clone = await workspace(t, o);
  await git(clone, "checkout", "-q", "-b", "prhead3", "origin/main");
  await commitFile(clone, "p3.txt");
  await git(clone, "push", "-q", "origin", "prhead3:refs/pull/2/head");
  await git(clone, "checkout", "-q", "-b", "prbase3", "origin/main");
  await commitFile(clone, "b3.txt");
  await git(clone, "push", "-q", "origin", "prbase3");
  const head = await git(clone, "rev-parse", "prhead3");
  await git(clone, "checkout", "-q", "feature");
  const advance = `${t.dir}/advance`;
  await git(t.dir, "clone", "-q", o, advance);
  await git(advance, "checkout", "-q", "prbase3");
  await commitFile(advance, "b3adv.txt");
  const base = await git(advance, "rev-parse", "HEAD");
  const env = await gh(t, "advance", { name: "prhead3", head, base, baseRefName: "prbase3", cross: false, owner: "o" }, `git -C '${advance}' push -q '${o}' prbase3:refs/heads/prbase3\n`);
  await expect(t, await targetDiff(t, clone, ["2"], { env }), ["p3.txt"], ["p3.txt"]);
});

// ---- 例: 止まる ----

// ルートの外に出る .. と空文字列は git が止める。その検査はモデルの生成器にある
fixture("絶対パスの path", async (t) => {
  const clone = await workspace(t);
  await fails(t, clone, ["--", `${clone}/a.txt`], { reason: "<path> はリポジトリのルートからの相対パス" });
  await fails(t, clone, ["topic", "--", `${clone}/t1.txt`], { reason: "<path> はリポジトリのルートからの相対パス" });
});

fixture("一致しない path", async (t) => {
  const clone = await workspace(t);
  await fails(t, clone, ["--", "no-such-dir"], { reason: "レビュー対象が空" });
  await fails(t, clone, ["topic", "--", "no-such-dir"], { reason: "レビュー対象が空" });
});

// 作業ツリーが正なので、staged した後に作業ツリーを戻した内容は対象外
fixture("staged だけの変更", async (t) => {
  const clone = await workspace(t);
  await git(clone, "checkout", "-q", "-b", "staged", "origin/main");
  await Deno.writeTextFile(`${clone}/b.txt`, "staged\n");
  await git(clone, "add", "b.txt");
  await Deno.writeTextFile(`${clone}/b.txt`, "b.txt\n");
  await fails(t, clone, ["--", "b.txt"], { reason: "レビュー対象が空" });
});

fixture("commit の無い入れ子のリポジトリ", async (t) => {
  const clone = await workspace(t);
  await git(clone, "init", "-q", "unborn-nested");
  await fails(t, clone, []);
});

fixture("打ち消し合うコミット", async (t) => {
  const clone = await workspace(t);
  await git(clone, "checkout", "-q", "-b", "cancel", "origin/main");
  await commitFile(clone, "z.txt");
  await git(clone, "rm", "-q", "z.txt");
  await git(clone, "commit", "-qm", "rm z.txt");
  await fails(t, clone, ["cancel"], { reason: "レビュー対象が空" });
});

// レビュー対象を空でなくし、空で止まるのと区別する
fixture("origin の HEAD が既定ブランチを指していない", async (t) => {
  const o = await ownOrigin(t);
  await git(o, "symbolic-ref", "HEAD", "refs/heads/gone");
  await git(t.dir, "clone", "-q", "-b", "main", o, `${t.dir}/badhead`);
  await Deno.writeTextFile(`${t.dir}/badhead/x.txt`, "x\n");
  // git の set-head --auto の文言 (canon: facts/git/repository-shapes の「remote とブランチ」。子は LC_ALL=C)
  await fails(t, `${t.dir}/badhead`, [], { reason: "Cannot determine remote HEAD" });
});

fixture("origin から消えたブランチは対象に解決しない", async (t) => {
  const o = await ownOrigin(t);
  const clone = await workspace(t, o);
  await git(o, "branch", "-q", "-D", "remote-only");
  await fails(t, clone, ["remote-only"]);
});

fixture("origin 無し", async (t) => {
  const repo = `${t.dir}/noorigin`;
  await git(t.dir, "init", "-q", "-b", "main", repo);
  await commitFile(repo, "a.txt");
  await fails(t, repo, []);
});

// ---- モデル: 履歴 ----

type Op =
  | { op: "commit"; b: number }
  | { op: "branch"; from: number }
  | { op: "merge"; from: number; ff: boolean }
  | { op: "update"; b: number };

interface Commit {
  id: string;
  parents: string[];
  file: string | null;
  /** file 1 つに収まらない commit (submodule の追加は gitlink とあわせて .gitmodules も足す) 用。無ければ file を使う。 */
  files?: string[];
}

class History {
  commits = new Map<string, Commit>();
  branches: string[] = ["main"];
  tips = new Map<string, string>([["main", ""]]);
  private n = 0;

  private add(parents: string[], withFile: boolean): string {
    this.n += 1;
    const id = `c${this.n}`;
    // 3 つに 1 つはサブディレクトリに置き、path をディレクトリで指定できるようにする
    const file = withFile ? (this.n % 3 === 0 ? `d/${id}.txt` : `${id}.txt`) : null;
    this.commits.set(id, { id, parents, file });
    return id;
  }

  ancestors(id: string): Set<string> {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(...this.commits.get(c)!.parents);
    }
    return seen;
  }

  isAncestor(a: string, b: string): boolean {
    return this.ancestors(b).has(a);
  }

  /** 共通の祖先のうち極大なもの。2 つ以上なら merge-base が 1 つに決まらない。 */
  mergeBases(a: string, b: string): string[] {
    const ca = [...this.ancestors(a)].filter((c) => this.isAncestor(c, b));
    return ca.filter((c) => !ca.some((d) => d !== c && this.isAncestor(c, d)));
  }

  firstParentChain(id: string): string[] {
    const chain: string[] = [];
    for (let c: string | undefined = id; c; c = this.commits.get(c)!.parents[0]) chain.push(c);
    return chain;
  }

  apply(o: Op) {
    const pick = (i: number) => this.branches[i % this.branches.length];
    const main = this.tips.get("main")!;
    switch (o.op) {
      case "commit": {
        const b = pick(o.b);
        this.tips.set(b, this.add(this.tips.get(b) ? [this.tips.get(b)!] : [], true));
        break;
      }
      case "branch": {
        // 空のブランチは対象として意味が無いので、1 コミット積んで作る
        const from = pick(o.from);
        const name = `b${this.branches.length}`;
        this.branches.push(name);
        this.tips.set(name, this.add([this.tips.get(from)!], true));
        break;
      }
      case "merge": {
        const from = pick(o.from);
        const tip = this.tips.get(from)!;
        if (from === "main" || this.isAncestor(tip, main)) break;
        if (o.ff && this.isAncestor(main, tip)) this.tips.set("main", tip);
        else this.tips.set("main", this.add([main, tip], false));
        break;
      }
      case "update": {
        const b = pick(o.b);
        const tip = this.tips.get(b)!;
        if (b === "main" || this.isAncestor(main, tip)) break;
        this.tips.set(b, this.add([tip, main], false));
        break;
      }
    }
  }

  filesOf(ids: Iterable<string>): string[] {
    return [...ids].map((c) => this.commits.get(c)!.file).filter((f): f is string => f !== null);
  }
}

// ---- モデル: 生成器 ----

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ op: fc.constant("commit" as const), b: fc.nat(5) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("branch" as const), from: fc.nat(5) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("merge" as const), from: fc.nat(5), ff: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("update" as const), b: fc.nat(5) }) },
);

const UNTRACKED = ["u.txt", "--stat", "sub2/x.txt", "linkdir", "nested", ".gitignore"] as const;
type Untracked = typeof UNTRACKED[number];

/** 止まる形は少なめに生成する (多いと通る形の組み合わせが減る) */
const rarely = fc.oneof({ weight: 4, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) });

const targetArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("checkout" as const), detached: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("branch" as const), b: fc.nat(5), local: fc.boolean(), deleted: rarely }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("commit" as const), c: fc.nat(30) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("pr" as const), head: fc.nat(5), base: fc.nat(5) }) },
);

const caseArb = fc.record({
  ops: fc.array(opArb, { minLength: 1, maxLength: 14 }),
  checkout: fc.nat(5),
  localCommits: fc.nat(2),
  modify: fc.option(fc.nat(30), { nil: null }),
  untracked: fc.subarray([...UNTRACKED]),
  unbornNested: rarely,
  dirtySubmodule: rarely,
  target: targetArb,
  paths: fc.array(fc.nat(40), { maxLength: 3 }),
  clone: fc.constantFrom("full", "single-branch", "shallow"),
  hooks: fc.boolean(),
  config: fc.boolean(),
  externalViaConfig: fc.boolean(),
  where: fc.constantFrom("root", "subdir", "worktree"),
  concurrent: fc.boolean(),
  mutation: fc.constantFrom("untracked", "edit", "chmod", "rule", "rename-rule"),
});
type Case = typeof caseArb extends fc.Arbitrary<infer T> ? T : never;

// ---- モデル: 実行 ----

/** モデルの履歴を src に作り、subject → sha の対応を返す。 */
async function realize(tips: Map<string, string>, ops: Op[], src: string): Promise<Map<string, string>> {
  await git(src, "init", "-q", "-b", "main");
  const replay = new History();
  const pick = (r: History, i: number) => r.branches[i % r.branches.length];
  for (const o of ops) {
    const main = replay.tips.get("main")!;
    switch (o.op) {
      case "commit": {
        const b = pick(replay, o.b);
        replay.apply(o);
        // 最初のコミットの前は unborn なので checkout しない
        if (replay.commits.size > 1) await git(src, "checkout", "-q", b);
        await commitFile(src, replay.commits.get(replay.tips.get(b)!)!.file!, replay.tips.get(b)!);
        break;
      }
      case "branch": {
        const from = pick(replay, o.from);
        replay.apply(o);
        const name = replay.branches.at(-1)!;
        await git(src, "checkout", "-q", "-b", name, from);
        await commitFile(src, replay.commits.get(replay.tips.get(name)!)!.file!, replay.tips.get(name)!);
        break;
      }
      case "merge": {
        const from = pick(replay, o.from);
        const tip = replay.tips.get(from)!;
        replay.apply(o);
        if (replay.tips.get("main") === main) break;
        await git(src, "checkout", "-q", "main");
        if (replay.tips.get("main") === tip) await git(src, "merge", "-q", "--ff-only", from);
        else await git(src, "merge", "-q", "--no-ff", "-m", replay.tips.get("main")!, from);
        break;
      }
      case "update": {
        const b = pick(replay, o.b);
        const tip = replay.tips.get(b)!;
        replay.apply(o);
        if (replay.tips.get(b) === tip) break;
        await git(src, "checkout", "-q", b);
        await git(src, "merge", "-q", "--no-ff", "-m", replay.tips.get(b)!, "main");
        break;
      }
    }
  }
  if (JSON.stringify([...replay.tips]) !== JSON.stringify([...tips])) throw new Error("replay がモデルと食い違う");
  const shas = new Map<string, string>();
  for (const line of (await git(src, "log", "--all", "--format=%H %s")).split("\n")) {
    const [sha, subject] = line.split(" ");
    shas.set(subject, sha);
  }
  return shas;
}

interface Expected {
  commits: Set<string>;
  files: Set<string>;
  head: string | null; // repo= が指すべき commit (対象無しなら null)
}

async function runCase(c: Case, root: string): Promise<void> {
  const h = new History();
  const ops: Op[] = [{ op: "commit", b: 0 }, ...c.ops];
  for (const o of ops) h.apply(o);
  const pickBranch = (i: number) => h.branches[i % h.branches.length];
  const mainTip = h.tips.get("main")!;
  const allCommits = [...h.commits.keys()];
  const allFiles = h.filesOf(allCommits);

  // ---- モデルで期待値を決める ----
  const co = pickBranch(c.checkout);
  const localIds = Array.from({ length: c.localCommits }, (_, i) => `l${i + 1}`);
  // 対象外の宣言 (submodule の中身は見ない) は作業ツリーの変更の話なので、対象無しの checkout でだけ意味を持つ
  const useSubmodule = c.dirtySubmodule && c.target.kind === "checkout";
  let coTip = localIds.at(-1) ?? h.tips.get(co)!;
  const originTips = new Map(h.tips);
  let prev = h.tips.get(co)!;
  for (const id of localIds) {
    h.commits.set(id, { id, parents: [prev], file: `${id}.txt` });
    prev = id;
  }
  if (useSubmodule) {
    h.commits.set("lsm", { id: "lsm", parents: [prev], file: null, files: [".gitmodules", "sm"] });
    coTip = "lsm";
  }
  h.tips.set(co, coTip);

  let rev: string | null = null; // 対象の commit (対象無しなら null)
  let base: string | null; // 分岐点 (null は空ツリー)
  let stop = false;
  const t = c.target;
  const mbOf = (a: string, b: string) => {
    const bases = h.mergeBases(a, b);
    fc.pre(bases.length === 1);
    return bases[0];
  };
  const baseOfRev = (r: string) => {
    if (!h.isAncestor(r, mainTip)) return mbOf(r, mainTip);
    return h.firstParentChain(mainTip).find((b) => b !== r && h.isAncestor(b, r)) ?? null;
  };
  let targetArg: string | undefined;
  let prStub: { name: string; head: string; base: string; baseRefName: string } | undefined;
  let deletedBranch: string | undefined;
  let localBranch: string | undefined;
  switch (t.kind) {
    case "checkout":
      base = mbOf(coTip, mainTip);
      break;
    case "branch": {
      const b = pickBranch(t.b);
      targetArg = b;
      rev = h.tips.get(b)!;
      // --single-branch と shallow の clone には、チェックアウト以外の remote-tracking ref が無いので手元のブランチを作れない
      const local = t.local && (c.clone === "full" || b === co);
      if (b !== co && b !== "main" && t.deleted) {
        deletedBranch = b;
        if (!local) stop = true;
      }
      if (local && b !== co) localBranch = b;
      base = baseOfRev(rev);
      break;
    }
    case "commit":
      rev = allCommits[t.c % allCommits.length];
      base = baseOfRev(rev);
      break;
    case "pr": {
      // head は main 以外 (あれば)、base は多くは main
      const head = h.branches.length > 1 ? h.branches[1 + t.head % (h.branches.length - 1)] : "main";
      const prBase = t.base % 3 === 0 ? pickBranch(t.base) : "main";
      fc.pre(head !== prBase);
      // origin には手元だけのコミットは無い
      rev = originTips.get(head)!;
      const baseTip = originTips.get(prBase)!;
      targetArg = "1";
      prStub = { name: head, head: rev, base: baseTip, baseRefName: prBase };
      base = mbOf(baseTip, rev);
      break;
    }
  }
  const tip = rev ?? coTip;
  const set = new Set([...h.ancestors(tip)].filter((x) => base === null || !h.ancestors(base).has(x)));

  const paths = c.paths.map((i) => (i === 0 ? "." : i === 1 ? "d" : i === 2 ? "nope.txt" : i === 3 ? `${root}/clone/a.txt` : i === 4 ? "../src/a.txt" : i === 5 ? "" : allFiles[(i - 6) % allFiles.length]));
  // 絶対パスは target-diff.sh が、ルートの外に出る .. と空文字列は git が止める
  if (c.paths.some((i) => i === 3 || i === 4 || i === 5)) stop = true;
  const matches = (f: string) => paths.length === 0 || paths.some((p) => p === "." || f === p || f.startsWith(`${p}/`));
  const expected: Expected = { commits: new Set(), files: new Set(), head: rev };
  // path を付けた git log は、その path の内容がどの親とも違う commit だけを出す (merge commit は両側がその path のファイルを持ち込むときだけ)
  const filtered = (id: string) => new Set(h.filesOf(h.ancestors(id)).filter(matches));
  const shown = (id: string) => {
    const { file, files, parents } = h.commits.get(id)!;
    const added = files ?? (file !== null ? [file] : []);
    if (added.length > 0) return added.some(matches);
    if (paths.length === 0) return true;
    const mine = filtered(id);
    return parents.every((p) => [...mine].some((f) => !filtered(p).has(f)));
  };
  for (const id of set) {
    const { file, files } = h.commits.get(id)!;
    const added = files ?? (file !== null ? [file] : []);
    if (shown(id)) expected.commits.add(id);
    for (const f of added) if (matches(f)) expected.files.add(f);
  }
  const worktreeFiles: string[] = [];
  const tipFiles = h.filesOf(h.ancestors(coTip));
  const modified = c.modify === null ? null : tipFiles[c.modify % tipFiles.length];
  if (t.kind === "checkout") {
    if (modified !== null) worktreeFiles.push(modified);
    worktreeFiles.push(...c.untracked);
    if (c.unbornNested) stop = true;
  }
  for (const f of worktreeFiles) if (matches(f)) expected.files.add(f);
  // 止まるかどうかは patch (ファイル集合) で決まる。merge commit だけの範囲は log に出るが patch が空
  if (expected.files.size === 0) stop = true;

  // ---- リポジトリを作る ----
  const src = `${root}/src`, origin = `${root}/origin.git`, clone = `${root}/clone`, tmp = `${root}/tmp`;
  await Deno.mkdir(src);
  await Deno.mkdir(tmp);
  const shas = await realize(originTips, ops, src);
  await git(root, "clone", "-q", "--bare", src, origin);
  // bare clone の HEAD は src の最後の checkout を写すので、既定ブランチを main に固定する
  await git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  if (prStub) await git(src, "push", "-q", origin, `${shas.get(prStub.head)}:refs/pull/1/head`);
  const cloneArgs = c.clone === "full" ? [] : c.clone === "single-branch" ? ["--single-branch", "--branch", co] : ["--depth", "1", "--branch", co];
  await git(root, "clone", "-q", ...cloneArgs, `file://${origin}`, clone);
  await git(clone, "checkout", "-q", co);
  for (const id of localIds) {
    await commitFile(clone, `${id}.txt`, id);
    shas.set(id, await git(clone, "rev-parse", "HEAD"));
  }
  if (useSubmodule) {
    const subRepo = `${root}/sub.git`;
    await Deno.mkdir(subRepo);
    await git(subRepo, "init", "-q", "-b", "main");
    await Deno.writeTextFile(`${subRepo}/f.txt`, "f\n");
    await git(subRepo, "add", "-A");
    await git(subRepo, "commit", "-q", "-m", "f");
    await git(clone, "-c", "protocol.file.allow=always", "submodule", "add", subRepo, "sm");
    await git(clone, "commit", "-q", "-m", "lsm");
    shas.set("lsm", await git(clone, "rev-parse", "HEAD"));
    await Deno.writeTextFile(`${clone}/sm/dirty.txt`, "d\n");
  }
  if (t.kind === "commit") targetArg = shas.get(rev!);
  // co 以外の手元のブランチ (main を含む) は、この生成器では常に origin/<b> から作るだけで先へ進めないので、-f で作り直しても同じ commit になる
  if (localBranch) await git(clone, "branch", "-q", "-f", localBranch, `origin/${localBranch}`);
  if (deletedBranch) await git(origin, "branch", "-q", "-D", deletedBranch);
  if (t.kind === "checkout" && t.detached) await git(clone, "checkout", "-q", "--detach");
  let wt = clone; // 作業ツリーの変更を置き、スクリプトを回すリポジトリ
  if (c.where === "worktree") {
    wt = `${root}/lw`;
    await git(clone, "worktree", "add", "-q", "--detach", wt, "HEAD");
  }
  if (t.kind === "checkout") {
    if (modified !== null) await Deno.writeTextFile(`${wt}/${modified}`, "changed\n", { append: true });
    for (const u of c.untracked) await makeUntracked(wt, u);
    if (c.untracked.includes(".gitignore")) await Deno.writeTextFile(`${wt}/ignored.txt`, "i\n");
    if (c.unbornNested) await git(wt, "init", "-q", `${wt}/unborn`);
  }
  if (c.hooks) {
    await Deno.mkdir(`${root}/hooks`);
    for (const [name, file] of [["post-checkout", "hook.txt"], ["fsmonitor", "fsmonitor.txt"]]) {
      await Deno.writeTextFile(`${root}/hooks/${name}`, `#!/bin/sh\necho x > ${file}\n`, { mode: 0o755 });
    }
    await git(clone, "config", "core.hooksPath", `${root}/hooks`);
    await git(clone, "config", "core.fsmonitor", `${root}/hooks/fsmonitor`);
  }
  const env: Record<string, string> = { TMPDIR: tmp };
  if (c.config) {
    // .gitattributes だと未追跡として diff に混ざるので、info/attributes (worktree 間で共有) に書く
    const attrs = local(await git(wt, "rev-parse", "--path-format=absolute", "--git-path", "info/attributes"));
    await Deno.writeTextFile(attrs, "*.txt diff=x\n");
    Object.assign(env, {
      GIT_CONFIG_COUNT: c.externalViaConfig ? "4" : "3",
      GIT_CONFIG_KEY_0: "diff.noprefix",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_KEY_1: "color.diff",
      GIT_CONFIG_VALUE_1: "always",
      GIT_CONFIG_KEY_2: "diff.x.textconv",
      GIT_CONFIG_VALUE_2: "echo textconv-output #",
      ...(c.externalViaConfig ? { GIT_CONFIG_KEY_3: "diff.external", GIT_CONFIG_VALUE_3: "true" } : { GIT_EXTERNAL_DIFF: "true" }),
    });
  }
  if (prStub) {
    await Deno.mkdir(`${root}/gh`);
    await Deno.writeTextFile(`${root}/gh/pre.sh`, "");
    await Deno.writeTextFile(`${root}/gh/out`, `${prStub.name}\t${shas.get(prStub.head)}\t${shas.get(prStub.base)}\t${prStub.baseRefName}\tfalse\to\npull request: T\n\nBODY\n`);
    Object.assign(env, { PATH: ghPath, GH_CASE: `${root}/gh` });
  }
  let cwd = wt;
  if (c.where === "subdir") {
    cwd = `${wt}/emptydir`;
    await Deno.mkdir(cwd);
  }
  const args = [...(targetArg ? [targetArg] : []), ...(paths.length ? ["--", ...paths] : [])];

  // ---- 回して照合する ----
  const invoke = () => exec("bash", [script, ...args], { cwd, env });
  const worktrees = async () => (await git(clone, "worktree", "list")).split("\n").length;
  const [n0, w0] = [await entries(tmp), await worktrees()];
  if (stop) {
    const r = await invoke();
    if (r.code === 0) throw new Error(`止まるべきだが通った: ${r.out}`);
    if (await entries(tmp) !== n0) throw new Error(`止まったのに run が残る: ${r.err}`);
    if (await worktrees() !== w0) throw new Error(`止まったのに worktree が残る: ${r.err}`);
    return;
  }
  const results = c.concurrent ? await Promise.all([invoke(), invoke()]) : [await invoke()];
  const outputs: Output[] = [];
  for (let r of results) {
    // fetch の衝突は、やり直せば通る (target-diff.sh の先頭の「止まる」。canon: facts/git/repository-shapes の並行実行)
    if (r.code !== 0 && /cannot lock ref|\.lock': File exists|shallow file has changed/.test(r.err)) r = await invoke();
    outputs.push(await checkOutput(r, cwd, args, tmp));
  }
  if (outputs.length === 2 && outputs[0].run === outputs[1].run) throw new Error("並行実行が run を共有している");
  const common = local(await git(clone, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  for (const o of outputs) {
    const got = await readDiff(o.diff);
    if (!same(got.commits, expected.commits)) throw new Error(`コミットが違う: 期待 ${show(expected.commits)} 実際 ${show(got.commits)}`);
    if (!same(got.files, expected.files)) throw new Error(`ファイルが違う: 期待 ${show(expected.files)} 実際 ${show(got.files)}`);
    if (!o.work.startsWith(`${common}/review-perspectives/`)) throw new Error(`work が本体の .git の下でない: ${o.work}`);
    if (expected.head !== null) {
      const at = await git(o.repo, "rev-parse", "HEAD");
      if (at !== shas.get(expected.head)) throw new Error(`repo が対象を指していない: ${expected.head} != ${at}`);
    }
  }
  if (t.kind === "checkout" && !c.concurrent) await checkIdentity(c, wt, outputs[0], invoke, cwd, args, tmp);
  for (const o of outputs) {
    if (expected.head !== null) await git(clone, "worktree", "remove", "--force", o.repo);
    await Deno.remove(o.run, { recursive: true });
  }
  if (t.kind === "checkout" && (await git(wt, "diff", "--cached", "--name-only")) !== "") throw new Error("本来の index が変わった");
}

async function makeUntracked(wt: string, u: Untracked) {
  switch (u) {
    case "u.txt":
    case "--stat":
      await Deno.writeTextFile(`${wt}/${u}`, "x\n");
      break;
    case "sub2/x.txt":
      await Deno.mkdir(`${wt}/sub2`);
      await Deno.writeTextFile(`${wt}/sub2/x.txt`, "x\n");
      break;
    case "linkdir":
      await symlink("sub2", `${wt}/linkdir`);
      break;
    case "nested":
      await git(wt, "init", "-q", `${wt}/nested`);
      await git(`${wt}/nested`, "commit", "-q", "--allow-empty", "-m", "n");
      break;
    case ".gitignore":
      await Deno.writeTextFile(`${wt}/.gitignore`, "ignored.txt\n");
      break;
  }
}

/** tree= は作業ツリーの 1 次元の変更で変わり rules= は変わらないこと。rules= は規則の内容と名前で変わること。 */
async function checkIdentity(c: Case, wt: string, before: Output, invoke: () => Promise<Run>, cwd: string, args: string[], tmpdir: string) {
  const rerun = async () => {
    const o = await checkOutput(await invoke(), cwd, args, tmpdir);
    await Deno.remove(o.run, { recursive: true });
    return o;
  };
  const tracked = (await git(wt, "ls-files")).split("\n").find((f) => f.endsWith(".txt"))!;
  switch (c.mutation) {
    case "untracked":
      await Deno.writeTextFile(`${wt}/mutation.txt`, "m\n");
      break;
    case "edit":
      await Deno.writeTextFile(`${wt}/${tracked}`, "m\n", { append: true });
      break;
    case "chmod":
      await Deno.chmod(`${wt}/${tracked}`, 0o755);
      break;
    case "rule":
    case "rename-rule":
      await Deno.mkdir(`${wt}/review-perspectives`);
      await Deno.writeTextFile(`${wt}/review-perspectives/x.md`, "s\n");
      break;
  }
  if (c.mutation === "rename-rule") {
    // 内容を変えずに名前だけ変える。比較の基準は名前を変える前
    before = await rerun();
    await Deno.rename(`${wt}/review-perspectives/x.md`, `${wt}/review-perspectives/y.md`);
  }
  const after = await rerun();
  if (c.mutation === "rule" || c.mutation === "rename-rule") {
    if (after.rules === before.rules) throw new Error(`${c.mutation} で rules が変わらない`);
  } else {
    if (after.tree === before.tree) throw new Error(`${c.mutation} で tree が変わらない`);
    if (after.rules !== before.rules) throw new Error(`${c.mutation} で rules が変わる`);
  }
}

// ---- 入口 ----

const modelFailures: string[] = [];
reports.push(modelFailures);
pending.push((async () => {
  await Deno.mkdir(`${tmp}/pbt`);
  await fc.assert(
    fc.asyncProperty(caseArb, async (c) => {
      const root = await Deno.makeTempDir({ dir: `${tmp}/pbt` });
      try {
        await runCase(c, root);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }),
    { numRuns, ...(seedEnv ? { seed: Number(seedEnv) } : {}), verbose: fc.VerbosityLevel.Verbose },
  );
})().catch((e) => modelFailures.push(`モデル: ${e instanceof Error ? e.message : e}`)));

await Promise.all(pending);
const all = reports.flat();
if (all.length) console.error(all.join("\n"));
Deno.exit(all.length ? 1 : 0);
