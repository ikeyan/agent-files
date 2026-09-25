/**
 * test-pr.ts — skills/setup-repo/pr-workflow/pr.sh の model based test。verify.sh から呼ぶ。
 *
 * PR の状態と操作列を生成し、pr.sh が呼ぶ経路だけを持つ fake の GitHub (127.0.0.1 の空きポート) に載せて pr.sh を回し、モデルから計算した出力と照合する。fake の返り方は canon の facts/github/rest-rate-limit-responses、facts/github/pr-comments-retrieval-and-resolved-state、facts/github/check-runs-filter-latest-hides-reruns に合わせる。
 *
 * モデル (pr.sh の先頭の仕様を集合で書いたもの):
 * - 状態 S は PENDING の review (提出前の下書き) を持たないものとする。提出されたら、その時に S に足す。
 * - 出す対象 T(S):
 *   - comment <login> <url>: 通常コメント。Codex (chatgpt-codex-connector[bot]) の利用上限のコメントと、Codex の summary で今の head の Completed でないものを除く。人間が書いた summary の形の本文は通常コメント。
 *   - codex-review completed <c> <url>: Codex の summary が Completed で、Commit の <c> が head の接頭辞。
 *   - review-comment <login> <url>: unresolved のスレッドの全コメント (返信を含む)。
 *   - review COMMENTED <login> <url>: 本文のある COMMENTED の review。
 *   - review CHANGES_REQUESTED <login> <url>: レビュアーごとに submittedAt が最大の、COMMENTED 以外の review が CHANGES_REQUESTED のもの。
 *   - ci-failure <name> <conclusion> <url>: head の check run (再実行で置き換えられたものを含む) の conclusion が失敗のもの。
 *   - ci-failure <context> <state> <target_url>: head の commit status (同じ context の後の status で置き換えられたものを含む) が failure・error のもの。
 *   - pr closed merged=<bool> <url>: 閉じた PR。
 * - 初回 (状態のディレクトリが空): T(S) の各要素を open で (閉じた PR は changed で) 出して exit 0。T(S) が空なら、何も出さずに状態を作って待つ。
 * - 以後: 状態 S0 から操作列 Δ で S1 になったら、T(S1) の要素のうち Δ で足したものを new、Δ で編集したものを changed、タイトルの変更を changed title <t>、説明の変更を description changed と unified diff で出して exit 0。どれも無ければ出さずに待つ。
 *   - Δ は 2 つに分けて続く 2 周期の始まりで入れ、前半だけでは何も出ないなら、前半の後の状態を S0 とする。
 *   - 生成しない遷移 (GitHub の挙動を確かめていないか、仕様が new と changed のどちらとも決めていないもの): review の dismiss、スレッドの unresolve、resolve 済みのスレッドへの返信、本文の無い review の編集、PR の reopen。
 * - reply-resolve: スレッド先頭の id なら、そのスレッドが resolved で、トークンの持ち主の同じ本文の返信がちょうど 1 件になり、ほかは変わらない (一時的な失敗で exit 1 になったら、そのままやり直す)。スレッド先頭でない id なら exit 1 で何も変えない。
 * - 恒久的な失敗: 401 なら auth の行で exit 2。404・301・権限の 403・レート制限でない GraphQL の errors なら error の行で exit 3。
 * - 一時的な失敗 (5xx・429・レート制限・接続の切断) を 2 件まで挟んでも、上の結果は変わらない。
 *
 * 環境: PR_RUNS (性質ごとの試行数、既定 8。1 以上の整数。それ以外は止まる)、FC_SEED (再現する seed。指定するなら整数。それ以外は止まる)。
 */
import fc from "fast-check";

const script = new URL("../skills/setup-repo/pr-workflow/pr.sh", import.meta.url).pathname;

const runsRaw = Deno.env.get("PR_RUNS");
const numRuns = runsRaw === undefined ? 8 : Number(runsRaw);
if (!Number.isInteger(numRuns) || numRuns < 1) {
  console.error(`test-pr.ts: PR_RUNS は 1 以上の整数: ${runsRaw ?? ""}`);
  Deno.exit(2);
}
const seedEnv = Deno.env.get("FC_SEED");
if (seedEnv !== undefined && !/^-?\d+$/.test(seedEnv)) {
  console.error(`test-pr.ts: FC_SEED は整数: ${seedEnv}`);
  Deno.exit(2);
}

const REPO = "o/r";
const PR = 1;
const ME = "me";
const BOT = "chatgpt-codex-connector[bot]";
const WEB = `https://github.com/${REPO}/pull/${PR}`;
const DOCS = "https://docs.github.com/rest";
const SUMMARY = "<!-- codex-pull-request-review-summary -->";
const USAGE_LIMIT = "You have reached your Codex usage limits for code reviews. You can see your limits in the Codex usage dashboard.";
const FAILING = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];
const CASE_SECONDS = 20;

// ---- PR の状態 ----

interface IssueComment {
  id: number;
  login: string;
  body: string;
  updated_at: string;
}
interface ReviewComment {
  id: number;
  in_reply_to_id?: number;
  login: string;
  body: string;
  updated_at: string;
}
interface Thread {
  node: string;
  root: number;
  resolved: boolean;
}
type ReviewState = "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "PENDING" | "DISMISSED";
interface Review {
  id: number;
  login: string;
  state: ReviewState;
  body: string;
  submittedAt: string | null;
  updatedAt: string;
}
interface CheckRun {
  id: number;
  sha: string;
  name: string;
  conclusion: string | null;
}
interface Status {
  id: number;
  sha: string;
  context: string;
  state: string;
}
interface World {
  n: number; // id と時刻の元。足すたびに進める
  pr: { state: "open" | "closed"; merged: boolean; title: string; body: string | null; head: string };
  issue: IssueComment[];
  rc: ReviewComment[];
  threads: Thread[];
  reviews: Review[];
  checks: CheckRun[];
  statuses: Status[]; // 古い順
}

const tick = (w: World) => ++w.n;
const idOf = (n: number) => 4_000_000_000 + n;
const timeOf = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString().replace(".000Z", "Z");
// 7 桁の接頭辞が互いに異なる sha
const shaOf = (n: number) => n.toString(16).padStart(7, "0") + ((n * 0x9e3779b1) >>> 0).toString(16).padStart(8, "0").repeat(5).slice(0, 33);
const urls = {
  issue: (id: number) => `${WEB}#issuecomment-${id}`,
  rc: (id: number) => `${WEB}#discussion_r${id}`,
  review: (id: number) => `${WEB}#pullrequestreview-${id}`,
  check: (id: number) => `https://github.com/${REPO}/runs/${id}`,
  status: (id: number) => `https://ci.example.com/${id}`,
};

