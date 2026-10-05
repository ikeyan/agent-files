/**
 * run-checks.ts — verify.sh の検査の段を並行に回す。verify.sh が状態を揃えた後に exec で起動する。
 *
 * 性質:
 * - 段は互いに独立なので、全部を同時に始める。
 * - 段ごとに標準出力と標準エラーを分けて残し、全部を待ってから、下の steps に並べた順で出す (終わった順でない)。
 *   - 通った段: 見出しと標準出力を stdout へ、標準エラーを stderr へ。
 *   - 落ちた段: 見出しと両方を stderr へ。落ちた段は全部出す。
 *   - 見出しに段の所要時間を出す。
 * - どれかの段が落ちるか、引数が 1 なら exit 1。
 * - 段が起動する子は、それぞれ自分のプロセスグループで回る (Deno.Command の detached。deno 2.9.7 の spawn() は子で setsid する)。
 *   - 子が終われば、そのグループに残ったものに SIGTERM を送る。残ったものが出力の pipe を開いたままにすると、段が終わらない。
 *   - SIGINT・SIGTERM では、動いている子のグループに SIGTERM を送り、子が終わってから 130・143 で終わる。段が起こした pr.sh なども残さない。
 *
 * 入力と環境の定義域:
 * - 引数は 1 つで、verify.sh が先に回した状態を揃える段の結果 (0 か 1)。外れていれば理由を出して落ちる。
 * - cwd はリポのルート。
 * - 読む環境変数は TMPDIR だけ (未設定か空なら /tmp。段の deno の read・write の許可に渡す)。子にはこのプロセスの環境を全部渡す (段の test が読む CI・PATH など)。
 * - PATH に shellcheck (0.11.0 だけ。違えばその段が落ちる)・git・deno があること。
 *
 * 並行の段が共有する、変わりうる状態: deno のキャッシュ (DENO_DIR) と deno.lock (deno が依存を解決したときに書く)。段の test は作業ツリーを読むだけで、書くものは TMPDIR の下にそれぞれ作る一時ディレクトリに置く。
 */

const self = "run-checks.ts";
const dec = new TextDecoder();
const enc = new TextEncoder();

if (Deno.args.length !== 1 || !["0", "1"].includes(Deno.args[0])) {
  console.error(`${self}: 引数は状態を揃える段の結果 (0 か 1) 1 つ (${Deno.args.join(" ")})`);
  Deno.exit(1);
}
const tmpdir = Deno.env.get("TMPDIR") || "/tmp";

