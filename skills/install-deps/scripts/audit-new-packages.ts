/**
 * audit-new-packages.ts — Detect recently published packages and check for
 * supply-chain attack indicators.
 *
 * Run via audit-new-packages.sh (which sets minimal Deno permissions).
 *
 * Exit codes:
 *   0 — no suspicious packages found
 *   1 — suspicious packages found
 *   2 — usage / prerequisite error
 */

import { parse as parseYaml } from "https://deno.land/std/yaml/mod.ts";
import { join } from "https://deno.land/std/path/mod.ts";

// ── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(): { days: number; ecosystem: string } {
  const result = { days: 3, ecosystem: "" };
  const raw = Deno.args;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--days" && raw[i + 1]) {
      result.days = Number(raw[++i]);
    } else if (raw[i] === "--ecosystem" && raw[i + 1]) {
      result.ecosystem = raw[++i];
    } else {
      console.error(`Unknown option: ${raw[i]}`);
      Deno.exit(2);
    }
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface Pkg {
  name: string;
  version: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;

async function run(cmd: string[], cwd?: string): Promise<string> {
  const c = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout } = await c.output();
  return new TextDecoder().decode(stdout);
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  try {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory) yield* walkFiles(p);
      else if (e.isFile) yield p;
    }
  } catch {
    // unreadable
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ── Detect ecosystem ─────────────────────────────────────────────────────────

type Ecosystem = "npm" | "pnpm" | "yarn" | "pip" | "unknown";

async function detectEcosystem(override: string): Promise<Ecosystem> {
  if (override) return override as Ecosystem;
  if (await exists("pnpm-lock.yaml")) return "pnpm";
  if (await exists("yarn.lock")) return "yarn";
  if (await exists("package-lock.json")) return "npm";
  if (
    (await exists("requirements.txt")) ||
    (await exists("Pipfile.lock")) ||
    (await exists("poetry.lock")) ||
    (await exists("uv.lock"))
  )
    return "pip";
  return "unknown";
}

// ── Extract packages ─────────────────────────────────────────────────────────

async function extractNpm(): Promise<Pkg[]> {
  const raw = JSON.parse(await Deno.readTextFile("package-lock.json"));
  const out: Pkg[] = [];
  for (const [key, val] of Object.entries<Record<string, unknown>>(
    raw.packages ?? {},
  )) {
    const name = key.startsWith("node_modules/")
      ? key.slice("node_modules/".length)
      : key;
    if (name && typeof val.version === "string")
      out.push({ name, version: val.version });
  }
  return out;
}

async function extractPnpm(): Promise<Pkg[]> {
  const raw = parseYaml(
    await Deno.readTextFile("pnpm-lock.yaml"),
  ) as Record<string, unknown>;
  const out: Pkg[] = [];
  for (const key of Object.keys((raw.packages ?? {}) as object)) {
    const clean = key.replace(/^\//, "");
    const at = clean.lastIndexOf("@");
    if (at > 0)
      out.push({ name: clean.slice(0, at), version: clean.slice(at + 1) });
  }
  return out;
}

async function extractYarn(): Promise<Pkg[]> {
  const content = await Deno.readTextFile("yarn.lock");
  const out: Pkg[] = [];
  const re = /^"?([^@\s][^@"]*?)@[^:]+?"?:\s*\n\s+version\s+"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) out.push({ name: m[1], version: m[2] });
  return out;
}

async function extractPip(): Promise<Pkg[]> {
  const out: Pkg[] = [];
  const candidates = ["requirements.txt", "requirements-dev.txt"];
  try {
    for await (const e of Deno.readDir("requirements")) {
      if (e.isFile && e.name.endsWith(".txt"))
        candidates.push(`requirements/${e.name}`);
    }
  } catch {
    // no requirements/ dir
  }
  for (const file of candidates) {
    if (!(await exists(file))) continue;
    for (const line of (await Deno.readTextFile(file)).split("\n")) {
      const m = line.match(/^([a-zA-Z0-9_-]+)==(.+)/);
      if (m) out.push({ name: m[1], version: m[2] });
    }
  }
  return out;
}

