/**
 * test-pre-push.ts — hooks/pre-push と verify.sh (hook の写しの部分) を検査する。verify.sh から呼ぶ。
 *
 * 検査すること:
 * - push のコマンドの PUSH_OK=1 の有無で、push を通す・止める
 * - PUSH_OK=1 の push は、hooks/pre-push.local があればそれに同じ引数と stdin で替わる。実行可能な通常のファイルでなければ (実行可能でない・ディレクトリ・壊れた symlink) 止まる
 * - 作業ツリーが無い (bare) リポジトリと .git の中からの push は止まる (git 自身のエラーも見える)
 * - main worktree と linked worktree、そのサブディレクトリからの push は、その作業ツリーのルートの pre-push.local を呼ぶ
 * - verify.sh は hooks/pre-push を common git dir の hooks へ写す (検査に落ちるリポでも、linked worktree で回しても)
 * - verify.sh を回すリポに scripts/ は無く、shellcheck の版が違っても verify.sh はこの test を呼び返さない
 * - 写す先の pre-push の状態ごとに、写す・何もしない・触らずに落とすのどれかになる
 *   - 無い・壊れた symlink: 写す (VERIFY_READONLY=1 では写さずに落ちる)
 *   - 現行と同じ実行可能なファイル: 何もしない (VERIFY_READONLY=1 でも)
 *   - それ以外 (旧版、別の hook、PUSH_OK の判定を足した hook、手を入れた写し、同じ中身で実行可能でないもの、ディレクトリ): 触らずに落とす (旧版と別の hook は VERIFY_READONLY=1 でも確かめる)
 * - 写しは main worktree の checkout によらず linked worktree の push も止める
 * - core.hooksPath が hook をよそへ向けていれば、verify.sh は設定を書かずに落ちる
 * ネットワークは使わない (bare リポジトリを file システム上に作って push する)。
 *
 * このスクリプトの入力と環境の定義域:
 * - 引数は取らない。
 * - 読む環境変数は PATH・TMPDIR だけ。PUSH_OK と VERIFY_READONLY は呼び出し元から引き継がない。
 * - TMPDIR (未設定か空なら /tmp) は絶対パスで、作った一時ディレクトリの解決済みのパスが A-Z a-z 0-9 . _ / - だけであること。外れていれば理由を出して落ちる。
 * - 後始末は、終わったときに一時ディレクトリを消す。SIGINT・SIGTERM では子に SIGTERM を送り、子が終わってから消す (子が書いている最中に消すと消し残す)。
 *
 * 並行の検査が共有する、変わりうる状態。これ以外は検査ごとの `${tmp}/f/<n>` の下に置き、新しく共有するものを足すときも検査ごとのパスにする:
 * - HOME (`${tmp}/home`) と TMPDIR (`${tmp}`): verify.sh は TMPDIR の下に起動ごとに別の作業ディレクトリを作る。deno は HOME の下にキャッシュを置く。
 *
 * 子の環境は PATH と下の baseEnv だけ (clearEnv。canon: facts/deno/command-spawn)。hook や rebase --exec から呼ばれても、呼び出し元の GIT_DIR などを子に渡さない。
 */

const here = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");
const self = "test-pre-push.ts";
const notSame = "hooks/pre-push と同じ実行可能なファイルでない";
const badLocal = "実行可能な通常のファイルでない";
const dec = new TextDecoder();

const tmpdirEnv = Deno.env.get("TMPDIR") ?? "";
if (tmpdirEnv && !tmpdirEnv.startsWith("/")) {
  console.error(`${self}: TMPDIR (${tmpdirEnv}) が絶対パスでない`);
  Deno.exit(1);
}
const tmp = await Deno.realPath(await Deno.makeTempDir({ dir: tmpdirEnv || "/tmp", prefix: "pre-push-test." }));
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