type CommentSpec =
  | { kind: "text"; login: string; text: string }
  | { kind: "summary"; login: string; completed: boolean; commit: "head" | "old" | "none"; len: number }
  | { kind: "limit"; login: string };

function summaryBody(completed: boolean, commit: string | null): string {
  return `${SUMMARY}\n### Codex Review\n\n| Status | Commit | Review trigger |\n| --- | --- | --- |\n` +
    `| ${completed ? "✅ **Completed**" : "🔄 **Running**"} | ${commit === null ? "—" : `\`${commit}\``} | New commits |\n`;
}

function addComment(w: World, c: CommentSpec) {
  let body: string;
  switch (c.kind) {
    case "text":
      body = c.text;
      break;
    case "limit":
      body = USAGE_LIMIT;
      break;
    case "summary": {
      const sha = c.commit === "head" ? w.pr.head : shaOf(tick(w));
      body = summaryBody(c.completed, c.commit === "none" ? null : sha.slice(0, c.len));
      break;
    }
  }
  const n = tick(w);
  w.issue.push({ id: idOf(n), login: c.login, body, updated_at: timeOf(n) });
}

function addThread(w: World, login: string, resolved: boolean): Thread {
  const n = tick(w);
  w.rc.push({ id: idOf(n), login, body: `root ${n}`, updated_at: timeOf(n) });
  const t = { node: `PRRT_${n}`, root: idOf(n), resolved };
  w.threads.push(t);
  return t;
}

function addReply(w: World, t: Thread, login: string, body: string) {
  const n = tick(w);
  w.rc.push({ id: idOf(n), in_reply_to_id: t.root, login, body, updated_at: timeOf(n) });
}

function addReview(w: World, login: string, state: ReviewState, body: boolean) {
  // PENDING の review は 1 人に 1 つまで
  if (state === "PENDING" && w.reviews.some((r) => r.state === "PENDING")) return;
  const n = tick(w);
  w.reviews.push({
    id: idOf(n),
    login: state === "PENDING" ? ME : login,
    state,
    body: body ? `review ${n}` : "",
    submittedAt: state === "PENDING" ? null : timeOf(n),
    updatedAt: timeOf(n),
  });
}

// ---- モデル ----

/** T(S) を、要素の鍵からイベント文への対応で返す (閉じた PR を除く)。 */
function targets(w: World): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of w.issue) {
    if (c.login === BOT && c.body.startsWith(SUMMARY)) {
      const commit = /`([0-9a-f]{7,40})`/.exec(c.body)?.[1];
      if (c.body.includes("**Completed**") && commit && w.pr.head.startsWith(commit)) {
        m.set(`ic:${c.id}`, `codex-review completed ${commit} ${urls.issue(c.id)}`);
      }
    } else if (!(c.login === BOT && c.body.startsWith(USAGE_LIMIT))) {
      m.set(`ic:${c.id}`, `comment ${c.login} ${urls.issue(c.id)}`);
    }
  }
  const open = new Set(w.threads.filter((t) => !t.resolved).map((t) => t.root));
  for (const c of w.rc) if (open.has(c.in_reply_to_id ?? c.id)) m.set(`rc:${c.id}`, `review-comment ${c.login} ${urls.rc(c.id)}`);
  const last = new Map<string, Review>();
  for (const r of w.reviews) {
    if (r.state === "COMMENTED") {
      if (r.body !== "") m.set(`rv:${r.id}`, `review COMMENTED ${r.login} ${urls.review(r.id)}`);
      continue;
    }
    const prev = last.get(r.login);
    if (r.state !== "PENDING" && (!prev || r.submittedAt! > prev.submittedAt!)) last.set(r.login, r);
  }
  for (const r of last.values()) {
    if (r.state === "CHANGES_REQUESTED") m.set(`rv:${r.id}`, `review CHANGES_REQUESTED ${r.login} ${urls.review(r.id)}`);
  }
  for (const c of w.checks) {
    if (c.sha === w.pr.head && FAILING.includes(c.conclusion ?? "")) m.set(`cr:${c.id}`, `ci-failure ${c.name} ${c.conclusion} ${urls.check(c.id)}`);
  }
  for (const s of w.statuses) {
    if (s.sha === w.pr.head && (s.state === "failure" || s.state === "error")) m.set(`st:${s.id}`, `ci-failure ${s.context} ${s.state} ${urls.status(s.id)}`);
  }
  return m;
}

/** 要素の鍵から版 (編集で変わる) への対応。 */
function revisions(w: World): Map<string, string> {
  return new Map([
    ...w.issue.map((c) => [`ic:${c.id}`, c.updated_at] as const),
    ...w.rc.map((c) => [`rc:${c.id}`, c.updated_at] as const),
    ...w.reviews.filter((r) => r.state !== "PENDING").map((r) => [`rv:${r.id}`, `${r.state} ${r.updatedAt}`] as const),
    ...w.checks.map((c) => [`cr:${c.id}`, ""] as const),
    ...w.statuses.map((s) => [`st:${s.id}`, ""] as const),
  ]);
}

const closedLine = (w: World) => `changed pr closed merged=${w.pr.merged} ${WEB}`;

function expectInitial(w: World): string[] {
  const lines = [...targets(w).values()].map((t) => `open ${t}`);
  if (w.pr.state === "closed") lines.push(closedLine(w));
  return lines;
}

function expectDelta(w0: World, w1: World): string[] {
  const r0 = revisions(w0), r1 = revisions(w1);
  const lines: string[] = [];
  for (const [k, t] of targets(w1)) {
    const before = r0.get(k);
    if (before === undefined) lines.push(`new ${t}`);
    else if (before !== r1.get(k)) lines.push(`changed ${t}`);
  }
  if (w0.pr.title !== w1.pr.title) lines.push(`changed title ${w1.pr.title}`);
  if (w1.pr.state === "closed") lines.push(closedLine(w1));
  return lines;
}

// ---- 操作 ----

type Op =
  | { op: "comment"; c: CommentSpec }
  | { op: "edit"; i: number; complete: boolean; text: string }
  | { op: "review"; login: string; state: ReviewState; body: boolean }
  | { op: "editReview"; i: number; shown: boolean; text: string }
  | { op: "submit"; state: ReviewState }
  | { op: "thread"; login: string }
  | { op: "reply"; i: number; login: string; text: string }
  | { op: "editReviewComment"; i: number; shown: boolean; text: string }
  | { op: "resolve"; i: number }
  | { op: "push"; summary: "stale" | "running" | "completed" }
  | { op: "ci"; check: boolean; name: string; conclusion: string }
  | { op: "title"; title: string }
  | { op: "body"; body: string | null }
  | { op: "close"; merged: boolean };

const isSummary = (c: IssueComment) => c.login === BOT && c.body.startsWith(SUMMARY);

function apply(w: World, o: Op) {
  const unresolved = w.threads.filter((t) => !t.resolved);
  switch (o.op) {
    case "comment":
      addComment(w, o.c);
      break;
    case "edit": {
      if (w.issue.length === 0) break;
      const c = w.issue[o.i % w.issue.length];
      if (isSummary(c)) {
        // Codex は summary を今の head の Running か Completed に書き換える
        const body = summaryBody(o.complete, w.pr.head.slice(0, 7));
        if (body === c.body) break;
        c.body = body;
      } else if (!(c.login === BOT && c.body.startsWith(USAGE_LIMIT))) c.body = `${c.body}\n${o.text}`;
      c.updated_at = timeOf(tick(w));
      break;
    }
    case "review":
      addReview(w, o.login, o.state, o.body);
      break;
    case "editReview": {
      const editable = w.reviews.filter((r) => r.state !== "PENDING" && r.body !== "");
      const shown = editable.filter((r) => targets(w).has(`rv:${r.id}`));
      const from = o.shown && shown.length > 0 ? shown : editable;
      if (from.length === 0) break;
      const r = from[o.i % from.length];
      r.body = `${r.body}\n${o.text}`;
      r.updatedAt = timeOf(tick(w));
      break;
    }
    case "submit": {
      const r = w.reviews.find((r) => r.state === "PENDING");
      if (!r) break;
      const n = tick(w);
      [r.state, r.submittedAt, r.updatedAt] = [o.state, timeOf(n), timeOf(n)];
      break;
    }
    case "thread":
      addThread(w, o.login, false);
      break;
    case "reply":
      // resolve 済みのスレッドへの返信が resolve を解くかは確かめていないので、unresolved のスレッドにだけ返信する
      if (unresolved.length === 0) addThread(w, o.login, false);
      else addReply(w, unresolved[o.i % unresolved.length], o.login, o.text);
      break;
    case "editReviewComment": {
      const shown = w.rc.filter((c) => targets(w).has(`rc:${c.id}`));
      const from = o.shown && shown.length > 0 ? shown : w.rc;
      if (from.length === 0) break;
      const c = from[o.i % from.length];
      c.body = `${c.body}\n${o.text}`;
      c.updated_at = timeOf(tick(w));
      break;
    }
    case "resolve":
      if (unresolved.length > 0) unresolved[o.i % unresolved.length].resolved = true;
      break;
    case "push": {
      w.pr.head = shaOf(tick(w));
      if (o.summary === "stale") break;
      const s = w.issue.find(isSummary);
      if (!s) addComment(w, { kind: "summary", login: BOT, completed: o.summary === "completed", commit: "head", len: 7 });
      else {
        s.body = summaryBody(o.summary === "completed", w.pr.head.slice(0, 7));
        s.updated_at = timeOf(tick(w));
      }
      break;
    }
    case "ci": {
      const n = tick(w);
      if (o.check) w.checks.push({ id: idOf(n), sha: w.pr.head, name: o.name, conclusion: o.conclusion });
      else w.statuses.push({ id: idOf(n), sha: w.pr.head, context: o.name, state: o.conclusion === "failure" ? "failure" : "error" });
      break;
    }
    case "title":
      w.pr.title = o.title;
      break;
    case "body":
      w.pr.body = o.body;
      break;
    case "close":
      w.pr.state = "closed";
      w.pr.merged = o.merged;
      break;
  }
}

// ---- 生成器 ----

const loginArb = fc.constantFrom("alice", "bob", ME, BOT);
const textArb = fc.array(fc.constantFrom("fix", "LGTM", "nit:", "`x`", "$HOME", '"q"', "日本語", "a\tb", "1\n2", "\\n", "%s", "<!-- -->"), {
  minLength: 1,
  maxLength: 4,
}).map((ws) => ws.join(" "));
const titleArb = fc.array(fc.constantFrom("Fix", "watch", "pr.sh", "日本語", "v2", "`x`", "a/b"), { minLength: 1, maxLength: 4 }).map((ws) => ws.join(" "));
const bodyArb = fc.option(
  fc.array(fc.constantFrom("line", "- item", "", "日本語", "crlf\r", "@@ -1 +1 @@", "+plus", "-minus"), { minLength: 1, maxLength: 6 })
    .map((ls) => ls.join("\n"))
    .filter((b) => b !== ""),
  { nil: null },
);
const commentArb: fc.Arbitrary<CommentSpec> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("text" as const), login: loginArb, text: textArb }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("summary" as const),
      login: fc.constantFrom(BOT, BOT, "alice"),
      completed: fc.boolean(),
      commit: fc.constantFrom("head" as const, "old" as const, "none" as const),
      len: fc.constantFrom(7, 12, 40),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("limit" as const), login: fc.constantFrom(BOT, "alice") }) },
);
const reviewStateArb = fc.constantFrom<ReviewState>("COMMENTED", "APPROVED", "CHANGES_REQUESTED", "PENDING", "DISMISSED");
const conclusionArb = fc.constantFrom(null, "success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "startup_failure", "stale");
/** 100 件ずつのページの境目をまたぐ件数を、ときどき足す */
const bulkArb = fc.oneof({ weight: 8, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.constantFrom(99, 100, 101, 150) });

const worldArb = fc.record({
  closed: fc.oneof({ weight: 4, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
  merged: fc.boolean(),
  title: titleArb,
  body: bodyArb,
  comments: fc.array(commentArb, { maxLength: 4 }),
  threads: fc.array(fc.record({ resolved: fc.boolean(), logins: fc.array(loginArb, { minLength: 1, maxLength: 3 }) }), { maxLength: 3 }),
  // review の編集が changed として検査に入るように、出す対象になる review (本文のある COMMENTED と CHANGES_REQUESTED) を多くする
  reviews: fc.array(
    fc.record({
      login: fc.constantFrom("alice", "bob", BOT),
      state: fc.oneof({ weight: 3, arbitrary: fc.constantFrom<ReviewState>("COMMENTED", "CHANGES_REQUESTED") }, { weight: 2, arbitrary: reviewStateArb }),
      body: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
    }),
    { maxLength: 5 },
  ),
  checks: fc.array(fc.record({ name: fc.constantFrom("build", "test", "lint (ubuntu)"), conclusion: conclusionArb, head: fc.boolean() }), { maxLength: 4 }),
  statuses: fc.array(
    fc.record({ context: fc.constantFrom("ci/a", "ci/b"), state: fc.constantFrom("pending", "success", "failure", "error"), head: fc.boolean() }),
    { maxLength: 4 },
  ),
  bulk: fc.record({ issue: bulkArb, threads: bulkArb, reviews: bulkArb, checks: bulkArb, statuses: bulkArb }),
});
type WorldSpec = typeof worldArb extends fc.Arbitrary<infer T> ? T : never;

function build(s: WorldSpec): World {
  const w: World = {
    n: 0,
    pr: { state: s.closed ? "closed" : "open", merged: s.closed && s.merged, title: s.title, body: s.body, head: "" },
    issue: [],
    rc: [],
    threads: [],
    reviews: [],
    checks: [],
    statuses: [],
  };
  w.pr.head = shaOf(tick(w));
  const old = shaOf(tick(w));
  for (let i = 0; i < s.bulk.issue; i++) addComment(w, i % 3 === 0 ? { kind: "text", login: "carol", text: "bulk" } : { kind: "limit", login: BOT });
  for (let i = 0; i < s.bulk.threads; i++) addThread(w, "carol", i % 2 === 0);
  for (let i = 0; i < s.bulk.reviews; i++) addReview(w, "carol", i % 2 === 0 ? "COMMENTED" : "APPROVED", true);
  for (let i = 0; i < s.bulk.checks; i++) {
    const n = tick(w);
    w.checks.push({ id: idOf(n), sha: w.pr.head, name: `bulk-${i}`, conclusion: i % 10 === 0 ? "failure" : "success" });
  }
  for (let i = 0; i < s.bulk.statuses; i++) {
    const n = tick(w);
    w.statuses.push({ id: idOf(n), sha: w.pr.head, context: `bulk/${i}`, state: i % 10 === 0 ? "error" : "success" });
  }
  for (const c of s.comments) addComment(w, c);
  for (const t of s.threads) {
    const th = addThread(w, t.logins[0], t.resolved);
    for (const l of t.logins.slice(1)) addReply(w, th, l, `reply ${w.n}`);
  }
  for (const r of s.reviews) addReview(w, r.login, r.state, r.body);
  for (const c of s.checks) {
    const n = tick(w);
    w.checks.push({ id: idOf(n), sha: c.head ? w.pr.head : old, name: c.name, conclusion: c.conclusion });
  }
  for (const st of s.statuses) {
    const n = tick(w);
    w.statuses.push({ id: idOf(n), sha: st.head ? w.pr.head : old, context: st.context, state: st.state });
  }
  return w;
}

/** shown の編集は出す対象のものから選ぶ (出さないものの編集ばかりだと changed の行が検査に入らない) */
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ op: fc.constant("comment" as const), c: commentArb }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("edit" as const), i: fc.nat(200), complete: fc.boolean(), text: textArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("review" as const), login: loginArb, state: reviewStateArb.filter((s) => s !== "DISMISSED"), body: fc.boolean() }) },
  {
    weight: 6,
    arbitrary: fc.record({
      op: fc.constant("editReview" as const),
      i: fc.nat(200),
      shown: fc.oneof({ weight: 3, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
      text: textArb,
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("submit" as const), state: fc.constantFrom<ReviewState>("COMMENTED", "APPROVED", "CHANGES_REQUESTED") }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("thread" as const), login: loginArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("reply" as const), i: fc.nat(200), login: loginArb, text: textArb }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("editReviewComment" as const), i: fc.nat(200), shown: fc.boolean(), text: textArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("resolve" as const), i: fc.nat(200) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("push" as const), summary: fc.constantFrom("stale" as const, "running" as const, "completed" as const) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("ci" as const), check: fc.boolean(), name: fc.constantFrom("build", "ci/a"), conclusion: fc.constantFrom(...FAILING) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("title" as const), title: titleArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("body" as const), body: bodyArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("close" as const), merged: fc.boolean() }) },
);

type Transient = { kind: "500" | "429" | "403" | "drop"; applied: boolean };
type Permanent = "401" | "404" | "301" | "403" | "graphql";
const failuresArb = fc.record({
  skip: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, { weight: 2, arbitrary: fc.nat(30) }),
  list: fc.array(fc.record({ kind: fc.constantFrom("500" as const, "429" as const, "403" as const, "drop" as const), applied: fc.boolean() }), {
    maxLength: 2,
  }),
});
const permanentArb = fc.oneof(
  { weight: 6, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.constantFrom<Permanent>("401", "404", "301", "403", "graphql") },
);

// ---- fake の GitHub ----

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-ratelimit-remaining": "4999", ...headers },
  });
}

/** ヘッダーの後、本文を送らずに接続を切る (Deno.serve は応答の前に切れない) */
function dropped(): Response {
  return new Response(new ReadableStream({ start: (c) => c.close() }), { headers: { "content-length": "1000" } });
}

function transient(kind: Transient["kind"], graphql: boolean): Response {
  switch (kind) {
    case "500":
      return json(500, { message: "Server Error" });
    case "429":
      // GraphQL は primary のレート制限を 200 と errors で返す
      if (graphql) return json(200, { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }] }, { "x-ratelimit-remaining": "0" });
      return json(429, { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.", documentation_url: DOCS }, {
        "retry-after": "1",
      });
    case "403":
      return json(403, { message: "API rate limit exceeded for user ID 1.", documentation_url: DOCS }, { "x-ratelimit-remaining": "0" });
    case "drop":
      return dropped();
  }
}

function page<T>(items: T[], q: URLSearchParams): T[] {
  const per = Math.min(Number(q.get("per_page") || "30"), 100);
  const p = Number(q.get("page") || "1");
  return items.slice((p - 1) * per, p * per);
}

/** GraphQL の選択に名前が現れるフィールドだけを残す */
function select(node: Record<string, unknown>, selection: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node).filter(([k]) => new RegExp(`\\b${k}\\b`).test(selection)));
}

class Fake {
  world: World;
  pending: World[] = []; // 周期の始まりに 1 つずつ入れる状態
  private appliedAt = -1; // 最後に入れたときの ends の数
  starts = 0; // 周期の始まり (PR の取得) の数
  ends: number[] = []; // 周期の終わり (commit status の最後のページ) ごとの、その時点の starts
  log: string[] = [];
  procs: Proc[] = [];
  private server: Deno.HttpServer<Deno.NetAddr>;

  constructor(world: World, private skip: number, private failures: Transient[], private permanent: Permanent | null) {
    this.world = world;
    this.server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => this.handle(req));
  }

  get url() {
    return `http://127.0.0.1:${this.server.addr.port}`;
  }

  close() {
    return this.server.shutdown();
  }

  private async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const body = req.method === "POST" ? await req.text() : "";
    this.log.push(`${req.method} ${u.pathname}${u.search}`);
    if (req.method === "GET" && u.pathname === `/repos/${REPO}/pulls/${PR}`) {
      this.starts++;
      // 周期の途中で状態が変わると 1 周期の中で食い違うので、周期の始まりで入れる。前に入れた状態を 1 周期が読み終えるまでは次を入れない
      if (this.pending.length > 0 && (this.appliedAt < 0 || this.ends.length > this.appliedAt)) {
        this.world = this.pending.shift()!;
        this.appliedAt = this.ends.length;
      }
    }
    let f: Transient | undefined;
    if (this.skip > 0) this.skip--;
    else f = this.failures.shift();
    if (f && !(f.kind === "drop" && f.applied)) return transient(f.kind, u.pathname === "/graphql");
    let end = false;
    const res = req.headers.get("authorization") !== "Bearer test" || this.permanent === "401"
      ? json(401, { message: "Bad credentials", documentation_url: DOCS, status: "401" })
      : u.pathname === "/graphql"
      ? this.graphql(JSON.parse(body))
      : this.rest(req.method, u, body, () => end = true);
    if (f) return dropped();
    if (end) this.ends.push(this.starts);
    return res;
  }

  private rest(method: string, u: URL, body: string, lastPage: () => void): Response {
    const w = this.world;
    const q = u.searchParams;
    const path = u.pathname;
    if (!path.startsWith(`/repos/${REPO}/`)) return json(404, { message: "Not Found", documentation_url: DOCS, status: "404" });
    if (this.permanent === "301") {
      const moved = `${this.url}/repositories/1${path.slice(`/repos/${REPO}`.length)}`;
      return json(301, { message: "Moved Permanently", url: moved, documentation_url: DOCS }, { location: moved });
    }
    if (this.permanent === "403") return json(403, { message: "Resource not accessible by integration", documentation_url: DOCS, status: "403" });
    const rest = path.slice(`/repos/${REPO}/`.length);
    const notFound = json(404, { message: "Not Found", documentation_url: DOCS, status: "404" });
    if (this.permanent === "404" && /^(pulls|issues)\/\d+(\/|$)/.test(rest)) return notFound;
    let m: RegExpMatchArray | null;
    if (method === "GET" && rest === `pulls/${PR}`) {
      return json(200, { number: PR, state: w.pr.state, merged: w.pr.merged, html_url: WEB, title: w.pr.title, body: w.pr.body, head: { sha: w.pr.head } });
    }
    if (method === "GET" && rest === `issues/${PR}/comments`) {
      return json(200, page(w.issue, q).map((c) => ({ id: c.id, user: { login: c.login }, body: c.body, updated_at: c.updated_at, html_url: urls.issue(c.id) })));
    }
    if (method === "GET" && rest === `pulls/${PR}/comments`) {
      return json(
        200,
        page(w.rc, q).map((c) => ({
          id: c.id,
          ...(c.in_reply_to_id === undefined ? {} : { in_reply_to_id: c.in_reply_to_id }),
          user: { login: c.login },
          body: c.body,
          updated_at: c.updated_at,
          html_url: urls.rc(c.id),
        })),
      );
    }
    if (method === "POST" && (m = rest.match(new RegExp(`^pulls/${PR}/comments/(\\d+)/replies$`)))) {
      const t = w.threads.find((t) => t.root === Number(m![1]));
      if (!t) return notFound;
      addReply(w, t, ME, JSON.parse(body).body);
      const c = w.rc.at(-1)!;
      return json(201, { id: c.id, in_reply_to_id: c.in_reply_to_id, user: { login: ME }, body: c.body, updated_at: c.updated_at, html_url: urls.rc(c.id) });
    }
    if (method === "GET" && (m = rest.match(/^commits\/([0-9a-f]{40})\/check-runs$/))) {
      let runs = w.checks.filter((c) => c.sha === m![1]);
      if ((q.get("filter") ?? "latest") === "latest") runs = runs.filter((c) => !runs.some((d) => d.name === c.name && d.id > c.id));
      const p = page(runs, q);
      return json(200, { total_count: runs.length, check_runs: p.map((c) => ({ id: c.id, name: c.name, status: c.conclusion === null ? "in_progress" : "completed", conclusion: c.conclusion, html_url: urls.check(c.id) })) });
    }
    if (method === "GET" && (m = rest.match(/^commits\/([0-9a-f]{40})\/statuses$/))) {
      const p = page(w.statuses.filter((s) => s.sha === m![1]).reverse(), q);
      if (p.length < Math.min(Number(q.get("per_page") || "30"), 100)) lastPage();
      return json(200, p.map((s) => ({ id: s.id, context: s.context, state: s.state, target_url: urls.status(s.id), description: null })));
    }
    return notFound;
  }

  private graphql(req: { query: string; variables?: Record<string, unknown> }): Response {
    const w = this.world;
    const { query, variables = {} } = req;
    if (this.permanent === "graphql") {
      return json(200, { errors: [{ path: ["query"], extensions: { code: "undefinedField" }, locations: [{ line: 1, column: 1 }], message: "Field 'x' doesn't exist on type 'Query'" }] });
    }
    if (/^\s*\{\s*viewer\s*\{\s*login\s*\}\s*\}\s*$/.test(query)) return json(200, { data: { viewer: { login: ME } } });
    if (this.permanent === "403") return json(200, { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
    if (query.includes("resolveReviewThread")) {
      const t = w.threads.find((t) => t.node === variables.t);
      if (!t) return json(200, { data: null, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a node with the global id of '${variables.t}'` }] });
      t.resolved = true;
      return json(200, { data: { resolveReviewThread: { thread: { isResolved: true } } } });
    }
    if (variables.owner !== "o" || variables.name !== "r" || variables.pr !== PR || this.permanent === "404") {
      return json(200, {
        data: { repository: { pullRequest: null } },
        errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: `Could not resolve to a PullRequest with the number of ${variables.pr}.` }],
      });
    }
    const conn = /pullRequest\(number:\$pr\)\{(\w+)\(first:(\d+),after:\$cursor\)\{(.*)\}\}\}\}$/.exec(query);
    if (!conn || Number(conn[2]) > 100) return json(200, { errors: [{ message: `unexpected query: ${query}` }] });
    const [, field, first, selection] = conn;
    let nodes: Record<string, unknown>[];
    if (field === "reviewThreads") {
      nodes = w.threads.map((t) => ({ id: t.node, isResolved: t.resolved, comments: { nodes: [{ databaseId: t.root }] } }));
    } else if (field === "reviews") {
      nodes = w.reviews.map((r) => ({
        databaseId: r.id,
        state: r.state,
        body: r.body,
        submittedAt: r.submittedAt,
        updatedAt: r.updatedAt,
        url: urls.review(r.id),
        author: { login: r.login },
      }));
    } else return json(200, { errors: [{ message: `unexpected field: ${field}` }] });
    const from = typeof variables.cursor === "string" ? Number(variables.cursor.slice(1)) : 0;
    const p = nodes.slice(from, from + Number(first)).map((n) => select(n, selection));
    return json(200, {
      data: {
        repository: {
          pullRequest: { [field]: { pageInfo: { hasNextPage: from + p.length < nodes.length, endCursor: p.length ? `c${from + p.length}` : null }, nodes: p } },
        },
      },
    });
  }
}

// ---- 実行 ----

/**
 * pr.sh の子プロセスに渡す環境を組み立てる (GH_TOKEN は既定で test、追加分は extra で上書き)。
 * 継承した http_proxy 等があると 127.0.0.1 の fake への要求もそれ経由になり fake に届かず固まるので、
 * NO_PROXY・no_proxy に 127.0.0.1 を足す (継承値があれば連結する)。
 */
function prEnv(extra: Record<string, string> = {}): Record<string, string> {
  const withLoopback = (name: string) => {
    const inherited = Deno.env.get(name);
    return inherited ? `${inherited},127.0.0.1` : "127.0.0.1";
  };
  return { GH_TOKEN: "test", NO_PROXY: withLoopback("NO_PROXY"), no_proxy: withLoopback("no_proxy"), ...extra };
}

async function within<T>(p: Promise<T>, deadline: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<undefined>((r) => timer = setTimeout(() => r(undefined), Math.max(0, deadline - Date.now())));
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

class Proc {
  out = "";
  err = "";
  code: number | null = null;
  private child: Deno.ChildProcess;
  private readers: ReadableStreamDefaultReader<string>[] = [];
  private pumps: Promise<void>[];

  constructor(args: string[], fake: Fake) {
    this.child = new Deno.Command("bash", {
      args: [script, ...args],
      env: prEnv({ GITHUB_API_URL: fake.url }),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    fake.procs.push(this);
    const pump = async (s: ReadableStream<Uint8Array>, put: (t: string) => void) => {
      const r = s.pipeThrough(new TextDecoderStream()).getReader();
      this.readers.push(r);
      for (;;) {
        const { value, done } = await r.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        put(value!);
      }
    };
    this.pumps = [pump(this.child.stdout, (t) => this.out += t), pump(this.child.stderr, (t) => this.err += t)];
    this.child.status.then((s) => this.code = s.code);
  }

  async exit(deadline: number): Promise<number> {
    const s = await within(this.child.status, deadline);
    if (s === undefined) {
      this.kill();
      await within(Promise.allSettled(this.pumps), deadline);
      throw new Error(`${CASE_SECONDS} 秒で終わらない\n${this.show()}`);
    }
    await within(Promise.all(this.pumps), deadline);
    return s.code;
  }

  /** 待ち続けている pr.sh を止める (sleep の子が標準出力を持ち続けるので、読むのもやめる) */
  kill() {
    if (this.code === null) this.child.kill("SIGKILL");
    for (const r of this.readers) r.cancel().catch(() => {});
  }

  show() {
    return `stdout:\n${this.out}\nstderr:\n${this.err}`;
  }
}

async function until(cond: () => boolean, proc: Proc, deadline: number) {
  while (!cond() && proc.code === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

/** pr.sh が cycles 周期を終えて次の周期に入るまで待ち、その間に何も出さず待ち続けていることを確かめる */
async function expectQuiet(fake: Fake, proc: Proc, deadline: number, cycles: number, what: string) {
  const base = fake.ends.length;
  await until(() => fake.ends.length >= base + cycles && fake.starts > fake.ends[base + cycles - 1], proc, deadline);
  if (proc.out !== "" || proc.code !== null) throw new Error(`${what}: 何も出さずに待つはず (exit ${proc.code})\n${proc.show()}`);
  if (fake.ends.length < base + cycles) throw new Error(`${what}: ${CASE_SECONDS} 秒で ${cycles} 周期を終えない\n${proc.show()}`);
}

const sorted = (xs: string[]) => [...xs].sort();

function expectLines(got: string[], want: string[], what: string, proc: Proc) {
  const [g, e] = [sorted(got), sorted(want)];
  if (JSON.stringify(g) !== JSON.stringify(e)) {
    const missing = e.filter((x) => !g.includes(x)), extra = g.filter((x) => !e.includes(x));
    throw new Error(`${what}: 出力が違う\n足りない: ${JSON.stringify(missing)}\n余分: ${JSON.stringify(extra)}\n${proc.show()}`);
  }
}

/** 出力をイベント文の行と、description changed に続く unified diff の行に分ける */
function parse(out: string): { events: string[]; diff: string[] | null } {
  const events: string[] = [];
  let diff: string[] | null = null;
  for (const l of out.split("\n").slice(0, -1)) {
    if (diff !== null && /^[-+ @\\]/.test(l)) diff.push(l);
    else if (l === "description changed" && diff === null) diff = [];
    else events.push(l);
  }
  return { events, diff };
}

const fileLines = (body: string | null) => `${body ?? "null"}\n`.split("\n").slice(0, -1);

function patch(old: string[], diff: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  for (let k = 0; k < diff.length; k++) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(diff[k]);
    if (!h) throw new Error(`hunk の見出しでない: ${diff[k]}`);
    const start = h[2] === "0" ? Number(h[1]) : Number(h[1]) - 1;
    while (i < start) out.push(old[i++]);
    while (k + 1 < diff.length && !diff[k + 1].startsWith("@@")) {
      const l = diff[++k];
      if (l[0] === "+") out.push(l.slice(1));
      else if (old[i] !== l.slice(1)) throw new Error(`diff が元の説明と合わない: ${JSON.stringify(l)} != ${JSON.stringify(old[i])}`);
      else {
        if (l[0] === " ") out.push(old[i]);
        i++;
      }
    }
  }
  while (i < old.length) out.push(old[i++]);
  return out;
}

function checkPermanent(code: number, out: string, p: Permanent, what: string, proc: Proc) {
  const [want, prefix] = p === "401" ? [2, "auth"] : [3, "error"];
  const lines = out.split("\n").filter((l) => l !== "");
  if (code !== want || lines.length === 0 || !lines.every((l) => l.startsWith(prefix))) {
    throw new Error(`${what}: ${p} で ${prefix} の行と exit ${want} のはず (exit ${code})\n${proc.show()}`);
  }
}

const watch = (fake: Fake, dir: string) => new Proc(["watch", REPO, String(PR), dir, "1"], fake);

/** 初回の watch を回して照合する。T(S) が空なら待っている pr.sh を返す。 */
async function initial(w: World, fake: Fake, dir: string, permanent: Permanent | null): Promise<Proc | null> {
  const deadline = Date.now() + CASE_SECONDS * 1000;
  const proc = watch(fake, dir);
  const want = expectInitial(w);
  if (permanent === null && want.length === 0) {
    await expectQuiet(fake, proc, deadline, 1, "初回で出す対象が無い");
    if (!(await exists(`${dir}/state`))) throw new Error(`初回で状態ファイルができていない\n${proc.show()}`);
    return proc;
  }
  const code = await proc.exit(deadline);
  if (permanent !== null) checkPermanent(code, proc.out, permanent, "watch", proc);
  else {
    if (code !== 0) throw new Error(`初回: exit ${code}\n${proc.show()}`);
    expectLines(proc.out.split("\n").slice(0, -1), want, "初回", proc);
  }
  return null;
}

async function withFake(w: World, failures: { skip: number; list: Transient[] }, permanent: Permanent | null, body: (fake: Fake, dir: string) => Promise<void>) {
  const fake = new Fake(w, failures.skip, structuredClone(failures.list), permanent);
  const dir = await Deno.makeTempDir({ dir: tmpRoot });
  try {
    await body(fake, dir);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : e}\n要求:\n${fake.log.join("\n")}`);
  } finally {
    for (const p of fake.procs) p.kill();
    await fake.close();
  }
}

// ---- 性質 ----

const p1 = fc.asyncProperty(worldArb, failuresArb, permanentArb, async (spec, failures, permanent) => {
  const w = build(spec);
  await withFake(structuredClone(w), failures, permanent, async (fake, dir) => {
    await initial(w, fake, dir, permanent);
  });
});

const p2 = fc.asyncProperty(worldArb, fc.array(opArb, { minLength: 1, maxLength: 3 }), fc.nat(), failuresArb, async (spec, generated, split, failures) => {
  const w0 = build({ ...spec, closed: false });
  // Δ を 2 つに分け、後半を次の周期 (前半で差が出たなら窓の後の取り直し) の始まりで入れる
  const cut = split % (generated.length + 1);
  const mid = structuredClone(w0);
  for (const o of generated.slice(0, cut)) apply(mid, o);
  const w1 = structuredClone(mid);
  for (const o of generated.slice(cut)) apply(w1, o);
  const quiet = (a: World, b: World) => expectDelta(a, b).length === 0 && a.pr.body === b.pr.body;
  // 前半で何も出なければ、pr.sh はその周期を基準に記録する
  const base = quiet(w0, mid) ? mid : w0;
  await withFake(structuredClone(w0), failures, null, async (fake, dir) => {
    let proc = await initial(w0, fake, dir, null);
    fake.pending = [mid, w1].map((w) => structuredClone(w));
    // 初回で出して終わったら、gh.md の手順どおり同じ状態のディレクトリで起動し直す
    proc ??= watch(fake, dir);
    const deadline = Date.now() + CASE_SECONDS * 1000;
    if (quiet(base, w1)) {
      await until(() => fake.pending.length === 0, proc, deadline);
      // 差を見つけたら窓を置いて取り直してから出すので、Δ を入れ終えた周期の次の周期まで待つ
      await expectQuiet(fake, proc, deadline, 2, "Δ に出すものが無い");
      proc.kill();
      return;
    }
    const code = await proc.exit(deadline);
    if (code !== 0) throw new Error(`以後: exit ${code}\n${proc.show()}`);
    const { events, diff } = parse(proc.out);
    expectLines(events, expectDelta(base, w1), "以後", proc);
    const bodyChanged = base.pr.body !== w1.pr.body;
    if (bodyChanged !== (diff !== null)) throw new Error(`以後: 説明の変更 (${bodyChanged}) と description changed の有無が合わない\n${proc.show()}`);
    if (diff !== null && JSON.stringify(patch(fileLines(base.pr.body), diff)) !== JSON.stringify(fileLines(w1.pr.body))) {
      throw new Error(`以後: diff を当てても新しい説明にならない\n${proc.show()}`);
    }
  });
});

const targetArb = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("root" as const), i: fc.nat(200) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("reply" as const), i: fc.nat(200) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("missing" as const) }) },
);

