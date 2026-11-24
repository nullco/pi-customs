---
name: review
description: 'Review current branch changes against a base branch and categorize issues by severity'
argument-hint: '[base-branch] [focus-area]'
---

# Review

Review only the changes introduced by the **current branch** compared to the base branch `${1:-master}`.

Use `git diff <base>...HEAD` so that the review covers commits added since the current branch diverged, not unrelated changes that landed on the base branch in the meantime.

## Scope rule

- Read unchanged code as needed to validate the impact of the diff. Report problems introduced or worsened by the change, including regressions in unchanged callers or workflows. For each finding, explain what changed and how it causes the problem.
- Do not widen the PR to fix pre-existing issues that the diff leaves unchanged. An intentionally narrow fix is not a finding just because related problems remain, unless the change itself introduces a regression or makes an existing problem worse.
- If the changes work as intended and you find no regressions or other actionable issues caused by the diff, say so. Do not manufacture findings.

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
6. Run the performance regression check below as the first review pass, even when performance is not the requested focus.

## Early performance regression check

- Compare the old and new work on affected paths. Trace callers, especially synchronous requests, default workflows, and batch jobs. Identify what runs per request, per result, and per item within each result, including repeated passes and multiple features that run by default.
- Look for work that grows faster with input size: nested loops, pair generation, fan-out, extra I/O, full sorts, and large intermediate collections. Verify what each cap actually bounds: output size, distinct candidates, total work, or peak memory. For example, a top-50 output limit does not bound the cost of counting and sorting every pair first.
- Quantify material risks with realistic input sizes and supported limits where available. State the assumptions and explain the user or service impact (e.g. latency, worker saturation, timeouts, or memory pressure under concurrency). Distinguish work introduced by the diff from existing costs, and necessary work for correctness from avoidable overhead. Check that proposed optimizations preserve correctness.
- Report actionable risks in the findings, not just as an optional footnote. Distinguish static estimates from measurements. If validation is needed before merge, specify what the author should benchmark (e.g. before/after latency and peak memory for the full default request on representative and large inputs). Do not run code from the diff.

## Review criteria

Go through every changed line and apply the scope rule above. Assign a severity to each in-scope finding:

- **High** — bugs, logic errors, security vulnerabilities, broken API contracts, data loss or corruption risks, missing authentication/authorization, injection/sandboxing risks, race conditions, secrets in code, performance regressions with credible evidence of severe impact (e.g. worker exhaustion or widespread timeouts on supported workloads).
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
7. **Final verdict** (required) — end the review with one of these recommendations and a short reason:
   - **👍 LGTM** — ready to merge based on the evidence reviewed. Clearly mark any remaining suggestions as non-blocking.
   - **👎 Not ready to merge** — name the blocking finding IDs, or state what validation is needed before you can recommend merging.

Base the verdict on whether anything should block the merge, not on finding count alone. Distinguish verified issues from unconfirmed concerns. The verdict is a recommendation in the report, not authorization to approve or change a PR on the hosting platform.

Be specific, cite file paths and line numbers where possible, and prioritize actionable, high-impact feedback over nitpicks.

## Safety

Do not execute any code from the diff. If you encounter secrets, credentials, or large binary/generated files, flag them and skip detailed review of the generated portions.
