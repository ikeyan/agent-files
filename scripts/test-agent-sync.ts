/**
 * test-agent-sync.ts — skills/setup-repo/agent-sync/sync.sh を、このリポの catalog (作業ツリーのもの) から作った手元の上流と、下流のリポを相手に回す。verify.sh から呼ぶ。
 *
 * 検査すること:
 * - 初回: 部品の一覧のファイルを、上流と同じバイトと一覧の mode で置く。一覧の mode は上流の git の mode と同じ。手で写した sync.sh と render.sb は同じバイトなので引き取る。下流の archetype が描画したファイルも置く。
 * - 2 回目は何も変えず、mode のずれと消したファイルは戻す。
 * - 上流の更新 (v1 → v2): 変わったファイルを置き直し、一覧から消えたファイルを消す (ディレクトリは消さず、利用者の空のディレクトリが残る)。
 * - 作業ツリーと git の状態を変えずに落ちる (理由も見る):
 *   - 引数 (exit 2)、入力ファイルの欠け、archetype.yaml の source の行の定義域、generated の定義域・順序・古いパスの種類、answers の欠け。
 *   - 置き先の重複 (別の置き先の親のディレクトリを含む)、置き先の .agent-sync/ の下、一覧の行が定義域の外 (上流のパスの symlink、置き先の途中の symlink を含む)、一覧と描画の不一致、描画の出力のファイル名に改行、描画が .agent-sync/sync.sh を置かない、利用者のファイル。
 *   - 置き先・古いパスの綴り (途中のディレクトリを含む) が既存のものと大文字小文字だけ違う・KELVIN SIGN など Unicode で同じものに当たる、上流の tree が同じものに当たる別のパスを持つ (NFC と NFD を含む)。一時ディレクトリが大文字小文字を区別しないときだけ。区別するときは別のファイルとして通ることを見る。上流の大文字小文字だけの改名は、古い綴りを消すまで前回の出力だと示して落ちる。
 *   - 途中のディレクトリの一覧が取れない (root では飛ばす)、置き先のディレクトリの綴りが大文字小文字だけ違う、生成物の同一性の表の落ちる行 (commit 済みの利用者の編集を含む)。
 *   - ロックが取られている、別のリポの sync.sh の起動、TMPDIR の文字と絶対パス、上流のパスの大文字小文字の衝突、fetch の GIT_TERMINAL_PROMPT、archetect の版、対応していない OS、OS の sandbox を適用できない・描画が非 0 で終わる、リポジトリの場所を決める GIT_* (`git rev-parse --local-env-vars` の各変数)。
 * - 環境:
 *   - awk が正規表現の区間を持たなくても通る。
 *   - GIT_CONFIG* は通る (この test 自身が GIT_CONFIG_COUNT で上流へ向ける)。core.autocrlf・core.eol を変えても、置くバイトは上流の blob と同じ。
 *   - UTF-8 の locale (LANG・LC_ALL) でも通り、文字の分類 (タブ・制御文字・空白・shell の特殊文字・é・あ・ｚ。canon: facts/shell/string-input-categories) ごとに、置き先・source の名前・TMPDIR の定義域の外として落ちる。
 * - 名前が - で始まるパス: 上流の tree にあっても取り出しが通り、置き先・古いパスにあっても置いて消せる。ディレクトリ同士の別名を持つ上流 (大文字小文字を区別しないファイルシステムだけ) は、取り出しで落ちる。
 * - 標準出力は git status --short と同じ。終わった (落ちた) 後にロックが残らない。
 *
 * OS の sandbox を適用できない環境 (別の sandbox の中など) では、最初の実際の描画 (初回) が sync.sh の固定の文言「OS の sandbox を適用できない」で落ちる。そのとき、描画を伴う残りの検査を飛ばしたことを理由と一緒に stderr に出す。CI (環境変数 CI が空でない) では落とす。
 * それ以外では archetect と、macOS では sandbox-exec と otool、Linux では bwrap と ldd が要り、無ければ落ちる。
 * ネットワークは使わない (上流は file システムの上のリポで、sync.sh が取る URL を git の insteadOf で向ける)。
 *
 * 検査は互いに独立に並行で回す。下流のリポは検査ごとに作るか、共有の元 (初回の後・v2 の後・古いパスを足した後) の写しを使い、sync.sh の同時の起動が同じリポのロックに当たらない。上流は最初に全ての commit を作り、後は読むだけ。
 * 子の環境は PATH と下の baseEnv だけ (clearEnv)。hook や rebase --exec から呼ばれても、呼び出し元の GIT_DIR などを子に渡さない。
 */

const here = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");
const url = "https://github.com/ikeyan/agent-files.git";
const noSandboxMsg = "agent-sync: OS の sandbox を適用できない";
const clash = "綴りの違う既存の";
const self = "test-agent-sync.ts";
const enc = new TextEncoder();
const dec = new TextDecoder();

const tmp = await Deno.realPath(await Deno.makeTempDir({ dir: Deno.env.get("TMPDIR") || "/tmp", prefix: "agent-sync-test." }));
const cleanup = () => {
  try {
    Deno.removeSync(tmp, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
};
addEventListener("unload", cleanup);
addEventListener("unhandledrejection", cleanup);
Deno.addSignalListener("SIGINT", () => Deno.exit(130));
Deno.addSignalListener("SIGTERM", () => Deno.exit(143));

const baseEnv: Record<string, string> = {
  PATH: Deno.env.get("PATH") ?? "",
  HOME: `${tmp}/home`,
  TMPDIR: tmp,
  GIT_CONFIG_GLOBAL: `${here}/scripts/test-gitconfig`,
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: `url.${tmp}/upstream.insteadOf`,
  GIT_CONFIG_VALUE_0: url,
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
  bytes: Uint8Array;
}

/** 同時に動かす子プロセスの数の上限。検査を全部並行に始め、ここで絞る。 */
const limit = Math.max(1, navigator.hardwareConcurrency);
let active = 0;
const waiters: (() => void)[] = [];

async function exec(cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string>; input?: string } = {}): Promise<Run> {
  while (active >= limit) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    const child = new Deno.Command(cmd, {
      args,
      cwd: o.cwd,
      env: { ...baseEnv, ...o.env },
      clearEnv: true,
      stdin: o.input === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (o.input !== undefined) {
      const w = child.stdin.getWriter();
      await w.write(enc.encode(o.input));
      await w.close();
    }
    const r = await child.output();
    return { code: r.code, out: dec.decode(r.stdout), err: dec.decode(r.stderr), bytes: r.stdout };
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/** 準備の git。落ちれば例外 (その検査を落とす)。 */
async function gitRun(dir: string, args: string[], o: { env?: Record<string, string>; input?: string } = {}): Promise<Run> {
  const r = await exec("git", ["-C", dir, ...args], o);
  if (r.code !== 0) throw new Error(`git -C ${dir} ${args.join(" ")}: exit ${r.code} — ${r.err}`);
  return r;
}
const git = async (dir: string, args: string[], o: { env?: Record<string, string>; input?: string } = {}) => (await gitRun(dir, args, o)).out;

/** 使い方の形 (リポの中で `./.agent-sync/sync.sh`) で起動する。Deno は相対パスのコマンドを絶対パスにして起動するので、$0 を保つよう env を通す。 */
const sync = (d: string, env: Record<string, string> = {}, args: string[] = []) =>
  exec("env", ["./.agent-sync/sync.sh", ...args], { cwd: d, env });

// ---- ファイル ----

/** 末尾の改行を全て落とす。 */
const chomp = (s: string) => s.replace(/\n+$/, "");

async function write(path: string, content: string, mode?: number) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, content);
  if (mode !== undefined) await Deno.chmod(path, mode);
}
const append = (path: string, content: string) => Deno.writeTextFile(path, content, { append: true });
const readOr = (path: string) => Deno.readTextFile(path).catch(() => "");
const lstatOr = (path: string) => Deno.lstat(path).catch(() => null);
const statOr = (path: string) => Deno.stat(path).catch(() => null);
/** 在るか (symlink の先を見る)。 */
const exists = async (path: string) => (await statOr(path)) !== null;
/** 在るか (symlink そのものを見る)。 */
const present = async (path: string) => (await lstatOr(path)) !== null;
/** 所有者として実行できるか (symlink の先を見る)。 */
const executable = async (path: string) => ((await statOr(path))?.mode ?? 0) & 0o100 ? true : false;
const sameBytes = async (a: Uint8Array, path: string) => {
  const b = await Deno.readFile(path).catch(() => null);
  return b !== null && a.length === b.length && a.every((x, i) => x === b[i]);
};

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

/** 1 行 1 件のファイルの行を書き換える (末尾の改行を保つ)。 */
async function editLines(path: string, f: (lines: string[]) => string[]) {
  const lines = (await Deno.readTextFile(path)).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const out = f(lines);
  await Deno.writeTextFile(path, out.length ? out.join("\n") + "\n" : "");
}

/** .git の外の全てのファイルの種類・実行可能か・中身 (ディレクトリそのものは出さず、一覧が取れないディレクトリの下は出さない)。 */
async function snapshot(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (rel: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(`${root}${rel}`));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const p = `${rel}/${e.name}`;
      const st = await Deno.lstat(`${root}${p}`);
      if (st.isSymlink) lines.push(`L .${p} ${await Deno.readLink(`${root}${p}`)}`);
      else if (st.isFile) {
        lines.push(`${(st.mode ?? 0) & 0o100 ? "x" : "-"} .${p} ${await sha256(await Deno.readFile(`${root}${p}`))}`);
      } else if (st.isDirectory) await walk(p);
    }
  };
  await walk("");
  return lines.sort().join("\n");
}

/** PATH の中の、その名前の実行可能な通常のファイル。 */
async function which(name: string): Promise<string | null> {
  for (const d of baseEnv.PATH.split(":")) {
    if (!d) continue;
    const st = await statOr(`${d}/${name}`);
    if (st?.isFile && (st.mode ?? 0) & 0o111) return `${d}/${name}`;
  }
  return null;
}

