/**
 * test-cleanup-branch.ts — skills/setup-repo/pr-workflow/cleanup-branch.sh を検査する。verify.sh から呼ぶ。
 *
 * 検査すること:
 * - ブランチの checkout 先ごとに、消えて、checkout していた worktree が同じ commit で detach される。他のブランチの ref と、他のブランチを checkout している worktree は変えない
 *   - main worktree (既定ブランチは linked worktree で checkout 中)・生きた linked worktree・ディレクトリが消えた linked worktree の登録・どこにも checkout されていない
 * - 先端が expected と違う・ブランチが無い・expected が 40 桁の 16 進数でない・引数の数が違う場合は、理由を示して断り、ブランチも worktree (detach・prune) も変えない
 * - ディレクトリが消えた locked な登録が checkout していれば、落ちてブランチを変えない
 * ネットワークは使わない (ローカルのリポジトリだけ)。
 *
 * このスクリプトの入力と環境の定義域:
 * - 引数は取らない。渡されれば理由を出して落ちる。
 * - 読む環境変数は PATH・TMPDIR だけ。
 * - TMPDIR (未設定か空なら /tmp) は絶対パスで、作った一時ディレクトリの解決済みのパスが A-Z a-z 0-9 . _ / - だけであること。外れていれば理由を出して落ちる。
 * - 後始末は、終わったときに一時ディレクトリを消す。SIGINT・SIGTERM では子に SIGTERM を送り、子が終わってから消す (子が書いている最中に消すと消し残す)。
 *
 * 並行の検査が共有する、変わりうる状態。これ以外は検査ごとの `${tmp}/f/<n>` の下に置き、新しく共有するものを足すときも検査ごとのパスにする:
 * - HOME (`${tmp}/home`) と TMPDIR (`${tmp}`)。
 *
 * 子の環境は PATH と下の baseEnv だけ (clearEnv。canon: facts/deno/command-spawn)。hook や rebase --exec から呼ばれても、呼び出し元の GIT_DIR などを子に渡さない。
 */

const here = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");
const self = "test-cleanup-branch.ts";
const script = `${here}/skills/setup-repo/pr-workflow/cleanup-branch.sh`;
const dec = new TextDecoder();

if (Deno.args.length) {
  console.error(`${self}: 引数は取らない (${Deno.args.join(" ")})`);
  Deno.exit(1);
}

const tmpdirEnv = Deno.env.get("TMPDIR") ?? "";
if (tmpdirEnv && !tmpdirEnv.startsWith("/")) {
  console.error(`${self}: TMPDIR (${tmpdirEnv}) が絶対パスでない`);
  Deno.exit(1);
}
const tmp = await Deno.makeTempDir({ dir: tmpdirEnv || "/tmp", prefix: "cleanup-branch-test." });
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
// 文字の定義域は resolved で見る: git は worktree のパスを解決して記録し、cleanup-branch.sh は `git worktree list` のパスを `git -C` に渡す (canon: facts/git/worktree-add-records-resolved-path)。
// deno が許可の照合でパスを解決するようになれば、tmp を解決したパス 1 本にできる。パスの文字 (空白・改行など) による違いは検査していないので、検査した形のパスでだけ回す。
const resolved = await Deno.realPath(tmp);
if (!/^\/[A-Za-z0-9._\/-]*$/.test(resolved)) {
  console.error(`${self}: TMPDIR (${tmpdirEnv}) の下に作った一時ディレクトリ ${resolved} が A-Z a-z 0-9 . _ / - だけの形でない。TMPDIR を直す`);
  Deno.exit(1);
}

