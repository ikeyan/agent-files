---
name: tsconfig
description: Knowledge about TypeScript tsconfig.json — how editors resolve it, per-directory configs, Solution Style with project references, extends, composite projects. Use when working with tsconfig.json files, setting up TypeScript projects, or debugging type-checking issues in monorepos or multi-target setups.
user-invocable: false
---

# tsconfig.json Knowledge

## How Editors Resolve tsconfig.json

VSCode and other editors perform type-checking per-file. When a TypeScript file is opened, the editor walks **up from the file's directory** to ancestor directories, looking for the **nearest file named exactly `tsconfig.json`**. That file becomes the configuration used for type-checking that file.

Key implications:

- Only the filename `tsconfig.json` is auto-discovered. Files named `tsconfig.build.json`, `tsconfig.app.json`, etc. are **not** picked up by the editor unless explicitly referenced.
- The **first** `tsconfig.json` found while walking upward wins — ancestor configs are ignored once a closer one is found.
- If no `tsconfig.json` is found, the editor falls back to default compiler options (no strict mode, no path aliases, etc.), which often produces spurious errors.

## Two Approaches for Multi-Config Projects

When different parts of a project need different TypeScript settings (e.g. `src/` targets ES2020 while `tests/` needs different types, or a monorepo has packages with different configs), there are two approaches:

### Approach 1: Per-Directory tsconfig.json

Place a `tsconfig.json` in each directory that needs distinct settings.

```
project/
├── src/
│   └── tsconfig.json    ← "target": "ES2020", "lib": ["DOM"]
├── tests/
│   └── tsconfig.json    ← "types": ["vitest/globals"]
└── tsconfig.json        ← shared/root (optional)
```

Each `tsconfig.json` can use `"extends"` to inherit from a shared base:

```jsonc
// tests/tsconfig.json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["vitest/globals"]
  },
  "include": ["./**/*.ts"]
}
```

**Pros**: Simple, each directory is self-contained, editor picks it up automatically.

**Cons**: If many directories share most settings, duplication increases. Build orchestration (e.g. `tsc --build`) requires each config to be a composite project anyway.

### Approach 2: Solution Style (tsconfig.json + Project References)

A root `tsconfig.json` contains **no compiler options and no file lists** — it exists solely to point the editor at the actual configs via `references`:

```jsonc
// tsconfig.json (Solution Style — root)
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.test.json" }
  ]
}
```

The actual settings live in variant files:

```jsonc
// tsconfig.app.json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2020",
    "lib": ["DOM", "ES2020"],
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

```jsonc
// tsconfig.node.json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "types": ["node"]
  },
  "include": ["vite.config.ts", "vitest.config.ts", "scripts/**/*.ts"]
}
```

**How it works with editors**: When the editor finds the root `tsconfig.json`, it sees `"files": []` and `"references": [...]`. It then determines which referenced project's `include` patterns match the currently open file and uses that project's settings. This is why the root must have `"files": []` (not `"include"`) — an empty `files` array tells TypeScript "this config owns no files directly; look at references instead."

**Pros**:

- All configs live in one place (the root), easy to see the full picture
- Each variant can set `"composite": true` enabling incremental builds with `tsc --build`
- Cross-project type references work via declaration files
- Common pattern in Vite/Vitest scaffolding (`create-vite`)

**Cons**:

- Slightly more indirection
- Every referenced project must set `"composite": true` (which implies `"declaration": true` and `"declarationMap": true`). `"noEmit": true` is incompatible with `composite` — if you only want type-checking without output, use `"emitDeclarationOnly": true` instead.
- A file not matched by any referenced project's `include` gets no type-checking in the editor — this is a common source of confusion

## Key tsconfig.json Fields

### extends

Inherits settings from another config. Relative to the file containing `extends`. Can reference `node_modules` packages:

```jsonc
{
  "extends": "@tsconfig/node20/tsconfig.json"
}
```

Multiple inheritance (TypeScript 5.0+):

```jsonc
{
  "extends": ["@tsconfig/strictest/tsconfig.json", "./tsconfig.base.json"]
}
```

Later entries override earlier ones. `compilerOptions` are merged shallowly (per key), but `include`/`exclude`/`files` are **replaced entirely**, not merged.

### composite

```jsonc
{ "compilerOptions": { "composite": true } }
```

Required for projects referenced via `references`. Enables:

- Incremental compilation (`tsc --build`)
- Auto-sets `declaration: true`
- Requires `rootDir` to be set (defaults to the directory of tsconfig.json)
- All source files must be matched by `include` or `files` (no implicit inclusion)

### references

```jsonc
{
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/utils" }
  ]
}
```

`path` points to a directory containing `tsconfig.json` or directly to a tsconfig file. Referenced projects must have `composite: true`.

### include / exclude / files

- `include`: Glob patterns for files to include. **Replaces** (not merges with) the inherited value from `extends`.
- `exclude`: Glob patterns to exclude. Defaults to `node_modules`, `bower_components`, `jspm_packages`, and `outDir`.
- `files`: Explicit list of files. Unlike `include`, does not support globs. When set to `[]` in Solution Style root, tells TS this config owns no files.

## Common Patterns

### Monorepo with Shared Base

```
monorepo/
├── tsconfig.base.json       ← shared compilerOptions
├── packages/
│   ├── core/
│   │   └── tsconfig.json    ← extends ../../tsconfig.base.json
│   └── web/
│       └── tsconfig.json    ← extends ../../tsconfig.base.json
└── tsconfig.json            ← Solution Style root with references
```

### Vite Project (Default Scaffolding)

```
project/
├── tsconfig.json            ← Solution Style root
├── tsconfig.app.json        ← browser code (src/)
└── tsconfig.node.json       ← Node code (vite.config.ts, etc.)
```

## TypeScript 6 Changes

See the [ts5to6 skill](../ts5to6/SKILL.md) for TS6 breaking changes: deprecated options (baseUrl, target ES5, moduleResolution node, AMD/UMD/SystemJS), changed defaults (strict true, module esnext, target current-year ES, rootDir ".", types []), and migration notes.

## Debugging Checklist

When type-checking in the editor doesn't match expectations:

1. **Which tsconfig is the editor using?** — In VSCode, open the TypeScript output panel or run "TypeScript: Open TS Server Log". Search for the file path to see which project it was assigned to.
2. **Is the file matched by `include`?** — If using Solution Style and the file isn't in any referenced project's `include`, it gets no config.
3. **Is `composite` set?** — Every project in `references` must have it.
4. **Did `include` get inherited?** — No: `include` in a child config **replaces** the parent's. If you extend a base and add your own `include`, the base's `include` is gone.
5. **Are paths relative to the right file?** — `include` patterns are relative to the tsconfig containing them, not the one that extends it.
