import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHunkClient, matchingSessions, repoRoot } from "./hunk.ts";
import { HunkWatcher, isNoteState, STATE_ENTRY } from "./watcher.ts";
import type { NoteState } from "./watcher.ts";

const TOOL = "pi_hunk_reply";
const POLL_MS = 2000;

export default function piHunk(pi: ExtensionAPI) {
    let watcher: HunkWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let setup: AbortController | undefined;

    function toolEnabled(enabled: boolean): void {
        const tools = pi.getActiveTools().filter((name) => name !== TOOL);
        pi.setActiveTools(enabled ? [...tools, TOOL] : tools);
    }

    function stop(ctx: ExtensionContext): void {
        generation++;
        setup?.abort();
        setup = undefined;
        if (timer) clearTimeout(timer);
        timer = undefined;
        watcher?.stop();
        watcher = undefined;
        toolEnabled(false);
        if (ctx.hasUI) ctx.ui.setStatus("pi-hunk", undefined);
    }

    function restore(ctx: ExtensionContext): NoteState[] {
        const states: NoteState[] = [];
        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "custom" && entry.customType === STATE_ENTRY && isNoteState(entry.data)) {
                states.push(entry.data);
            }
        }
        return states;
    }

    async function start(ctx: ExtensionContext, requestedId?: string): Promise<void> {
        stop(ctx);
        const token = generation;
        const controller = new AbortController();
        setup = controller;
        const current = () => token === generation && !controller.signal.aborted;
        try {
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
            const active = new HunkWatcher(repo, client, {
                idle: () => current() && ctx.isIdle() && !ctx.hasPendingMessages(),
                send: (prompt) => {
                    if (!current()) throw new Error("Hunk watching stopped");
                    pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: false });
                },
                save: (state) => { if (current()) pi.appendEntry(STATE_ENTRY, state); },
                status: (text) => { if (current() && ctx.hasUI) ctx.ui.setStatus("pi-hunk", text); },
                notify: (text, level) => { if (current() && ctx.hasUI) ctx.ui.notify(text, level); },
            }, restore(ctx), pinned);
            watcher = active;
            toolEnabled(true);
            if (ctx.hasUI) ctx.ui.notify("pi-hunk enabled. Unanswered human comments will be addressed; replies stay in Hunk.", "info");

            const tick = async () => {
                if (!current() || watcher !== active) return;
                await active.poll();
                if (current() && watcher === active) {
                    timer = setTimeout(() => void tick(), POLL_MS);
                    timer.unref();
                }
            };
            await tick();
        } catch (error) {
            if (!current()) return;
            stop(ctx);
            ctx.ui.notify(`Could not enable pi-hunk: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
    }

    pi.registerTool({
        name: TOOL,
        label: "Hunk reply",
        description: "Reply to an active pi-hunk user request after addressing it, and record that comment version as handled. Use the exact IDs/version supplied by the watcher. Does not delete notes or mark threads resolved.",
        defaultActive: false,
        executionMode: "sequential",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        parameters: Type.Object({
            sessionId: Type.String(),
            noteId: Type.String(),
            version: Type.String(),
            summary: Type.String({ minLength: 1, description: "Concise answer, changes/checks performed, or blocker, posted as a reply in Hunk" }),
        }),
        async execute(_id, params, signal) {
            if (!watcher) throw new Error("pi-hunk is off; enable it with /hunk on");
            await watcher.reply(params.sessionId, params.noteId, params.version, params.summary, signal);
            return {
                content: [{ type: "text", text: "Reply confirmed in Hunk; this comment version is addressed." }],
                details: { sessionId: params.sessionId, noteId: params.noteId, version: params.version },
            };
        },
    });

    pi.registerCommand("hunk", {
        description: "pi-hunk: on [session-id], off, status, or retry unanswered attempts",
        handler: async (args, ctx) => {
            const [action = "status", id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
            if (extra.length || (id && action !== "on")) {
                ctx.ui.notify("Usage: /hunk on [session-id] | off | status | retry", "warning");
                return;
            }
            switch (action) {
                case "on":
                    if (watcher && !id) {
                        ctx.ui.notify(watcher.status(), "info");
                    } else {
                        await start(ctx, id);
                    }
                    break;
                case "off":
                    stop(ctx);
                    ctx.ui.notify("pi-hunk off. Undispatched requests were cancelled; an ongoing agent run is not aborted.", "info");
                    break;
                case "status":
                    ctx.ui.notify(watcher?.status() ?? "pi-hunk is off. Use /hunk on to start watching this repository.", "info");
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

    // No timers or subprocesses are started during extension discovery/startup.
    pi.on("session_start", (_event, ctx) => stop(ctx));
    pi.on("session_before_switch", (_event, ctx) => stop(ctx));
    pi.on("session_before_fork", (_event, ctx) => stop(ctx));
    pi.on("session_before_tree", (_event, ctx) => stop(ctx));
    pi.on("session_tree", (_event, ctx) => stop(ctx));
    pi.on("session_shutdown", (_event, ctx) => stop(ctx));
    pi.on("agent_settled", () => watcher?.settled());
}
