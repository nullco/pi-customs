import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { isReplyCommand, parseReplyCommand, replyCommand, ReplyCommandError, REQUEST_TYPE, SENT_NOTICE } from "./cli.ts";
import { HunkRequest } from "./request.ts";
import { createHunkClient, matchingSessions, repoRoot } from "./hunk.ts";
import { StateStore } from "./state.ts";
import { replyRenderers } from "./render.ts";
import { HunkWatcher, isNoteState, STATE_ENTRY } from "./watcher.ts";
import type { Task } from "./watcher.ts";
const POLL_MS = 1000;

export default function piHunk(pi: ExtensionAPI) {
    let watcher: HunkWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let setup: AbortController | undefined;
    let lastNotice = "";
    pi.registerToolRenderer((name, next) => ["bash", "write"].includes(name)
        ? replyRenderers(name, getAgentDir(), next(), (message) => new Text(message, 0, 0), (children, theme, context, previous) => {
            const bg = (line: string) => theme.bg(context.isPartial ? "toolPendingBg"
                : context.isError ? "toolErrorBg" : "toolSuccessBg", line);
            const box = previous instanceof Box ? previous : new Box(context.outputPad, 1, bg);
            box.setBgFn(bg);
            box.setPaddingX(context.outputPad);
            box.clear();
            for (const child of children) box.addChild(child);
            return box;
        })
        : next());

    type Pending = { owner: HunkWatcher; task: Task; scope: HunkRequest; sentAt: number };
    let pending: Pending | undefined;
    type ReplyCall = { request?: Pending; summary?: string; prepared?: boolean; confirmed?: boolean; reason?: string };
    const calls = new Map<string, ReplyCall>();

    function notifySent(request: Pending, ctx: ExtensionContext): void {
        if (request.owner !== watcher) return;
        lastNotice = "";
        if (!request.scope.notified && ctx.hasUI) {
            request.scope.notified = true;
            ctx.ui.notify(SENT_NOTICE, "info");
        }
    }

    function stop(): void {
        generation++;
        setup?.abort();
        setup = undefined;
        if (timer) clearTimeout(timer);
        timer = undefined;
        watcher?.stop();
        watcher = undefined;
        pending = undefined;
        // Do not abort the main agent: it may be handling ordinary Pi requests too.
    }

    async function start(ctx: ExtensionContext, requestedId?: string): Promise<void> {
        stop();
        const token = generation;
        const controller = new AbortController();
        setup = controller;
        const current = () => token === generation && !controller.signal.aborted;
        try {
            if (!ctx.model) throw new Error("Select a model in Pi before enabling Hunk");
            if (!pi.getActiveTools().includes("bash")) throw new Error("Enable Pi's existing bash tool before enabling Hunk");
            const repo = await repoRoot(ctx.cwd, controller.signal);
            if (!current()) return;
            const client = createHunkClient(repo);
            const matches = await matchingSessions(client, repo, controller.signal);
            if (!current()) return;
            let pinned = requestedId;
            if (pinned && !matches.some((session) => session.sessionId === pinned)) {
                throw new Error("That Hunk session does not belong to this repository or is no longer active");
            }
            if (!pinned && matches.length > 1) {
                if (!ctx.hasUI) throw new Error("Multiple Hunk sessions match; use /hunk on <session-id>");
                const choices = matches.map((session) => `${session.sessionId} — ${session.title ?? "Hunk review"}`);
                const choice = await ctx.ui.select("Choose a Hunk session for this repository", choices);
                if (!current() || !choice) return;
                pinned = matches[choices.indexOf(choice)]?.sessionId;
                if (!pinned) return;
            }
            if (!current()) return;
            const store = new StateStore(getAgentDir(), repo);
            const initial = store.load();
            if (!initial.length) {
                // Migrate tracking from the original version; new tracking stays in the journal.
                for (const entry of ctx.sessionManager.getBranch()) {
                    if (entry.type === "custom" && entry.customType === STATE_ENTRY && isNoteState(entry.data) && entry.data.repo === repo) {
                        initial.push(entry.data);
                        store.save(entry.data);
                    }
                }
            }
            lastNotice = "";
            const active = new HunkWatcher(repo, client, {
                idle: () => current() && ctx.isIdle() && !ctx.hasPendingMessages(),
                send: (prompt, task) => {
                    if (!current()) throw new Error("Hunk watching stopped");
                    const requestId = randomUUID();
                    pending = { owner: active, task, scope: new HunkRequest(requestId), sentAt: Date.now() };
                    try {
                        // The CLI command's literal reply stays in ordinary bash tool-call history.
                        pi.sendMessage({
                            customType: REQUEST_TYPE,
                            content: `Reply command (replace REPLY only):\n${replyCommand(requestId, task.sessionId, task.note.noteId)}\n\n${prompt}`, display: false,
                            details: { requestId },
                        }, { triggerTurn: true, deliverAs: "followUp" });
                    } catch (error) {
                        pending = undefined;
                        throw error;
                    }
                },
                save: (state) => { if (current()) store.save(state); },
                notify: (text) => { if (current()) lastNotice = text; },
                received: (count) => {
                    if (current() && ctx.hasUI) ctx.ui.notify(count === 1 ? "Hunk comment received."
                        : `${count} Hunk comments received.`, "info");
                },
            }, initial, pinned);
            watcher = active;

            const tick = async () => {
                if (!current() || watcher !== active) return;
                if (pending?.owner === active && !pending.scope.started && Date.now() - pending.sentAt > 15000 &&
                    ctx.isIdle() && !ctx.hasPendingMessages()) {
                    // sendMessage is fire-and-forget; recover if Pi rejected the run before any events.
                    pending = undefined;
                    active.settled();
                    lastNotice = "The Hunk request did not start in Pi. Inspect the outcome, then use /hunk retry.";
                    if (ctx.hasUI) ctx.ui.notify("Hunk reply was not sent. Check /hunk status.", "warning");
                }
                await active.poll();
                if (current() && watcher === active) {
                    timer = setTimeout(() => void tick(), POLL_MS);
                    timer.unref();
                }
            };
            await tick();
        } catch (error) {
            if (!current()) return;
            stop();
            ctx.ui.notify(`Could not enable pi-hunk: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
    }

    pi.registerCommand("hunk", {
        description: "Handle Hunk comments in main Pi: on [session-id], off, status, or retry",
        handler: async (args, ctx) => {
            const [action = "status", id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
            if (extra.length || (id && action !== "on")) {
                ctx.ui.notify("Usage: /hunk on [session-id] | off | status | retry", "warning");
                return;
            }
            switch (action) {
                case "on":
                    if (!watcher || id) await start(ctx, id);
                    break;
                case "off":
                    stop();
                    break;
                case "status":
                    ctx.ui.notify(watcher
                        ? `${watcher.status()}${lastNotice ? `\nLast notice: ${lastNotice}` : ""}`
                        : "pi-hunk is off. Use /hunk on to start watching this repository.", "info");
                    break;
                case "retry":
                    if (!watcher) {
                        ctx.ui.notify("Enable pi-hunk first with /hunk on", "warning");
                        return;
                    }
                    try {
                        watcher.retry();
                        await watcher.poll();
                    } catch (error) {
                        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
                    }
                    break;
                default:
                    ctx.ui.notify("Usage: /hunk on [session-id] | off | status | retry", "warning");
            }
        },
    });

    // No timer or subprocess is started until /hunk on. No status-bar entry is used.
    pi.on("session_start", () => stop());
    pi.on("session_before_switch", () => stop());
    pi.on("session_before_fork", () => stop());
    pi.on("session_before_tree", () => stop());
    pi.on("session_tree", () => stop());
    pi.on("session_shutdown", () => stop());
    pi.on("message_start", (event) => pending?.scope.messageStart(event.message));
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash" || !isReplyCommand(event.input.command)) return;
        const call: ReplyCall = {};
        calls.set(event.toolCallId, call);
        try {
            const parsed = parseReplyCommand(event.input.command);
            const request = pending;
            if (event.parentToolCallId || !request || request.owner !== watcher || !request.scope.canPost ||
                (parsed.requestId !== undefined && parsed.requestId !== request.scope.requestId) || parsed.sessionId !== request.task.sessionId ||
                parsed.noteId !== request.task.note.noteId) {
                return { block: true, reason: "This Hunk reply is no longer an active, uninterrupted request" };
            }
            call.request = request;
            call.summary = parsed.summary;
            if (request.scope.attempted) {
                call.confirmed = request.scope.confirmed;
                return { block: true, terminate: true,
                    reason: "A Hunk reply was already attempted; inspect Hunk before using /hunk retry" };
            }
            request.scope.attempted = true;
            const post = await request.owner.prepareReply(parsed.sessionId, parsed.noteId, request.task.version, parsed.summary, ctx.signal);
            if (pending !== request || request.owner !== watcher || !request.scope.canPost) {
                return { block: true, reason: "Hunk watching stopped or another request took over" };
            }
            if (!post) {
                call.confirmed = request.scope.confirmed = true;
                return { block: true, reason: "This comment version already has a confirmed reply in Hunk" };
            }
            call.prepared = true;
            // Continue through normal bash execution and all remaining approval hooks.
        } catch (error) {
            const safe = ["The Hunk session closed or no longer belongs to this repo",
                "The Hunk comment changed or vanished; do not reply to its old version"];
            lastNotice = error instanceof ReplyCommandError || (error instanceof Error && safe.includes(error.message))
                ? error.message : "The Hunk reply command failed validation";
            call.reason = lastNotice;
            return { block: true, reason: lastNotice };
        }
    });
    pi.on("message_end", async (event, ctx) => {
        const message = event.message;
        if (message.role !== "toolResult" || message.toolName !== "bash") return;
        const call = calls.get(message.toolCallId);
        if (!call) return;
        calls.delete(message.toolCallId);
        let confirmed = !!call.confirmed;
        if (call.prepared && call.request && !call.request.owner.stopped) {
            try {
                confirmed = await call.request.owner.confirmReply(call.request.task.sessionId,
                    call.request.task.note.noteId, call.request.task.version, call.summary!);
            } catch { /* A later poll reconciles lost acknowledgments; never echo CLI --summary errors. */ }
        }
        if (confirmed && call.request) {
            call.request.scope.confirmed = true;
            notifySent(call.request, ctx);
        }
        // Preserve the literal reply in bash's input. Give the model an honest, body-free
        // delivery status, including blocked calls and CLI errors after successful delivery.
        return { message: { ...message, isError: !confirmed, content: [{ type: "text" as const,
            text: confirmed ? "Reply confirmed in Hunk." : `Hunk reply not confirmed.${call.reason ? ` ${call.reason}.` : ""} Inspect Hunk and /hunk status before retrying.` }] } };
    });
    pi.on("agent_settled", (event, ctx) => {
        const request = pending;
        calls.clear();
        if (!request || request.owner !== watcher) return;
        if (!request.scope.started && !event.aborted) return;
        pending = undefined;
        const diagnostic = lastNotice;
        request.owner.settled();
        if (request.scope.confirmed) {
            notifySent(request, ctx);
        } else {
            lastNotice = diagnostic || (event.aborted ? "The main agent run was aborted before confirmed delivery"
                : request.scope.interrupted ? "Another request interrupted the Hunk response" : "No Hunk reply was confirmed");
            if (ctx.hasUI) ctx.ui.notify("Hunk reply was not confirmed. Check /hunk status.", "warning");
        }
        // Only the timer starts the next queued comment.
    });
}
