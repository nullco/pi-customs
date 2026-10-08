import { basename, dirname, resolve } from "node:path";
import type { ToolRenderers, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { isReplyCommand } from "./cli.ts";

/** Also keep old reply-file writes hidden when displaying sessions from that version. */
function legacyReply(args: any, cwd: string, agentDir: string): boolean {
    const path = args?.path ?? args?.file_path;
    if (typeof path !== "string") return false;
    const absolute = resolve(cwd, path);
    return dirname(absolute) === resolve(agentDir, "pi-hunk", "replies") &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/.test(basename(absolute));
}

const empty: Component = { render: () => [], invalidate() {} };
type Frame = (children: Component[], theme: Parameters<NonNullable<ToolRenderers["renderCall"]>>[1],
    context: ToolRenderContext, previous?: Component) => Component;

/** Presentation only. Ordinary command/code rendering still delegates to Pi. */
export function replyRenderers(name: string, agentDir: string, delegate: ToolRenderers | undefined,
    text: (message: string) => Component, frame: Frame): ToolRenderers {
    const slots = new WeakMap<object, { call?: Component; result?: Component; frame?: Component }>();
    function cache(state: object) {
        let slot = slots.get(state);
        if (!slot) { slot = {}; slots.set(state, slot); }
        return slot;
    }
    const hidden = (args: any, cwd: string) => name === "bash" ? isReplyCommand(args?.command) : legacyReply(args, cwd, agentDir);
    return {
        ...delegate,
        // A default shell leaves padding/background even for empty components.
        // Self framing lets hidden calls occupy zero rows; normal calls get Pi's box.
        renderShell: "self",
        renderCall(args, theme, context) {
            // Don't flash content while the command/path is still being streamed.
            if (!context.argsComplete || hidden(args, context.cwd)) return empty;
            const slot = cache(context.state);
            slot.call = delegate?.renderCall?.(args, theme, { ...context, lastComponent: slot.call })
                ?? text(name === "bash" ? args?.command ?? "bash" : `write ${args?.path ?? ""}\n${args?.content ?? ""}`);
            if (delegate?.renderShell === "self") return slot.call;
            slot.frame = frame([slot.call, ...(slot.result ? [slot.result] : [])], theme, context, slot.frame);
            return slot.frame;
        },
        renderResult(result, options, theme, context) {
            if (!context.argsComplete || hidden(context.args, context.cwd)) return empty;
            const slot = cache(context.state);
            slot.result = delegate?.renderResult?.(result, options, theme, { ...context, lastComponent: slot.result })
                ?? text(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"));
            if (delegate?.renderShell === "self") return slot.result;
            // Update the same call frame, rather than adding another padded tool box.
            slot.frame = frame([...(slot.call ? [slot.call] : []), slot.result], theme, context, slot.frame);
            return empty;
        },
    };
}
