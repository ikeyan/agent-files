/**
 * test-target-diff.ts — skills/review-perspectives/target-diff.sh の model based test。verify.sh から呼ぶ。
 *
 * 履歴の操作列と環境の形を生成し、履歴のモデルから「対象のコミット集合」と「対象のファイル集合」を計算して、スクリプトが書き出した target.diff と照合する。生成する次元は canon の `facts/git/repository-shapes` の目録の行で、目録の行を足したらここの生成器にも次元を足す。出力を変える git の設定は diff.external・GIT_EXTERNAL_DIFF・textconv・color.diff・diff.noprefix を生成する。log.showSignature は unsigned commit では検証結果の行が出ず観測できないので生成しない (fixture でも扱わない)。作業ツリーの項目は、対象無しの checkout に限り稀に tracked submodule の中の未コミットの変更 (dirtySubmodule) も生成し、target-diff.sh の対象外の宣言 (submodule の中身は見ない) を確かめる。scripts/test-target-diff.sh は、生成に向かない形 (unborn HEAD、打ち消し合うコミット、origin の HEAD 無し、消した path) を例で固定する。
 *
 * モデル (スクリプトの先頭の仕様を集合で書いたもの):
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
 *
 * 環境: TARGET_DIFF_RUNS (試行数、既定 25。1 以上の整数。それ以外は止まる)、FC_SEED (再現する seed。指定するなら整数。それ以外は止まる)。
 */
import fc from "fast-check";

const script = new URL("../skills/review-perspectives/target-diff.sh", import.meta.url).pathname;

const runsRaw = Deno.env.get("TARGET_DIFF_RUNS");
const numRuns = runsRaw === undefined ? 25 : Number(runsRaw);
if (!Number.isInteger(numRuns) || numRuns < 1) {
  console.error(`test-target-diff.ts: TARGET_DIFF_RUNS は 1 以上の整数: ${runsRaw ?? ""}`);
  Deno.exit(2);
}
const seedEnv = Deno.env.get("FC_SEED");
if (seedEnv !== undefined && !/^-?\d+$/.test(seedEnv)) {
  console.error(`test-target-diff.ts: FC_SEED は整数: ${seedEnv}`);
  Deno.exit(2);
}

// ---- 履歴のモデル ----

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

// ---- 生成器 ----

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

// ---- 実行 ----

const baseEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

async function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const out = await new Deno.Command(cmd, { args, cwd, env: { ...baseEnv, ...env }, stdout: "piped", stderr: "piped" }).output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return { ok: out.success, stdout: text(out.stdout), stderr: text(out.stderr) };
}
async function git(cwd: string, ...args: string[]): Promise<string> {
  // 検査側の git が hook と fsmonitor を走らせて作業ツリーを変えないように
  const r = await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], cwd);
  if (!r.ok) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}
async function commitFile(cwd: string, file: string, subject = file) {
  if (file.includes("/")) await Deno.mkdir(`${cwd}/${file.slice(0, file.lastIndexOf("/"))}`, { recursive: true });
  await Deno.writeTextFile(`${cwd}/${file}`, `${file}\n`);
  await git(cwd, "add", "--", file);
  await git(cwd, "commit", "-q", "-m", subject);
}

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

interface Output {
  work: string;
  run: string;
  repo: string;
  diff: string;
  tree: string;
  rules: string;
}

function parseOutput(stdout: string): Output {
  const o: Record<string, string> = {};
  for (const line of stdout.split("\n").filter((l) => l !== "")) {
    const m = /^(work|run|repo|diff|tree|rules)=(.*)$/.exec(line);
    if (!m) throw new Error(`出力に形式外の行がある: ${line}`);
    o[m[1]] = m[2];
  }
  return o as unknown as Output;
}