// ---- 検査の単位 ----

interface Ctx {
  dir: string;
  fail(msg: string): void;
}
class BaseFailed extends Error {}
const reports: string[][] = [];
const pending: Promise<unknown>[] = [];
let seq = 0;

/** 検査を始める。独立に並行で回り、落ちた理由を登録の順で最後に出す。返り値は後の検査の前提に使う。 */
function fixture<T>(name: string, body: (t: Ctx) => Promise<T>): Promise<T> {
  const failures: string[] = [];
  reports.push(failures);
  const dir = `${tmp}/f/${seq++}`;
  const p = (async () => {
    await Deno.mkdir(dir, { recursive: true });
    return await body({ dir, fail: (m) => failures.push(m) });
  })().catch((e) => {
    failures.push(e instanceof BaseFailed ? `${name}: 前提の ${e.message} が落ちたので回せない` : `${name}: 例外 — ${e instanceof Error ? e.stack : e}`);
    throw new BaseFailed(name);
  });
  pending.push(p.catch(() => {}));
  return p;
}

const settled = () => Promise.all(pending);

function report(): number {
  const all = reports.flat();
  if (all.length) console.error(all.join("\n"));
  return all.length ? 1 : 0;
}

// ---- sync.sh の観察 ----

async function porcelain(d: string) {
  return await git(d, ["status", "--porcelain"]);
}

/** ディレクトリの下のファイルのパスと中身。skip が真の相対パス (/ で始まる) の下は見ない。 */
async function filesUnder(dir: string, skip: (rel: string) => boolean = () => false): Promise<string> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for await (const e of Deno.readDir(`${dir}${rel}`)) {
      const p = `${rel}/${e.name}`;
      if (skip(p)) continue;
      if (e.isDirectory) await walk(p);
      else if (e.isFile) out.push(`${p} ${await sha256(await Deno.readFile(`${dir}${p}`))}`);
    }
  };
  await walk("");
  return out.sort().join("\n");
}

/** .git の下のうち、落ちた sync.sh が変えてはならないもの (index は git status が書き直し、objects は大きいので見ない)。 */
const gitDirState = (d: string) => filesUnder(`${d}/.git`, (p) => p === "/index" || p === "/objects");

/** git status の出力と終了状態 (一覧が取れないディレクトリがあっても比べられるよう、落ちても例外にしない)。 */
const gitState = async (d: string) => {
  const r = await exec("git", ["-C", d, "status", "--porcelain"]);
  return `${r.code}\n${r.out}`;
};

/** sync.sh が落ち、作業ツリーと git の状態 (index と .git の下を含む) を変えず、理由を示す。 */
async function expectFail(t: Ctx, name: string, d: string, want: string, env: Record<string, string> = {}): Promise<Run> {
  const before = await snapshot(d);
  const stateBefore = await gitState(d);
  const gitDirBefore = await gitDirState(d);
  const lock = `${d}/.git/agent-sync.lock`;
  const had = await present(lock);
  const r = await sync(d, env);
  if (r.code === 0) t.fail(`${name}: sync.sh が通った`);
  if (await snapshot(d) !== before) t.fail(`${name}: 落ちた sync.sh が作業ツリーを変えた`);
  if (await gitDirState(d) !== gitDirBefore) t.fail(`${name}: 落ちた sync.sh が .git の下を変えた`);
  if (await gitState(d) !== stateBefore) t.fail(`${name}: 落ちた sync.sh が git の状態を変えた`);
  const has = await present(lock);
  if (has && !had) t.fail(`${name}: 落ちた sync.sh がロックを残した`);
  if (!has && had) t.fail(`${name}: 他の起動のロックを消した`);
  if (!r.err.includes(want)) t.fail(`${name}: stderr に「${want}」が無い — ${r.err}`);
  return r;
}

/** 通り、標準出力が git status --short と同じで、ロックを残さない。 */
async function syncOk(t: Ctx, name: string, d: string, env: Record<string, string> = {}): Promise<Run> {
  const r = await sync(d, env);
  await checkOk(t, name, d, r);
  return r;
}

async function checkOk(t: Ctx, name: string, d: string, r: Run) {
  if (r.code !== 0) t.fail(`${name}: sync.sh が落ちた — ${r.err}`);
  if (chomp(r.out) !== chomp(await git(d, ["status", "--short"]))) t.fail(`${name}: 標準出力が git status --short と違う — ${r.out}`);
  if (await present(`${d}/.git/agent-sync.lock`)) t.fail(`${name}: ロックが残った`);
}

/** 作業ツリーが commit と同じ。 */
async function clean(t: Ctx, name: string, d: string) {
  const s = await porcelain(d);
  if (s) t.fail(`${name}: 作業ツリーが変わった — ${s}`);
}

// ---- 準備 ----

const ciFs = await (async () => {
  // 一時ディレクトリのファイルシステムが大文字小文字を区別しないか (macOS の APFS の既定)。検査の環境の選択で、sync.sh の挙動の分岐ではない。
  await Deno.writeTextFile(`${tmp}/CaseProbe`, "");
  const r = await exists(`${tmp}/caseprobe`);
  await Deno.remove(`${tmp}/CaseProbe`);
  return r;
})();

const tools = Deno.build.os === "darwin"
  ? ["archetect", "sandbox-exec", "otool"]
  : Deno.build.os === "linux"
  ? ["archetect", "bwrap", "ldd"]
  : ["archetect", `unsupported-os-${Deno.build.os}`];
for (const name of tools) {
  if (!(await which(name))) {
    console.error(`${self}: ${name} が PATH に無い (AGENTS.md「このリポの検証」の必要なもの)`);
    Deno.exit(1);
  }
}
await Deno.mkdir(baseEnv.HOME);

