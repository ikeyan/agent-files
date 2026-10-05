/**
 * test-codex-limits.ts — skills/setup-repo/pr-workflow/codex-limits.sh を、PATH の先頭に置いた偽の codex (app-server の役) を相手に回し、出力・終了コード・後始末を検査する。verify.sh から呼ぶ。
 *
 * 検査すること:
 * - id 2 の応答 (前に通知を挟む) を、窓ごとのタブ区切りの 3 行にして exit 0 で終わる。値が null の項目・無い項目・null の窓は - になる。stderr は空 (codex の stderr を捨てる)
 * - app-server に送る行は initialize・initialized・account/rateLimits/read の 3 行
 * - app-server が error を返せば exit 1 で、stderr の 1 行目に message を出す
 * - 次の場合は exit 2 で、stderr の 1 行目に理由を出す:
 *   - app-server が何も返さずに終わる・codex が PATH に無い: 応答の前に終わった
 *   - 応答が JSON でない: jq の理由
 *   - jq が PATH に無い: jq に触れる理由
 *   - app-server が応答しない: 30 秒待ってから、30 秒以内に応答しない
 * - 応答しない例の他は、30 秒の timeout を待たずに (5 秒以内に) 終わる
 * - どの場合も、終わった後に app-server (偽物は入力が閉じても終わらない) と codex-limits.sh の一時ディレクトリが残らない
 * ネットワークは使わない (本物の codex を起動しない)。
 *
 * このスクリプトの入力と環境の定義域:
 * - 引数は取らない。渡されれば理由を出して落ちる。
 * - 読む環境変数は PATH・TMPDIR だけ。PATH に bash (bash スクリプトの `#!/usr/bin/env bash` が引く)・jq・mktemp・mkfifo・rm (codex-limits.sh)・cat (偽の codex)・sleep (偽の codex と alive)・mkdir・ln (codex か jq を欠いた PATH を作る準備) があること (codex は要らない)。
 * - TMPDIR (未設定か空なら /tmp) は絶対パスで、作った一時ディレクトリの綴りと解決済みのパスが A-Z a-z 0-9 . _ / - だけであること。外れていれば理由を出して落ちる。
 * - 後始末は、終わったときに一時ディレクトリを消す。SIGINT・SIGTERM では子に SIGTERM を送り、子が終わってから消す (子が書いている最中に消すと消し残す)。codex-limits.sh は SIGTERM でも EXIT trap で app-server を止める (canon: facts/shell/bash-exit-trap-runs-on-fatal-signal)。
 *
 * 並行の検査が共有する、変わりうる状態。これ以外は検査ごとの `${tmp}/f/<n>` の下に置き (codex-limits.sh の TMPDIR と、偽の codex が読み書きする CASE も)、新しく共有するものを足すときも検査ごとのパスにする:
 * - HOME (`${tmp}/home`)。
 * - 偽の codex (`${tmp}/bin/codex`) と、codex か jq を欠いた PATH (`${tmp}/no-codex`・`${tmp}/no-jq`): 準備で作った後は読むだけ。
 *
 * 子の環境は baseEnv と、検査ごとの CASE・TMPDIR・PATH だけ (clearEnv。canon: facts/deno/command-spawn)。
 */

const here = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");
const self = "test-codex-limits.ts";
const script = `${here}/skills/setup-repo/pr-workflow/codex-limits.sh`;
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
const tmp = await Deno.makeTempDir({ dir: tmpdirEnv || "/tmp", prefix: "codex-limits-test." });
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

const baseEnv: Record<string, string> = {
  PATH: Deno.env.get("PATH") ?? "",
  HOME: `${tmp}/home`,
  TMPDIR: tmp,
  // 失敗の理由に出す子の文言を locale に依らせない。clearEnv で locale の環境変数が無くても、macOS では GNU gettext を使う bash などがシステムの言語で訳す (canon: facts/shell/gettext-macos-system-language)
  LC_ALL: "C",
};

// ---- 子プロセス ----

interface Run {
  code: number;
  out: string;
  err: string;
  /** 起動から終わるまでのミリ秒 (同時に動かす数の上限を待つ時間を含まない)。 */
  ms: number;
}

/** 同時に動かす子プロセスの数の上限。検査を全部並行に始め、ここで絞る。 */
const limit = Math.max(1, navigator.hardwareConcurrency);
let active = 0;
const waiters: (() => void)[] = [];

