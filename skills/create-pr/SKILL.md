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

Every required check must be executed. If the current environment cannot run one, give the user the exact command to run locally and wait for them to confirm its result.

**If any check fails on the default branch**, do not classify it as pre-existing from that result alone. Trace the failure to the exact commit and changed line that introduced it, verify that the check passes on the parent and fails on that commit, and confirm that the surrounding history and PRs based on revisions from either side corroborate the boundary: earlier revisions pass, while later revisions either fail or contain a fix. Report this evidence to the user and do not proceed until they decide whether to fix the baseline first or continue with the established pre-existing failure.

### 5. Create a Feature Branch

Create a branch from the default branch following the project's naming convention (if documented), or fall back to:

```
<type>/<short-description>
```

e.g. `fix/null-pointer-in-parser`, `feat/add-csv-export`

### 6. Implement Changes

Make the requested changes, following the coding standards discovered in step 2.

After implementation, re-run **all** CI checks from step 4, using the same user-assisted local execution when the current environment cannot run one. Fix any failures introduced by the changes before proceeding. Treat a baseline failure as unrelated only when step 4 established its history; if the user chose to continue, include that evidence in the PR description.

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

## Verification
<how the changes were tested>
```

Before submitting, review the description against the diff:

- **Prose and diff must agree.** If the description claims "does X in the same-account case" but the code does X unconditionally, one of them is wrong — decide which, and fix both so no visible mismatch remains. Fixing only the prose leaves a tell.
- **Verify embedded code blocks render as intended on GitHub.** Backslashes inside a heredoc and similar escapes can survive into the rendered Markdown; check the preview, not just the source.
- **State the purpose.** Make the problem and intended outcome clear to the repository's owners and reviewers.
- **Explain reviewer-relevant constraints.** Include only non-obvious constraints and trade-offs that remain relevant to the final implementation; omit chronological experimentation and discarded alternatives.
- **Omit details visible in the diff.** Do not narrate file-by-file edits that reviewers can read directly.
- **Keep agent-local details out of the PR.** Explain environment-specific details to the user instead, unless that environment is itself the subject of the PR.
- **Report verification, not instructions.** When the procedure is documented in `CONTRIBUTING.md` or similar, list each successful check by its exact executed command without restating the procedure. For an established baseline failure, include the command, result, and the historical evidence from step 4 that identifies its cause.

### 9. Post-creation

After the PR is created:

1. Print the PR URL for the user
2. Check if the project requires any post-PR actions (e.g. signing a CLA bot comment)
3. Watch for CI status with `gh pr checks` if relevant
