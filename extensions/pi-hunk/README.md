# pi-hunk

Handle human Hunk comments with the **main Pi agent**, keeping question/reply bodies out of chat. Pi posts through the **existing bash tool and Hunk CLI**—no intermediate reply files, new model tools, separate agent, or status-bar entry. **Enabled automatically when a Pi session starts.** Requires Git, Hunk's `session comment` CLI, and Pi's `bash` tool enabled.

```text
Hunk comment → hidden steering → main Pi codes/checks
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

Open Hunk separately in your own terminal. The extension never launches its interactive UI. It starts watching on Pi startup/reload and when a session is created, resumed, or forked. With no matching Hunk window it waits; with multiple matches it pauses without opening a startup selector. Use `/hunk on` to choose a window or `/hunk on <session-id>` to select explicitly.

If Git/Hunk is unavailable, the working directory is not a Git checkout, or no model/bash tool is enabled, automatic startup stays off quietly; `/hunk status` shows the diagnostic. Use `/hunk on` after fixing prerequisites. Unanswered existing comments can trigger main-agent work automatically.

## Commands

- `/hunk on` — watch this checkout; choose a session if several windows match.
- `/hunk on <session-id>` — watch one specific window (`hunk session list --json` lists IDs).
- `/hunk off` — stop polling until manually enabled or the next session start/reload, neutralize undelivered Hunk steering, and block future pi-hunk reply attempts. Does **not** abort main Pi, undo edits, or recall a CLI command that already passed the guard/is running.
- `/hunk status` (or `/hunk`) — show on/off state, active/queued/retry counts, and the last diagnostic. No status-bar entry is used.
- `/hunk retry` — retry attempts without confirmed delivery, after inspecting what happened.

Watching stops before shutdown, session replacement, fork, or tree navigation. A subsequent session-start event (including reload) enables it automatically again. Tree navigation does not start a new session; run `/hunk on` afterward.

## Main-agent processing

Polling happens every 5 seconds **after the previous poll completes**. Repository matching resolves symlinks without conflating separate worktrees. Without a matching window it waits; ambiguous windows pause until selected. A specifically selected window is never silently replaced.

Unanswered existing human notes, new notes, observed edits, and human follow-ups become requests. Agent/AI notes do not trigger work. On first discovery, existing notes with a newer direct agent reply are considered addressed.

**Comments steer the current conversation.** Each newly discovered comment is sent as a hidden steering message on the next poll, even when Pi is busy or already addressing another Hunk comment. Pi receives steering after the current assistant turn and its tool calls—not by aborting an in-flight tool. When idle, the same message starts a main-agent run. Pi's existing steering mode controls whether queued messages are delivered one at a time or together; the extension does not change that setting.

Each message carries one comment and its own reply target. Multiple delivered comments remain independently replyable, including markerless CLI replies. A newer version supersedes the old version of the same comment; a different Hunk comment does not invalidate earlier unfinished Hunk work. Short receipt notices appear while Pi is busy; multiple newly discovered comments are grouped.

Each hidden request contains the comment, file/line anchor, bounded thread context, a literal CLI reply template, and minimal routing guidance: address the comment, run the supplied command with a shell-quoted reply, keep the bodies out of chat, avoid Hunk acknowledgments in chat, and continue other pending work. The extension supplies delivery/failure notifications and does not prescribe a reply length or writing style. Existing main-agent context, model, tools, and approvals still apply.

The template is a single ordinary bash command:

```sh
# pi-hunk-reply:<unique-request-id>
hunk session comment add '<session-id>' --reply-to '<note-id>' --summary '<reply>' --author pi-hunk --json
```

The comment marker associates the call with its originating request. If the model omits it, the extension still recognizes the literal reply operation with the reserved `--author pi-hunk` and matches it to the active session/note. Both forms are guarded and hidden. The guard accepts only that one literal CLI operation and its expected IDs/options—no substitutions, pipelines, redirects, chained commands, or nested tools. This intentionally is not a general shell parser. Replies must fit within 64 KiB and the shell command within 96 KiB. The bash call still passes normal approval hooks; this does not grant broader permission to arbitrary shell commands.

Queued steering is revalidated at delivery. Requests cancelled by `/hunk off`, superseded by edits, or deleted before delivery are replaced with a body-free cancellation notice before reaching the model. Pi has no per-message steering removal API, so cancellation may still consume a turn boundary; ordinary Pi queues are not cleared. Valid delivered questions remain in context/history.

Before allowing the reply call, the extension verifies repository/session ownership, the unchanged note version, and that no ordinary delivered user/custom request took over. Reply intent is saved before execution. Delivery is checked against the actual Hunk thread afterward, not inferred solely from exit status. A CLI error after successful delivery can therefore be confirmed without posting again. Reply tool results give the model a brief, body-free delivery status. Only one authorized posting attempt is allowed per request. After the main run settles, unchanged unfinished/failed requests await `/hunk retry` rather than spinning agent turns; `/hunk status` distinguishes these from active steering. Superseded or deleted versions are not retried.

## Chat and context

Chat shows **“Hunk watching is on.”** when an explicit `/hunk on` succeeds, and **“Hunk watching is off.”** on `/hunk off` or when session/tree navigation stops an enabled watcher. Explicit `/hunk on` and `/hunk off` acknowledge the requested state even if already set. Automatic startup/reload stays quiet (including missing prerequisites), and shutdown/internal restarts do not add off-notification noise. “On” means the watcher is enabled; it may still be waiting for a window or paused on ambiguity—see `/hunk status`.

**“Hunk comment received.”** and **“Reply sent to Hunk.”** use the same notification style. Delivery is announced once, after verification, even if the main agent is later aborted. Failures also produce a short notification. Reply bash calls occupy **zero chat rows**, including output/errors and expanded/history views. Normal coding tool activity stays visible.

**Questions and full replies remain in main Pi context:** hidden requests are stored in history, and literal reply text remains in standard bash tool-call arguments. Posting commands/output using the marker or reserved author are hidden by the renderer, including expansion and replay. Partial bash/write argument streams remain hidden until complete to prevent accidental flashing. Ordinary completed commands and code writes retain their normal renderers and framing. Legacy reply-file writes also remain hidden in old history, but this version never creates or reads those files.

Pi has no selective suppression API for streamed assistant text, so the prompt instructs the agent not to narrate Hunk replies or acknowledgments while allowing ordinary conversation to continue. This is display control, **not redaction**: raw session JSON/RPC events and approval dialogs may expose tool arguments. Non-TUI clients control their own rendering. Normal context limits and compaction apply.

## Timing and limits

**Replies are posted during the bash call, not deferred until the whole agent run settles.** Aborting afterward cannot undo delivery. `/hunk off` blocks new pi-hunk attempts, but cannot recall a command already allowed by the guard without aborting the main agent. Posting checks and CLI insertion are not atomic: a note edit between preflight and execution can still race, especially if another approval hook waits after preflight. Subsequent observed versions are handled separately. Other shell commands without the marker or reserved author are not governed by this guard; it is a workflow integration, not a shell security sandbox.

**“Addressed” means a response was posted, not that Hunk's thread was marked resolved.** A blocker or clarifying question is also a response; add a human follow-up to continue. Inspect partial changes and Hunk before retrying unconfirmed work.

The extension does not publish externally, navigate/reload reviews, restart the daemon, or delete notes. It uses documented CLI polling, not private WebSocket/daemon protocols. Hunk may display an older diff after changes; Pi must inspect current local code. Run only one watcher per review: no cross-process worker lock is provided.

## Resource use

Polling does not call the model. Each watcher typically performs one local `hunk session list` command per five-second interval, plus one comment-list command when a single matching window is active (roughly 12–24 CLI invocations per minute, fewer if reads are slow). Reply checks add reads while comments are being handled. Timers do not overlap polls or keep Pi alive after shutdown.

Model/token cost comes from processing unanswered comments, not idle polling. Multiple Pi instances watching the same checkout multiply polling and can race to handle the same comment: keep one watcher per review and use `/hunk off` in the others.

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

The real Pi-session smoke test uses a scripted provider, native bash/transcript components, and a fake CLI. It verifies on/off notifications, automatic startup/reload, quiet missing prerequisites, waiting/ambiguous windows, zero-row expanded/history rendering for marked and markerless replies, delivery notifications, question/reply context, unchanged tools/hooks, steering during ordinary/Hunk work, multiple reply targets, denied/wrong-target posting, queued edits/deletions/cancellation, abort-after-post, lost acknowledgments, no reply files, and off/shutdown:

```sh
node extensions/pi-hunk/sdk-smoke.mjs /path/to/node_modules/@earendil-works/pi-coding-agent
```
