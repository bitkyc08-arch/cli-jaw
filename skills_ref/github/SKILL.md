---
name: github
description: "GitHub operations via `gh` CLI: issues, PRs, CI runs, code review, API queries, PR comment handling, CI debugging, auto-fix issue workflows, and stage→commit→push→PR (yeet). Use when interacting with GitHub. NOT for: local git operations (use git directly), non-GitHub repos, or complex browser flows."
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
        "requires": { "bins": ["gh"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
            {
              "id": "apt",
              "kind": "apt",
              "package": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (apt)",
            },
          ],
      },
  }
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub repositories, issues, PRs, and CI.

## When to Use

✅ **USE this skill when:**

- Checking PR status, reviews, or merge readiness
- Viewing CI/workflow run status and logs
- Creating, closing, or commenting on issues
- Creating or merging pull requests
- Querying GitHub API for repository data
- Listing repos, releases, or collaborators
- Addressing PR review comments (merged from gh-address-comments)
- Debugging and fixing failing CI checks (merged from gh-fix-ci)
- Auto-fixing issues and opening PRs (merged from gh-issues)
- Stage → commit → push → PR in one flow (merged from yeet)

## When NOT to Use

❌ **DON'T use this skill when:**

- Local git operations (commit, push, pull, branch) → use `git` directly
- Non-GitHub repos (GitLab, Bitbucket, self-hosted) → different CLIs
- Cloning repositories → use `git clone`
- Reviewing actual code changes → use `coding-agent` skill
- Complex multi-file diffs → use `coding-agent` or read files directly

## Setup

```bash
# Authenticate (one-time)
gh auth login

# Verify
gh auth status
```

## Common Commands

### Pull Requests

```bash
# List PRs
gh pr list --repo owner/repo

# Check CI status
gh pr checks 55 --repo owner/repo

# View PR details
gh pr view 55 --repo owner/repo

# Create PR
gh pr create --title "feat: add feature" --body "Description"

# Merge PR
gh pr merge 55 --squash --repo owner/repo
```

### Issues

```bash
# List issues
gh issue list --repo owner/repo --state open

# Create issue
gh issue create --title "Bug: something broken" --body "Details..."

# Close issue
gh issue close 42 --repo owner/repo
```

### CI/Workflow Runs

```bash
# List recent runs
gh run list --repo owner/repo --limit 10

# View specific run
gh run view <run-id> --repo owner/repo

# View failed step logs only
gh run view <run-id> --repo owner/repo --log-failed

# Re-run failed jobs
gh run rerun <run-id> --failed --repo owner/repo
```

### API Queries

```bash
# Get PR with specific fields
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'

# List all labels
gh api repos/owner/repo/labels --jq '.[].name'

# Get repo stats
gh api repos/owner/repo --jq '{stars: .stargazers_count, forks: .forks_count}'
```

## JSON Output

Most commands support `--json` for structured output with `--jq` filtering:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
gh pr list --json number,title,state,mergeable --jq '.[] | select(.mergeable == "MERGEABLE")'
```

## Templates

### PR Review Summary

```bash
PR=55 REPO=owner/repo
echo "## PR #$PR Summary"
gh pr view $PR --repo $REPO --json title,body,author,additions,deletions,changedFiles \
  --jq '"**\(.title)** by @\(.author.login)\n\n\(.body)\n\n📊 +\(.additions) -\(.deletions) across \(.changedFiles) files"'
gh pr checks $PR --repo $REPO
```

### Issue Triage

```bash
gh issue list --repo owner/repo --state open --json number,title,labels,createdAt \
  --jq '.[] | "[\(.number)] \(.title) - \([.labels[].name] | join(", ")) (\(.createdAt[:10]))"'
```

---

## Merged Workflows

> The following workflows were consolidated from gh-issues, gh-address-comments, gh-fix-ci, and yeet.

### PR Comment Handling (from gh-address-comments)

Address review/issue comments on the open PR for the current branch:

1. Check auth: `gh auth status`
2. Find current PR: `gh pr view --json number,url`
3. List review comments: `gh api repos/{owner}/{repo}/pulls/{pr}/comments --jq '.[] | "\(.id): \(.body[:80])"'`
4. Address each comment, commit fixes
5. Push and re-request review

### Fix Failing CI (from gh-fix-ci)

Debug and fix failing GitHub Actions checks:

1. Find failing checks: `gh pr checks <PR> --repo owner/repo`
2. Get failed run logs: `gh run view <run-id> --log-failed`
3. Summarize failure snippet and root cause
4. Draft fix plan → get approval → implement
5. Push fix and verify CI passes

### Auto-Fix Issues (from gh-issues)

Fetch issues, implement fixes, and open PRs:

1. List target issues: `gh issue list --label bug --limit 5`
2. For each issue: create branch, implement fix, open PR
3. Monitor PR reviews and address comments
4. Uses GitHub REST API with `$GH_TOKEN` for automation

### Yeet: Stage → Commit → Push → PR (from yeet)

One-shot flow to ship changes:

1. If on main/master, create branch: `git checkout -b codex/{description}`
2. Stage changes: `git add -A`
3. Commit: `git commit -m "{description}"`
4. Push: `git push -u origin HEAD`
5. Open PR: `gh pr create --title "[codex] {description}" --body "..."`

## Notes

- Always specify `--repo owner/repo` when not in a git directory
- Use URLs directly: `gh pr view https://github.com/owner/repo/pull/55`
- Rate limits apply; use `gh api --cache 1h` for repeated queries