// ── Publish-date checks ─────────────────────────────────────────────────────

function isRecent(dateStr: string, thresholdMs: number): boolean {
  const ts = new Date(dateStr).getTime();
  return !isNaN(ts) && ts >= thresholdMs;
}

async function npmPublishDate(
  name: string,
  version: string,
  thresholdMs: number,
): Promise<string | null> {
  const data = (await fetchJson(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
  )) as Record<string, unknown> | null;
  if (!data) return null;
  const pub = ((data.time as Record<string, string>) ?? {})[version];
  return pub && isRecent(pub, thresholdMs) ? pub : null;
}

async function pipPublishDate(
  name: string,
  version: string,
  thresholdMs: number,
): Promise<string | null> {
  const data = (await fetchJson(
    `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
  )) as Record<string, unknown> | null;
  if (!data) return null;
  const urls = (data.urls as Array<Record<string, unknown>>) ?? [];
  const t = urls[0]?.upload_time_iso_8601 as string | undefined;
  return t && isRecent(t, thresholdMs) ? t : null;
}

// ── Deep inspection ──────────────────────────────────────────────────────────

const TEXT_EXT = /\.(js|ts|mjs|cjs|json|md|txt|sh|py|rb|cfg|toml|rst)$/i;

async function inspectNpm(
  name: string,
  version: string,
): Promise<string[]> {
  const issues: string[] = [];

  // Version metadata
  const ver = (await fetchJson(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  )) as Record<string, unknown> | null;

  // 1. Install scripts
  if (ver) {
    const scripts = (ver.scripts as Record<string, string>) ?? {};
    const suspect = ["preinstall", "install", "postinstall"].filter(
      (k) => k in scripts,
    );
    if (suspect.length)
      issues.push(
        `HAS INSTALL SCRIPTS:\n${suspect.map((s) => `    ${s}: ${scripts[s]}`).join("\n")}`,
      );
  }

  // 2. Provenance
  const prov = (await fetchJson(
    `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
  )) as Record<string, unknown> | null;
  if (
    !prov ||
    (Array.isArray(prov.attestations) && prov.attestations.length === 0)
  )
    issues.push("NO PROVENANCE ATTESTATION");

  // 3. Tarball: invisible unicode
  const tarball = (ver?.dist as Record<string, string>)?.tarball;
  if (tarball) {
    const tmp = await Deno.makeTempDir();
    try {
      const tgz = join(tmp, "pkg.tgz");
      const res = await fetch(tarball);
      if (res.ok && res.body) {
        const f = await Deno.open(tgz, { write: true, create: true });
        await res.body.pipeTo(f.writable);
        await run(["tar", "xzf", tgz, "-C", tmp]);

        const pkgDir = join(tmp, "package");
        const bad: string[] = [];
        for await (const p of walkFiles(pkgDir)) {
          if (!TEXT_EXT.test(p)) continue;
          try {
            if (INVISIBLE_RE.test(await Deno.readTextFile(p))) {
              bad.push(p.slice(pkgDir.length + 1));
              if (bad.length >= 10) break;
            }
          } catch {
            /* skip */
          }
        }
        if (bad.length)
          issues.push(
            `INVISIBLE UNICODE CHARACTERS found in:\n${bad.map((f) => `    ${f}`).join("\n")}`,
          );
      }
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  }

  return issues;
}

async function inspectPip(
  name: string,
  version: string,
): Promise<string[]> {
  const issues: string[] = [];

  const data = (await fetchJson(
    `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
  )) as Record<string, unknown> | null;
  if (!data) return issues;

  // 1. Provenance
  const urls = (data.urls as Array<Record<string, unknown>>) ?? [];
  if (!urls.some((u) => u.has_sig === true))
    issues.push("NO PROVENANCE / SIGNATURE");

  // 2. Download & inspect
  const sdist = urls.find((u) => u.packagetype === "sdist") ?? urls[0];
  const dlUrl = sdist?.url as string | undefined;
  if (dlUrl) {
    const tmp = await Deno.makeTempDir();
    try {
      const archive = join(tmp, "archive");
      const res = await fetch(dlUrl);
      if (res.ok && res.body) {
        const f = await Deno.open(archive, { write: true, create: true });
        await res.body.pipeTo(f.writable);

        if (/\.tar\.gz$|\.tgz$/.test(dlUrl))
          await run(["tar", "xzf", archive, "-C", tmp]);
        else if (/\.whl$|\.zip$/.test(dlUrl))
          await run(["unzip", "-qo", archive, "-d", tmp]);

        // Invisible unicode
        const bad: string[] = [];
        for await (const p of walkFiles(tmp)) {
          if (p === archive || !TEXT_EXT.test(p)) continue;
          try {
            if (INVISIBLE_RE.test(await Deno.readTextFile(p))) {
              bad.push(p.slice(tmp.length + 1));
              if (bad.length >= 10) break;
            }
          } catch {
            /* skip */
          }
        }
        if (bad.length)
          issues.push(
            `INVISIBLE UNICODE CHARACTERS found in:\n${bad.map((f) => `    ${f}`).join("\n")}`,
          );

        // Suspicious setup.py
        const suspectRe =
          /\b(urllib|requests\.get|exec\(|eval\(|subprocess|os\.system|__import__)\b/;
        for await (const p of walkFiles(tmp)) {
          if (!p.endsWith("setup.py")) continue;
          try {
            const lines = (await Deno.readTextFile(p)).split("\n");
            const hits = lines
              .map((l, i) => ({ n: i + 1, t: l.trim() }))
              .filter((l) => suspectRe.test(l.t));
            if (hits.length)
              issues.push(
                `SUSPICIOUS CODE IN setup.py:\n${hits
                  .slice(0, 10)
                  .map((h) => `    ${h.n}: ${h.t}`)
                  .join("\n")}`,
              );
          } catch {
            /* skip */
          }
        }
      }
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  }

  return issues;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = parseArgs();
const eco = await detectEcosystem(args.ecosystem);

console.log(
  `=== Supply Chain Audit (packages published within last ${args.days} days) ===`,
);
console.log(`Ecosystem: ${eco}\n`);

if (eco === "unknown") {
  console.error("ERROR: Could not detect ecosystem. No lockfile found.");
  Deno.exit(2);
}

const packages: Pkg[] = await ({
  npm: extractNpm,
  pnpm: extractPnpm,
  yarn: extractYarn,
  pip: extractPip,
}[eco]!)();

console.log(`Total packages in lockfile: ${packages.length}`);
console.log("Checking publish dates...\n");

const thresholdMs = Date.now() - args.days * 86_400_000;
let suspicious = 0;
const recentPkgs: string[] = [];

const BATCH = 10;
for (let i = 0; i < packages.length; i += BATCH) {
  const batch = packages.slice(i, i + BATCH);
  const results = await Promise.all(
    batch.map(async (pkg) => {
      const pubDate =
        eco === "pip"
          ? await pipPublishDate(pkg.name, pkg.version, thresholdMs)
          : await npmPublishDate(pkg.name, pkg.version, thresholdMs);
      return { pkg, pubDate };
    }),
  );

  for (const { pkg, pubDate } of results) {
    if (!pubDate) continue;
    recentPkgs.push(`${pkg.name}@${pkg.version}`);
    console.log(`RECENT: ${pkg.name}@${pkg.version} (published: ${pubDate})`);
    console.log("  Inspecting...");

    const issues =
      eco === "pip"
        ? await inspectPip(pkg.name, pkg.version)
        : await inspectNpm(pkg.name, pkg.version);

    if (issues.length) {
      console.log("  *** SUSPICIOUS ***");
      for (const issue of issues) console.log(`  - ${issue}`);
      suspicious++;
    } else {
      console.log("  OK (no indicators found)");
    }
    console.log();
  }
}

console.log("---");
console.log(`Recently published packages: ${recentPkgs.length}`);
console.log(`Suspicious packages: ${suspicious}`);

if (suspicious > 0) {
  console.log(
    "\n!!! WARNING: Suspicious packages detected. Review before installing. !!!",
  );
  Deno.exit(1);
}