/** 元の作業ツリーの、追跡しているか無視されていないファイルを先へ写す (symlink は symlink のまま)。 */
async function copyTracked(from: string, to: string, paths: string[]) {
  const list = (await git(from, ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", ...paths])).split("\0").filter(Boolean);
  for (const p of list) {
    const st = await lstatOr(`${from}/${p}`);
    if (!st) continue;
    await Deno.mkdir(`${to}/${p}`.replace(/\/[^/]*$/, ""), { recursive: true });
    if (st.isSymlink) await Deno.symlink(await Deno.readLink(`${from}/${p}`), `${to}/${p}`);
    else {
      await Deno.copyFile(`${from}/${p}`, `${to}/${p}`);
      await Deno.chmod(`${to}/${p}`, (st.mode ?? 0o644) & 0o777);
    }
  }
}

// 上流: このリポの作業ツリーの catalog と、一覧が指すファイルに、sandbox の外へ出ようとする検査用の部品 probe を足したもの
const up = `${tmp}/upstream`;
await Deno.mkdir(`${tmp}/outside`);
await copyTracked(here, up, ["archetype.yaml", "components", "hooks", "skills/setup-repo"]);
await Deno.writeTextFile(`${tmp}/secret.txt`, "secret\n");
await append(`${up}/archetype.yaml`, "  probe:\n    source: ./components/probe\n");
await write(`${up}/components/probe/archetype.yaml`, "description: probe\n");
await write(
  `${up}/components/probe/archetype.lua`,
  `local context = Context.new()
print("lua-stdout")
local results = {}
local function try(name, f)
  local ok, r = pcall(f)
  results[#results + 1] = name .. ": " .. tostring(ok and r)
end
try("write-outside", function()
  local h = io.open("${tmp}/outside/written", "w")
  if h then h:write("x"); h:close(); return "written" end
end)
try("read-outside", function()
  local h = io.open("${tmp}/secret.txt")
  if h then local s = h:read("a"); h:close(); return s end
end)
try("os.execute", function() return os.execute("/usr/bin/touch ${tmp}/outside/executed") end)
try("io.popen", function()
  local h = io.popen("/usr/bin/id")
  if h then local s = h:read("a"); h:close(); if s ~= "" then return s end end
end)
context:set("results", table.concat(results, "\\n"))
directory.render("content", context, { if_exists = Existing.Error })
return context
`,
);
await write(`${up}/components/probe/content/probe.txt`, "{{ results }}\n");
await write(`${up}/components/probe/content/.agent-sync/files/probe`, "-\tprobe.txt\t644\n");
await Deno.symlink("pre-push", `${up}/hooks/link`);
await Deno.symlink("hooks", `${up}/hlink`);
await git(up, ["init", "-q", "-b", "main"]);
await git(up, ["add", "-A"]);
await git(up, ["commit", "-q", "-m", "v1"]);
const v1 = chomp(await git(up, ["rev-parse", "HEAD"]));
const lists = chomp(await git(up, ["ls-tree", "-r", "--name-only", v1, "--", "components"])).split("\n")
  .filter((p) => /\/content\/\.agent-sync\/files\//.test(p) && !p.startsWith("components/probe/")).sort();
if (!lists.length) {
  console.error("上流に部品の一覧が無い");
  Deno.exit(1);
}

// 上流の tree が、ファイルシステムの同じものに当たる別のパスを持てば、何も残さず落ちる (macOS の APFS の既定のように大文字小文字と Unicode の正規化を同一視するファイルシステムでは、後の blob が先のものを上書きする)。綴りの規則を再現せず、置く前に在るかをファイルシステムに聞くので、KELVIN SIGN (U+212A) の K と ASCII の K、NFC と NFD の é も落ちる。
// macOS の作業ツリーでは両方を置けないので、git のオブジェクトを直接作る。どの ref からも届かない commit を sha で取る。区別するファイルシステムでは別のパスとして置かれるので、衝突の fixture は同一視するときだけ。
const blobA = chomp(await git(up, ["hash-object", "-w", "--stdin"], { input: "a\n" }));
const blobB = chomp(await git(up, ["hash-object", "-w", "--stdin"], { input: "b\n" }));
const kelvin = "\u212a";
const mktree = async (entries: string) => chomp(await git(up, ["mktree"], { input: entries }));
const treeCommit = async (name: string, entries: string) => chomp(await git(up, ["commit-tree", await mktree(entries), "-m", name]));
const twoFiles = async (a: string, b: string) => `040000 tree ${await mktree(`100644 blob ${blobA}\t${a}\n100644 blob ${blobB}\t${b}\n`)}\tx\n`;
const subDir = await mktree(`100644 blob ${blobB}\tx\n`);
const cNl = chomp(await git(up, ["commit-tree", chomp(await git(up, ["mktree", "-z"], { input: `100644 blob ${blobA}\ta\nb\0` })), "-m", "newline"]));
const collisions: [string, string, string][] = [["newline", cNl, "に改行がある"]];
if (ciFs) {
  const dirA = await mktree(`100644 blob ${blobA}\ta.txt\n`);
  const dirB = await mktree(`100644 blob ${blobB}\tb.txt\n`);
  const xTree = await mktree(`040000 tree ${dirA}\tFoo\n040000 tree ${dirB}\tfoo\n`);
  collisions.unshift(
    ["file-file", await treeCommit("file-file", await twoFiles("README.md", "readme.md")), "上流のパス x/readme.md がファイルシステム上で別のパスと同じものに当たる"],
    ["file-dir", await treeCommit("file-dir", `100644 blob ${blobA}\tFoo\n040000 tree ${subDir}\tfoo\n`), "上流のパス foo/x の途中のディレクトリが、ファイルシステム上で別のパスと同じものに当たる"],
    ["dir-dir", await treeCommit("dir-dir", `040000 tree ${xTree}\tx\n`), "上流のパス x/foo/b.txt の途中のディレクトリが、ファイルシステム上で別のパスと同じものに当たる"],
    ["dir-file", await treeCommit("dir-file", `040000 tree ${subDir}\tFoo\n100644 blob ${blobA}\tfoo\n`), "上流のパス foo がファイルシステム上で別のパスと同じものに当たる"],
    ["kelvin", await treeCommit("kelvin", await twoFiles("K.txt", `${kelvin}.txt`)), "がファイルシステム上で別のパスと同じものに当たる"],
    ["nfc-nfd", await treeCommit("nfc-nfd", await twoFiles("\u00e9.txt", "e\u0301.txt")), "がファイルシステム上で別のパスと同じものに当たる"],
  );
}

// 名前が - で始まる上流のパス (-x/y と --help/x) を v1 に足した commit
const dashIndex = { GIT_INDEX_FILE: `${tmp}/dash.index` };
await git(up, ["read-tree", v1], { env: dashIndex });
await git(up, ["update-index", "--add", "--cacheinfo", `100644,${blobA},-x/y`, "--cacheinfo", `100644,${blobA},--help/x`], { env: dashIndex });
const cDash = chomp(await git(up, ["commit-tree", chomp(await git(up, ["write-tree"], { env: dashIndex })), "-m", "dash"]));

// v2: hooks/pre-push を変え、codex-limits.sh を一覧から消す
await append(`${up}/hooks/pre-push`, "# v2\n");
await editLines(`${up}/components/pr-workflow/content/.agent-sync/files/pr-workflow`, (ls) => ls.filter((l) => !l.includes("codex-limits.sh")));
await git(up, ["commit", "-q", "-am", "v2"]);
const v2 = chomp(await git(up, ["rev-parse", "HEAD"]));

// ---- shim ----

const realGit = (await which("git"))!;
const realAwk = (await which("awk"))!;
const realUname = (await which("uname"))!;
const shim = async (dir: string, name: string, body: string) => await write(`${tmp}/${dir}/${name}`, body, 0o755);
// OS の sandbox を適用できなければ、固定の文言で落ちる (sandbox-exec・bwrap を、対象を起動する前に失敗する起動側の出力と終了状態の shim に替える)。文言の無い非 0 は、描画の失敗として落ちる
await shim("shim-sb", "sandbox-exec", '#!/bin/sh\necho "sandbox-exec: sandbox_apply: Operation not permitted" >&2\nexit 71\n');
await shim("shim-sb", "bwrap", '#!/bin/sh\necho "bwrap: No permissions to create new namespace" >&2\nexit 1\n');
await shim("shim-sb-plain", "sandbox-exec", "#!/bin/sh\nexit 71\n");
await shim("shim-sb-plain", "bwrap", "#!/bin/sh\nexit 1\n");
// 起動コマンドだけが無い PATH (sync.sh が他に使うコマンドは残す)
await Deno.mkdir(`${tmp}/shim-nolauncher`);
for (const d of baseEnv.PATH.split(":")) {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(d || "/"));
  } catch {
    continue;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "sandbox-exec" || e.name === "bwrap") continue;
    const st = await statOr(`${d}/${e.name}`);
    if (!st?.isFile || !((st.mode ?? 0) & 0o111)) continue;
    await Deno.symlink(`${d}/${e.name}`, `${tmp}/shim-nolauncher/${e.name}`).catch(() => {});
  }
}
// fetch のときの GIT_TERMINAL_PROMPT を FETCH_PROMPT_LOG に記録する git
await shim(
  "shim-git",
  "git",
  `#!/bin/sh
for a in "$@"; do
  [ "$a" = fetch ] && echo "\${GIT_TERMINAL_PROMPT-unset}" >>"$FETCH_PROMPT_LOG"
done
exec "${realGit}" "$@"
`,
);
// awk が正規表現の区間 {n} を持たない (mawk 1.3.4-20200724 より前。canon: facts/shell/awk-interval-expressions)。区間を含むプログラムを拒む
await shim(
  "shim-awk",
  "awk",
  `#!/bin/sh
for a in "$@"; do
  if printf '%s\\n' "$a" | grep -qE '[]a-z0-9)]\\{[0-9]+(,[0-9]*)?\\}'; then echo "awk: 区間表現を含むプログラム" >&2; exit 2; fi
done
exec "${realAwk}" "$@"
`,
);
await shim("shim-ver", "archetect", "#!/bin/sh\necho archetect 3.6.0\n");
await shim(
  "shim-os",
  "uname",
  `#!/bin/sh
[ "$1" = -s ] && { echo Plan9; exit 0; }
exec "${realUname}" "$@"
`,
);
// 手順 4 の mv を、MV_FAIL_AT 番目か、最後の引数が MV_FAIL_PAT に合うときに失敗させる
await shim(
  "shim-mv",
  "mv",
  `#!/bin/sh
n=$(cat "$MV_COUNT" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" >"$MV_COUNT"
for last; do :; done
case $last in $MV_FAIL_PAT) echo "mv: 疑似の失敗" >&2; exit 1 ;; esac
[ "$n" != "$MV_FAIL_AT" ] || { echo "mv: 疑似の失敗" >&2; exit 1; }
exec /bin/mv "$@"
`,
);
const withPath = (dir: string) => ({ PATH: `${tmp}/${dir}:${baseEnv.PATH}` });

const loc = await (async () => {
  const avail = (await exec("locale", ["-a"])).out.split("\n").map((l) => l.toLowerCase());
  return ["en_US.UTF-8", "en_US.utf8", "ja_JP.UTF-8", "ja_JP.utf8", "C.UTF-8", "C.utf8"].find((l) => avail.includes(l.toLowerCase()));
})();
if (!loc) console.error(`${self}: UTF-8 の locale が無いので、locale の検査を飛ばした`);
const locEnv: Record<string, string> = loc ? { LC_ALL: loc, LANG: loc } : {};

// ---- 下流 ----

const pinYaml = (sha: string) => `description: test downstream\ncatalog:\n  agent-files:\n    source: ${url}#${sha}\n`;

/** 手で sync.sh と render.sb を写した下流のリポを作る。 */
async function makeDs(d: string, sha: string) {
  await exec("git", ["init", "-q", "-b", "main", d]);
  const a = `${d}/.agent-sync`;
  await write(`${a}/archetype/archetype.yaml`, pinYaml(sha));
  await write(
    `${a}/archetype/archetype.lua`,
    `local context = Context.new()
context:prompt_text("Project:", "project")
directory.render("content", context, { if_exists = Existing.Error })
context:merge(catalog.render("agent-files/agent-sync", context))
context:merge(catalog.render("agent-files/pre-push", context))
context:merge(catalog.render("agent-files/pr-workflow", context))
return context
`,
  );
  await write(`${a}/archetype/content/NOTICE.txt`, "project {{ project }}\n");
  await write(`${a}/archetype/content/.agent-sync/files/local`, "-\tNOTICE.txt\t644\n");
  await write(`${a}/answers.yaml`, "project: demo\n");
  await write(`${a}/generated`, "");
  for (const f of ["sync.sh", "render.sb"]) {
    const src = `${here}/skills/setup-repo/agent-sync/${f}`;
    await Deno.copyFile(src, `${a}/${f}`);
    await Deno.chmod(`${a}/${f}`, (await Deno.stat(src)).mode! & 0o777);
  }
  await write(`${d}/hooks/pre-push.local`, "#!/bin/sh\nexit 0\n", 0o755);
  await write(`${d}/.gitignore`, ".env\n");
  await write(`${d}/.env`, "secret\n");
  await git(d, ["add", "-A"]);
  await git(d, ["commit", "-q", "-m", "init"]);
}

/** 共有の元のリポを、この検査だけの場所へ写す。 */
async function copyOf(t: Ctx, base: Promise<string>, name = "ds"): Promise<string> {
  const d = `${t.dir}/${name}`;
  const r = await exec("cp", ["-Rp", await base, d]);
  if (r.code !== 0) throw new Error(`cp: ${r.err}`);
  return d;
}

const textId = async (s: string) => chomp(await git(tmp, ["hash-object", "--stdin"], { input: `${s}\n` }));
const blobId = async (rev: string, path: string) => chomp(await git(up, ["rev-parse", `${rev}:${path}`]));
const blobBytes = async (rev: string, path: string) => (await gitRun(up, ["cat-file", "blob", `${rev}:${path}`])).bytes;

