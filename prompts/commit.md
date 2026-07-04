---
description: 'Review staged changes and commit with a Conventional Commits message'
---

# /commit

You are being invoked via `/commit`.

1. Review the current git state with `git status` and `git diff --cached`.
   If nothing is staged, stage all changes with `git add -A` first, then use
   `git diff --cached`.

2. Write a concise Conventional Commits message for the diff. Use a single
   subject line (`<type>(<scope>): <summary>`) and add a short body only if
   the changes really need more explanation.

3. Commit with `git commit -m "<subject>"` (and `-m "<body>"` if you wrote one).

4. Do **not** push.

Keep the subject under 72 characters and do not end it with a period. If the
changes are ambiguous or risky, ask the user before committing.