/** 動いている子。止めるときは、そのプロセスグループに SIGTERM を送る。 */
const children = new Set<Deno.ChildProcess>();
const killGroup = (child: Deno.ChildProcess) => {
  try {
    Deno.kill(-child.pid, "SIGTERM");
  } catch (e) {
    // ESRCH: グループに誰も残っていない
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
};
let interrupted = false;
const interrupt = async (code: number) => {
  interrupted = true;
  children.forEach(killGroup);
  await Promise.allSettled([...children].map((c) => c.status));
  Deno.exit(code);
};
Deno.addSignalListener("SIGINT", () => interrupt(130));
Deno.addSignalListener("SIGTERM", () => interrupt(143));

interface Run {
  code: number;
  out: Uint8Array;
  err: Uint8Array;
}

/** 子を自分のプロセスグループで起動し、終わるまで待つ。 */
async function exec(cmd: string, args: string[], stdin?: Uint8Array): Promise<Run> {
  if (interrupted) throw new Error("中断した");
  const child = new Deno.Command(cmd, {
    args,
    detached: true,
    stdin: stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  children.add(child);
  try {
    const out = new Response(child.stdout).bytes();
    const err = new Response(child.stderr).bytes();
    if (stdin) {
      const w = child.stdin.getWriter();
      await w.write(stdin);
      await w.close();
    }
    const status = await child.status;
    killGroup(child);
    return { code: status.code, out: await out, err: await err };
  } finally {
    children.delete(child);
  }
}

/** git が知っているファイル (作業ツリーの未追跡を含み、無視するものを除く) のうち、pathspec に合うもの。 */
async function gitFiles(patterns: string[]): Promise<Run & { files: string[] }> {
  const r = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", ...patterns]);
  return { ...r, files: dec.decode(r.out).split("\n").filter(Boolean) };
}

/** git が知っているファイルが 1 件以上あるときだけ、それを引数に足してコマンドを回す。無ければ通す。 */
async function checkFiles(cmd: string, args: string[], patterns: string[]): Promise<Run> {
  const ls = await gitFiles(patterns);
  if (ls.code !== 0) return { ...ls, out: new Uint8Array() };
  if (!ls.files.length) return ls;
  return exec(cmd, [...args, ...ls.files]);
}

// 版で出す指摘が違う (SC2015 は 0.9.0 が出し 0.11.0 は出さない。canon: facts/shellcheck) ので、手元と CI で同じ版に揃える。
const shellcheckVersion = "0.11.0";
async function shellcheck(): Promise<Run> {
  let actual = "";
  try {
    actual = dec.decode((await exec("shellcheck", ["--version"])).out).match(/^version: (.*)$/m)?.[1] ?? "";
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  if (actual !== shellcheckVersion) {
    const msg = `shellcheck の版が ${actual || "不明 (shellcheck が無い)"} で、${shellcheckVersion} でない。macOS: brew install shellcheck (Homebrew の版が ${shellcheckVersion} でなければ https://github.com/koalaman/shellcheck/releases/tag/v${shellcheckVersion} の成果物を PATH に置く)。Linux: .github/workflows/verify.yml の shellcheck の手順と同じに入れる\n`;
    return { code: 1, out: new Uint8Array(), err: enc.encode(msg) };
  }
  return checkFiles("shellcheck", [], ["*.sh", "hooks/pre-push"]);
}

const deno = (perms: string[], script: string) => exec("deno", ["run", ...perms, script]);

const steps: [string, () => Promise<Run>][] = [
  ["shellcheck", shellcheck],
  ["deno check", () => checkFiles("deno", ["check"], ["*.ts"])],
  ["scripts/test-target-diff.ts", () =>
    deno([
      "--allow-run=git,bash,/bin/bash,ln",
      "--allow-env=PATH,TMPDIR,TARGET_DIFF_RUNS,FC_SEED",
      `--allow-read=${tmpdir},/bin/bash`,
      `--allow-write=${tmpdir}`,
    ], "scripts/test-target-diff.ts")],
  // sync.sh の写しと shim を一時ディレクトリから起動し、symlink を作るので、run・read・write はパスを絞れない
  ["scripts/test-agent-sync.ts", () =>
    deno(["--allow-run", "--allow-env=CI,PATH,TMPDIR", "--allow-read", "--allow-write"], "scripts/test-agent-sync.ts")],
  // 一時ディレクトリに symlink を作るので、read・write はパスを絞れない
  ["scripts/test-pre-push.ts", () =>
    deno(["--allow-run=git,env", "--allow-env=PATH,TMPDIR", "--allow-read", "--allow-write"], "scripts/test-pre-push.ts")],
  ["scripts/test-cleanup-branch.ts", () =>
    deno([
      "--allow-run=git,skills/setup-repo/pr-workflow/cleanup-branch.sh",
      "--allow-env=PATH,TMPDIR",
      `--allow-read=${tmpdir}`,
      `--allow-write=${tmpdir}`,
    ], "scripts/test-cleanup-branch.ts")],
  ["scripts/test-codex-limits.ts", () =>
    deno([
      "--allow-run=bash,skills/setup-repo/pr-workflow/codex-limits.sh",
      "--allow-env=PATH,TMPDIR",
      `--allow-read=${tmpdir}`,
      `--allow-write=${tmpdir}`,
    ], "scripts/test-codex-limits.ts")],
  ["scripts/test-pr.ts", () =>
    deno([
      "--allow-run=bash",
      "--allow-net=127.0.0.1",
      "--allow-env=PR_RUNS,FC_SEED,PATH",
      `--allow-read=${tmpdir}`,
      `--allow-write=${tmpdir}`,
    ], "scripts/test-pr.ts")],
  ["scripts/verify.ts", async () => {
    const ls = await gitFiles([]);
    if (ls.code !== 0) return { ...ls, out: new Uint8Array() };
    return exec("deno", ["run", "--allow-read=.", "--allow-net=www.schemastore.org", "scripts/verify.ts"], ls.out);
  }],
];

const results = await Promise.all(steps.map(async ([, run]) => {
  const start = performance.now();
  const r = await run().catch((e): Run => ({ code: 1, out: new Uint8Array(), err: enc.encode(`${e instanceof Error ? e.stack : e}\n`) }));
  return { ...r, secs: ((performance.now() - start) / 1000).toFixed(1) };
}));

const write = (w: { writeSync(p: Uint8Array): number }, data: Uint8Array) => {
  for (let i = 0; i < data.length;) i += w.writeSync(data.subarray(i));
};
let status = Number(Deno.args[0]);
results.forEach((r, i) => {
  const name = steps[i][0];
  if (r.code === 0) {
    write(Deno.stdout, enc.encode(`== ${name}: 通った (${r.secs} 秒)\n`));
    write(Deno.stdout, r.out);
    write(Deno.stderr, r.err);
  } else {
    write(Deno.stderr, enc.encode(`== ${name}: 落ちた (exit ${r.code}、${r.secs} 秒)\n`));
    write(Deno.stderr, r.out);
    write(Deno.stderr, r.err);
    status = 1;
  }
});
Deno.exit(status);
