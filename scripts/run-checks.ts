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
 *   - 子 (グループの先頭) が終われば、グループを空にしてから段を終える: 残ったものに SIGTERM を送り、出力の pipe が閉じるか猶予 (graceMs) が過ぎたら SIGKILL を送る。SIGTERM を無視して pipe を開いたままのものがいても段が終わり、pipe を開いていないものも残らない。
 *   - SIGHUP・SIGINT・SIGTERM (終了コードは下の signals) の 1 回目では、記録している (下の「状態」) グループに SIGTERM を送り、全部のグループを上の手順で空にしてから終わる。段の出力は出さない。グループの状態ごとに:
 *     - 先頭が SIGTERM で終わる:
 *       - 子孫が残らない、または SIGTERM で終わる: pipe が閉じたら SIGKILL を送り (届く先は無い)、終わる。
 *       - 子孫が SIGTERM を無視する: pipe を開いていれば猶予の後に、開いていなければ pipe が閉じたらすぐ SIGKILL を送る。
 *     - 先頭が SIGTERM で終わらない (子孫を待つ、または無視する): 先頭が終わるまで待つ (段の test が一時ディレクトリを片付けられるように)。終わった後は上と同じ。
 *   - 2 回目のシグナルでは、記録しているグループに SIGKILL を送り、待たずに終わる (SIGTERM を受けても終わらない先頭がいても抜けられるように)。
 *   - 各グループに SIGTERM は高々 1 回送る。段の子孫の run-checks.ts (test-pre-push.ts が回す verify.sh) は、2 回目を 2 回目のシグナルと読んで段を待たずに終わるため。
 *   - 自分で setsid してグループを抜けた子孫は止めない。それが pipe を開いたままだと、段は終わらない。
 * - 状態: 起動した子のグループを、起動から SIGKILL を送るまで記録する。鍵は子 (pgid は子の pid)。メンバーの残るグループの pgid を OS は他に使わない (POSIX の Process ID Reuse) ので、先頭を回収した後も -pid はそのグループに届く。
 *
 * 入力と環境の定義域:
 * - 引数は 1 つで、verify.sh が先に回した状態を揃える段の結果 (0 か 1)。外れていれば理由を出して落ちる。
 * - cwd はリポのルート。
 * - 読む環境変数は TMPDIR だけ (未設定か空なら /tmp。段の deno の read・write の許可に渡す)。子にはこのプロセスの環境を全部渡す (段の test が読む CI・PATH など)。
 * - git が知っているファイル (canon: facts/git/path-output-quoting、facts/git/untracked-entry-kinds) の名前: UTF-8 として正しく (WHATWG の UTF-8 decoder が fatal で投げない)、改行を含まないものだけを処理する。外れる名前が 1 つでもあれば、理由と名前 (バイトを escape したもの) を出して gitFiles を使う段を落とす。UTF-8 として不正な名前はコマンドへ渡す引数 (文字列) で表せず、改行を含む名前は verify.ts へ渡す 1 行 1 件の入力で割れるため。処理する名前の次元:
 *   - `-` で始まる: shellcheck と deno check へは `./` を前置して渡す。`--` は使わない (shellcheck 0.11.0 は `--` の後を位置引数にするが、deno 2.9.7 の deno check は `--` の後の名前を無視して cwd 全体を検査する。canon: facts/deno/check-double-dash)。verify.ts は名前を行から読むだけなので前置しない。
 *   - 非 ASCII・`"`・`\`・タブ・空白: そのまま渡す。git は -z で quote せずに出し、コマンドへは引数の配列で渡し、verify.ts へは行で渡す。
 *   - U+FEFF で始まる: そのまま渡す (decode で BOM として落とさない)。
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

/** 起動した子 (グループの先頭) と、そのグループを空にし終えたら解決するもの。 */
const groups = new Map<Deno.ChildProcess, Promise<unknown>>();
const killGroup = (child: Deno.ChildProcess, signal: Deno.Signal) => {
  try {
    Deno.kill(-child.pid, signal);
  } catch (e) {
    // ESRCH: グループに誰も残っていない。EPERM: 残っているのは終わりかけのものだけ (macOS。canon: facts/deno/command-spawn の測定。終わりかけのグループに EPERM を返さなくなったら、PermissionDenied を外せる)
    if (!(e instanceof Deno.errors.NotFound || e instanceof Deno.errors.PermissionDenied)) throw e;
  }
};
const termed = new WeakSet<Deno.ChildProcess>();
const term = (child: Deno.ChildProcess) => {
  if (termed.has(child)) return;
  termed.add(child);
  killGroup(child, "SIGTERM");
};
/** SIGTERM を送ってから SIGKILL を送るまで、グループの出力の pipe が閉じるのを待つ時間。 */
const graceMs = 2000;
/** 先頭が終わった後のグループを空にする。 */
async function emptyGroup(child: Deno.ChildProcess, outputs: Promise<unknown>) {
  term(child);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([outputs, new Promise((r) => timer = setTimeout(r, graceMs))]);
  } finally {
    clearTimeout(timer);
    killGroup(child, "SIGKILL");
  }
}
/** 中断が始まっていれば、その経路 (終了コードを決めて Deno.exit する。解決しない)。 */
let interruption: Promise<never> | undefined;
const interrupt = async (code: number): Promise<never> => {
  groups.forEach((_, c) => term(c));
  await Promise.all(groups.values());
  Deno.exit(code);
};
for (const [signal, code] of Object.entries(signals) as [Deno.Signal, number][]) {
  Deno.addSignalListener(signal, () => {
    if (!interruption) {
      interruption = interrupt(code);
      return;
    }
    groups.forEach((_, c) => killGroup(c, "SIGKILL"));
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

/** 子を自分のプロセスグループで起動し、終わってグループを空にするまで待つ。 */
async function exec(cmd: string, args: string[], stdin?: Uint8Array): Promise<Run> {
  if (interruption) throw new Error("中断した");
  const child = new Deno.Command(cmd, {
    args,
    detached: true,
    stdin: stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const run = collect(child, cmd, stdin);
  groups.set(child, run.catch(() => {}));
  try {
    return await run;
  } finally {
    groups.delete(child);
  }
}

/** 子の出力を受け、子が終わったらグループを空にする。投げるときも、先頭を止めて回収し、グループを空にしてから投げる。 */
async function collect(child: Deno.ChildProcess, cmd: string, stdin?: Uint8Array): Promise<Run> {
  const outputs = Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).bytes()]);
  let fed: boolean;
  try {
    fed = !stdin || await feed(child.stdin, stdin);
  } catch (e) {
    term(child);
    await child.status;
    await emptyGroup(child, outputs);
    throw e;
  }
  const status = await child.status;
  await emptyGroup(child, outputs);
  const [out, err] = await outputs;
  if (fed || status.code !== 0) return { code: status.code, out, err };
  return { code: 1, out, err: new Uint8Array([...err, ...enc.encode(`${self}: ${cmd} が stdin を読み終える前に閉じた\n`)]) };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** 印字できる ASCII (空白と \ を除く) の他のバイトを \xHH にする。 */
const escapeBytes = (b: Uint8Array) =>
  Array.from(b, (c) => c > 0x20 && c < 0x7f && c !== 0x5c ? String.fromCharCode(c) : `\\x${c.toString(16).padStart(2, "0")}`).join("");

/** git が知っているファイル (作業ツリーの未追跡を含み、無視するものを除く) のうち、pathspec に合うもの。-z でなければ git は非 ASCII の名前を quote して出す (canon: facts/git/path-output-quoting)。git が落ちれば out は空 (落ちた段に一覧を出さない)。out は名前を改行で繋いだもの。 */
async function gitFiles(patterns: string[]): Promise<Run & { files: string[] }> {
  const r = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...patterns]);
  if (r.code !== 0) return { ...r, out: new Uint8Array(), files: [] };
  const files: string[] = [];
  const rejected: Uint8Array[] = [];
  for (let i = 0; i < r.out.length;) {
    const end = r.out.indexOf(0, i);
    const name = r.out.subarray(i, end < 0 ? r.out.length : end);
    i += name.length + 1;
    let f: string | undefined;
    try {
      f = utf8.decode(name);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
    if (f === undefined || f.includes("\n")) rejected.push(name);
    else files.push(f);
  }
  if (rejected.length) {
    return { code: 1, out: new Uint8Array(), err: enc.encode(`${self}: UTF-8 として不正な名前 (引数の文字列で表せない) か改行を含む名前 (1 行 1 件の入力で割れる) のファイルがある。名前を変えるか消す: ${rejected.map(escapeBytes).join(" ")}\n`), files: [] };
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
