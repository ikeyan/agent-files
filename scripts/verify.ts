/**
 * verify.ts — リポ内の JSON と Markdown を検査する。verify.sh から呼ぶ。
 *
 * 事前条件: リポのルートを cwd にして、`git ls-files` が使えること。
 * 副作用: 検査結果を stdout / stderr に出し、違反が 1 件でもあれば exit 1。
 *
 * JSON: 構文 + JSON Schema (schemastore)。schema は実行のたびに取得する。
 * Markdown: リポ内を指すリンクの解決先と、見出し由来の anchor。
 */
import Ajv from "npm:ajv@8.17.1";
import addFormats from "npm:ajv-formats@3.0.1";

const SCHEMAS: Record<string, string> = {
  ".claude/settings.json": "https://www.schemastore.org/claude-code-settings.json",
  ".claude-plugin/plugin.json": "https://www.schemastore.org/claude-code-plugin-manifest.json",
  ".claude-plugin/marketplace.json": "https://www.schemastore.org/claude-code-marketplace.json",
};

const violations: string[] = [];
const report = (file: string, message: string) => violations.push(`${file}: ${message}`);

const tracked = async (pattern: string): Promise<string[]> => {
  const { stdout } = await new Deno.Command("git", {
    args: ["ls-files", pattern],
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(stdout).split("\n").filter(Boolean);
};

const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));

const jsonFiles = await tracked("*.json");
const markdownFiles = await tracked("*.md");

for (const file of jsonFiles) {
  let json: unknown;
  try {
    json = JSON.parse(await Deno.readTextFile(file));
  } catch (e) {
    report(file, `読めない — ${e instanceof Error ? e.message : e}`);
    continue;
  }
  const schemaUrl = SCHEMAS[file];
  if (!schemaUrl) {
    report(file, "対応する schema が verify.ts の SCHEMAS に無い");
    continue;
  }
  const res = await fetch(schemaUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${schemaUrl}: HTTP ${res.status}`);
  const validate = ajv.compile(await res.json());
  if (!validate(json)) {
    for (const err of validate.errors ?? []) {
      report(file, `schema 違反 ${err.instancePath || "/"} ${err.message}`);
    }
  }
}

/** GitHub の見出し anchor 生成 (小文字化、記号除去、空白をハイフン、重複は -1, -2 …)。 */
const anchorsOf = (markdown: string): Set<string> => {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (!heading) continue;
    const base = heading[1]
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
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
    report(file, "git が追跡しているがファイルが無い");
    continue;
  }
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto: 等の外部
    const [path, anchor] = target.split("#");
    const resolved = path === "" ? file : `${dir}/${path}`.replace(/^\.\//, "");
    const normalized = decodeURIComponent(new URL(resolved, "file:///").pathname.slice(1));
    if (!(await Deno.stat(normalized).then(() => true).catch(() => false))) {
      report(file, `リンク先が無い — ${target}`);
      continue;
    }
    if (!anchor || !normalized.endsWith(".md")) continue;
    if (!(await anchorsFor(normalized)).has(decodeURIComponent(anchor).toLowerCase())) {
      report(file, `anchor が見出しに無い — ${target}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  Deno.exit(1);
}
console.log(`ok: JSON ${jsonFiles.length} 件、Markdown ${markdownFiles.length} 件`);
