import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HUNK_SKILL_GUIDELINE, hunkSkillPath, registerHunkReview, reviewPrompt } from "./review.ts";

const skillText = "---\nname: hunk-review\ndescription: Review live Hunk sessions\n---\n# Hunk review\nBUNDLED SKILL SENTINEL\nRead references/details.md when needed.\n";
async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-skill-"));
    const path = join(root, "bundled skill", "hunk-review", "SKILL.md");
    const config = join(root, "config.json"), calls = join(root, "calls.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, skillText);
    await writeFile(config, JSON.stringify({ path }));
    const executable = join(root, "hunk");
    await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');const config=JSON.parse(fs.readFileSync(${JSON.stringify(config)},'utf8'));if(config.fail){console.error('PRIVATE CLI ERROR');process.exit(1);}const done=()=>console.log(config.path);if(config.delay)setTimeout(done,10000);else done();`);
    await chmod(executable, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${root}:${oldPath}`;
    t.after(async () => { process.env.PATH = oldPath; await rm(root, { recursive: true, force: true }); });
    const events = new Map<string, Function[]>(), sent: { content: string; options: unknown }[] = [], notices: string[] = [];
    const ctx = { cwd: root, model: {}, hasUI: true, isIdle: () => true,
        ui: { notify: (text: string) => notices.push(text) } };
    const pi = {
        on: (name: string, handler: Function) => {
            events.set(name, [...(events.get(name) ?? []), handler]);
            return () => {};
        },
        getActiveTools: () => ["bash"],
        sendUserMessage: (content: string, options: unknown) => sent.push({ content, options }),
    };
    const review = registerHunkReview(pi as never);
    const emit = async (type: string, fields = {}) => {
        const results = [];
        for (const handler of events.get(type) ?? []) results.push(await handler({ type, cwd: root, ...fields }, ctx));
        return results;
    };
    return { root, path, calls, pi, ctx, sent, notices, review, emit,
        configure: (value: object) => writeFile(config, JSON.stringify({ path, ...value })),
        callCount: async () => { try { return (await readFile(calls, "utf8")).trim().split("\n").length; } catch { return 0; } },
    };
}
async function until(predicate: () => Promise<boolean>) {
    const deadline = Date.now() + 3000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for skill discovery");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("skill registration discovers the bundled canonical file without factory-time work or UI", async (t) => {
    const f = await fixture(t);
    assert.equal(await f.callCount(), 0);
    const link = join(f.root, "alias", "SKILL.md");
    await mkdir(dirname(link));
    await symlink(f.path, link);
    await f.configure({ path: link });
    assert.deepEqual(await f.emit("resources_discover"), [{ skillPaths: [f.path] }]);
    assert.deepEqual(JSON.parse((await readFile(f.calls, "utf8")).trim()), ["skill", "path"]);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.notices, []);
});

test("routing is Hunk-specific, deduplicated, and preserves existing structured guidelines", async (t) => {
    const f = await fixture(t);
    const options = { promptGuidelines: ["Keep ordinary project rules"] };
    await f.emit("before_agent_start", { systemPromptOptions: options });
    await f.emit("before_agent_start", { systemPromptOptions: options });
    assert.deepEqual(options.promptGuidelines, ["Keep ordinary project rules", HUNK_SKILL_GUIDELINE]);
    assert.match(HUNK_SKILL_GUIDELINE, /already in context/);
    assert.match(HUNK_SKILL_GUIDELINE, /hunk skill path/);
    assert.match(HUNK_SKILL_GUIDELINE, /hidden comment requests.*quiet-chat/);
    assert.match(HUNK_SKILL_GUIDELINE, /ordinary user-requested reviews may be narrated/);
    assert.equal(await f.callCount(), 0);
});

test("explicit review embeds the freshly resolved skill, references, and verbatim multiline request", async (t) => {
    const f = await fixture(t);
    await f.emit("resources_discover");
    const upgraded = join(f.root, "upgraded skill", "SKILL.md");
    await mkdir(dirname(upgraded));
    await writeFile(upgraded, skillText.replace("BUNDLED", "UPGRADED"));
    await f.configure({ path: upgraded });
    const request = "Review main...HEAD\nFocus on race conditions; preserve  this spacing.";
    await f.review(request, f.ctx as never);
    assert.equal(await f.callCount(), 2);
    assert.equal(f.sent.length, 1);
    assert(f.sent[0].content.startsWith(`<skill name="hunk-review" location="${upgraded}">`));
    assert(f.sent[0].content.includes(JSON.stringify(dirname(upgraded))));
    assert(f.sent[0].content.includes("UPGRADED SKILL SENTINEL"));
    assert(f.sent[0].content.endsWith(request));
    assert.deepEqual(f.sent[0].options, { deliverAs: "followUp" });
    assert.deepEqual(f.notices, []);
    assert.match(f.sent[0].content, /ask me to open Hunk/);
    assert.match(f.sent[0].content, /not the reserved pi-hunk reply author/);
});

test("review works without discovery and queues behind active work without aborting it", async (t) => {
    const f = await fixture(t);
    await f.review("", { ...f.ctx, isIdle: () => false } as never);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].content, /Walk me through the current changes/);
    assert.deepEqual(f.sent[0].options, { deliverAs: "followUp" });
    assert.deepEqual(f.notices, ["Hunk review queued."]);
    assert.equal(await f.callCount(), 1);
});

test("failed discovery stays quiet and explicit review reports a body-free failure", async (t) => {
    const f = await fixture(t);
    await f.configure({ fail: true });
    assert.deepEqual(await f.emit("resources_discover"), [undefined]);
    assert.deepEqual(f.notices, []);
    await f.review("Review this", f.ctx as never);
    assert.deepEqual(f.sent, []);
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0], /Could not load.*hunk skill path/);
    assert(!f.notices[0].includes("PRIVATE CLI ERROR"));
});

test("missing Hunk reports PATH explicitly without confusing a missing skill file with a missing executable", async (t) => {
    const f = await fixture(t);
    await f.configure({ path: join(f.root, "missing", "SKILL.md") });
    await f.review("Review this", f.ctx as never);
    assert.match(f.notices.pop()!, /Could not load the Hunk review skill/);
    const emptyBin = join(f.root, "empty-bin");
    await mkdir(emptyBin);
    process.env.PATH = emptyBin;
    assert.deepEqual(await f.emit("resources_discover"), [undefined]);
    assert.deepEqual(f.notices, []);
    await f.review("Review this", f.ctx as never);
    assert.match(f.notices[0], /Hunk was not found on PATH/);
    assert.deepEqual(f.sent, []);
});

test("invalid skill paths, non-files, empty and oversized skills are not advertised or embedded", async (t) => {
    const f = await fixture(t);
    for (const path of ["SKILL.md", "", `${f.path}\nextra`, `${f.path}\0`, join(f.root, "other.md"), join(f.root, "missing", "SKILL.md")]) {
        await f.configure({ path });
        await assert.rejects(hunkSkillPath(f.root));
    }
    const directory = join(f.root, "SKILL.md");
    await mkdir(directory);
    await f.configure({ path: directory });
    assert.deepEqual(await f.emit("resources_discover"), [undefined]);
    await f.configure({});
    for (const content of ["", " ", "x".repeat(256 * 1024 + 1)]) {
        await writeFile(f.path, content);
        await f.review("Review this", f.ctx as never);
        assert.equal(f.sent.length, 0);
    }
});

test("missing model or bash prevents review dispatch without running skill discovery", async (t) => {
    const f = await fixture(t);
    await f.review("Review this", { ...f.ctx, model: undefined } as never);
    f.pi.getActiveTools = () => [];
    await f.review("Review this", f.ctx as never);
    assert.equal(await f.callCount(), 0);
    assert.equal(f.sent.length, 0);
    assert.match(f.notices[0], /Select a model/);
    assert.match(f.notices[1], /bash tool/);
});

test("session lifecycle cancels pending review loads without dispatch or stale errors", async (t) => {
    const f = await fixture(t);
    await f.configure({ delay: true });
    for (const event of ["session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_tree", "session_shutdown"]) {
        const before = await f.callCount();
        const review = f.review("Review this", f.ctx as never);
        await until(async () => await f.callCount() > before);
        await f.emit(event);
        await review;
        assert.deepEqual(f.sent, []);
        assert.deepEqual(f.notices, []);
    }
    const before = await f.callCount();
    const discovery = f.emit("resources_discover");
    await until(async () => await f.callCount() > before);
    await f.emit("session_shutdown");
    assert.deepEqual(await discovery, [undefined]);
});

test("review prompt escapes location attributes without losing the reference directory", () => {
    const path = '/skills/a"&b/SKILL.md';
    const prompt = reviewPrompt(path, skillText, "Review this");
    assert(prompt.includes('location="/skills/a&quot;&amp;b/SKILL.md"'));
    assert(prompt.includes(JSON.stringify(dirname(path))));
    assert(prompt.endsWith("Request:\nReview this"));
});
