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
 * - 段の子孫 (段が起こした pr.sh なども) を段より長く残さない。段が起動する子は、それぞれ自分のプロセスグループで回る (Deno.Command の detached。deno 2.9.7 の spawn() は子で setsid する) ので、グループごとに止める。
 *   - 子が終われば、そのグループに残ったものに SIGTERM を送る。残ったものが出力の pipe を開いたままにすると、段も終わらない。
 *   - SIGHUP・SIGINT・SIGTERM (終了コードは下の signals) の 1 回目では、動いている子のグループに SIGTERM を送り、子が終わってから終わる (段の test が一時ディレクトリを片付けられるように)。段の出力は出さない。
 *   - 2 回目のシグナルでは、残っている子のグループに SIGKILL を送り、待たずに終わる (SIGTERM を受けても終わらない子がいても抜けられるように)。
 *
 * 入力と環境の定義域:
 * - 引数は 1 つで、verify.sh が先に回した状態を揃える段の結果 (0 か 1)。外れていれば理由を出して落ちる。
 * - cwd はリポのルート。
 * - 読む環境変数は TMPDIR だけ (未設定か空なら /tmp。段の deno の read・write の許可に渡す)。子にはこのプロセスの環境を全部渡す (段の test が読む CI・PATH など)。
 * - git が知っているファイル (canon: facts/git/path-output-quoting、facts/git/untracked-entry-kinds) の名前の次元:
 *   - 改行: 含む名前が 1 つでもあれば、理由と名前を出して gitFiles を使う段を落とす。verify.ts へ渡す 1 行 1 件の入力で名前が割れるため。
 *   - `-` で始まる: shellcheck と deno check へは `./` を前置して渡す。`--` は使わない (shellcheck 0.11.0 は `--` の後を位置引数にするが、deno 2.9.7 の deno check は `--` の後の名前を無視して cwd 全体を検査する。canon: facts/deno/check-double-dash)。verify.ts は名前を行から読むだけなので前置しない。
 *   - 非 ASCII・`"`・`\`・タブ・空白: そのまま渡す。git は -z で quote せずに出し、コマンドへは引数の配列で渡し、verify.ts へは行で渡す。
 *   - 作業ツリーに無い追跡ファイル・リンク先の無い symlink: git は一覧に出す。コマンドがその名前の無いことを知らせて落ちる (shellcheck は exit 2)。
 * - deno は 2.9.7 で確かめた。detached が子で setsid すること、Deno.kill に負の pid を渡すとプロセスグループに送れること、先に終わった子の stdin への write が Deno.errors.BrokenPipe で投げることに依存する。版は検査しない (CI は v2.x を使う)。外れた版 (detached が setsid しない版など) では、段の孫が止められずに残る。
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

/** 受けるシグナルと、それで終わるときの終了コード。 */
const signals: Partial<Record<Deno.Signal, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** 動いている子。止めるときは、そのプロセスグループに送る。 */
const children = new Set<Deno.ChildProcess>();
const killGroup = (child: Deno.ChildProcess, signal: Deno.Signal) => {
  try {
    Deno.kill(-child.pid, signal);
  } catch (e) {
    // ESRCH: グループに誰も残っていない。EPERM: 残っているのは終わりかけのものだけ (macOS。canon: facts/deno/command-spawn の測定。終わりかけのグループに EPERM を返さなくなったら、PermissionDenied を外せる)
    if (!(e instanceof Deno.errors.NotFound || e instanceof Deno.errors.PermissionDenied)) throw e;
  }
};
/** 中断が始まっていれば、その経路 (終了コードを決めて Deno.exit する。解決しない)。 */
let interruption: Promise<never> | undefined;
const interrupt = async (code: number): Promise<never> => {
  children.forEach((c) => killGroup(c, "SIGTERM"));
  await Promise.allSettled([...children].map((c) => c.status));
  Deno.exit(code);
};
for (const [signal, code] of Object.entries(signals) as [Deno.Signal, number][]) {
  Deno.addSignalListener(signal, () => {
    if (!interruption) {
      interruption = interrupt(code);
      return;
    }
    children.forEach((c) => killGroup(c, "SIGKILL"));
    Deno.exit(code);
  });
}

interface Run {
  code: number;
  out: Uint8Array;
  err: Uint8Array;
}

/** 子の stdin に書いて閉じる。子が先に終わっていた (stdin を閉じていた) なら false (BrokenPipe。canon: facts/deno/command-spawn)。 */
async function feed(stdin: WritableStream<Uint8Array>, data: Uint8Array): Promise<boolean> {
  const w = stdin.getWriter();
  try {
    await w.write(data);
    await w.close();
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.BrokenPipe) return false;
    throw e;
  }
}

/** 子を自分のプロセスグループで起動し、終わるまで待つ。投げるときも、子を回収してグループを止めてから投げる。 */
async function exec(cmd: string, args: string[], stdin?: Uint8Array): Promise<Run> {
  if (interruption) throw new Error("中断した");
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
    const fed = !stdin || await feed(child.stdin, stdin);
    const status = await child.status;
    killGroup(child, "SIGTERM");
    const run = { code: status.code, out: await out, err: await err };
    if (fed || run.code !== 0) return run;
    return { ...run, code: 1, err: new Uint8Array([...run.err, ...enc.encode(`${self}: ${cmd} が stdin を読み終える前に閉じた\n`)]) };
  } catch (e) {
    killGroup(child, "SIGTERM");
    await child.status;
    throw e;
  } finally {
    children.delete(child);
  }
}

/** git が知っているファイル (作業ツリーの未追跡を含み、無視するものを除く) のうち、pathspec に合うもの。-z でなければ git は非 ASCII の名前を quote して出す (canon: facts/git/path-output-quoting)。git が落ちれば out は空 (落ちた段に一覧を出さない)。out は名前を改行で繋いだもの。 */
async function gitFiles(patterns: string[]): Promise<Run & { files: string[] }> {
  const r = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...patterns]);
  if (r.code !== 0) return { ...r, out: new Uint8Array(), files: [] };
  const files = dec.decode(r.out).split("\0").filter(Boolean);
  const nl = files.filter((f) => f.includes("\n"));
  if (nl.length) {
    return { code: 1, out: new Uint8Array(), err: enc.encode(`${self}: 改行を含む名前のファイルがある (1 行 1 件の入力で割れる)。名前を変えるか消す: ${nl.map((f) => JSON.stringify(f)).join(" ")}\n`), files: [] };
  }
  return { ...r, out: enc.encode(files.map((f) => `${f}\n`).join("")), files };
}

/** git が知っているファイルが 1 件以上あるときだけ、それを引数に足してコマンドを回す。無ければ通す。 */
async function checkFiles(cmd: string, args: string[], patterns: string[]): Promise<Run> {
  const ls = await gitFiles(patterns);
  if (ls.code !== 0 || !ls.files.length) return ls;
  return exec(cmd, [...args, ...ls.files.map((f) => `./${f}`)]);
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
    if (ls.code !== 0) return ls;
    return exec("deno", ["run", "--allow-read=.", "--allow-net=www.schemastore.org", "scripts/verify.ts"], ls.out);
  }],
];

const results = await Promise.all(steps.map(async ([, run]) => {
  const start = performance.now();
  const r = await run().catch((e): Run => ({ code: 1, out: new Uint8Array(), err: enc.encode(`${e instanceof Error ? e.stack : e}\n`) }));
  return { ...r, secs: ((performance.now() - start) / 1000).toFixed(1) };
}));
if (interruption) await interruption;

const write = (w: { writeSync(p: Uint8Array): number }, data: Uint8Array) => {
  for (let i = 0; i < data.length;) i += w.writeSync(data.subarray(i));
};
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
  }
});
const status = Deno.args[0] === "1" || results.some((r) => r.code !== 0) ? 1 : 0;
Deno.exit(status);