async function exec(cmd: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  while (active >= limit) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    if (interrupted) throw new Error("中断した");
    const start = performance.now();
    const child = new Deno.Command(cmd, {
      args,
      env: { ...baseEnv, ...env },
      // canon: facts/deno/command-spawn — clearEnv は env だけを子に渡す。spawn() の stdin の既定は inherit
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    children.add(child);
    const r = await child.output().finally(() => children.delete(child));
    return { code: r.code, out: dec.decode(r.stdout), err: dec.decode(r.stderr), ms: performance.now() - start };
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/** 準備の bash。落ちれば例外。 */
async function bash(src: string, args: string[], env: Record<string, string> = {}) {
  const r = await exec("bash", ["-c", `set -euo pipefail; ${src}`, "bash", ...args], env);
  if (r.code !== 0) throw new Error(`bash -c '${src}' ${args.join(" ")}: exit ${r.code} — ${r.err}`);
}

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

const fakeCodex = `#!/usr/bin/env bash
# 偽の codex app-server。受けた行を $CASE/in に書き、$CASE/mode ごとに振る舞う:
# - respond: id 1 に応え、id 2 に通知を挟んで $CASE/response を返す。入力が閉じても終わらない (codex-limits.sh が止めることを見る)
# - hang: 応えずに 60 秒眠る
# - exit: 何も返さずに終わる
# stderr にログを出す (codex-limits.sh が捨てることを見る)。
[ "$1" = app-server ] || exit 64
echo $$ > "$CASE/pid"
echo "fake codex: started" >&2
case $(cat "$CASE/mode") in
  hang) exec sleep 60 ;;
  exit) exit 0 ;;
esac
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$CASE/in"
  case $line in
    '{"id":1,'*) echo '{"id":1,"result":{"userAgent":"fake"}}' ;;
    '{"id":2,'*) echo '{"method":"remoteControl/status/changed","params":{"status":"disabled"}}' && cat "$CASE/response" ;;
  esac
done
exec sleep 60
`;
await Deno.mkdir(`${tmp}/bin`);
await Deno.writeTextFile(`${tmp}/bin/codex`, fakeCodex);
await Deno.chmod(`${tmp}/bin/codex`, 0o755);
const fakePath = `${tmp}/bin:${baseEnv.PATH}`;
// PATH のディレクトリを丸ごと除くと mktemp などの要るコマンドも道連れになりうるので、要るコマンドだけを集める。symlink は deno で作ると read・write の許可をパスに絞れないので bash で作る
const gather = (dir: string, names: string[]) => bash('d=$1; shift; mkdir "$d"; for c; do p=$(command -v "$c") || { echo "$c が PATH に無い" >&2; exit 1; }; ln -s "$p" "$d/$c"; done', [dir, ...names], { PATH: fakePath });
await gather(`${tmp}/no-codex`, ["bash", "jq", "mktemp", "mkfifo", "rm"]);
await gather(`${tmp}/no-jq`, ["bash", "codex", "mktemp", "mkfifo", "rm", "cat", "sleep"]);

// ---- 回して照合する ----

/** ファイルの中身。無ければ null で、読めない (権限など) ときは投げる。 */
const readOptional = (path: string) =>
  Deno.readTextFile(path).catch((e) => {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  });

/** 例のディレクトリで codex-limits.sh を回す。mode と response は偽の codex が読む。 */
async function run(t: Ctx, mode: "respond" | "hang" | "exit", response = "", path = fakePath): Promise<Run> {
  await Deno.mkdir(`${t.dir}/tmp`);
  await Deno.writeTextFile(`${t.dir}/mode`, `${mode}\n`);
  await Deno.writeTextFile(`${t.dir}/response`, `${response}\n`);
  return exec(script, [], { CASE: t.dir, TMPDIR: `${t.dir}/tmp`, PATH: path });
}

/** pid が 2 秒のうちに消えなければ真。codex-limits.sh の EXIT trap は kill するだけで終わりを待たない (SIGTERM を無視する app-server で止まらないため) ので、すぐには消えていないことがある。codex-limits.sh が終わりを待つようになれば、poll をやめて 1 回の `kill -0` にする。 */
const alive = async (pid: string) => (await exec("bash", ["-c", 'for _ in {1..20}; do kill -0 "$1" 2> /dev/null || exit 1; sleep 0.1; done', "bash", pid])).code === 0;

/** 終わった後に、app-server と codex-limits.sh の一時ディレクトリが残っていないこと、30 秒の timeout を待ったかを確かめる。 */
async function expectEnded(t: Ctx, r: Run, waited = false) {
  if (waited && r.ms < 29_000) t.fail(`${(r.ms / 1000).toFixed(1)} 秒で終わった — 30 秒の timeout を待っていない`);
  if (!waited && r.ms >= 5_000) t.fail(`${(r.ms / 1000).toFixed(1)} 秒かかった — 30 秒の timeout を待った疑い`);
  const pid = await readOptional(`${t.dir}/pid`);
  if (pid !== null && await alive(pid.trim())) t.fail(`app-server (pid ${pid.trim()}) が残っている`);
  const left: string[] = [];
  for await (const e of Deno.readDir(`${t.dir}/tmp`)) left.push(e.name);
  if (left.length) t.fail(`一時ディレクトリが残っている — ${left.join(" ")}`);
}

/** exit 0 で、stdout が out、stderr が空。 */
async function expectOk(t: Ctx, r: Run, out: string) {
  if (r.code !== 0) t.fail(`終了コード ${r.code} != 0 — stderr ${JSON.stringify(r.err)}`);
  if (r.out !== out) t.fail(`stdout が違う — 期待 ${JSON.stringify(out)} 実際 ${JSON.stringify(r.out)}`);
  if (r.err !== "") t.fail(`stderr が空でない — ${JSON.stringify(r.err)}`);
  await expectEnded(t, r);
}

/** exit code で、stdout が空、stderr の 1 行目が reason (文字列なら一致、正規表現なら合う)。 */
async function expectFail(t: Ctx, r: Run, code: number, reason: string | RegExp, waited = false) {
  if (r.code !== code) t.fail(`終了コード ${r.code} != ${code} — stderr ${JSON.stringify(r.err)}`);
  if (r.out !== "") t.fail(`stdout が空でない — ${JSON.stringify(r.out)}`);
  const line = r.err.split("\n")[0];
  if (typeof reason === "string" ? line !== reason : !reason.test(line)) t.fail(`stderr の 1 行目が違う — 期待 ${typeof reason === "string" ? JSON.stringify(reason) : reason} 実際 ${JSON.stringify(r.err)}`);
  await expectEnded(t, r, waited);
}

const ended = "codex-limits.sh: codex app-server が応答の前に終わった";

// 30 秒かかるので最初に始める
fixture("応答しない", async (t) => {
  await expectFail(t, await run(t, "hang"), 2, "codex-limits.sh: codex app-server が 30 秒以内に応答しない", true);
  if (await readOptional(`${t.dir}/pid`) === null) t.fail("app-server が起動されていない");
});

fixture("全部の値", async (t) => {
  const r = await run(t, "respond", '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":100,"resetsAt":1790000000,"windowDurationMins":300},"secondary":{"usedPercent":41,"resetsAt":1790500000,"windowDurationMins":10080},"rateLimitReachedType":"rate_limit_reached","planType":"business"}}}');
  await expectOk(t, r, "primary\t100\t1790000000\t300\nsecondary\t41\t1790500000\t10080\nreached\trate_limit_reached\n");
  const want = [
    '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"pr-workflow","title":"pr-workflow","version":"0"}}}',
    '{"method":"initialized"}',
    '{"id":2,"method":"account/rateLimits/read","params":null}',
    "",
  ].join("\n");
  const got = await readOptional(`${t.dir}/in`);
  if (got === null) t.fail("app-server が 1 行も受けていない");
  else if (got !== want) t.fail(`app-server に送った行が違う — ${JSON.stringify(got)}`);
});

fixture("null の値と窓", async (t) => {
  const r = await run(t, "respond", '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":0,"resetsAt":null,"windowDurationMins":null},"secondary":null,"rateLimitReachedType":null}}}');
  await expectOk(t, r, "primary\t0\t-\t-\nsecondary\t-\t-\t-\nreached\t-\n");
});

fixture("無い窓と項目", async (t) => {
  await expectOk(t, await run(t, "respond", '{"id":2,"result":{"rateLimits":{}}}'), "primary\t-\t-\t-\nsecondary\t-\t-\t-\nreached\t-\n");
});

fixture("error", async (t) => {
  const r = await run(t, "respond", '{"id":2,"error":{"code":-32603,"message":"failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)"}}');
  await expectFail(t, r, 1, "codex-limits.sh: failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)");
});

fixture("応答が JSON でない", async (t) => {
  await expectFail(t, await run(t, "respond", "not json"), 2, /^jq: /);
});

fixture("何も返さずに終わる", async (t) => {
  await expectFail(t, await run(t, "exit"), 2, ended);
});

fixture("codex が PATH に無い", async (t) => {
  await expectFail(t, await run(t, "respond", "", `${tmp}/no-codex`), 2, ended);
});

fixture("jq が PATH に無い", async (t) => {
  await expectFail(t, await run(t, "respond", '{"id":2,"result":{"rateLimits":{}}}', `${tmp}/no-jq`), 2, /jq/);
});

await Promise.all(pending);
const all = reports.flat();
if (all.length) console.error(all.join("\n"));
Deno.exit(all.length ? 1 : 0);