/** 一覧のファイルが、その rev の blob と同じバイトと一覧の mode で置かれている。 */
async function checkPlaced(t: Ctx, name: string, d: string, rev: string) {
  for (const list of lists) {
    for (const line of chomp(await git(up, ["show", `${rev}:${list}`])).split("\n")) {
      const [from, dest, mode] = line.split("\t");
      const wantMode = (await git(up, ["ls-tree", rev, "--", from])).slice(0, 6);
      if (wantMode !== `100${mode}`) t.fail(`${list}: ${from} の mode ${mode} が上流の git の mode (${wantMode}) と違う`);
      if (!(await sameBytes(await blobBytes(rev, from), `${d}/${dest}`))) t.fail(`${name}: ${d}/${dest} が上流の ${from} と違う`);
      if ((await executable(`${d}/${dest}`)) !== (mode === "755")) t.fail(`${name}: ${d}/${dest} の mode が ${mode} でない`);
    }
  }
}

const setPin = (d: string, from: string, to: string) =>
  editLines(`${d}/.agent-sync/archetype/archetype.yaml`, (ls) => ls.map((l) => l.replace(new RegExp(`#${from}$`), `#${to}`)));
const localList = (d: string) => `${d}/.agent-sync/archetype/content/.agent-sync/files/local`;
const lua = (d: string) => `${d}/.agent-sync/archetype/archetype.lua`;
const generated = (d: string) => `${d}/.agent-sync/generated`;

// ---- 描画を伴わない検査 (初回の描画の前に落ちる) ----

fixture("OS の sandbox", async (t) => {
  const d = `${t.dir}/nosb`;
  await makeDs(d, v1);
  await expectFail(t, "OS の sandbox を適用できない", d, noSandboxMsg, withPath("shim-sb"));
  const plain = await expectFail(t, "文言の無い起動側の失敗は描画の失敗", d, "描画が exit", withPath("shim-sb-plain"));
  if (plain.err.includes(noSandboxMsg)) t.fail("文言の無い起動側の失敗が、OS の sandbox を適用できないとされた");
  const nol = await expectFail(t, "起動コマンドが PATH に無い", d, "描画を起動できない", { PATH: `${tmp}/shim-nolauncher` });
  if (nol.err.includes(noSandboxMsg)) t.fail("起動コマンドが無い失敗が、OS の sandbox を適用できないとされた");
});

for (const [cname, csha, cwant] of collisions) {
  fixture(`上流のパスの衝突 ${cname}`, async (t) => {
    const d = `${t.dir}/collide`;
    await makeDs(d, csha);
    await expectFail(t, `上流のパスの衝突 ${cname}`, d, cwant);
  });
}

// fetch は GIT_TERMINAL_PROMPT=0 で呼ばれる (環境に GIT_TERMINAL_PROMPT=1 があっても。排他を握ったまま端末で資格情報を待たない)
fixture("fetch の GIT_TERMINAL_PROMPT", async (t) => {
  const d = `${t.dir}/prompt`;
  await makeDs(d, v1);
  await expectFail(t, "fetch の GIT_TERMINAL_PROMPT", d, "OS の sandbox を適用できない", {
    PATH: `${tmp}/shim-git:${tmp}/shim-sb:${baseEnv.PATH}`,
    GIT_TERMINAL_PROMPT: "1",
    FETCH_PROMPT_LOG: `${t.dir}/fetch-prompt.txt`,
  });
  const got = chomp(await readOr(`${t.dir}/fetch-prompt.txt`));
  if (got !== "0") t.fail(`fetch の GIT_TERMINAL_PROMPT が 0 でない — ${got}`);
  // TMPDIR は絶対パス。相対パスなら、作業ディレクトリが cwd (リポの中) にできる前に落ちる
  await expectFail(t, "TMPDIR が相対パス", d, "絶対パスでない", { TMPDIR: "." });
  await expectFail(t, "TMPDIR が相対パス (ディレクトリ名)", d, "絶対パスでない", { TMPDIR: "sub/dir" });
});

// ---- 初回 ----
// 最初の実際の描画が OS の sandbox を適用できずに落ちたとき、CI (CI が空でない) なら落とし、そうでなければ描画を伴う残りの検査を飛ばす。
// 外せる条件: Claude Code の sandbox の中でも入れ子の sandbox-exec が通るようになれば、この分岐は動かない。分岐ごと消す。

type First = { skip: string } | { base: string; snap: string };
const first = fixture<First>("初回", async (t) => {
  const d = `${t.dir}/ds`;
  await makeDs(d, v1);
  const r = await sync(d);
  if (r.err.includes(noSandboxMsg)) return { skip: r.err };
  await checkOk(t, "初回", d, r);
  await checkPlaced(t, "初回", d, v1);
  if (chomp(await readOr(`${d}/NOTICE.txt`)) !== "project demo") t.fail("初回: 下流の archetype が描画した NOTICE.txt が違う");
  // generated は <置き先><TAB><置いたバイトの id>。上流のバイトの id と、下流が描画した NOTICE.txt のバイトの id
  const want: string[] = [];
  for (const list of lists) {
    for (const line of chomp(await git(up, ["show", `${v1}:${list}`])).split("\n")) {
      const [from, dest] = line.split("\t");
      want.push(`${dest}\t${await blobId(v1, from)}`);
    }
  }
  want.push(`NOTICE.txt\t${await textId("project demo")}`);
  const gen = chomp(await Deno.readTextFile(generated(d)));
  if (gen !== want.sort().join("\n")) t.fail(`初回: generated が <置き先><TAB><id> の一覧でない — ${gen}`);
  if (await git(d, ["status", "--porcelain", "--", ".agent-sync/sync.sh", ".agent-sync/render.sb", ".env", "hooks/pre-push.local"])) {
    t.fail("初回: 手で写した sync.sh・render.sb か、下流のファイルが変わった");
  }
  if (await exists(`${d}/.agent-sync/files`)) t.fail("初回: 一覧そのものを作業ツリーに置いた");
  const snap = await snapshot(d);
  await git(d, ["add", "-A"]);
  await git(d, ["commit", "-q", "-m", "sync"]);
  return { base: d, snap };
});

const init = await first.catch(() => null);
if (init && "skip" in init) {
  await settled();
  if (Deno.env.get("CI")) {
    console.error(`${self}: CI で OS の sandbox を適用できない — ${init.skip}`);
    Deno.exit(1);
  }
  const tail = chomp(init.skip).split("\n").slice(-3).join(" ");
  console.error(`${self}: 初回の描画で OS の sandbox を適用できなかった (${tail}) ので、描画を伴う残りの検査を飛ばした。適用できる環境 (別の sandbox の外や CI) で回すと全部を検査する`);
  Deno.exit(report());
}

// ---- 描画を伴う検査 ----

/** 前提の値を取り出す。Deno は未処理の reject でプロセスを終えるので、前提が待つ検査より先に落ちても終わらないよう handler を付けておく。 */
const derive = <T, U>(p: Promise<T>, f: (v: T) => U): Promise<U> => {
  const q = p.then(f);
  q.catch(() => {});
  return q;
};
const v1Base = derive(first, (f) => (f as { base: string }).base);
const firstSnap = derive(first, (f) => (f as { snap: string }).snap);

/** v1 の生成物を置いて commit した下流の写しで、通り何も変えない。 */
const okOnCopy = (name: string, prepare: (d: string, t: Ctx) => Promise<Record<string, string>>) =>
  fixture(name, async (t) => {
    const d = await copyOf(t, v1Base);
    await syncOk(t, name, d, await prepare(d, t));
    await clean(t, name, d);
  });

okOnCopy("2回目", async () => ({}));
okOnCopy("awk が区間を持たない", async () => withPath("shim-awk"));
if (loc) okOnCopy(`locale ${loc}`, async () => locEnv);
okOnCopy("GIT_DEFAULT_HASH=sha256", async () => ({ GIT_DEFAULT_HASH: "sha256" }));
okOnCopy("GIT_TEMPLATE_DIR", async (_d, t) => {
  await write(`${t.dir}/git-template/hooks/reference-transaction`, "#!/bin/sh\nexit 1\n", 0o755);
  return { GIT_TEMPLATE_DIR: `${t.dir}/git-template` };
});
okOnCopy("mode のずれと消したファイル", async (d) => {
  await Deno.chmod(`${d}/hooks/pre-push`, 0o644);
  await Deno.chmod(`${d}/.claude/skills/pr-workflow/SKILL.md`, 0o755);
  await Deno.remove(`${d}/.claude/skills/pr-workflow/gh.md`);
  return {};
});

/** v1 の写しを prepare で変えて、落ちることを見る。 */
const failOnCopy = (name: string, want: string, prepare: (d: string, t: Ctx) => Promise<Record<string, string> | void>) =>
  fixture(name, async (t) => {
    const d = await copyOf(t, v1Base);
    await expectFail(t, name, d, want, (await prepare(d, t)) ?? {});
  });

failOnCopy("answers の欠け", "project", (d) => Deno.writeTextFile(`${d}/.agent-sync/answers.yaml`, "{}\n"));

