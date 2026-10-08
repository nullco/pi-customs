# pi-hunk

Address human comments in a live Hunk review from Pi, and reply in the same threads. **Off by default.** Requires Git and a Hunk CLI with `session comment` commands.

## Load

Try it for one Pi invocation, from the repository you want reviewed:

```sh
pi -e /absolute/path/to/pi-customs/extensions/pi-hunk
```

Or install this directory as a local Pi package:

```sh
pi install /absolute/path/to/pi-customs/extensions/pi-hunk
```

Open Hunk separately in your own terminal. The extension never launches its interactive UI.

## Commands

- `/hunk on` — watch this checkout; choose a session if several windows match.
- `/hunk on <session-id>` — watch one specific window (`hunk session list --json` lists IDs).
- `/hunk off` — stop polling and cancel requests not yet dispatched.
- `/hunk status` (or `/hunk`) — show watcher/queue status.
- `/hunk retry` — explicitly retry attempts without a confirmed reply, after inspecting what happened.

Watching stops on reload, shutdown, session replacement, fork, or tree navigation. Run `/hunk on` again afterward. `/hunk off` does **not** abort an agent run already started; use Pi's normal abort action if needed. Replies through the extension are disabled while off.

## Behavior

After enabling, the extension polls every two seconds **after the previous poll completes**. It matches the Git checkout root, resolving symlinks without conflating separate worktrees. Without a matching window it waits; ambiguous windows pause until selected. A specifically selected window is never silently replaced.

Unanswered existing human notes, new notes, edits to observed notes, and human follow-ups become user requests in Pi. Agent/AI notes do not trigger work. On first discovery, existing notes with a direct agent reply newer than the note are considered addressed. Historical thread context is bounded; the new request is preserved in full.

Requests are batched (up to five) and dispatched only when Pi is idle with no pending messages. While Pi is busy, comments stay in the watcher's local queue and are re-read before dispatch, so deleted or edited queued notes are not sent stale.

Pi answers questions or makes requested changes using its ordinary coding tools. It then calls `pi_hunk_reply` with the outcome, checks performed, or blocker. That tool checks the session still belongs to this checkout and the comment version has not changed before posting a reply. It does not navigate, reload the diff, restart the daemon, delete notes, or publish to GitLab/GitHub. Existing approval requirements still apply.

**“Addressed” means a response was posted, not that Hunk's thread was marked resolved.** There is no documented CLI command for the latter. A blocker/clarifying question is also a response; add a human follow-up to continue.

## Recovery and limits

Comment versions, submissions, and confirmed replies are stored in custom entries on the active Pi session branch, outside model context. Resuming the same branch and enabling again does not replay handled versions. If a run is aborted, fails, or omits its reply, the extension does not automatically launch an endless retry loop: inspect its outcome and use `/hunk retry`.

Reply intent is persisted before posting. Lost acknowledgements are reconciled against matching Hunk replies; repeated tool calls do not duplicate the same reply. The CLI cannot make comment-version validation and reply insertion atomic, so an edit made between those operations can still race. Run only one Pi watcher for a given Hunk review: there is no cross-process worker lock or global tracking store.

Polling uses the documented CLI, not Hunk's private daemon/WebSocket protocol. It reads notes and anchors, not full raw patches. Since Hunk may still show an older diff after code changes, Pi must inspect current local code and explain unclear/stale anchors rather than assume the displayed diff is current.

## Tests

No credentials, model calls, or real Hunk session needed (Node 22.19+):

```sh
node --test extensions/pi-hunk/*.test.ts
# Or, from this directory:
npm test
```
