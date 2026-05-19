---
name: create-pr
description: Create a GitHub pull request for an open-source project. Forks the repo, reads essential docs (README, CONTRIBUTING.md, DEVELOPERS.md, pull_request_template.md), and drafts a PR that follows the project's guidelines. Use when the user wants to contribute to an upstream OSS repo.
disable-model-invocation: true
argument-hint: <org/repo>
---

# Create PR for an Open-Source Project

Prepare and submit a pull request to an upstream repository, following the project's own contribution guidelines.

## Arguments

- `$ARGUMENTS` — the target repository in `org/repo` format (e.g. `facebook/react`)

## Workflow

### 1. Fork & Clone

Fork the repository and clone it locally (default branch only to save bandwidth):

```bash
gh repo fork $ARGUMENTS --clone --default-branch-only
```

If the fork or clone already exists, skip this step and use the existing local copy.

### 2. Read Project Documentation

Before writing any code, first **list the root directory** of the cloned repo to discover any contribution-related files beyond the known ones below. Look for files whose name suggests contribution guidelines, development setup, or PR processes (e.g. `HACKING.md`, `docs/contributing/`, `Makefile`, etc.).

Then read the following files **in the cloned repo** to understand contribution requirements, coding standards, and PR expectations. Skip any file that does not exist.

| Priority | File | Purpose |
|----------|------|---------|
| 1 | `README.md` (or `README`) | Project overview, setup instructions |
| 2 | `CONTRIBUTING.md` | Contribution process, code style, commit conventions |
| 3 | `DEVELOPERS.md` (or `DEVELOPMENT.md`) | Build system, local dev setup, testing |
| 4 | `.github/pull_request_template.md` (or `.github/PULL_REQUEST_TEMPLATE.md`, `.github/PULL_REQUEST_TEMPLATE/`) | Required PR format and checklist |

Also check for (and read if found):

- `CLAUDE.md` / `AGENTS.md` — AI-specific contribution guidance
- `CODE_OF_CONDUCT.md` — community norms
- `.github/CODEOWNERS` — who will review
- Any other contribution-related files discovered in the root listing

Summarize key findings to the user before proceeding:

- Required PR format or checklist items
- Branch naming conventions (if any)
- CI checks: test, lint, typecheck, build, and any other validation commands
- Commit message conventions (e.g. Conventional Commits)
- Any CLA or DCO requirements

### 3. Install Dependencies

Use the `/install-deps` skill to safely install project dependencies. This handles package manager detection, lockfile generation if missing, supply-chain audit of recently published packages, and locked installation.

### 4. Verify Baseline CI Checks

Before making any changes, run **all** of the project's validation commands on the default branch to confirm they pass in a clean state. This includes but is not limited to:

- **Tests** (`npm test`, `make test`, `pytest`, etc.)
- **Linter** (`eslint`, `ruff`, `golangci-lint`, etc.)
- **Type checker** (`tsc --noEmit`, `mypy`, `pyright`, etc.)
- **Build** (`npm run build`, `make`, `cargo build`, etc.)
- **Any other checks** listed in CI config (`.github/workflows/`, `Makefile`, `package.json` scripts, etc.)

Identify the exact commands from the documentation read in step 2, or inspect `package.json` scripts / `Makefile` targets / CI workflow files.

**If any check fails on the default branch**, stop and warn the user immediately. Report which checks failed and their output. Do not proceed to implementation until the user decides how to handle it (e.g. skip that check, fix it first, or continue anyway).

### 5. Create a Feature Branch

Create a branch from the default branch following the project's naming convention (if documented), or fall back to:

```
<type>/<short-description>
```

e.g. `fix/null-pointer-in-parser`, `feat/add-csv-export`

### 6. Implement Changes

Make the requested changes, following the coding standards discovered in step 2.

After implementation, re-run **all** CI checks from step 4. Fix any failures before proceeding. If a failure is unrelated to your changes (i.e. it also failed in step 4's baseline), note it in the PR description.

### 7. Commit

Write commit messages following the project's convention (found in CONTRIBUTING.md or commit history). If no convention is specified, use [Conventional Commits](https://www.conventionalcommits.org/).

### 8. Push & Open PR

```bash
git push -u origin HEAD
```

Create the PR using `gh pr create`. If a pull request template was found in step 2, use it as the PR body structure and fill in all required sections.

```bash
gh pr create --repo $ARGUMENTS --title "<title>" --body "<body from template>"
```

If no template exists, use this default structure:

```
## Summary
<1-3 bullet points>

## Changes
<description of what was changed and why>

## Test plan
<how the changes were tested>
```

### 9. Post-creation

After the PR is created:

1. Print the PR URL for the user
2. Check if the project requires any post-PR actions (e.g. signing a CLA bot comment)
3. Watch for CI status with `gh pr checks` if relevant