// 一覧の行は下流の一覧に足す (作業ツリーの archetype を描画に渡す)
const listRows: [string, string][] = [
  ["hooks/pre-push\thooks/pre-push\t755", "置き先が重複している"],
  ["hooks/pre-push\tHOOKS/pre-push\t755", "置き先が重複している"],
  ["-\tNOTICE.txt\t644", "置き先が重複している"],
  ["/etc/passwd\tpasswd\t644", "上流のパスが定義域の外"],
  ["hooks/../hooks/pre-push\tx\t644", "上流のパスが定義域の外"],
  ["hooks/pre-push\t../x\t644", "置き先のパスが定義域の外"],
  ["hooks/pre-push\t.git/hooks/pre-push\t755", "置き先のパスが定義域の外"],
  ["hooks/pre-push\t.GIT/x\t755", "置き先のパスが定義域の外"],
  ["hooks/pre-push\tx y\t644", "置き先のパスが定義域の外"],
  ["hooks/pre-push\tfoo\t644\nhooks/pre-push\tfoo/bar\t644", "の親のディレクトリ"],
  ["hooks/pre-push\tfoo/bar\t644\nhooks/pre-push\tfoo\t644", "の親のディレクトリ"],
  ["hooks/pre-push\tFOO/bar\t644\nhooks/pre-push\tfoo\t644", "の親のディレクトリ"],
  ["hooks/pre-push\tDocs/b.md\t644\nhooks/pre-push\tdocs/a.md\t644", "ディレクトリの綴りが大文字小文字だけ違う"],
  ["hooks/pre-push\tdocs/a.md\t644\nhooks/pre-push\tDOCS/b/c.md\t644", "ディレクトリの綴りが大文字小文字だけ違う"],
  ["hooks/pre-push\thooks\t644", "の親のディレクトリ"],
  ["hooks/pre-push\tNOTICE.txt/x\t644", "の親のディレクトリ"],
  ["hooks/pre-push\t.agent-sync/answers.yaml\t644", "置いてよい 2 つ"],
  ["hooks/pre-push\t.agent-sync/archetype/archetype.lua\t644", "置いてよい 2 つ"],
  ["hooks/pre-push\t.agent-sync/generated\t644", "置いてよい 2 つ"],
  ["hooks/pre-push\t.AGENT-SYNC/sync.sh\t644", "置いてよい 2 つ"],
  ["hooks/pre-push\t.agent-sync\t644", "置いてよい 2 つ"],
  ["hooks/pre-push\tx\t600", "mode が 644 でも 755 でもない"],
  ["hooks/pre-push\tx", "タブ区切りの 3 つの欄でない"],
  ["hooks/missing\tx\t644", "symlink を通らない通常のファイルでない"],
  ["-\tmissing.txt\t644", "描画が出していない"],
];
for (const [line, want] of listRows) {
  failOnCopy(`一覧の行 ${JSON.stringify(line)}`, want, (d) => append(localList(d), `${line}\n`));
}
failOnCopy("一覧に無い描画の出力", "どの一覧にも - の行で無い", (d) => write(`${d}/.agent-sync/archetype/content/extra.txt`, "x\n"));
// 下流の archetype が先に描画するので、部品の描画の if_exists が重なりを拒むかを見る
failOnCopy("部品と同じ名前の一覧", "File already exists", (d) => write(`${d}/.agent-sync/archetype/content/.agent-sync/files/pre-push`, "hooks/pre-push\thooks/pre-push\t755\n"));

// 引数があれば exit 2 で何もしない
fixture("引数", async (t) => {
  const d = await copyOf(t, v1Base);
  const r = await sync(d, {}, ["extra"]);
  if (r.code !== 2) t.fail(`引数: exit ${r.code} (2 のはず)`);
  if (!r.err.includes("usage")) t.fail(`引数: usage が無い — ${r.err}`);
});

// archetype.yaml の source の行は、sha で固定した https の URL がちょうど 1 つで、名前が定義域の中
const yaml = (d: string) => `${d}/.agent-sync/archetype/archetype.yaml`;
failOnCopy("source の行が 2 つ", "ちょうど 1 つでない", (d) => append(yaml(d), `  other:\n    source: ${url}#${v1}\n`));
const sourceRows: [string, string][] = [
  ["", "ちょうど 1 つでない"],
  [`    source: ${url}#abc\n`, "ちょうど 1 つでない"],
  [`    source: ${v1}0\n`, "ちょうど 1 つでない"],
  [`    source: ${v1.toUpperCase()}\n`, "ちょうど 1 つでない"],
  [`    source: http://github.com/ikeyan/agent-files.git#${v1}\n`, "ちょうど 1 つでない"],
  [`    source: https://example.com/x/...git#${v1}\n`, "定義域の外"],
  [`    source: https://example.com/x/a%20b.git#${v1}\n`, "定義域の外"],
];
for (const [src, want] of sourceRows) {
  failOnCopy(`source ${JSON.stringify(src)}`, want, (d) => Deno.writeTextFile(yaml(d), `description: x\ncatalog:\n  agent-files:\n${src}`));
}

for (const f of ["archetype/archetype.yaml", "archetype/archetype.lua", "answers.yaml", "generated"]) {
  failOnCopy(`入力 ${f} が無い`, `${f} が無い`, (d, t) => Deno.rename(`${d}/.agent-sync/${f}`, `${t.dir}/missing.orig`));
}

// generated は、1 行が <パス><TAB><id> で、パスが定義域の中で LC_ALL=C の順に重複が無く、id が 40 桁か 64 桁の小文字 16 進。古いパスは通常のファイル
const id40 = await textId("x");
const genRows: [string, string, (ls: string[]) => string[]][] = [
  ["generated が逆順", "重複なしでない", (ls) => ls.toSorted().reverse()],
  ["generated が重複", "重複なしでない", (ls) => [...ls, ls.at(-1)!]],
  ["generated が同じパスで id 違いの重複", "重複なしでない", (ls) => [...ls, `${ls.at(-1)!.split("\t")[0]}\t${id40}`]],
  ["generated のパスが定義域の外", "パスが定義域の外", (ls) => [...ls, `../x\t${id40}`]],
  ["generated に .agent-sync/ の入力", "置いてよい 2 つ", (ls) => [...ls, `.agent-sync/answers.yaml\t${id40}`]],
  ["generated の行に id が無い", "2 つの欄でない", (ls) => [...ls, "zzz"]],
  ["generated の行が 3 欄", "2 つの欄でない", (ls) => [...ls, `zzz\t${id40}\textra`]],
  ...["abc", id40.toUpperCase(), `${id40}0`, id40.replace(/[0-9]/g, "g")].map((bad): [string, string, (ls: string[]) => string[]] => [
    `generated の id ${bad}`,
    "小文字 16 進でない",
    (ls) => [...ls, `zzz\t${bad}`],
  ]),
];
for (const [name, want, edit] of genRows) failOnCopy(name, want, (d) => editLines(generated(d), edit));
failOnCopy("古いパスがディレクトリ", "古いパス zdir が通常のファイルでない", async (d) => {
  await append(generated(d), `zdir\t${id40}\n`);
  await Deno.mkdir(`${d}/zdir`);
});

// 上流のパスの symlink と、置き先の途中の symlink
const linkRows: [string, string][] = [
  ["hooks/link\tx\t644", "symlink を通らない通常のファイルでない"],
  ["hlink/pre-push\tx\t644", "symlink を通らない通常のファイルでない"],
  ["hooks/pre-push\tlink/x\t644", "途中に、symlink"],
];
for (const [line, want] of linkRows) {
  failOnCopy(`一覧の行 ${JSON.stringify(line)}`, want, async (d) => {
    await Deno.symlink("hooks", `${d}/link`);
    await append(localList(d), `${line}\n`);
  });
}

// 他の起動がロックを取っていれば落ちる。そのロックは消さない
failOnCopy("ロックが取られている", "agent-sync.lock がある", (d) => Deno.mkdir(`${d}/.git/agent-sync.lock`));
failOnCopy("archetect の版", "archetect 3.6.1 が PATH に無い", async () => withPath("shim-ver"));
failOnCopy("対応していない OS", "対応していない OS: Plan9", async () => withPath("shim-os"));

// 文字の分類 (canon: facts/shell/string-input-categories) ごとに、置き先・source の名前・TMPDIR の定義域が拒む。UTF-8 の locale があればその下で回す。
// タブと空白は、欄・単語の区切りの検査が先に当たる。
const charCases: { name: string; ch: string; src: string; dest: string }[] = [
  { name: "tab", ch: "\t", src: "ちょうど 1 つでない", dest: "タブ区切りの 3 つの欄でない" },
  { name: "x01", ch: "\x01", src: "定義域の外", dest: "置き先のパスが定義域の外" },
  { name: "space", ch: " ", src: "ちょうど 1 つでない", dest: "置き先のパスが定義域の外" },
  { name: "dollar", ch: "$", src: "定義域の外", dest: "置き先のパスが定義域の外" },
  { name: "star", ch: "*", src: "定義域の外", dest: "置き先のパスが定義域の外" },
  { name: "dquote", ch: '"', src: "定義域の外", dest: "置き先のパスが定義域の外" },
  { name: "squote", ch: "'", src: "定義域の外", dest: "置き先のパスが定義域の外" },
  { name: "backslash", ch: "\\", src: "定義域の外", dest: "置き先のパスが定義域の外" },
  { name: "latin-e-acute", ch: "é", src: "定義域の外", dest: "置き先のパスが定義域の外" },
  { name: "cjk-a", ch: "あ", src: "定義域の外", dest: "置き先のパスが定義域の外" },
  { name: "fullwidth-z", ch: "ｚ", src: "定義域の外", dest: "置き先のパスが定義域の外" },
];
for (const c of charCases) {
  failOnCopy(`TMPDIR に文字 ${c.name}`, "A-Z a-z 0-9 . _ / - 以外の文字がある", async (_d, t) => {
    await Deno.mkdir(`${t.dir}/t${c.ch}m`);
    return { TMPDIR: `${t.dir}/t${c.ch}m`, ...locEnv };
  });
  failOnCopy(`source の名前に文字 ${c.name}`, c.src, async (d) => {
    await Deno.writeTextFile(yaml(d), `description: x\ncatalog:\n  agent-files:\n    source: https://example.com/x/a${c.ch}.git#${v1}\n`);
    return locEnv;
  });
  failOnCopy(`置き先に文字 ${c.name}`, c.dest, async (d) => {
    await append(localList(d), `hooks/pre-push\ta${c.ch}b\t644\n`);
    return locEnv;
  });
}

// 上流の更新: hooks/pre-push を変え、codex-limits.sh を一覧から消す
const v2Base = fixture("v2", async (t) => {
  const d = await copyOf(t, v1Base);
  await setPin(d, v1, v2);
  await syncOk(t, "v2", d);
  if (await exists(`${d}/.claude/skills/pr-workflow/codex-limits.sh`)) t.fail("v2: 一覧から消えた codex-limits.sh が残った");
  if (!(await sameBytes(await blobBytes(v2, "hooks/pre-push"), `${d}/hooks/pre-push`))) t.fail("v2: hooks/pre-push が v2 でない");
  if ((await Deno.readTextFile(generated(d))).includes("codex-limits.sh")) t.fail("v2: generated に codex-limits.sh が残った");
  const changed = chomp(await porcelain(d)).split("\n").sort();
  const want = [" D .claude/skills/pr-workflow/codex-limits.sh", " M .agent-sync/archetype/archetype.yaml", " M .agent-sync/generated", " M hooks/pre-push"].sort();
  if (changed.join("\n") !== want.join("\n")) t.fail(`v2: 変わったものが想定と違う — ${changed.join("\n")}`);
  await git(d, ["add", "-A"]);
  await git(d, ["commit", "-q", "-m", "v2"]);
  return d;
});