// ' は pre-push.local の中に単一引用符で書くため、空白・%・非 ASCII は deno が file URL で percent-encode し、Module not found の照合が合わなくなるため (canon: facts/deno/run-missing-module)
if (!/^\/[A-Za-z0-9._\/-]*$/.test(tmp)) {
  console.error(`${self}: TMPDIR (${tmpdirEnv}) の下に作った一時ディレクトリ ${tmp} が A-Z a-z 0-9 . _ / - だけの形でない。TMPDIR を直す`);
  Deno.exit(1);
}

const baseEnv: Record<string, string> = {
  PATH: Deno.env.get("PATH") ?? "",
  HOME: `${tmp}/home`,
  TMPDIR: tmp,
  // clearEnv で locale の環境変数が無くても、macOS では GNU gettext を使う bash などがシステムの言語で訳す。子のメッセージを照合するため C に固定する (canon: facts/shell/gettext-macos-system-language)
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

async function exec(cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string> } = {}): Promise<Run> {
  while (active >= limit) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    if (interrupted) throw new Error("中断した");
    const child = new Deno.Command(cmd, {
      args,
      cwd: o.cwd,
      env: { ...baseEnv, ...o.env },
      // canon: facts/deno/command-spawn — cmd は / が無ければ、この env.PATH で引かれる (old-shellcheck の PATH が効く)。clearEnv は env だけを子に渡す。spawn() の stdin の既定は inherit で、pre-push.local が git の渡すものでなくこのプロセスの stdin を読みうる
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

/** 準備の git。落ちれば例外 (その検査を落とす)。 */
async function git(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const r = await exec("git", ["-C", dir, ...args], { env });
  if (r.code !== 0) throw new Error(`git -C ${dir} ${args.join(" ")}: exit ${r.code} — ${r.err}`);
  return r.out.replace(/\n+$/, "");
}

/** 試す push。落ちても例外にしない。 */
const push = (dir: string, args: string[], env: Record<string, string> = {}) => exec("git", ["-C", dir, "push", ...args], { env });
const pushOk = { PUSH_OK: "1" };

/**
 * 使い方の形 (リポのルートで `./verify.sh`) で起動する。Deno.Command は / を含むコマンドを絶対パスにして起動し、$0 が絶対パスになるので、相対のまま渡すよう env を通す (canon: facts/deno/command-spawn)。
 * 外せる条件: Deno.Command が相対の argv[0] を保てるようになれば、env を通さず直接起動する。
 * env 自身も env.PATH で引かれるので、PATH を差し替える検査 (old-shellcheck) は env のあるディレクトリを PATH に残す。
 */
const verify = (repo: string, env: Record<string, string> = {}) => exec("env", ["./verify.sh"], { cwd: repo, env });

// ---- ファイル ----

async function write(path: string, content: string, mode?: number) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, content);
  if (mode !== undefined) await Deno.chmod(path, mode);
}
async function install(from: string, to: string) {
  await Deno.mkdir(to.slice(0, to.lastIndexOf("/")), { recursive: true });
  await Deno.copyFile(from, to);
  await Deno.chmod(to, 0o755);
}
const readOr = (path: string) => Deno.readTextFile(path).catch(() => null);
const lstatOr = (path: string) => Deno.lstat(path).catch(() => null);
/** 在るか (symlink そのものを見る)。 */
const present = async (path: string) => (await lstatOr(path)) !== null;
/** 実行可能な通常のファイルか (symlink の先を見る)。 */
const executable = async (path: string) => {
  const st = await Deno.stat(path).catch(() => null);
  return st !== null && st.isFile && ((st.mode ?? 0) & 0o100) !== 0;
};
const sameBytes = async (a: string, b: string) => {
  const [x, y] = await Promise.all([Deno.readFile(a).catch(() => null), Deno.readFile(b).catch(() => null)]);
  return x !== null && y !== null && x.length === y.length && x.every((v, i) => v === y[i]);
};

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
    await body({ dir, fail: (m) => failures.push(m) });
  })().catch((e) => failures.push(`${name}: 例外 — ${e instanceof Error ? e.stack : e}`)));
}

// ---- 準備 ----

const hookSrc = `${here}/hooks/pre-push`;