const p3 = fc.asyncProperty(
  worldArb,
  targetArb,
  textArb,
  fc.record({ mine: fc.boolean(), others: fc.boolean(), elsewhere: fc.boolean() }),
  failuresArb,
  permanentArb,
  async (spec, target, text, prior, failures, permanent) => {
    const w = build(spec);
    addThread(w, "alice", false);
    let id = 1;
    let thread: Thread | undefined;
    if (target.kind === "root") {
      thread = w.threads[target.i % w.threads.length];
      id = thread.root;
      // 前の実行が返信の後で止まった跡と、他人の同じ本文の返信と、別のスレッドへの自分の同じ本文の返信
      if (prior.mine) addReply(w, thread, ME, text);
      if (prior.others) addReply(w, thread, "alice", text);
      const other = w.threads.find((t) => t !== thread);
      if (prior.elsewhere && other) addReply(w, other, ME, text);
    } else if (target.kind === "reply") {
      addReply(w, w.threads[target.i % w.threads.length], "bob", "reply");
      id = w.rc.at(-1)!.id;
    }
    const before = structuredClone(w);
    await withFake(w, failures, permanent, async (fake) => {
      const deadline = Date.now() + CASE_SECONDS * 1000;
      let proc: Proc;
      let code: number;
      let attempts = 0;
      do {
        proc = new Proc(["reply-resolve", REPO, String(PR), String(id), text], fake);
        code = await proc.exit(deadline);
      } while (code === 1 && ++attempts < 3);
      const after = fake.world;
      const unchanged = () => {
        if (after.rc.length !== before.rc.length || JSON.stringify(after.threads) !== JSON.stringify(before.threads)) {
          throw new Error(`reply-resolve: スレッドを変えてはいけない\n${proc.show()}`);
        }
      };
      // 301 は REST にだけ返るので、スレッドが無いと分かるのと REST に触れるのとどちらが先かで exit が決まる
      if (permanent === "301" && !thread) {
        if (code !== 1 && code !== 3) throw new Error(`reply-resolve: exit ${code}\n${proc.show()}`);
        unchanged();
      } else if (permanent !== null) {
        checkPermanent(code, proc.out, permanent, "reply-resolve", proc);
        unchanged();
      } else if (!thread) {
        if (code !== 1) throw new Error(`reply-resolve: スレッド先頭でない id で exit ${code}\n${proc.show()}`);
        unchanged();
      } else {
        if (code !== 0) throw new Error(`reply-resolve: exit ${code}\n${proc.show()}`);
        const mine = after.rc.filter((c) => c.in_reply_to_id === id && c.login === ME && c.body === text);
        if (mine.length !== 1) throw new Error(`reply-resolve: 自分の同じ本文の返信が ${mine.length} 件\n${proc.show()}`);
        if (after.rc.length !== before.rc.length + (prior.mine ? 0 : 1)) throw new Error(`reply-resolve: 返信の数が合わない\n${proc.show()}`);
        for (const t of after.threads) {
          const b = before.threads.find((b) => b.node === t.node);
          if (!b) throw new Error(`reply-resolve: スレッドが before に無い: ${t.node}`);
          if (t.resolved !== (t.node === thread.node || b.resolved)) throw new Error(`reply-resolve: resolve の状態が違う: ${t.node}\n${proc.show()}`);
        }
      }
    });
  },
);