// リポジトリの場所を決める GIT_* が設定されていれば、手順 1 の前に落ちる。指された別のリポジトリにも何も起きない (GIT_CONFIG* は通る: この test 自身が使う)
fixture("GIT_*", async (t) => {
  const d = await copyOf(t, v2Base);
  const other = `${t.dir}/other`;
  await exec("git", ["init", "-q", "-b", "main", other]);
  await git(other, ["commit", "-q", "--allow-empty", "-m", "other"]);
  const otherState = async () => (await git(other, ["for-each-ref"])) + (await filesUnder(`${other}/.git`));
  const otherBefore = await otherState();
  const head = await git(d, ["rev-parse", "HEAD"]);
  for (const v of chomp(await git(tmp, ["rev-parse", "--local-env-vars"])).split("\n")) {
    if (["GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"].includes(v)) continue;
    await expectFail(t, `${v} が設定されている`, d, `${v} が設定されている`, { [v]: `${other}/.git` });
  }
  if (await otherState() !== otherBefore) t.fail("GIT_*: 指された別のリポジトリが変わった");
  if (await git(d, ["rev-parse", "HEAD"]) !== head) t.fail("GIT_*: ds の HEAD が変わった");
  await clean(t, "GIT_* の後", d);
});

// 生成物の同一性 (sync.sh の同一性の表の行ごと)。表は git の状態・HEAD を見ないので、commit 済みの編集も、追跡していない・無視されているも、中身の id だけで決まる。
const dest = "hooks/pre-push";
/** generated のそのパスの行の id を差し替える。id が - なら行を消す。 */
const recAs = (d: string, path: string, id: string) =>
  editLines(generated(d), (ls) => ls.flatMap((l) => (l.split("\t")[0] !== path ? [l] : id === "-" ? [] : [`${path}\t${id}`])));

/** v2 の写しを prepare で変えて、通り、$dest が置くものと同じバイトの実行可能なファイルで、generated の行がその id。 */
const placedOk = (name: string, prepare: (d: string) => Promise<void>) =>
  fixture(name, async (t) => {
    const d = await copyOf(t, v2Base);
    await prepare(d);
    await syncOk(t, name, d);
    if (!(await sameBytes(await blobBytes(v2, dest), `${d}/${dest}`)) || !(await executable(`${d}/${dest}`))) {
      t.fail(`${name}: ${dest} が置くものと同じバイトの実行可能なファイルでない`);
    }
    if (!(await Deno.readTextFile(generated(d))).split("\n").includes(`${dest}\t${await blobId(v2, dest)}`)) {
      t.fail(`${name}: generated の ${dest} の行が置いたバイトの id でない`);
    }
  });
/** v2 の写しを prepare で変えて、落ち、触らない。 */
const refusedOnV2 = (name: string, want: string, prepare: (d: string, t: Ctx) => Promise<void>) =>
  fixture(name, async (t) => {
    const d = await copyOf(t, v2Base);
    await prepare(d, t);
    await expectFail(t, name, d, want);
  });
const userEdit = "前回置いたもの (generated の id) とも今回置くものとも違う";

placedOk("置き先: 無い", (d) => Deno.remove(`${d}/${dest}`));
placedOk("置き先: cur = new (generated の id は違う)", async (d) => recAs(d, dest, await textId("other")));
placedOk("置き先: cur = rec ≠ new (前回の結果)", async (d) => {
  await Deno.writeTextFile(`${d}/${dest}`, "old\n");
  await recAs(d, dest, await textId("old"));
});
placedOk("置き先: 前回の結果が staged", async (d) => {
  await Deno.writeTextFile(`${d}/${dest}`, "old\n");
  await recAs(d, dest, await textId("old"));
  await git(d, ["add", dest]);
});
placedOk("置き先: 前回の結果が追跡されず無視されている", async (d) => {
  await Deno.writeTextFile(`${d}/${dest}`, "old\n");
  await recAs(d, dest, await textId("old"));
  await append(`${d}/.gitignore`, `${dest}\n`);
  await git(d, ["rm", "-q", "--cached", dest]);
});
refusedOnV2("置き先: 利用者の編集 (未コミット)", userEdit, (d) => Deno.writeTextFile(`${d}/${dest}`, "mine\n"));
refusedOnV2("置き先: 利用者の編集を commit した", userEdit, async (d) => {
  await Deno.writeTextFile(`${d}/${dest}`, "mine\n");
  await git(d, ["commit", "-q", "-am", "mine"]);
});
refusedOnV2("置き先: 利用者の編集が staged", userEdit, async (d) => {
  await Deno.writeTextFile(`${d}/${dest}`, "mine\n");
  await git(d, ["add", dest]);
});
refusedOnV2("置き先: generated に無く、置くものと違う", userEdit, async (d) => {
  await Deno.writeTextFile(`${d}/${dest}`, "mine\n");
  await recAs(d, dest, "-");
});
placedOk("置き先: generated に無く、置くものと同じ", (d) => recAs(d, dest, "-"));
placedOk("置き先: mode だけ違う", (d) => Deno.chmod(`${d}/${dest}`, 0o644));
fixture("置き先: hard link で mode だけ違う", async (t) => {
  const name = "置き先: hard link で mode だけ違う";
  const d = await copyOf(t, v2Base);
  const hl = `${t.dir}/hl`;
  await Deno.link(`${d}/${dest}`, hl);
  await Deno.chmod(`${d}/${dest}`, 0o644);
  await syncOk(t, name, d);
  const a = await Deno.stat(`${d}/${dest}`);
  const b = await Deno.stat(hl);
  if (!((a.mode ?? 0) & 0o100) || (a.ino === b.ino && a.dev === b.dev)) t.fail(`${name}: ${dest} が新しい inode の実行可能なファイルでない`);
  if ((b.mode ?? 0) & 0o100 || !(await sameBytes(await blobBytes(v2, dest), hl)) || ((b.mode ?? 0) & 0o7777) !== 0o644) {
    t.fail(`${name}: 別の hard link の mode かバイトが変わった`);
  }
});
refusedOnV2("置き先: symlink", "通常のファイルでない", async (d) => {
  await Deno.remove(`${d}/${dest}`);
  await Deno.symlink("nowhere", `${d}/${dest}`);
});
fixture("置き先: ディレクトリへの symlink", async (t) => {
  const d = await copyOf(t, v2Base);
  await Deno.mkdir(`${d}/linkdir`);
  await Deno.remove(`${d}/${dest}`);
  await Deno.symlink("../linkdir", `${d}/${dest}`);
  await expectFail(t, "置き先: ディレクトリへの symlink", d, "通常のファイルでない");
  if ((await Array.fromAsync(Deno.readDir(`${d}/linkdir`))).length) t.fail("置き先: ディレクトリへの symlink の先に書かれた");
});
refusedOnV2("置き先: ディレクトリ", "通常のファイルでない", async (d) => {
  await Deno.remove(`${d}/${dest}`);
  await Deno.mkdir(`${d}/${dest}`);
});

// 作業ツリーの既存のパスの綴りは、要求した綴りと完全に等しくなければならない。大文字小文字を区別しないファイルシステムでは、別の綴りの利用者のファイルや途中のディレクトリに当たるので落ちる。区別するファイルシステムでは別のファイルなので通る。
if (ciFs) {
  refusedOnV2("置き先: 大文字小文字だけ違う利用者のファイル (中身が同じ、generated に id がある)", clash, async (d) => {
    await Deno.remove(`${d}/NOTICE.txt`);
    await Deno.writeTextFile(`${d}/notice.txt`, "project demo\n");
  });
  refusedOnV2("置き先: 大文字小文字だけ違う利用者のファイル (中身が同じ、generated に無い)", clash, async (d) => {
    await Deno.remove(`${d}/NOTICE.txt`);
    await Deno.writeTextFile(`${d}/notice.txt`, "project demo\n");
    await recAs(d, "NOTICE.txt", "-");
  });
  refusedOnV2("置き先: 利用者が綴りの大文字小文字を変えた", clash, (d) => Deno.rename(`${d}/${dest}`, `${d}/hooks/Pre-Push`));
  refusedOnV2("置き先: 途中のディレクトリが大文字小文字だけ違う", clash, (d) => Deno.rename(`${d}/hooks`, `${d}/Hooks`));
  // 綴りの規則を再現せず、一覧の完全一致で見るので、大文字小文字の畳み込みでない同一視 (KELVIN SIGN と K) も落ちる
  refusedOnV2("置き先: 途中のディレクトリが KELVIN SIGN の別名", clash, (d) => Deno.rename(`${d}/hooks`, `${d}/hoo${kelvin}s`));
} else {
  fixture("置き先: 大文字小文字だけ違うファイルが別にある", async (t) => {
    const d = await copyOf(t, v2Base);
    await Deno.writeTextFile(`${d}/notice.txt`, "mine\n");
    await syncOk(t, "置き先: 大文字小文字だけ違うファイルが別にある", d);
    if (await readOr(`${d}/notice.txt`) !== "mine\n") t.fail("置き先: 別のファイル notice.txt が変わった");
  });
  fixture("置き先: 大文字小文字だけ違うディレクトリが別にある", async (t) => {
    const d = await copyOf(t, v2Base);
    await write(`${d}/Hooks/pre-push`, "mine\n");
    await syncOk(t, "置き先: 大文字小文字だけ違うディレクトリが別にある", d);
    if (await readOr(`${d}/Hooks/pre-push`) !== "mine\n") t.fail("置き先: 別のディレクトリ Hooks が変わった");
  });
}

