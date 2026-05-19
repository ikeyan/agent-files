---
name: edit-pr
description: Edit the title and body of an existing GitHub pull request. Fetches the current PR content, writes it to a temp file for editing, then writes it back. Use when the user wants to update a PR description.
argument-hint: <pr-url>
---

# Edit PR Title and Body

Edit the title and body of an existing GitHub pull request interactively.

## Arguments

- The PR URL (e.g. `https://github.com/sindresorhus/type-fest/pull/1399`)

## Workflow

### 1. Fetch current PR content

```bash
gh pr view <pr-url> --json title,body | jq -r '"# " + .title + "\n\n" + .body' > /tmp/pr-edit.md
```

### 2. Edit the content

Open `/tmp/pr-edit.md` and edit it. The format is:

```
# PR Title Here

PR body content here (markdown)
```

The first `# ` heading line is the title. Everything after it is the body.

### 3. Write back to the PR

```bash
gh pr edit <pr-url> --title "$(head -1 /tmp/pr-edit.md | sed 's/^# //')" --body "$(tail -n +3 /tmp/pr-edit.md)"
```

### 4. Confirm

Show the updated PR URL to the user.
