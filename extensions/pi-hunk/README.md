# pi-hunk

Handle human Hunk comments with the **main Pi agent**, keeping question/reply bodies out of chat. Pi posts through the **existing bash tool and Hunk CLI**—no intermediate reply files, new model tools, separate agent, or status-bar entry. **Off by default.** Requires Git, Hunk's `session comment` CLI, and Pi's `bash` tool enabled.

```text
Hunk comment → hidden request → main Pi codes/checks
                                     ↓
                          normal bash tool → Hunk CLI
                                     ↓
                           brief delivery status in chat
```

## Load

From the repository you want reviewed:

```sh
pi -e /absolute/path/to/pi-customs/extensions/pi-hunk
# Or install this directory as a local Pi package:
pi install /absolute/path/to/pi-customs/extensions/pi-hunk
```

Open Hunk separately in your own terminal. The extension never launches its interactive UI.

## Commands

- `/hunk on` — watch this checkout; choose a session if several windows match.
- `/hunk on <session-id>` — watch one specific window (`hunk session list --json` lists IDs).
- `/hunk off` — stop polling and block future pi-hunk reply attempts. Does **not** abort main Pi, undo edits, or recall a CLI command that already passed the guard/is running.
- `/hunk status` (or `/hunk`) — show on/off state, work/queue status, and the last diagnostic. No status-bar entry is used.
- `/hunk retry` — retry attempts without confirmed delivery, after inspecting what happened.

Watching stops on reload, shutdown, session replacement, fork, or tree navigation. Run `/hunk on` again afterward.

## Main-agent processing

Polling happens every second **after the previous poll completes**. Repository matching resolves symlinks without conflating separate worktrees. Without a matching window it waits; ambiguous windows pause until selected. A specifically selected window is never silently replaced.

Unanswered existing human notes, new notes, observed edits, and human follow-ups become requests. Agent/AI notes do not trigger work. On first discovery, existing notes with a newer direct agent reply are considered addressed.

**One comment runs at a time.** Comments stay queued until main Pi is idle with no pending messages. Queued notes are re-read before dispatch, so edits/deletions take effect. Short receipt notices appear even while Pi is busy; multiple newly discovered comments are grouped.

Each hidden request contains the comment, file/line anchor, bounded thread context, a literal CLI reply template, and a minimal routing instruction: address the comment, run the supplied command with a concise shell-quoted reply, keep the bodies out of chat, and finish without a chat response. The extension supplies delivery/failure notifications. Existing main-agent context, model, tools, and approvals still apply.

The template is a single ordinary bash command:

```sh
# pi-hunk-reply:<unique-request-id>
hunk session comment add '<session-id>' --reply-to '<note-id>' --summary '<reply>' --author pi-hunk --json
```

The comment marker associates the call with its originating request. If the model omits it, the extension still recognizes the literal reply operation with the reserved `--author pi-hunk` and matches it to the active session/note. Both forms are guarded and hidden. The guard accepts only that one literal CLI operation and its expected IDs/options—no substitutions, pipelines, redirects, chained commands, or nested tools. This intentionally is not a general shell parser. Replies must fit within 64 KiB and the shell command within 96 KiB. The bash call still passes normal approval hooks; this does not grant broader permission to arbitrary shell commands.

Before allowing the reply call, the extension verifies repository/session ownership, the unchanged note version, and that no other delivered user/custom request took over. Reply intent is saved before execution. Delivery is checked against the actual Hunk thread afterward, not inferred solely from exit status. A CLI error after successful delivery can therefore be confirmed without posting again. Reply tool results give the model a brief, body-free delivery status. Only one authorized posting attempt is allowed per request; unconfirmed work waits for `/hunk retry` rather than spinning agent turns.

## Chat and context

Chat shows **“Hunk comment received.”** and **“Reply sent to Hunk.”** as extension notifications in the same style. Delivery is announced once, after verification, even if the main agent is later aborted. Failures also produce a short notification. Reply bash calls occupy **zero chat rows**, including output/errors and expanded/history views. Normal coding tool activity stays visible.

**Questions and full replies remain in main Pi context:** hidden requests are stored in history, and literal reply text remains in standard bash tool-call arguments. Posting commands/output using the marker or reserved author are hidden by the renderer, including expansion and replay. Partial bash/write argument streams remain hidden until complete to prevent accidental flashing. Ordinary completed commands and code writes retain their normal renderers and framing. Legacy reply-file writes also remain hidden in old history, but this version never creates or reads those files.

Pi has no selective suppression API for streamed assistant text, so the prompt instructs the agent not to narrate the reply or emit a final chat acknowledgment. This is display control, **not redaction**: raw session JSON/RPC events and approval dialogs may expose tool arguments. Non-TUI clients control their own rendering. Normal context limits and compaction apply.

## Timing and limits

**Replies are posted during the bash call, not deferred until the whole agent run settles.** Aborting afterward cannot undo delivery. `/hunk off` blocks new pi-hunk attempts, but cannot recall a command already allowed by the guard without aborting the main agent. Posting checks and CLI insertion are not atomic: a note edit between preflight and execution can still race, especially if another approval hook waits after preflight. Subsequent observed versions are handled separately. Other shell commands without the marker or reserved author are not governed by this guard; it is a workflow integration, not a shell security sandbox.

**“Addressed” means a response was posted, not that Hunk's thread was marked resolved.** A blocker or clarifying question is also a response; add a human follow-up to continue. Inspect partial changes and Hunk before retrying unconfirmed work.

The extension does not publish externally, navigate/reload reviews, restart the daemon, or delete notes. It uses documented CLI polling, not private WebSocket/daemon protocols. Hunk may display an older diff after changes; Pi must inspect current local code. Run only one watcher per review: no cross-process worker lock is provided.

## Tracking

The private per-repository journal remains under `~/.pi/agent/pi-hunk/<repo-hash>.jsonl` (or the configured agent directory), outside model context. It records versions, attempts, and intended/confirmed reply text for deduplication and recovery. Legacy session tracking is migrated when no journal exists. On reload, previously missed markerless replies are reconciled against newer direct `pi-hunk` replies for the unchanged note version. The journal is retained without automatic rotation.

There is **no reply spool/file lifecycle** in this version. Old orphan files from the earlier file-based version are not read, reused, or automatically deleted. Standard bash keeps its own usual output/truncation behavior; the extension does not allocate temporary answer files.

## Tests

No credentials, real model calls, or live Hunk session needed (Node 22.19+):

```sh
node --test extensions/pi-hunk/*.test.ts
# Or, from this directory:
npm test
```

The real Pi-session smoke test uses a scripted provider, native bash/transcript components, and a fake CLI. It verifies zero-row expanded/history rendering for marked and markerless replies, delivery notifications, question/reply context, unchanged tools/hooks, busy receipts, denied/wrong-target posting, edits, abort-after-post, lost acknowledgments, no reply files, and off/shutdown:

```sh
node extensions/pi-hunk/sdk-smoke.mjs /path/to/node_modules/@earendil-works/pi-coding-agent
```