async function readDiff(path: string): Promise<{ commits: Set<string>; files: Set<string> }> {
  const text = await Deno.readTextFile(path);
  const lines = text.split("\n");
  const commits = new Set<string>();
  const files = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (/^commit [0-9a-f]+$/.test(lines[i])) commits.add(lines[i + 2]);
    const m = /^diff --git a\/(.*) b\//.exec(lines[i]);
    if (m) files.add(m[1]);
  }
  return { commits, files };
}

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const show = (s: Set<string>) => `[${[...s].sort().join(" ")}]`;

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
  let prStub: { name: string; head: string; base: string } | undefined;
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
      prStub = { name: head, head: rev, base: baseTip };
      base = mbOf(baseTip, rev);
      break;
    }
  }
  const tip = rev ?? coTip;
  const set = new Set([...h.ancestors(tip)].filter((x) => base === null || !h.ancestors(base).has(x)));

  const paths = c.paths.map((i) => (i === 0 ? "." : i === 1 ? "d" : i === 2 ? "nope.txt" : i === 3 ? `${root}/clone/a.txt` : i === 4 ? "../src/a.txt" : i === 5 ? "" : allFiles[(i - 6) % allFiles.length]));
  // 絶対パス・ルートの外に出る .. ・空文字列は git 自体が止める (target-diff.sh 8 行目)
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
    const attrs = await git(wt, "rev-parse", "--path-format=absolute", "--git-path", "info/attributes");
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
    await Deno.mkdir(`${root}/bin`);
    await Deno.writeTextFile(
      `${root}/bin/gh`,
      `#!/bin/sh\nprintf '${prStub.name}\\t${shas.get(prStub.head)}\\t${shas.get(prStub.base)}\\tfalse\\to\\npull request: T\\n\\nBODY\\n'\n`,
      { mode: 0o755 },
    );
    env.PATH = `${root}/bin:${Deno.env.get("PATH")}`;
  }
  let cwd = wt;
  if (c.where === "subdir") {
    cwd = `${wt}/emptydir`;
    await Deno.mkdir(cwd);
  }
  const args = [...(targetArg ? [targetArg] : []), ...(paths.length ? ["--", ...paths] : [])];

  // ---- 回して照合する ----
  const invoke = () => run("bash", [script, ...args], cwd, env);
  const runsBefore = async () => (await Array.fromAsync(Deno.readDir(tmp))).length;
  const worktreesBefore = async () => (await git(clone, "worktree", "list")).split("\n").length;
  const [n0, w0] = [await runsBefore(), await worktreesBefore()];
  if (stop) {
    const r = await invoke();
    if (r.ok) throw new Error(`止まるべきだが通った: ${r.stdout}`);
    if (await runsBefore() !== n0) throw new Error(`止まったのに run が残る: ${r.stderr}`);
    if (await worktreesBefore() !== w0) throw new Error(`止まったのに worktree が残る: ${r.stderr}`);
    return;
  }
  const results = c.concurrent ? await Promise.all([invoke(), invoke()]) : [await invoke()];
  const outputs: Output[] = [];
  for (let r of results) {
    if (!r.ok && /cannot lock ref|\.lock': File exists|shallow file has changed/.test(r.stderr)) r = await invoke();
    if (!r.ok) throw new Error(`止まった: ${r.stderr}`);
    outputs.push(parseOutput(r.stdout));
  }
  if (outputs.length === 2 && outputs[0].run === outputs[1].run) throw new Error("並行実行が run を共有している");
  for (const o of outputs) {
    const got = await readDiff(o.diff);
    if (!same(got.commits, expected.commits)) throw new Error(`コミットが違う: 期待 ${show(expected.commits)} 実際 ${show(got.commits)}`);
    if (!same(got.files, expected.files)) throw new Error(`ファイルが違う: 期待 ${show(expected.files)} 実際 ${show(got.files)}`);
    const common = await git(clone, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!o.work.startsWith(`${common}/review-perspectives/`)) throw new Error(`work が本体の .git の下でない: ${o.work}`);
    if (expected.head !== null) {
      const at = await git(o.repo, "rev-parse", "HEAD");
      if (at !== shas.get(expected.head)) throw new Error(`repo が対象を指していない: ${expected.head} != ${at}`);
      if (!o.repo.startsWith(`${o.run}/`)) throw new Error(`repo が run の下でない: ${o.repo}`);
    } else if (await Deno.realPath(o.repo) !== await Deno.realPath(wt)) throw new Error(`repo がチェックアウトでない: ${o.repo}`);
  }
  if (t.kind === "checkout" && !c.concurrent) await checkIdentity(c, wt, outputs[0], invoke);
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
      await Deno.symlink("sub2", `${wt}/linkdir`);
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
async function checkIdentity(c: Case, wt: string, before: Output, invoke: () => Promise<{ ok: boolean; stdout: string; stderr: string }>) {
  const rerun = async () => {
    const r = await invoke();
    if (!r.ok) throw new Error(`同一性の検査で止まった: ${r.stderr}`);
    const o = parseOutput(r.stdout);
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

const tmpRoot = await Deno.makeTempDir({ prefix: "target-diff-pbt." });
try {
  await fc.assert(
    fc.asyncProperty(caseArb, async (c) => {
      const root = await Deno.makeTempDir({ dir: tmpRoot });
      try {
        await runCase(c, root);
      } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
      }
    }),
    { numRuns, ...(seedEnv ? { seed: Number(seedEnv) } : {}), verbose: fc.VerbosityLevel.Verbose },
  );
} finally {
  await Deno.remove(tmpRoot, { recursive: true }).catch(() => {});
}
