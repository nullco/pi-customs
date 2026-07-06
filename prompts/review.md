---
description: 'Review current branch changes against a base branch and categorize issues by severity'
argument-hint: '[base-branch] [focus-area]'
---

# Review

Review only the changes introduced by the **current branch** compared to the base branch `${1:-master}`.

Use `git diff <base>...HEAD` so that the review covers commits added since the current branch diverged, not unrelated changes that landed on the base branch in the meantime.

## Arguments

- `$1` → base branch to compare against (default: `master`). Use `main`, `staging`, `origin/master`, etc. when appropriate.
- `$2` → optional focus area to weight more heavily, e.g. `security`, `performance`, `API contract`, `error handling`.

## Steps

1. Detect the current branch:
   ```bash
   git branch --show-current
   ```
2. Resolve the base branch. If `${1:-master}` does not exist locally, try `origin/${1:-master}`. If neither resolves, ask the user for the correct base branch.
3. Show the diff stats so the user sees the scope:
   ```bash
   git diff --stat <resolved-base>...HEAD
   ```
4. Fetch the full diff:
   ```bash
   git diff --no-color <resolved-base>...HEAD
   ```
   If the diff is very large, split it by file or commit, review each part, and aggregate the findings.
5. Skip generated/binary files (lockfile churn, compiled assets, images, vendored code) unless the change itself is about those files.

## Review criteria

Go through every changed line and flag problems or possible improvements. Assign a severity to each finding:

- **High** — bugs, logic errors, security vulnerabilities, broken API contracts, data loss or corruption risks, missing authentication/authorization, injection/sandboxing risks, race conditions, secrets in code.
- **Medium** — missing or weak error handling, unvalidated inputs, performance concerns, duplicated code, unclear naming/abstractions, test coverage gaps, backwards-compatibility concerns.
- **Low** — style inconsistencies, minor refactoring opportunities, optional documentation/comment improvements, trivial nitpicks.

Focus categories (tag each finding with the best fit):

- Correctness / Logic
- Security
- Performance
- Error handling & edge cases
- Maintainability / readability
- Testing
- Documentation / comments
- API / contract changes

## Output format

Return a concise markdown report:

1. **Summary** — current branch, base branch, number of files changed, commit count (optional), and total counts of High / Medium / Low findings.
2. **High findings** — list first. For each:
   - `file:line` or `file:line-range`
   - Category
   - Problem
   - Suggested fix / improvement
3. **Medium findings** — same format.
4. **Low findings** — same format.
5. **Optional focus-area section** — if `$2` was provided, add a short dedicated subsection with findings specifically relevant to that focus.
6. **Positive notes** (optional) — briefly mention anything that looks well done.

Be specific, cite file paths and line numbers where possible, and prioritize actionable, high-impact feedback over nitpicks.

## Safety

Do not execute any code from the diff. If you encounter secrets, credentials, or large binary/generated files, flag them and skip detailed review of the generated portions.
