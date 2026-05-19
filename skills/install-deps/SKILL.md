---
name: install-deps
description: Safely install or update project dependencies with supply-chain attack detection. Detects the package manager from lockfiles, generates a lockfile if missing (JS/Python), audits recently published packages for suspicious indicators (install scripts, missing provenance, invisible unicode), and installs with lockfile pinning. Use when setting up a new project, updating dependencies, or before running code in an unfamiliar repo.
disable-model-invocation: true
---

# Install or Update Dependencies Safely

Install or update project dependencies with supply-chain security checks. This skill covers both fresh installs and dependency updates (e.g. version bumps, adding new packages, running `npm update` / `pnpm update`).

## When to Use

- **Fresh install**: Cloned a new repo, need to install all dependencies
- **Dependency update**: Bumping versions, adding new packages, running update commands, or reviewing Dependabot / Renovate PRs
- **Audit only**: Checking existing lockfile for recently published suspicious packages without changing anything

## Workflow

### 1. Detect Package Manager

If project documentation specifies a package manager, use it. Otherwise infer from lockfiles and commands present in the repo:

| Lockfile | Package Manager |
|----------|----------------|
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |
| `package-lock.json` | npm |
| `bun.lockb` / `bun.lock` | bun |
| `Pipfile.lock` | pipenv |
| `poetry.lock` | poetry |
| `uv.lock` | uv |
| `requirements.txt` | pip |
| `Cargo.lock` | cargo |
| `go.sum` | go modules |
| `Gemfile.lock` | bundler |

Also check for version constraints: `.node-version`, `.nvmrc`, `.python-version`, `.tool-versions`, `rust-toolchain.toml`, etc.

### 2. Generate or Update Lockfile (JS / Python)

For JavaScript and Python projects, a missing lockfile is a supply-chain risk. **Do not install without a lockfile.**

**If no lockfile exists** (fresh install):

- **npm**: `npm install --package-lock-only`
- **pnpm**: `pnpm install --lockfile-only`
- **yarn**: `yarn install --mode update-lockfile` (yarn v2+) or `yarn install --pure-lockfile` (v1)
- **pip**: `pip-compile requirements.in -o requirements.txt` (if `pip-tools` available), or create `requirements.txt` from `setup.py`/`pyproject.toml` using `pip install --dry-run --report` and pin versions manually

**If updating dependencies**, update the lockfile first without installing:

- **npm**: `npm update --package-lock-only` or edit `package.json` then `npm install --package-lock-only`
- **pnpm**: `pnpm update --lockfile-only`
- **yarn**: `yarn up <pkg>` (v2+) or `yarn upgrade <pkg>` (v1)
- **pip**: `pip-compile --upgrade requirements.in`

This lets the supply-chain audit in step 3 inspect the new versions **before** any code is executed on the machine.

### 3. Supply-Chain Audit

Run the supply-chain audit script to detect recently published packages with suspicious characteristics:

```bash
"${CLAUDE_SKILL_DIR}/scripts/audit-new-packages.sh" --days 3
```

The wrapper script runs `audit-new-packages.ts` via Deno with minimal permissions:

- `--allow-read=.,${TMPDIR}` — lockfiles in CWD and extracted temp files
- `--allow-write=${TMPDIR}` — temp directories for tarball extraction
- `--allow-net=registry.npmjs.org,pypi.org` — registry APIs only
- `--allow-run=tar,unzip` — archive extraction only

The script checks all packages published within the last 3 days for:

1. **Install scripts** (`preinstall`/`postinstall`/`install`) — common attack vector for arbitrary code execution during `npm install`
2. **Provenance attestation** — packages with npm/sigstore provenance have a verified link between the published tarball and a specific GitHub commit; absence is a yellow flag
3. **Invisible Unicode characters** — zero-width spaces, bidi overrides, and similar characters in source code can hide malicious logic

If the script reports suspicious packages, perform manual inspection:

- Download the tarball and read the flagged code directly
- Compare with the previous version's tarball:
  ```bash
  # npm example
  npm pack <pkg>@<prev-version> && npm pack <pkg>@<new-version>
  # Extract both and diff
  diff -r package-prev/ package-new/
  ```
- Check the GitHub repo (if linked) for matching commits
- If the package cannot be verified as trustworthy, **stop and warn the user**. Do not proceed with installation.

### 4. Install

Once the audit passes, install dependencies using the detected package manager with the lockfile:

**Fresh install** (use locked/frozen mode — no lockfile modifications):

- **npm**: `npm ci`
- **pnpm**: `pnpm install --frozen-lockfile`
- **yarn**: `yarn install --frozen-lockfile` (v1) or `yarn install --immutable` (v2+)
- **pip**: `pip install -r requirements.txt --require-hashes` (if hashes available)
- **cargo**: `cargo build`
- **go**: `go mod download`

**After dependency update** (lockfile was already updated in step 2):

- **npm**: `npm ci` (reads updated lockfile)
- **pnpm**: `pnpm install --frozen-lockfile`
- **yarn**: `yarn install --immutable` (v2+)
- **pip**: `pip install -r requirements.txt`

Prefer `ci` / `--frozen-lockfile` / `--immutable` modes to ensure exact lockfile versions are installed without modification.
