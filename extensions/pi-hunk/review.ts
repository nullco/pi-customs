import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { HUNK_SKILL_INSTRUCTIONS } from "./instructions.ts";

const exec = promisify(execFile);
const MAX_SKILL_BYTES = 256 * 1024;
export const HUNK_SKILL_GUIDELINE = `For user-requested Hunk reviews: ${HUNK_SKILL_INSTRUCTIONS} Never launch Hunk's interactive UI in a Pi tool; ask the user to open Hunk if no matching session exists. Preserve hidden comment requests' supplied reply targets and quiet-chat rules; ordinary user-requested reviews may be narrated. The pi-hunk author is reserved for supplied comment replies; use Hunk's default author for other notes.`;

/** Discover the installed skill, rather than copying it or assuming an install layout. */
export async function hunkSkillPath(cwd: string, signal?: AbortSignal): Promise<string> {
    const { stdout } = await exec("hunk", ["skill", "path"], { cwd, signal, timeout: 5000, maxBuffer: 16 * 1024 });
    const path = stdout.trim();
    if (!isAbsolute(path) || /[\r\n\0]/.test(path) || basename(path) !== "SKILL.md") {
        throw new Error("Hunk did not return an absolute SKILL.md path");
    }
    const resolved = await realpath(path);
    const info = await stat(resolved);
    if (!info.isFile() || info.size === 0 || info.size > MAX_SKILL_BYTES) {
        throw new Error("The Hunk skill must be a nonempty file of at most 256 KiB");
    }
    await access(resolved, constants.R_OK);
    signal?.throwIfAborted();
    return resolved;
}

export function reviewPrompt(path: string, content: string, request: string): string {
    // Match Pi's skill-command envelope so the full instructions stay in context/history
    // while the interactive transcript can present the skill as a compact block.
    const location = path.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    return `<skill name="hunk-review" location="${location}">\nReferences are relative to ${JSON.stringify(dirname(path))}.\n\n${content.trim()}\n</skill>\n\nUse this skill for a user-requested Hunk review of this checkout, not a hidden comment reply. Normal chat narration is allowed. Do not launch an interactive Hunk process in a Pi tool; if no matching session exists, ask me to open Hunk. Use Hunk's default author for review notes, not the reserved pi-hunk reply author.\n\nRequest:\n${request || "Walk me through the current changes in the live Hunk session, focusing on intent, risks, and potential bugs."}`;
}

/** Skill availability is independent of the watcher and /hunk on/off. */
export function registerHunkReview(pi: ExtensionAPI): (request: string, ctx: ExtensionCommandContext) => Promise<void> {
    let epoch = 0;
    const operations = new Set<AbortController>();
    const cancel = () => {
        epoch++;
        for (const controller of operations) controller.abort();
        operations.clear();
    };
    async function operation<T>(work: (signal: AbortSignal, current: () => boolean) => Promise<T>): Promise<T> {
        const controller = new AbortController();
        const token = epoch;
        operations.add(controller);
        try {
            return await work(controller.signal, () => token === epoch && !controller.signal.aborted);
        } finally {
            operations.delete(controller);
        }
    }
    pi.on("session_start", cancel);
    pi.on("session_before_switch", cancel);
    pi.on("session_before_fork", cancel);
    pi.on("session_before_tree", cancel);
    pi.on("session_tree", cancel);
    pi.on("session_shutdown", cancel);
    pi.on("resources_discover", (event) => operation(async (signal, current) => {
        try {
            const path = await hunkSkillPath(event.cwd, signal);
            if (current()) return { skillPaths: [path] };
        } catch { /* Missing/older Hunk or an unavailable skill must not add startup noise. */ }
    }));
    pi.on("before_agent_start", (event) => {
        const guidelines = event.systemPromptOptions.promptGuidelines;
        if (!guidelines.includes(HUNK_SKILL_GUIDELINE)) guidelines.push(HUNK_SKILL_GUIDELINE);
    });

    return async (request, ctx) => {
        if (!ctx.model) {
            ctx.ui.notify("Select a model in Pi before starting a Hunk review", "warning");
            return;
        }
        if (!pi.getActiveTools().includes("bash")) {
            ctx.ui.notify("Enable Pi's existing bash tool before starting a Hunk review", "warning");
            return;
        }
        await operation(async (signal, current) => {
            try {
                // Resolve/read anew for explicit invocation, even if discovery failed or Hunk upgraded.
                const path = await hunkSkillPath(ctx.cwd, signal);
                const content = await readFile(path, { encoding: "utf8", signal });
                if (!content.trim() || Buffer.byteLength(content) > MAX_SKILL_BYTES) {
                    throw new Error("The Hunk skill is empty or too large");
                }
                if (!current()) return;
                // This is an ordinary user request: do not impersonate a guarded comment task.
                // Follow-up delivery preserves active work and starts a turn when idle.
                const queued = !ctx.isIdle();
                pi.sendUserMessage(reviewPrompt(path, content, request), { deliverAs: "followUp" });
                if (queued && ctx.hasUI) ctx.ui.notify("Hunk review queued.", "info");
            } catch (error) {
                if (!current()) return;
                const failure = error as { code?: string; path?: string } | null;
                ctx.ui.notify(failure?.code === "ENOENT" && failure.path === "hunk"
                    ? "Hunk was not found on PATH. Install Hunk or add it to PATH, then retry /hunk review."
                    : "Could not load the Hunk review skill. Check `hunk skill path`, then retry /hunk review.", "error");
            }
        });
    };
}