// 途中のディレクトリの一覧が取れなければ (中身を開けない mode 111)、綴りを突き合わせられないので落ちる。大文字小文字を区別するかによらない。
if ((await exec("id", ["-u"])).out.trim() === "0") {
  console.error(`${self}: root は mode 111 のディレクトリも一覧できるので、一覧が取れない検査を飛ばした`);
} else {
  fixture("置き先: 途中のディレクトリの一覧が取れない", async (t) => {
    const name = "置き先: 途中のディレクトリの一覧が取れない";
    const d = await copyOf(t, v2Base);
    const before = await snapshot(d);
    await Deno.chmod(`${d}/hooks`, 0o111);
    try {
      await expectFail(t, name, d, "の一覧を取れない");
    } finally {
      await Deno.chmod(`${d}/hooks`, 0o755);
    }
    if (await snapshot(d) !== before) t.fail(`${name}: 一覧が取れずに落ちた sync.sh が作業ツリーを変えた`);
  });
}

// 古いパス (generated にあって置き先に無い)
const old = "zzz-old.txt";
const staleBase = fixture("古いパスの元", async (t) => {
  const d = await copyOf(t, v2Base);
  await Deno.writeTextFile(`${d}/${old}`, "old\n");
  await append(generated(d), `${old}\t${await textId("old")}\n`);
  await git(d, ["add", "-A"]);
  await git(d, ["commit", "-q", "-m", "old"]);
  return d;
});
/** 古いパスの元の写しを prepare で変えて、通り、古いパスが無く generated にも無い。 */
const staleGone = (name: string, prepare: (d: string) => Promise<void>) =>
  fixture(name, async (t) => {
    const d = await copyOf(t, staleBase);
    await prepare(d);
    await syncOk(t, name, d);
    if (await exists(`${d}/${old}`) || (await Deno.readTextFile(generated(d))).split("\n").some((l) => l.startsWith(`${old}\t`))) {
      t.fail(`${name}: 古いパス ${old} か generated の行が残った`);
    }
  });
/** 古いパスの元の写しを prepare で変えて、落ち、古いパスに触らない。 */
const staleRefused = (name: string, want: string, prepare: (d: string) => Promise<void>) =>
  fixture(name, async (t) => {
    const d = await copyOf(t, staleBase);
    await prepare(d);
    await expectFail(t, name, d, want);
  });
const staleEdit = `古いパス ${old} の中身が、前回置いたもの (generated の id) と違う`;
const staleKind = `古いパス ${old} が通常のファイルでない`;

staleGone("古いパス: cur = rec", async () => {});
staleGone("古いパス: 消した", (d) => Deno.remove(`${d}/${old}`));
staleGone("古いパス: 初めから無い", async (d) => {
  await git(d, ["rm", "-q", old]);
  await git(d, ["commit", "-q", "-m", `no ${old}`]);
});
staleRefused("古いパス: 編集 (未コミット)", staleEdit, (d) => append(`${d}/${old}`, "edited\n"));
staleRefused("古いパス: 編集を commit した", staleEdit, async (d) => {
  await append(`${d}/${old}`, "edited\n");
  await git(d, ["commit", "-q", "-am", `edit ${old}`]);
});
staleRefused("古いパス: 編集が staged", staleEdit, async (d) => {
  await append(`${d}/${old}`, "edited\n");
  await git(d, ["add", old]);
});
staleGone("古いパス: 追跡していないが cur = rec", async (d) => {
  await git(d, ["rm", "-q", "--cached", old]);
  await git(d, ["commit", "-q", "-m", `untrack ${old}`]);
});
staleGone("古いパス: 無視されているが cur = rec", async (d) => {
  await append(`${d}/.gitignore`, `${old}\n`);
  await git(d, ["rm", "-q", "--cached", old]);
});
staleGone("古いパス: mode だけ違う", (d) => Deno.chmod(`${d}/${old}`, 0o755));
staleRefused("古いパス: symlink", staleKind, async (d) => {
  await Deno.remove(`${d}/${old}`);
  await Deno.symlink("nowhere", `${d}/${old}`);
});
staleRefused("古いパス: ディレクトリ", staleKind, async (d) => {
  await Deno.remove(`${d}/${old}`);
  await Deno.mkdir(`${d}/${old}`);
});
if (ciFs) {
  staleRefused("古いパス: 大文字小文字だけ違う利用者のファイル (中身が同じ)", clash, async (d) => {
    await Deno.remove(`${d}/${old}`);
    await Deno.writeTextFile(`${d}/ZZZ-old.txt`, "old\n");
  });
  staleRefused("古いパス: 途中のディレクトリが大文字小文字だけ違う", clash, async (d) => {
    await append(generated(d), `zzzdir/o.txt\t${await textId("old")}\n`);
    await write(`${d}/Zzzdir/o.txt`, "old\n");
  });
  staleRefused("古いパス: KELVIN SIGN の別名のファイル (中身が同じ)", clash, async (d) => {
    await append(generated(d), `zzzk.txt\t${await textId("old")}\n`);
    await Deno.writeTextFile(`${d}/zzz${kelvin}.txt`, "old\n");
  });
} else {
  fixture("古いパス: 大文字小文字だけ違うファイルが別にある", async (t) => {
    const name = "古いパス: 大文字小文字だけ違うファイルが別にある";
    const d = await copyOf(t, staleBase);
    await Deno.writeTextFile(`${d}/ZZZ-old.txt`, "old\n");
    await syncOk(t, name, d);
    if (await exists(`${d}/${old}`) || !(await statOr(`${d}/ZZZ-old.txt`))?.isFile) t.fail(`${name}: 別のファイル ZZZ-old.txt を消したか、古いパスが残った`);
  });
}

// 上流が置き先を大文字小文字だけ改名すると、大文字小文字を区別しないファイルシステムでは前回の出力の古い綴りに当たって落ちる。文言は前回の出力だと示し、古い綴りを消せば通る (描画の出力の改名で再現する)。
if (ciFs) {
  fixture("上流の大文字小文字だけの改名", async (t) => {
    const d = await copyOf(t, v1Base, "ren");
    const content = `${d}/.agent-sync/archetype/content`;
    await git(d, ["rm", "-q", "--cached", ".agent-sync/archetype/content/NOTICE.txt"]);
    await Deno.rename(`${content}/NOTICE.txt`, `${content}/rename.tmp`);
    await Deno.rename(`${content}/rename.tmp`, `${content}/notice.txt`);
    await Deno.writeTextFile(`${content}/.agent-sync/files/local`, "-\tnotice.txt\t644\n");
    await git(d, ["add", "-A"]);
    await expectFail(t, "上流の大文字小文字だけの改名", d, "前回 sync が置いた NOTICE.txt と綴りが違う (ファイルシステム上は同じもの)。NOTICE.txt を消してから起動し直す");
    await Deno.remove(`${d}/NOTICE.txt`);
    await syncOk(t, "上流の大文字小文字だけの改名の後、古い綴りを消した", d);
    const names = (await Array.fromAsync(Deno.readDir(d))).map((e) => e.name);
    const gen = await Deno.readTextFile(generated(d));
    if (!names.includes("notice.txt") || gen.includes("NOTICE.txt") || !gen.split("\n").some((l) => l.startsWith("notice.txt\t"))) {
      t.fail("上流の大文字小文字だけの改名: notice.txt が置かれず generated が改名後の綴りでない");
    }
  });
}

// 名前が - で始まるパスは、外部コマンドにオプションとして読まれない。上流の tree に -x/y と --help/x があっても取り出しは通り (置き先は一覧が決めるので置かれない)、置き先と古いパスの名前が - で始まっても置いて消せる。
fixture("上流のパスの名前が - で始まる", async (t) => {
  const d = `${t.dir}/dashup`;
  await makeDs(d, cDash);
  await syncOk(t, "上流のパスの名前が - で始まる", d);
  if (await exists(`${d}/-x`) || await exists(`${d}/--help`)) t.fail("上流のパスの名前が - で始まる: 一覧に無い上流のパスを置いた");
});
fixture("置き先・古いパスの名前が - で始まる", async (t) => {
  const d = await copyOf(t, v1Base, "dashdest");
  const content = `${d}/.agent-sync/archetype/content`;
  await write(`${content}/-dash/-f.txt`, "d\n");
  await append(`${content}/.agent-sync/files/local`, "-\t-dash/-f.txt\t644\n");
  await syncOk(t, "置き先の名前が - で始まる (置く)", d);
  if (chomp(await readOr(`${d}/-dash/-f.txt`)) !== "d" || !(await Deno.readTextFile(generated(d))).split("\n").some((l) => l.startsWith("-dash/-f.txt\t"))) {
    t.fail("置き先の名前が - で始まる: 置かれず generated にも無い");
  }
  await git(d, ["add", "-A"]);
  await git(d, ["commit", "-q", "-m", "dash"]);
  await Deno.remove(`${content}/-dash`, { recursive: true });
  await Deno.writeTextFile(`${content}/.agent-sync/files/local`, "-\tNOTICE.txt\t644\n");
  await syncOk(t, "古いパスの名前が - で始まる (消す)", d);
  if (await exists(`${d}/-dash/-f.txt`) || (await Deno.readTextFile(generated(d))).includes("-dash")) t.fail("古いパスの名前が - で始まる: 消えず generated に残った");
});

// 利用者が生成物を編集して commit した後、上流が同じファイルを置き続けても、一覧から消しても、落ちて何も変えない。
fixture("編集を commit した生成物を、上流が置き続ける", async (t) => {
  const d = await copyOf(t, v1Base, "edit");
  await append(`${d}/hooks/pre-push`, "# mine\n");
  await git(d, ["commit", "-q", "-am", "user edit of a generated file"]);
  await expectFail(t, "編集を commit した生成物を、上流が置き続ける (同じ pin)", d, userEdit);
  await setPin(d, v1, v2);
  await expectFail(t, "編集を commit した生成物を、上流が置き続ける (v2 で中身も変わる)", d, userEdit);
});
fixture("編集を commit した生成物を、上流が一覧から消す", async (t) => {
  const d = await copyOf(t, v1Base, "edit2");
  const f = `${d}/.claude/skills/pr-workflow/codex-limits.sh`;
  await append(f, "# mine\n");
  await git(d, ["commit", "-q", "-am", "user edit of a generated file"]);
  await setPin(d, v1, v2);
  await expectFail(t, "編集を commit した生成物を、上流が一覧から消す", d, "古いパス .claude/skills/pr-workflow/codex-limits.sh の中身が");
  if (!(await exists(f))) t.fail("編集を commit した古いパスが消えた");
});

