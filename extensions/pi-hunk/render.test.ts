import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { replyRenderers } from "./render.ts";
import { replyCommand } from "./cli.ts";

const id = "00000000-0000-4000-8000-000000000001";
const text = (message: string) => ({ render: (width: number) => [message.slice(0, width)], invalidate() {} });
const theme = {} as any;
const frame = (children: any[], _theme: any, _context: any, previous?: any) => {
    const component = previous ?? { children: [], render(width: number) { return this.children.flatMap((child: any) => child.render(width)); }, invalidate() {} };
    component.children = children;
    return component;
};
function context(args: any, extra: Partial<ToolRenderContext> = {}): ToolRenderContext {
    return { args, toolCallId: "bash:1", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/tmp/repo",
        executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false,
        isError: false, durationMs: 1, outputPad: 1, ...extra };
}

test("marked and markerless reply calls occupy zero rows, including errors/expanded/history", () => {
    const renderers = replyRenderers("bash", "/tmp/agent", undefined, text, frame);
    const command = replyCommand(id, "s", "n", "SECRET REPLY");
    for (const value of [command, command.slice(command.indexOf("\n") + 1)]) {
        const args = { command: value };
        for (const expanded of [false, true]) {
            const ctx = context(args, { expanded });
            assert.equal(renderers.renderShell, "self");
            assert.deepEqual(renderers.renderCall!(args, theme, ctx).render(80), []);
            const result = { content: [{ type: "text" as const, text: "Error echoed SECRET REPLY" }], details: undefined };
            assert.deepEqual(renderers.renderResult!(result, { expanded, isPartial: false }, theme, { ...ctx, isError: true }).render(80), []);
            assert(args.command.includes("SECRET REPLY")); // No context mutation by rendering.
        }
    }
});

test("partial argument streams never flash a reply before its marker is complete", () => {
    const renderers = replyRenderers("bash", "/tmp/agent", undefined, text, frame);
    for (const args of [{}, { command: "# pi-hunk" }, { command: replyCommand(id, "s", "n", "SECRET REPLY") }]) {
        assert.deepEqual(renderers.renderCall!(args, theme, context(args, { argsComplete: false })).render(80), []);
    }
});

test("ordinary commands delegate normally without passing placeholder components", () => {
    const call = text("Normal bash call");
    const result = text("Normal bash result");
    const previous: unknown[] = [];
    const renderers = replyRenderers("bash", "/tmp/agent", {
        renderCall(_args, _theme, ctx) { previous.push(ctx.lastComponent); return call; },
        renderResult() { return result; },
    }, text, frame);
    const args = { command: "npm test" };
    const ctx = context(args);
    const placeholder = renderers.renderCall!(args, theme, { ...ctx, argsComplete: false });
    const box = renderers.renderCall!(args, theme, { ...ctx, lastComponent: placeholder });
    assert.deepEqual(box.render(80), ["Normal bash call"]);
    assert.equal(renderers.renderCall!(args, theme, ctx), box);
    assert.deepEqual(renderers.renderResult!({ content: [], details: undefined }, { expanded: true, isPartial: false }, theme, ctx).render(80), []);
    assert.deepEqual(box.render(80), ["Normal bash call", "Normal bash result"]);
    assert.deepEqual(previous, [undefined, call]);
});

test("legacy reply-file history remains hidden without creating or reading files", () => {
    const renderers = replyRenderers("write", "/tmp/agent", undefined, text, frame);
    const args = { path: `/tmp/agent/pi-hunk/replies/${id}.md`, content: "OLD REPLY" };
    assert(!renderers.renderCall!(args, theme, context(args)).render(80).join("\n").includes("OLD REPLY"));
    const normal = { path: "app.ts", content: "Normal code" };
    assert(renderers.renderCall!(normal, theme, context(normal)).render(80).join("\n").includes("Normal code"));
});