const baseEnv: Record<string, string> = {
  PATH: Deno.env.get("PATH") ?? "",
  HOME: `${tmp}/home`,
  TMPDIR: tmp,
  // 失敗の理由に出す子の文言を locale に依らせない。clearEnv で locale の環境変数が無くても、macOS では GNU gettext を使う bash などがシステムの言語で訳す (canon: facts/shell/gettext-macos-system-language)
  LC_ALL: "C",
  GIT_CONFIG_GLOBAL: `${here}/scripts/test-gitconfig`,
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
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

async function exec(cmd: string, args: string[], o: { cwd?: string } = {}): Promise<Run> {
  while (active >= limit) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    if (interrupted) throw new Error("中断した");
    const child = new Deno.Command(cmd, {
      args,
      cwd: o.cwd,
      env: baseEnv,
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

/** 準備と観測の git。落ちれば例外 (その検査を落とす)。 */
async function git(dir: string, args: string[]): Promise<string> {
  const r = await exec("git", ["-C", dir, ...args]);
  if (r.code !== 0) throw new Error(`git -C ${dir} ${args.join(" ")}: exit ${r.code} — ${r.err}`);
  return r.out.replace(/\n+$/, "");
}

/** repo を cwd にして cleanup-branch.sh を回す。$0 を見ないので絶対パスで起動してよい。 */
const cleanupBranch = (repo: string, args: string[]) => exec(script, args, { cwd: repo });

// ---- 検査の単位 ----

interface Ctx {
  dir: string;
  fail(msg: string): void;
}
const reports: string[][] = [];
const pending: Promise<unknown>[] = [];

/** 検査を始める。独立に並行で回り、落ちた理由を登録の順で最後に出す。 */
function fixture(name: string, body: (t: Ctx) => Promise<void>) {
  const failures: string[] = [];
  reports.push(failures);
  const dir = `${tmp}/f/${reports.length - 1}`;
  pending.push((async () => {
    await Deno.mkdir(dir, { recursive: true });
    await body({ dir, fail: (m) => failures.push(`${name}: ${m}`) });
  })().catch((e) => failures.push(`${name}: 例外 — ${e instanceof Error ? e.stack : e}`)));
}

// ---- 準備 ----

/** dir/repo に、main に 1 commit、main から分けた work に 1 commit 足したリポを作る。main を checkout した状態で返す。 */
async function newRepo(dir: string) {
  const repo = `${dir}/repo`;
  await git(dir, ["init", "-q", "-b", "main", repo]);
  await git(repo, ["commit", "-q", "--allow-empty", "-m", "base"]);
  await git(repo, ["switch", "-q", "-c", "work"]);
  await git(repo, ["commit", "-q", "--allow-empty", "-m", "work"]);
  await git(repo, ["switch", "-q", "main"]);
  return repo;
}
const tip = (repo: string, branch: string) => git(repo, ["rev-parse", `refs/heads/${branch}`]);
/** ブランチの一覧 (名前と先端)。except を渡せばそのブランチを除く。 */
const heads = async (repo: string, except?: string) => {
  const lines = (await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])).split("\n");
  return lines.filter((l) => except === undefined || !l.startsWith(`refs/heads/${except} `)).join("\n");
};
const hasBranch = async (repo: string, branch: string) => (await exec("git", ["-C", repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0;
const worktreeList = (repo: string) => git(repo, ["worktree", "list", "--porcelain"]);
/** worktree が checkout しているブランチ (detach なら空)。 */
const current = (wt: string) => git(wt, ["branch", "--show-current"]);

// ---- 消える場合 ----

// branch (既定は work) を checkout している worktree (wt。無ければ undefined) は、同じ commit のまま detach され、branch は消える。他のブランチは変わらない
async function expectDeleted(t: Ctx, repo: string, wt?: string, branch = "work") {
  const sha = await tip(repo, branch);
  const others = await heads(repo, branch);
  const r = await cleanupBranch(repo, [branch, sha]);
  if (r.code !== 0) t.fail(`消せなかった (exit ${r.code}) — ${r.err.trimEnd()}`);
  if (await hasBranch(repo, branch)) t.fail("ブランチが残った");
  const after = await heads(repo, branch);
  if (after !== others) t.fail(`他のブランチが変わった — ${after}`);
  if (wt === undefined) return;
  if (await git(wt, ["rev-parse", "HEAD"]) !== sha) t.fail(`${wt} の HEAD が元の commit でない`);
  const b = await current(wt);
  if (b) t.fail(`${wt} が detach されていない (${b})`);
}

fixture("main worktree が checkout (既定ブランチは linked worktree が checkout 中)", async (t) => {
  const repo = await newRepo(t.dir);
  await git(repo, ["switch", "-q", "work"]);
  await git(repo, ["worktree", "add", "-q", `${t.dir}/main-wt`, "main"]);
  await expectDeleted(t, repo, repo);
});

fixture("linked worktree が checkout", async (t) => {
  const repo = await newRepo(t.dir);
  await git(repo, ["worktree", "add", "-q", `${t.dir}/wt`, "work"]);
  await expectDeleted(t, repo, `${t.dir}/wt`);
});

fixture("ディレクトリが消えた登録が checkout", async (t) => {
  const repo = await newRepo(t.dir);
  await git(repo, ["worktree", "add", "-q", `${t.dir}/wt`, "work"]);
  await Deno.remove(`${t.dir}/wt`, { recursive: true });
  await expectDeleted(t, repo);
});

// 名前に / を含むブランチ
fixture("linked worktree が checkout (名前に / を含む)", async (t) => {
  const repo = await newRepo(t.dir);
  await git(repo, ["branch", "feature/work", "work"]);
  await git(repo, ["worktree", "add", "-q", `${t.dir}/wt`, "feature/work"]);
  await expectDeleted(t, repo, `${t.dir}/wt`, "feature/work");
});

fixture("checkout 無し", async (t) => {
  const repo = await newRepo(t.dir);
  await expectDeleted(t, repo);
});

// 名前が work で始まる別のブランチを checkout している worktree は detach しない
fixture("他のブランチの worktree", async (t) => {
  const repo = await newRepo(t.dir);
  await git(repo, ["worktree", "add", "-q", `${t.dir}/wt`, "work"]);
  await git(repo, ["worktree", "add", "-q", "-b", "work-x", `${t.dir}/wt-x`, "work"]);
  await expectDeleted(t, repo, `${t.dir}/wt`);
  const b = await current(`${t.dir}/wt-x`);
  if (b !== "work-x") t.fail(`work-x を checkout している worktree が変わった (${b || "detach"})`);
});

// locked な登録は prune されず、detach するディレクトリも無いので落ちる (cleanup-branch.sh の先頭)。断る理由 (usage・先端の不一致・ブランチが無い) でなく、その登録のディレクトリへ移れないことで落ち、登録は変わらない
// canon: facts/git/worktree-lock-survives-prune — git -C は消えたディレクトリへ移れず「cannot change to」で exit 128 になる (LC_ALL=C の文言)
fixture("ディレクトリが消えた locked な登録が checkout", async (t) => {
  const repo = await newRepo(t.dir);
  await git(repo, ["worktree", "add", "-q", "--lock", `${t.dir}/wt`, "work"]);
  const wt = await Deno.realPath(`${t.dir}/wt`);
  await Deno.remove(`${t.dir}/wt`, { recursive: true });
  const [refs, list] = [await heads(repo), await worktreeList(repo)];
  if (!list.includes(`worktree ${wt}\n`) || !/^locked/m.test(list)) t.fail(`locked な登録が無い — ${list}`);
  const r = await cleanupBranch(repo, ["work", await tip(repo, "work")]);
  if (r.code === 0) t.fail("落ちなかった");
  for (const refusal of ["usage:", "PR の head", "が無い", "40 桁"]) {
    if (r.err.includes(refusal)) t.fail(`断る理由 (${refusal}) で落ちた — ${r.err.trimEnd()}`);
  }
  if (!r.err.includes(`cannot change to '${wt}'`)) t.fail(`locked な登録のディレクトリへ移れずに落ちたのでない — ${r.err.trimEnd()}`);
  if (await heads(repo) !== refs) t.fail(`ブランチが変わった — ${await heads(repo)}`);
  if (await worktreeList(repo) !== list) t.fail(`worktree の登録が変わった — ${await worktreeList(repo)}`);
});

// ---- 断る場合 ----

// work は生きた linked worktree (wt) が checkout し、ディレクトリが消えた登録 (gone、ブランチ other) もあるリポで断らせ、ブランチも worktree も変えないことを見る
const refusals: [string, (good: string, main: string) => string[], string][] = [
  ["先端が違う", (_, main) => ["work", main], "PR の head"],
  ["ブランチが無い", (good) => ["nothing", good], "refs/heads/nothing が無い"],
  ["短縮形の sha", (good) => ["work", good.slice(0, 7)], "40 桁の 16 進数でない"],
  ["大文字の sha", (good) => ["work", good.toUpperCase()], "40 桁の 16 進数でない"],
  ["ref 名", () => ["work", "work"], "40 桁の 16 進数でない"],
  ["sha が空", () => ["work", ""], "40 桁の 16 進数でない"],
  ["引数が 0 個", () => [], "usage:"],
  ["引数が 1 つ", () => ["work"], "usage:"],
  ["引数が 3 個", (good) => ["work", good, "extra"], "usage:"],
];
for (const [name, args, reason] of refusals) {
  fixture(`断る: ${name}`, async (t) => {
    const repo = await newRepo(t.dir);
    await git(repo, ["worktree", "add", "-q", `${t.dir}/wt`, "work"]);
    await git(repo, ["worktree", "add", "-q", "-b", "other", `${t.dir}/gone`, "main"]);
    await Deno.remove(`${t.dir}/gone`, { recursive: true });
    const [refs, list] = [await heads(repo), await worktreeList(repo)];
    const r = await cleanupBranch(repo, args(await tip(repo, "work"), await tip(repo, "main")));
    if (r.code === 0) t.fail("断らなかった");
    if (!r.err.includes(reason)) t.fail(`理由 (${reason}) を示さない — ${r.err.trimEnd()}`);
    if (await heads(repo) !== refs) t.fail(`断ったのにブランチが変わった — ${await heads(repo)}`);
    if (await worktreeList(repo) !== list) t.fail(`断ったのに worktree の登録が変わった — ${await worktreeList(repo)}`);
    const b = await current(`${t.dir}/wt`);
    if (b !== "work") t.fail(`断ったのに work を checkout している worktree が変わった (${b || "detach"})`);
  });
}

await Promise.all(pending);
const all = reports.flat();
if (all.length) console.error(all.join("\n"));
Deno.exit(all.length ? 1 : 0);