/** hooks/pre-push の写しを common git dir の hooks に置いた clone と、その push 先の bare リポジトリ。clone には commit が 1 つある。 */
async function cloneWithHook(dir: string) {
  const remote = `${dir}/remote.git`;
  const clone = `${dir}/clone`;
  await git(dir, ["init", "-q", "-b", "main", "--bare", remote]);
  await git(dir, ["clone", "-q", remote, clone]);
  await install(hookSrc, `${await git(clone, ["rev-parse", "--path-format=absolute", "--git-common-dir"])}/hooks/pre-push`);
  await commitFile(clone, "a");
  return { remote, clone };
}

async function commitFile(repo: string, name: string) {
  await Deno.writeTextFile(`${repo}/${name}.txt`, `${name}\n`);
  await git(repo, ["add", `${name}.txt`]);
  await git(repo, ["commit", "-q", "-m", name]);
}

/** repo の ref の一覧 (pattern を渡せばそれに合うものだけ)。 */
const refOf = (repo: string, ...pattern: string[]) => git(repo, ["for-each-ref", ...pattern]);

/** 作業ツリーの verify.sh と hooks/pre-push だけを commit したリポ。scripts/ が無いので verify.sh の検査の段は起動できずに落ち、この test を呼び返さない。 */
async function verifyRepo(repo: string) {
  await git(tmp, ["init", "-q", "-b", "main", repo]);
  await Deno.copyFile(`${here}/verify.sh`, `${repo}/verify.sh`);
  await Deno.mkdir(`${repo}/hooks`);
  await Deno.copyFile(hookSrc, `${repo}/hooks/pre-push`);
  await git(repo, ["add", "verify.sh", "hooks/pre-push"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  const hook = `${repo}/.git/hooks/pre-push`;
  await Deno.remove(hook).catch(() => {});
  return hook;
}

// ---- PUSH_OK ----

// PUSH_OK=1 が無ければ push は止まり、remote には何も届かない。PUSH_OK=0 も止まる。PUSH_OK=1 を付ければ通る。
// 許可は残らない: 続く push は push すべき差分が無くても、hook は毎回呼ばれるので PUSH_OK が無ければ止まる
fixture("PUSH_OK", async (t) => {
  const { remote, clone } = await cloneWithHook(t.dir);
  const r = await push(clone, ["origin", "main"]);
  if (r.code === 0) t.fail("PUSH_OK 無しで push が通った");
  if (!r.err.includes("PUSH_OK=1")) t.fail(`PUSH_OK 無しのエラーメッセージに PUSH_OK=1 が無い — ${r.err}`);
  if (await refOf(remote, "refs/heads/main")) t.fail("PUSH_OK 無しで remote に ref ができた");
  if ((await push(clone, ["origin", "main"], { PUSH_OK: "0" })).code === 0) t.fail("PUSH_OK=0 で push が通った");
  const ok = await push(clone, ["-q", "origin", "main"], pushOk);
  if (ok.code !== 0) t.fail(`PUSH_OK=1 で push が失敗した — ${ok.err}`);
  if (!await refOf(remote, "refs/heads/main")) t.fail("PUSH_OK=1 で remote に ref ができない");
  if ((await push(clone, ["origin", "main"])).code === 0) t.fail("PUSH_OK=1 の push の後、PUSH_OK 無し (push する差分も無い) が通った");
});

// ---- pre-push.local ----

/** clone/hooks/pre-push.local を、引数と stdin を dir に書き、dir/local.rc の値で終わるものにする。 */
async function recordingLocal(dir: string, clone: string) {
  await write(
    `${clone}/hooks/pre-push.local`,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/local.args'\ncat > '${dir}/local.stdin'\nexit "$(cat '${dir}/local.rc')"\n`,
    0o755,
  );
}

// hooks/pre-push.local は、PUSH_OK=1 の push でだけ同じ引数と stdin で呼ばれ、その終了コードが push の可否になる
fixture("pre-push.local の呼び出し", async (t) => {
  const { remote, clone } = await cloneWithHook(t.dir);
  await recordingLocal(t.dir, clone);
  await commitFile(clone, "b");
  const head = await git(clone, ["rev-parse", "HEAD"]);
  await Deno.writeTextFile(`${t.dir}/local.rc`, "0\n");
  if ((await push(clone, ["origin", "main"])).code === 0) t.fail("pre-push.local があると PUSH_OK 無しで push が通った");
  if (await present(`${t.dir}/local.args`)) t.fail("PUSH_OK 無しの push で pre-push.local が呼ばれた");
  await Deno.writeTextFile(`${t.dir}/local.rc`, "1\n");
  if ((await push(clone, ["origin", "main"], pushOk)).code === 0) t.fail("pre-push.local が 1 で終わったのに push が通った");
  const args = await readOr(`${t.dir}/local.args`);
  if (args === null) t.fail("pre-push.local が呼ばれなかった (引数の記録が無い)");
  else if (args !== `origin\n${remote}\n`) t.fail(`pre-push.local の引数が push の remote 名と URL でない — ${args}`);
  const stdin = await readOr(`${t.dir}/local.stdin`);
  if (stdin === null) t.fail("pre-push.local が呼ばれなかった (stdin の記録が無い)");
  else if (!new RegExp(`^refs/heads/main ${head} refs/heads/main `, "m").test(stdin)) t.fail(`pre-push.local の stdin に push する ref の行が無い — ${stdin}`);
  if (await refOf(remote, "refs/heads/main")) t.fail("pre-push.local が 1 で終わったのに remote に ref ができた");
  await Deno.writeTextFile(`${t.dir}/local.rc`, "0\n");
  const ok = await push(clone, ["-q", "origin", "main"], pushOk);
  if (ok.code !== 0) t.fail(`pre-push.local が 0 で終わったのに push が失敗した — ${ok.err}`);
  if (await git(remote, ["rev-parse", "main"]) !== head) t.fail("pre-push.local が 0 で終わったのに remote が進まない");
});

// 実行可能な通常のファイルでない pre-push.local は、無視せず push を止めて示す (検査が黙って外れない)。実行可能な通常のファイルに戻せば通る
const badLocals: [string, (local: string, dir: string) => Promise<void>][] = [
  ["実行可能でない", (local) => Deno.chmod(local, 0o644)],
  ["ディレクトリ", async (local) => {
    await Deno.remove(local);
    await Deno.mkdir(local);
  }],
  ["壊れた symlink", async (local, dir) => {
    await Deno.remove(local);
    await Deno.symlink(`${dir}/nowhere`, local);
  }],
];
for (const [name, breakLocal] of badLocals) {
  fixture(`pre-push.local: ${name}`, async (t) => {
    const { remote, clone } = await cloneWithHook(t.dir);
    await recordingLocal(t.dir, clone);
    await Deno.writeTextFile(`${t.dir}/local.rc`, "0\n");
    if ((await push(clone, ["-q", "origin", "main"], pushOk)).code !== 0) t.fail(`${name}: 壊す前の push が失敗した`);
    await Deno.remove(`${t.dir}/local.args`);
    await commitFile(clone, "b");
    const local = `${clone}/hooks/pre-push.local`;
    await breakLocal(local, t.dir);
    const r = await push(clone, ["-q", "origin", "main"], pushOk);
    if (r.code === 0) t.fail(`${name}: pre-push.local が実行可能な通常のファイルでないのに push が通った`);
    if (!r.err.includes(badLocal)) t.fail(`${name}: pre-push.local の問題を示さない — ${r.err}`);
    if (await present(`${t.dir}/local.args`)) t.fail(`${name}: 実行可能でない pre-push.local が呼ばれた`);
    if (await git(remote, ["rev-parse", "main"]) === await git(clone, ["rev-parse", "HEAD"])) t.fail(`${name}: push が止まらず remote が進んだ`);
    await Deno.remove(local);
    await recordingLocal(t.dir, clone);
    const ok = await push(clone, ["-q", "origin", "main"], pushOk);
    if (ok.code !== 0) t.fail(`${name}: pre-push.local を実行可能な通常のファイルに戻しても push が止まる — ${ok.err}`);
  });
}

// ---- 作業ツリーの場所 ----

// 作業ツリーが無い (bare リポジトリ) からの push は、pre-push.local を探せないので止まる
fixture("bare リポジトリ", async (t) => {
  const { remote, clone } = await cloneWithHook(t.dir);
  await git(clone, ["push", "-q", "origin", "main"], pushOk);
  const bare = `${t.dir}/bare.git`;
  await git(t.dir, ["clone", "-q", "--bare", remote, bare]);
  await install(hookSrc, `${bare}/hooks/pre-push`);
  const remote2 = `${t.dir}/remote2.git`;
  await git(t.dir, ["init", "-q", "-b", "main", "--bare", remote2]);
  const r = await push(bare, [remote2, "main"], pushOk);
  if (r.code === 0) t.fail("bare リポジトリから push が通った");
  if (!r.err.includes("bare リポジトリ")) t.fail(`bare リポジトリからの push のエラーに理由が無い — ${r.err}`);
  if (await refOf(remote2)) t.fail("bare リポジトリからの push で remote に ref ができた");
});

/** clone と linked worktree の lwt (どちらも sub/deep を持つ) を作り、それぞれのルートに、呼ばれたら who に名前を書く pre-push.local を置く。 */
async function worktrees(dir: string) {
  const { remote, clone } = await cloneWithHook(dir);
  const lwt = `${dir}/lwt`;
  await git(clone, ["worktree", "add", "-q", "--detach", lwt]);
  for (const [root, name] of [[clone, "main"], [lwt, "linked"]]) {
    await Deno.mkdir(`${root}/sub/deep`, { recursive: true });
    await write(`${root}/hooks/pre-push.local`, `#!/bin/sh\necho ${name} > '${dir}/who'\n`, 0o755);
  }
  return { remote, clone, lwt };
}

/** cwd から PUSH_OK=1 で push し、呼ばれた pre-push.local の名前を返す (呼ばれなければ空)。 */
async function whoPushes(t: Ctx, cwd: string, remote: string, branch: string) {
  const r = await exec("git", ["push", "-q", remote, `HEAD:refs/heads/${branch}`], { cwd, env: pushOk });
  if (r.code !== 0) t.fail(`${cwd} からの push が失敗した — ${r.err}`);
  return ((await readOr(`${t.dir}/who`)) ?? "").trim();
}

// hook は push を打った場所によらず作業ツリーのルートで走るので、そのルートの hooks/pre-push.local を呼ぶ。linked worktree は main のものを使わない
const whoRows: [string, (w: { clone: string; lwt: string }) => string, string][] = [
  ["main worktree のルート", (w) => w.clone, "main"],
  ["main worktree のサブディレクトリ", (w) => `${w.clone}/sub/deep`, "main"],
  ["linked worktree のルート", (w) => w.lwt, "linked"],
  ["linked worktree のサブディレクトリ", (w) => `${w.lwt}/sub/deep`, "linked"],
];
for (const [name, cwd, want] of whoRows) {
  fixture(`${name}からの push`, async (t) => {
    const w = await worktrees(t.dir);
    const got = await whoPushes(t, cwd(w), w.remote, "w");
    if (got !== want) t.fail(`${name}からの push が、そのルートの pre-push.local (${want}) でなく「${got}」を呼んだ`);
  });
}
fixture("pre-push.local の無い linked worktree からの push", async (t) => {
  const w = await worktrees(t.dir);
  await Deno.remove(`${w.lwt}/hooks/pre-push.local`);
  const got = await whoPushes(t, w.lwt, w.remote, "w");
  if (got) t.fail(`linked worktree に pre-push.local が無いのに、「${got}」が呼ばれた`);
});

// 作業ツリーのルートを得られない .git の中からの push は、git 自身のエラーを隠さず止まる
fixture(".git の中からの push", async (t) => {
  const w = await worktrees(t.dir);
  const r = await exec("git", ["push", w.remote, "HEAD:refs/heads/w"], { cwd: `${w.clone}/.git`, env: pushOk });
  if (r.code === 0) t.fail(".git の中からの push が通った");
  if (!r.err.includes("must be run in a work tree")) t.fail(`.git の中からの push で git 自身のエラーが見えない — ${r.err}`);
  if (!r.err.includes("ルートを得られない")) t.fail(`.git の中からの push のエラーに理由が無い — ${r.err}`);
  if (await refOf(w.remote, "refs/heads/w")) t.fail(".git の中からの push で remote に ref ができた");
  if (await present(`${t.dir}/who`)) t.fail(".git の中からの push で pre-push.local が呼ばれた");
});

// ---- verify.sh の写し ----

// verify.sh は、検査が落ちても hooks/pre-push を common git dir の hooks に写してから落ちる (hook が無い clone から push できる期間を作らない)
fixture("verify.sh が写す", async (t) => {
  const repo = `${t.dir}/repo`;
  const hook = await verifyRepo(repo);
  if ((await verify(repo)).code === 0) t.fail("検査の段が落ちるのに verify.sh が通った");
  if (!await executable(hook) || !await sameBytes(hookSrc, hook)) t.fail(`検査に落ちた verify.sh が ${hook} に hooks/pre-push の実行可能な写しを置いていない`);
});

// linked worktree で回しても、写す先はその worktree の git dir でなく common git dir の hooks
fixture("linked worktree で回した verify.sh", async (t) => {
  const repo = `${t.dir}/repo`;
  const hook = await verifyRepo(repo);
  const wt = `${t.dir}/wt`;
  await git(repo, ["worktree", "add", "-q", "--detach", wt]);
  await verify(wt);
  if (!await executable(hook) || !await sameBytes(hookSrc, hook)) t.fail(`linked worktree で回した verify.sh が ${hook} に hooks/pre-push の実行可能な写しを置いていない`);
  const own = `${await git(wt, ["rev-parse", "--path-format=absolute", "--git-dir"])}/hooks/pre-push`;
  if (await present(own)) t.fail(`linked worktree で回した verify.sh が ${own} に書いた`);
});

// 版の違う shellcheck が先にあっても (その段だけが落ちて残りの段は回る)、verify.sh はこの test を呼び返さない
fixture("shellcheck の版が違う verify.sh", async (t) => {
  const repo = `${t.dir}/repo`;
  await verifyRepo(repo);
  await write(`${t.dir}/old-shellcheck/shellcheck`, '#!/bin/sh\necho "version: 0.9.0"\n', 0o755);
  const r = await verify(repo, { PATH: `${t.dir}/old-shellcheck:${baseEnv.PATH}` });
  if (r.code === 0) t.fail("shellcheck の版が違うのに verify.sh が通った");
  if (!r.err.includes("shellcheck の版が 0.9.0 で")) t.fail(`verify.sh が shellcheck の版の違いを示さない — ${r.err}`);
  // canon: facts/deno/run-missing-module — 無いモジュールは Module not found と file URL で示し exit 1 で終わる。tmp は encode の要らない文字だけ
  if (!/^== scripts\/test-pre-push\.ts: 落ちた \(exit 1、/m.test(r.err) || !r.err.includes(`Module not found "file://${repo}/scripts/test-pre-push.ts"`)) {
    t.fail(`shellcheck の版が違うとき、verify.sh を回すリポの scripts/test-pre-push.ts の段が起動できずに落ちていない — ${r.err}`);
  }
});

// 現行と同じ実行可能なファイルなら、示さず、写し直さない
for (const readonly of [false, true]) {
  const label = `現行と同じ実行可能な pre-push (${readonly ? "readonly" : "normal"})`;
  fixture(label, async (t) => {
    const repo = `${t.dir}/repo`;
    const hook = await verifyRepo(repo);
    await install(hookSrc, hook);
    const before = await Deno.lstat(hook);
    const r = await verify(repo, readonly ? { VERIFY_READONLY: "1" } : {});
    if (r.err.includes(notSame) || r.out.includes("を写した")) t.fail(`${label}: verify.sh が示した、または写した — ${r.out}${r.err}`);
    const after = await Deno.lstat(hook);
    if (after.ino !== before.ino || after.mtime?.getTime() !== before.mtime?.getTime()) t.fail(`${label}: verify.sh が pre-push を置き直した`);
  });
}

// 無いときに VERIFY_READONLY=1 なら、写さずに落として示す
fixture("VERIFY_READONLY=1 で pre-push が無い", async (t) => {
  const repo = `${t.dir}/repo`;
  const hook = await verifyRepo(repo);
  const r = await verify(repo, { VERIFY_READONLY: "1" });
  if (r.code === 0) t.fail("VERIFY_READONLY=1 で pre-push が無いのに verify.sh が通った");
  if (!r.err.includes(`${hook}: ${notSame}`)) t.fail(`VERIFY_READONLY=1 の verify.sh が pre-push が無いことを示さない — ${r.err}`);
  if (await present(hook)) t.fail("VERIFY_READONLY=1 の verify.sh が pre-push を作った");
});

// hooks/pre-push と同じ実行可能なファイルでない pre-push は、verify.sh が上書きせずに落とす (VERIFY_READONLY=1 でも示すだけで触らない)
const oldHook = `#!/bin/sh
# push を、$(git rev-parse --git-dir)/push-ok がある 1 回だけ通し、通したら消す。token は pr-workflow の push の手順で作る (レビュアーなどの push を止めるため)。token は worktree ごと (git rev-parse --git-dir の下) で、main checkout の token では linked worktree の push は通らない。
# git が呼ぶのは verify.sh が $GIT_COMMON_DIR/hooks (全 worktree で共有) に写した写しで、このファイルではない。githooks(5) の pre-push: push の前に呼ばれ、非 0 で終わると git push は何も push せずに止まる。
set -eu
token="$(git rev-parse --git-dir)/push-ok"
rm -- "$token" 2>/dev/null || {
  echo "pre-push: $token が無い。push は pr-workflow の手順で行う (touch \\"$token\\" してから push)" >&2
  exit 1
}
`;
const current = await Deno.readTextFile(hookSrc);
const foreign: [string, string, number, boolean][] = [
  ["旧版の hook", oldHook, 0o755, false],
  ["旧版の hook", oldHook, 0o755, true],
  ["別の hook", "#!/bin/sh\nexec ./scripts/lint\n", 0o755, false],
  ["別の hook", "#!/bin/sh\nexec ./scripts/lint\n", 0o755, true],
  ["PUSH_OK の判定を足した利用者の hook", '#!/bin/sh\n[ "${PUSH_OK:-}" = 1 ] || exit 1\nexec ./scripts/lint\n', 0o755, false],
  ["現行版に手を入れた写し", `${current}echo extra\n`, 0o755, false],
  ["現行版と同じ中身で実行可能でない写し", current, 0o644, false],
];
for (const [name, content, mode, readonly] of foreign) {
  const label = `${name} (${readonly ? "readonly" : "normal"})`;
  fixture(label, async (t) => {
    const repo = `${t.dir}/repo`;
    const hook = await verifyRepo(repo);
    await write(hook, content, mode);
    const r = await verify(repo, readonly ? { VERIFY_READONLY: "1" } : {});
    if (r.code === 0) t.fail(`${label}: 同じ実行可能なファイルでない pre-push があるのに verify.sh が通った`);
    if (!r.err.includes(`${notSame} (上書きしない)`)) t.fail(`${label}: 他の pre-push を verify.sh が示さない — ${r.err}`);
    if (await readOr(hook) !== content) t.fail(`${label}: verify.sh が他の pre-push を書き換えた`);
    if (((await Deno.lstat(hook)).mode! & 0o777) !== mode) t.fail(`${label}: verify.sh が pre-push の mode を変えた`);
  });
}
fixture("ディレクトリの pre-push", async (t) => {
  const repo = `${t.dir}/repo`;
  const hook = await verifyRepo(repo);
  await Deno.mkdir(hook);
  const r = await verify(repo);
  if (r.code === 0) t.fail("ディレクトリの pre-push があるのに verify.sh が通った");
  if (!r.err.includes(`${notSame} (上書きしない)`)) t.fail(`ディレクトリの pre-push を verify.sh が示さない — ${r.err}`);
  const st = await lstatOr(hook);
  if (!st?.isDirectory || await present(`${hook}/pre-push`)) t.fail("ディレクトリの pre-push を verify.sh が置き換えた、または中に書いた");
});

// 壊れた symlink は無いものとして扱う。置き換えか書き通しかでなく、実行可能な写しが残ることを見る
fixture("壊れた symlink の pre-push", async (t) => {
  const repo = `${t.dir}/repo`;
  const hook = await verifyRepo(repo);
  await Deno.symlink(`${t.dir}/nowhere`, hook);
  await verify(repo);
  if (!await executable(hook) || !await sameBytes(hookSrc, hook)) t.fail("壊れた symlink の pre-push を verify.sh が実行可能な写しにしない");
});

// hooks/ の無い linked worktree (hooks/pre-push の無い commit と同じ) からも、PUSH_OK 無しの push は止まる。
// main worktree を hooks/pre-push の無い commit に切り替えても、linked worktree からの PUSH_OK 無しの push は止まる
fixture("linked worktree の push", async (t) => {
  const repo = `${t.dir}/repo`;
  const hook = await verifyRepo(repo);
  await install(hookSrc, hook);
  const remote = `${t.dir}/remote.git`;
  await git(t.dir, ["init", "-q", "-b", "main", "--bare", remote]);
  const wt = `${t.dir}/wt`;
  await git(repo, ["worktree", "add", "-q", "--detach", wt]);
  await Deno.remove(`${wt}/hooks`, { recursive: true });
  const r1 = await push(wt, [remote, "HEAD:refs/heads/wt"]);
  if (r1.code === 0) t.fail("hooks/ の無い linked worktree から PUSH_OK 無しで push が通った");
  if (!r1.err.includes("PUSH_OK")) t.fail(`hooks/ の無い linked worktree の PUSH_OK 無しの push のエラーに PUSH_OK が無い — ${r1.err}`);
  await git(repo, ["checkout", "-q", "--detach"]);
  await git(repo, ["rm", "-qf", "hooks/pre-push"]);
  await git(repo, ["commit", "-q", "-m", "hooks/pre-push の無い commit"]);
  const r2 = await push(wt, [remote, "HEAD:refs/heads/wt"]);
  if (r2.code === 0) t.fail("main worktree が hooks/pre-push の無い commit のとき、linked worktree から PUSH_OK 無しで push が通った");
  if (!r2.err.includes("PUSH_OK")) t.fail(`main worktree が hooks/pre-push の無い commit のときの PUSH_OK 無しの push のエラーに PUSH_OK が無い — ${r2.err}`);
  if (await refOf(remote, "refs/heads/wt")) t.fail("linked worktree からの PUSH_OK 無しの push で remote に ref ができた");
});

// core.hooksPath が hook をよそへ向けていれば、verify.sh は設定元を示して落ち、設定は書き換えない
fixture("core.hooksPath", async (t) => {
  const repo = `${t.dir}/repo`;
  await verifyRepo(repo);
  await git(repo, ["config", "core.hooksPath", "hooks"]);
  const r = await verify(repo);
  if (r.code === 0) t.fail("core.hooksPath が hook をよそへ向けているのに verify.sh が通った");
  if (!r.err.includes("local file:.git/config hooks")) t.fail(`core.hooksPath の設定元を verify.sh が示さない — ${r.err}`);
  const got = await exec("git", ["-C", repo, "config", "--get", "core.hooksPath"]);
  if (got.code !== 0 || got.out !== "hooks\n") t.fail(`verify.sh が core.hooksPath を書き換えた — exit ${got.code}、${got.out}${got.err}`);
});

await Promise.all(pending);
const all = reports.flat();
if (all.length) console.error(all.join("\n"));
Deno.exit(all.length ? 1 : 0);
