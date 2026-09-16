/**
 * verify.ts — リポ内の JSON と Markdown を検査する。verify.sh から呼ぶ。
 *
 * 事前条件: リポのルートを cwd にして、検査対象のパスを 1 行 1 件で stdin に流すこと。
 * 副作用: 検査結果を stdout / stderr に出し、違反が 1 件でもあれば exit 1。
 *
 * JSON: 構文 + JSON Schema。schema は実行のたびに取得する。
 * Markdown: リポ内を指すリンクの解決先と、見出し由来の anchor。
 */
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/2020";
import type { ValidateFunction } from "ajv";
import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";

/** 検査する JSON と、当てる schema。null は構文だけ見る。ここに無いファイルは違反として報告する。 */
const SCHEMAS: Record<string, string | null> = Object.assign({ __proto__: null }, {
  ".claude/settings.json": "https://www.schemastore.org/claude-code-settings.json",
  ".claude-plugin/plugin.json": "https://www.schemastore.org/claude-code-plugin-manifest.json",
  ".claude-plugin/marketplace.json": "https://www.schemastore.org/claude-code-marketplace.json",
  // deno の schema は相対 $ref を持ち ajv に非同期解決が要る。deno 自身が読む設定なので構文だけにする。
  "deno.json": null,
});

const violations: string[] = [];
const report = (file: string, message: string) => violations.push(`${file}: ${message}`);

/** 壊れた %-エンコードで例外を出さない (URIError で検査全体が止まるのを防ぐ)。 */
const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const exists = (path: string) => Deno.stat(path).then(() => true).catch(() => false);

const targets = new TextDecoder().decode(await new Response(Deno.stdin.readable).bytes())
  .split("\n").filter(Boolean);

// logger: false — schema が使う format キーワード (uri 等) を ajv 本体は解釈せず、
// 無視した旨を毎回 20 行ほど警告に出すため。format 自体は検査していない。
const ajvOptions = { allErrors: true, strict: false, logger: false } as const;
const byDraft = { "draft-07": new Ajv(ajvOptions), "2020-12": new Ajv2020(ajvOptions) };

const validators = new Map<string, ValidateFunction | null>();
/** 同じ schema を 2 度 compile すると ajv が $id 重複で落ちるので、URL 単位で使い回す。取れなければ null。 */
const validatorOf = async (url: string): Promise<ValidateFunction | null> => {
  const cached = validators.get(url);
  if (cached !== undefined) return cached;
  let validate: ValidateFunction | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const schema: { $schema?: string } = await res.json();
    const ajv = schema.$schema?.includes("2020-12") ? byDraft["2020-12"] : byDraft["draft-07"];
    validate = ajv.compile(schema);
  } catch (e) {
    // 1 つの schema が取れないだけで、残りの JSON と Markdown の検査まで落とさない。
    report(url, `schema を用意できない — ${e instanceof Error ? e.message : e}`);
  }
  validators.set(url, validate);
  return validate;
};

const jsonFiles = targets.filter((f) => f.endsWith(".json"));
const markdownFiles = targets.filter((f) => f.endsWith(".md"));

for (const file of jsonFiles) {
  let json: unknown;
  try {
    json = JSON.parse(await Deno.readTextFile(file));
  } catch (e) {
    report(file, `読めない — ${e instanceof Error ? e.message : e}`);
    continue;
  }
  if (!(file in SCHEMAS)) {
    report(file, "対応する schema が verify.ts の SCHEMAS に無い");
    continue;
  }
  const schemaUrl = SCHEMAS[file];
  const validate = schemaUrl && await validatorOf(schemaUrl);
  if (validate && !validate(json)) {
    for (const err of validate.errors ?? []) {
      report(file, `schema 違反 ${err.instancePath || "/"} ${err.message}`);
    }
  }
}

// Markdown は CommonMark のパーサで読む。コードブロック・インラインコードの中はリンクでも見出しでもない。
const md = new MarkdownIt({ html: true });
type Token = ReturnType<typeof md.parse>[number];

/**
 * 先頭の --- で囲まれたブロックを落としてからパースする。GitHub はこのブロックを YAML として読めなくても
 * frontmatter として扱い、本文として描画しない (見出しにもリンクにもならない)。残すと --- が見出しの下線になる。
 */
const parse = (markdown: string): Token[] =>
  md.parse(markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""), {});

/** 見出しの anchor。github-slugger は GitHub が描画時に付ける id と同じ規則 (重複は -1, -2 …)。 */
const anchorsOf = (markdown: string): Set<string> => {
  const tokens = parse(markdown);
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  tokens.forEach((token, i) => {
    if (token.type !== "heading_open") return;
    const text = (tokens[i + 1].children ?? [])
      .filter((c) => c.type === "text" || c.type === "text_special" || c.type === "code_inline")
      .map((c) => c.content)
      .join("");
    anchors.add(slugger.slug(text));
  });
  return anchors;
};

/** リンクと画像の参照先 (参照スタイルのリンクも解決済みで出てくる)。 */
const targetsOf = (markdown: string): string[] => {
  const out: string[] = [];
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      const target = token.type === "link_open" ? token.attrGet("href") : token.type === "image" ? token.attrGet("src") : null;
      if (typeof target === "string") out.push(target);
      if (token.children) walk(token.children);
    }
  };
  walk(parse(markdown));
  return out;
};

const anchorCache = new Map<string, Set<string>>();
const anchorsFor = async (path: string): Promise<Set<string>> => {
  const cached = anchorCache.get(path);
  if (cached) return cached;
  const anchors = anchorsOf(await Deno.readTextFile(path));
  anchorCache.set(path, anchors);
  return anchors;
};

for (const file of markdownFiles) {
  const text = await Deno.readTextFile(file).catch(() => null);
  if (text === null) {
    report(file, "git の一覧にあるがファイルが無い");
    continue;
  }
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  for (const target of targetsOf(text)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue; // http:, mailto:, //host (プロトコル相対) 等の外部
    const [path, anchor] = target.split("#");
    const resolved = path === "" ? file : `${dir}/${path}`.replace(/^\.\//, "");
    const normalized = decode(new URL(resolved, "file:///").pathname.slice(1));
    if (!(await exists(normalized))) {
      report(file, `リンク先が無い — ${target}`);
      continue;
    }
    if (!anchor || !normalized.endsWith(".md")) continue;
    if (!(await anchorsFor(normalized)).has(decode(anchor))) {
      report(file, `anchor が見出しに無い — ${target}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  Deno.exit(1);
}
console.log(`ok: JSON ${jsonFiles.length} 件、Markdown ${markdownFiles.length} 件`);