// 描画の出力のファイル名に改行があれば、一覧の - の行の突き合わせで foo と bar に割れて通らないよう、手順 3 の最初に落ちる。古いパスを消さずに落ちる (下流の archetype.lua は上流のコードと同じく信頼しない)
fixture("描画の出力のファイル名に改行", async (t) => {
  const d = await copyOf(t, v1Base, "nlname");
  await editLines(lua(d), (ls) =>
    ls.filter((l) => !l.includes("agent-files/pr-workflow"))
      .map((l) => l.replace(/^return context/, 'local h = io.open("foo\\nbar", "w"); h:write("x"); h:close()\nreturn context')));
  await append(localList(d), "-\tfoo\t644\n-\tbar\t644\n");
  await expectFail(t, "描画の出力のファイル名に改行", d, "描画の出力のパスが定義域の外");
  if (!(await exists(`${d}/.claude/skills/pr-workflow/SKILL.md`))) t.fail("描画の出力のファイル名に改行: 古いパスを消した");
});

// 古いパスの削除は記録したファイルだけで、ディレクトリは消さない (利用者の空のディレクトリに sync が置いたファイルを、上流が落としても残る)
fixture("keepdir", async (t) => {
  const d = `${t.dir}/keepdir`;
  await makeDs(d, v1);
  await Deno.mkdir(`${d}/.claude/skills/pr-workflow`, { recursive: true });
  await syncOk(t, "keepdir の初回", d);
  if (!(await statOr(`${d}/.claude/skills/pr-workflow/SKILL.md`))?.isFile) t.fail("keepdir: 初回が pr-workflow を置かなかった");
  await editLines(lua(d), (ls) => ls.filter((l) => !l.includes("agent-files/pr-workflow")));
  await syncOk(t, "keepdir: 上流が部品を落とす", d);
  if (await exists(`${d}/.claude/skills/pr-workflow/SKILL.md`)) t.fail("keepdir: 古いパスが残った");
  if (!(await statOr(`${d}/.claude/skills/pr-workflow`))?.isDirectory) t.fail("keepdir: 利用者の空のディレクトリを消した");
});

// 前回の結果を commit する前に続けて起動しても、何も変わらない
fixture("commit 前に続けて起動", async (t) => {
  const d = `${t.dir}/twice`;
  await makeDs(d, v1);
  await syncOk(t, "commit 前の 1 回目", d);
  const snap = await snapshot(d);
  await syncOk(t, "commit 前の 2 回目", d);
  if (await snapshot(d) !== snap) t.fail("commit 前の 2 回目が作業ツリーを変えた");
  if (snap !== await firstSnap) t.fail("commit 前の 1 回目が、初回と違う結果を作った");
});

// 手順 4 の mv が途中で失敗すれば、一時ファイルとロックを残さずに落ちる。起動し直せば、続けて起動したのと同じ作業ツリーに収束する
/** .git の外の、名前が .agent-sync. で始まるもの (手順 4 の一時ファイル)。 */
async function leftovers(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for await (const e of Deno.readDir(`${root}${rel}`)) {
      if (e.name === ".git") continue;
      if (e.name.startsWith(".agent-sync.")) out.push(`${rel}/${e.name}`);
      if (e.isDirectory) await walk(`${rel}/${e.name}`);
    }
  };
  await walk("");
  return out;
}
const applyFails = (name: string, fail: Record<string, string>, after?: (t: Ctx, count: string) => void) =>
  fixture(name, async (t) => {
    const d = `${t.dir}/part`;
    await makeDs(d, v1);
    const count = `${t.dir}/mv.count`;
    const r = await sync(d, { ...withPath("shim-mv"), MV_COUNT: count, MV_FAIL_AT: "0", MV_FAIL_PAT: "-", ...fail });
    if (r.code === 0) t.fail(`${name}: sync.sh が通った`);
    if (!r.err.includes("mv: 疑似の失敗")) t.fail(`${name}: mv が失敗していない — ${r.err}`);
    const left = await leftovers(d);
    if (left.length) t.fail(`${name}: 一時ファイルが残った — ${left.join(" ")}`);
    if (await present(`${d}/.git/agent-sync.lock`)) t.fail(`${name}: ロックが残った`);
    after?.(t, chomp(await readOr(count)));
    await syncOk(t, `${name} の後の起動し直し`, d);
    if (await snapshot(d) !== await firstSnap) t.fail(`${name}: 起動し直しが、初回と同じ作業ツリーに収束しない`);
  });
applyFails("mv の失敗 (2 つ目)", { MV_FAIL_AT: "2" }, (t, n) => {
  if (n !== "2") t.fail(`mv の失敗 (2 つ目): 2 つ目の mv で失敗していない (数: ${n})`);
});
applyFails("mv の失敗 (generated)", { MV_FAIL_PAT: "*/generated" });

// 上流の部品の Lua は、sandbox の外へ書けず、外を読めず、プロセスを起動できない
fixture("probe の部品", async (t) => {
  const d = `${t.dir}/hostile`;
  await makeDs(d, v1);
  await Deno.writeTextFile(
    lua(d),
    'local context = Context.new()\ncontext:merge(catalog.render("agent-files/agent-sync", context))\ncontext:merge(catalog.render("agent-files/probe", context))\nreturn context\n',
  );
  await Deno.remove(`${d}/.agent-sync/archetype/content`, { recursive: true });
  await git(d, ["add", "-A"]);
  await git(d, ["commit", "-q", "-m", "probe"]);
  await syncOk(t, "probe の部品", d);
  const got = chomp(await readOr(`${d}/probe.txt`));
  if (got !== ["write-outside", "read-outside", "os.execute", "io.popen"].map((n) => `${n}: nil`).join("\n")) t.fail(`probe の部品: sandbox の外への操作が通った — ${got}`);
  const outside = (await Array.fromAsync(Deno.readDir(`${tmp}/outside`))).map((e) => e.name);
  if (outside.length) t.fail(`probe の部品: sandbox の外にファイルができた — ${outside.join(" ")}`);
});

// 取り出しは git の設定 (core.autocrlf・core.eol) に依らず、置くバイトは上流の blob と同じ (checkout なら shebang が CRLF になる。canon: facts/git/checkout-filters-vs-raw-blob)
fixture("core.autocrlf=true・core.eol=crlf", async (t) => {
  const name = "core.autocrlf=true・core.eol=crlf";
  const d = `${t.dir}/crlf`;
  await makeDs(d, v1);
  await syncOk(t, name, d, { GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_1: "core.autocrlf", GIT_CONFIG_VALUE_1: "true", GIT_CONFIG_KEY_2: "core.eol", GIT_CONFIG_VALUE_2: "crlf" });
  await checkPlaced(t, name, d, v1);
  if ((await readOr(`${d}/hooks/pre-push`)).includes("\r")) t.fail("core.autocrlf=true: hooks/pre-push に CR がある");
});

// 描画が .agent-sync/sync.sh を置かなければ (agent-sync の部品を合成していない・一覧が 1 つも無い)、generated の全てを古いパスとして消さずに落ちる
fixture("agent-sync の部品を合成していない", async (t) => {
  const d = `${t.dir}/nocomp`;
  await makeDs(d, v1);
  await syncOk(t, "nocomp の初回", d);
  await git(d, ["add", "-A"]);
  await git(d, ["commit", "-q", "-m", "sync"]);
  await editLines(lua(d), (ls) => ls.filter((l) => !l.includes("agent-files/agent-sync")));
  await expectFail(t, "agent-sync の部品を合成していない", d, ".agent-sync/sync.sh を置かない");
  await Deno.writeTextFile(lua(d), "return Context.new()\n");
  await Deno.remove(`${d}/.agent-sync/archetype/content`, { recursive: true });
  await expectFail(t, "描画が一覧を 1 つも出さない", d, ".agent-sync/sync.sh を置かない");
});

// このスクリプトが、カレントの作業ツリーの .agent-sync/ のものでなければ落ちる。どちらの作業ツリーも変えない
fixture("別のリポの sync.sh", async (t) => {
  const d = await copyOf(t, v1Base);
  const wrong = `${t.dir}/wrong`;
  await exec("git", ["init", "-q", "-b", "main", wrong]);
  await git(wrong, ["commit", "-q", "--allow-empty", "-m", "wrong"]);
  const beforeDs = await snapshot(d);
  const beforeWrong = await snapshot(wrong);
  const r = await exec(`${d}/.agent-sync/sync.sh`, [], { cwd: wrong });
  if (r.code === 0) t.fail("別のリポの sync.sh が通った");
  if (!r.err.includes("の .agent-sync/ でない")) t.fail(`別のリポの sync.sh: 理由が無い — ${r.err}`);
  if (await snapshot(d) !== beforeDs || await snapshot(wrong) !== beforeWrong) t.fail("別のリポの sync.sh が作業ツリーを変えた");
  if (await present(`${d}/.git/agent-sync.lock`) || await present(`${wrong}/.git/agent-sync.lock`)) t.fail("別のリポの sync.sh がロックを残した");
});

// generated に無い置き先に利用者のファイルがあれば、置き換えない
fixture("利用者のファイル", async (t) => {
  const d = `${t.dir}/user`;
  await makeDs(d, v1);
  await Deno.writeTextFile(`${d}/hooks/pre-push`, "#!/bin/sh\necho mine\n");
  await expectFail(t, "利用者のファイル", d, "利用者のファイル");
});

await settled();
Deno.exit(report());