// ---- 固定の検査 ----

/** <args> と <env> の組が curl 自身に恒久的な失敗 (URL・プロトコルの誤り) として扱われ、exit 3 と error の行 (stdout、fail 3 から) で止まることを確かめる。生成器は repo の形を変えないので、ここで固定して確かめる */
async function checkPermanentCurlFailure(what: string, args: string[], env: Record<string, string>) {
  const cmd = new Deno.Command("bash", {
    args: [script, ...args],
    env: prEnv(env),
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const out = new TextDecoder().decode(stdout);
  if (code !== 3 || !out.split("\n").some((l) => l.startsWith("error"))) {
    throw new Error(
      `${what}: exit 3 と error の行 (stdout) のはず (exit ${code})\nstdout:\n${out}\nstderr:\n${new TextDecoder().decode(stderr)}`,
    );
  }
}

/** <args> と <env> の組が pr.sh の起動時の GITHUB_API_URL の形の検査で止まり、exit 2 と "pr.sh: GITHUB_API_URL は" で始まる行 (stderr) になることを確かめる。生成器は GITHUB_API_URL の形を変えないので、ここで固定して確かめる */
async function checkGuardFailure(what: string, args: string[], env: Record<string, string>) {
  const cmd = new Deno.Command("bash", {
    args: [script, ...args],
    env: prEnv(env),
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const err = new TextDecoder().decode(stderr);
  if (code !== 2 || !err.split("\n").some((l) => l.startsWith("pr.sh: GITHUB_API_URL は"))) {
    throw new Error(
      `${what}: exit 2 と "pr.sh: GITHUB_API_URL は" の行 (stderr) のはず (exit ${code})\nstdout:\n${new TextDecoder().decode(stdout)}\nstderr:\n${err}`,
    );
  }
}

/**
 * URL のスキームの取り違え (TLS を話さない相手に https で GITHUB_API_URL を向ける) と、CURL_CA_BUNDLE が読めない設定が、ともに curl 自身の
 * 恒久的な失敗として exit 3 と error の行になることを確かめる。生成器は GITHUB_API_URL や CURL_CA_BUNDLE の形を変えないので、ここで固定して確かめる。
 */
async function checkPermanentCurlConfigFailures() {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, () => new Response("not tls"));
  try {
    const api = `https://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
    await checkPermanentCurlFailure("URL のスキームの取り違え検査", ["reply-resolve", REPO, String(PR), "1", "x"], { GITHUB_API_URL: api });
    await checkPermanentCurlFailure(
      "CURL_CA_BUNDLE が読めない検査",
      ["reply-resolve", REPO, String(PR), "1", "x"],
      { GITHUB_API_URL: api, CURL_CA_BUNDLE: `${tmpRoot}/no-such-ca-bundle` },
    );
  } finally {
    await server.shutdown();
  }
}

// ---- 入口 ----

const tmpRoot = await Deno.makeTempDir({ prefix: "pr-pbt." });
try {
  await checkGuardFailure("GITHUB_API_URL の検査 (スペースが入る)", ["reply-resolve", REPO, String(PR), "1", "x"], { GITHUB_API_URL: "not a url" });
  await checkGuardFailure("GITHUB_API_URL の検査 (スキーム省略)", ["reply-resolve", REPO, String(PR), "1", "x"], { GITHUB_API_URL: "not-a-url" });
  await checkGuardFailure("GITHUB_API_URL の検査 (クエリが付く)", ["reply-resolve", REPO, String(PR), "1", "x"], {
    GITHUB_API_URL: "http://127.0.0.1:8080?x",
  });
  await checkGuardFailure("GITHUB_API_URL の検査 (フラグメントが付く)", ["reply-resolve", REPO, String(PR), "1", "x"], {
    GITHUB_API_URL: "http://127.0.0.1:8080#f",
  });
  await checkGuardFailure("GITHUB_API_URL の検査 (ポート 0)", ["reply-resolve", REPO, String(PR), "1", "x"], { GITHUB_API_URL: "http://127.0.0.1:0" });
  await checkGuardFailure("GITHUB_API_URL の検査 (ポート 00000)", ["reply-resolve", REPO, String(PR), "1", "x"], {
    GITHUB_API_URL: "http://127.0.0.1:00000",
  });
  await checkGuardFailure("GITHUB_API_URL の検査 (ポート 65536、範囲外)", ["reply-resolve", REPO, String(PR), "1", "x"], {
    GITHUB_API_URL: "http://127.0.0.1:65536",
  });
  await checkPermanentCurlFailure(
    "owner/repo にスペースが入る検査",
    ["watch", "o r/x", String(PR), await Deno.makeTempDir({ dir: tmpRoot }), "1"],
    {},
  );
  await checkPermanentCurlConfigFailures();
  // 1 件に数秒かかるので、縮小せずに最初の反例で止める (FC_SEED と表示される path で再現する)
  const params = { numRuns, ...(seedEnv ? { seed: Number(seedEnv) } : {}), endOnFailure: true, verbose: fc.VerbosityLevel.Verbose };
  await fc.assert(p1, params);
  await fc.assert(p2, params);
  await fc.assert(p3, params);
} finally {
  await Deno.remove(tmpRoot, { recursive: true }).catch(() => {});
}
