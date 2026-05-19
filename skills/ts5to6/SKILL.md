---
name: ts5to6
description: TypeScript 6 breaking changes — deprecated options (baseUrl as lookup root, target ES5, moduleResolution node, AMD/UMD/SystemJS) removed in tsgo/TS7, and changed defaults (strict true, module esnext, target current-year ES, rootDir ".", types []). Use when upgrading to TS6 or writing new tsconfig.
user-invocable: false
---

# TypeScript 6 Changes

TypeScript 6 introduces significant breaking changes to tsconfig defaults and deprecates legacy options that will be removed in tsgo / TypeScript 7.

## Deprecated (removed in tsgo / TS7)

These options still work in TS6 with a deprecation warning but will be hard errors in the Go-based compiler (tsgo) and TypeScript 7:

| Option | Deprecated Value | Replacement |
|--------|-----------------|-------------|
| `baseUrl` | Using as module lookup root | Use `paths` with explicit mappings instead. `baseUrl` for path alias resolution was a source of accidental bare-specifier resolution from the project root. |
| `target` | `"ES5"` | `"ES2018"` or later. ES5 emit is no longer supported — the ecosystem has moved past IE11. |
| `moduleResolution` | `"node"` (aka `"node10"`) | `"node16"`, `"nodenext"`, or `"bundler"`. The legacy `"node"` resolution doesn't understand `exports`/`imports` in package.json. |
| `module` | `"amd"`, `"umd"`, `"system"` | `"esnext"`, `"node16"`, or `"nodenext"`. AMD/UMD/SystemJS module formats are no longer maintained. |

## Changed Defaults

TS6 changes the defaults for new projects. Existing projects with explicit values are unaffected, but omitting these fields now gives different behavior:

| Option | Old Default | TS6 Default | Notes |
|--------|-------------|-------------|-------|
| `strict` | `false` | **`true`** | All strict-family flags are now on by default. Opt out explicitly if needed. |
| `module` | `"commonjs"` | **`"esnext"`** | ESM is the default module system. |
| `target` | `"ES3"` | **Current year's ES version** (moving target) | e.g. `"ES2026"` in 2026. Tracks the latest ratified spec. |
| `rootDir` | (inferred from source files) | **`"."`** | The directory of tsconfig.json. Previously inferred as the longest common path of all input files, which was fragile. |
| `types` | (all `@types/*` in node_modules) | **`[]`** (empty) | No `@types` packages are auto-included. Explicitly list what you need: `"types": ["node", "vitest/globals"]`. This prevents phantom globals from unrelated `@types` packages. |

## Migration Notes

When upgrading a project to TS6:

1. **Audit implicit defaults** — If your tsconfig omits `strict`, `module`, `target`, `rootDir`, or `types`, TS6 may change behavior silently. Run `tsc --showConfig` before and after upgrading to diff effective settings.

2. **Add explicit `types`** — The `"types": []` default is the most likely source of new errors. If your code uses `process.env`, DOM APIs, or test globals, you need:
   ```jsonc
   "types": ["node"]           // for Node.js globals
   "types": ["vitest/globals"] // for test globals
   // etc.
   ```

3. **Replace `moduleResolution: "node"`** — Switch to `"node16"` (if targeting Node.js) or `"bundler"` (if using Vite/webpack/esbuild). The key difference is that `"node16"`/`"nodenext"` enforce file extensions in relative imports while `"bundler"` does not.

4. **Drop `target: "ES5"`** — If you still need ES5 output, use a dedicated transpiler (Babel, SWC) as a post-processing step. TypeScript no longer emits ES5 downlevel code.

5. **Remove `baseUrl` for module resolution** — If you have:
   ```jsonc
   { "baseUrl": ".", "paths": { "@/*": ["src/*"] } }
   ```
   Remove `baseUrl` and keep `paths` — path mappings work without `baseUrl` since TS4.1. If you were relying on `baseUrl` to make `import "utils/foo"` resolve from the project root, convert to explicit `paths` entries.
