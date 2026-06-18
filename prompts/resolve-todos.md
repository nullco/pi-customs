---
description: 'Resolve every "TODO: pi:" comment in the current project — implement each requested change, then remove the comment. Language-agnostic. Hand-triggered; does not auto-invoke.'
argument-hint: '[path | --list | --dry-run]'
---

# resolve-todos

Scan the **current project (cwd)** for `TODO: pi:` comments, implement what
each asks for, then delete the comment. Work one TODO at a time. The marker is
plain text, so this works in any language or file format.

Everything runs in the user's project. Never scan or modify the pi-customs
package itself.

## Arguments (from $@)

- A path → search only there (e.g. `src/api`).
- `--list` or `--dry-run` → enumerate only, change nothing.
- Otherwise → search the whole project (`.`) and resolve every TODO.

## Marker format

`TODO: pi:` followed by an instruction, possibly continuing on subsequent
comment lines:

```ts
// TODO: pi: extract this loop into a helper named `sumValues`
x = 1  # TODO: pi: rename to `count`
```

```python
# TODO: pi: add a docstring and handle the empty-list case
def average(xs):
    return sum(xs) / len(xs)
```

## Workflow

1. **Enumerate** by running this in the project cwd (set `<ROOT>` to the path
   arg, or `.` if none was given):

   ```bash
   rg --no-heading --line-number --with-filename \
      --glob '!**/.git/**' --glob '!**/node_modules/**' \
      --glob '!**/resolve-todos.md' \
      'TODO: pi:' "<ROOT>" || true
   ```

   Prints `path:line:content` per match. Respects `.gitignore`, skips binaries.
   The `!**/resolve-todos.md` glob skips this template's own file, which
   contains `TODO: pi:` only as examples (e.g. when run inside the pi-customs
   repo).
   If `--list`/`--dry-run` was given, report the list and stop here.

2. **Loop one at a time.** Do NOT batch-edit: line numbers shift after each edit
   and one fix can affect others. Each iteration:

   a. Re-run the `rg` command and take the **first** result (line numbers are
      stale — re-query, don't cache).
   b. Read the file and enough surrounding context to understand the TODO.
   c. Implement the change the TODO requests — the real work; make the code do
      what the comment asks, following surrounding style.
   d. Remove the comment using the rules below.
   e. Re-run `rg` periodically to confirm progress and that no new
      `TODO: pi:` markers were introduced.

3. **Verify.** Run the `rg` command once more — it must print nothing.
   Summarize what you resolved.

## Comment removal rules

Language-agnostic; pick the rule that fits the comment style in view:

- **Whole-line comment** (`//`, `#`, `--`, `;`, `'`): delete the entire line.
- **Trailing comment on a code line**: strip only the comment, keep the code,
  trim trailing whitespace.
- **Block comment** (`/* */`, `<!-- -->`, `""" """`, `--[[ ]]`, …): if it
  contains only the TODO, remove the whole block; otherwise remove just the
  TODO line(s) inside.

Never leave an empty `TODO: pi:` marker behind. Collapse doubled blank lines
that result. Don't change code semantics beyond what the TODO requires.

## Safety

Pause and ask before acting on a TODO that is: ambiguous/underspecified; large,
risky, or cross-cutting; in conflict with other TODOs or existing code; or
needs a decision only the user can make. Resolve the rest first, then list
skipped TODOs with `file:line` and the reason.
