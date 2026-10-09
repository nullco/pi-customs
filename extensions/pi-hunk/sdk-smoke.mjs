// Real main Pi session, native bash/transcript rendering, scripted model, fake Hunk.
// Pass the installed @earendil-works/pi-coding-agent directory as argv[2].
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReplyCommand, replyCommand, SENT_NOTICE } from "./cli.ts";

const packageDir = process.argv[2] ? resolve(process.argv[2])
    : dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const root = await mkdtemp(join(tmpdir(), "pi-hunk-sdk-"));
const oldPath = process.env.PATH;
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
let session;
const gates = new Map();
function gate(name) {
    if (!gates.has(name)) {
        let done;
        gates.set(name, { promise: new Promise((resolve) => { done = resolve; }), done: () => done(), started: false });
    }
    return gates.get(name);
}
async function until(predicate) {
    const deadline = Date.now() + 10000;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for main Pi / direct Hunk reply");
        await new Promise((done) => setTimeout(done, 30));
    }
    await new Promise((done) => setTimeout(done, 100));
}
try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    await mkdir(repo);
    await mkdir(bin);
    execFileSync("git", ["init", "--quiet", repo]);
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    const sdk = await import(pathToFileURL(join(packageDir, "dist/index.js")));
    const aiRoot = resolve(packageDir, "../../@earendil-works/pi-ai");
    const { Type, fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentTools } = await import(pathToFileURL(join(aiRoot, "dist/index.js")));
    const notesPath = join(root, "notes.json");
    const callsPath = join(root, "calls.jsonl");
    const sessionsPath = join(root, "sessions.json");
    await writeFile(sessionsPath, JSON.stringify([{ sessionId: "s", repoRoot: repo }]));
    const note = { noteId: "user:1", source: "user", body: "Explain this function", filePath: "app.ts", newRange: [1, 1] };
    await writeFile(notesPath, JSON.stringify([note]));
    const executable = join(bin, "hunk");
    await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(args)+'\\n');const notes=JSON.parse(fs.readFileSync(${JSON.stringify(notesPath)},'utf8'));if(args[2]==='add'){notes.push({noteId:'agent:'+notes.length,source:'agent',filePath:'app.ts',body:args[args.indexOf('--summary')+1],parentId:args[args.indexOf('--reply-to')+1]});fs.writeFileSync(${JSON.stringify(notesPath)},JSON.stringify(notes));if(args[args.indexOf('--reply-to')+1]==='user:6'){console.error('Lost acknowledgement: '+args.join(' '));process.exit(1);}}console.log(JSON.stringify(args[1]==='list'?{sessions:JSON.parse(fs.readFileSync(${JSON.stringify(sessionsPath)},'utf8'))}:args[2]==='list'?{comments:notes}:{commentId:'agent:1'}));`);
    await chmod(executable, 0o755);
    process.env.PATH = `${bin}:${oldPath}`;
    const faux = fauxProvider({ provider: "pi-hunk-test", tokensPerSecond: Infinity });
    const requests = [];
    const response = async (transcript) => {
        const history = JSON.stringify(transcript.messages);
        assert(history.includes("foreground-context-sentinel"));
        const tools = getCurrentTools(transcript.messages).map((tool) => tool.name);
        assert(tools.includes("foreground_marker") && tools.includes("bash"));
        assert(!tools.includes("pi_hunk_reply"));
        const latest = new Map();
        const attempted = new Set(), checked = new Set();
        const markers = new Set();
        let takeover = -1;
        let lastPost;
        for (const [index, message] of transcript.messages.entries()) {
            const text = typeof message.content === "string" ? message.content
                : message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
            if (message.role === "user" && text.includes("ordinary takeover")) takeover = index;
            if (message.role === "user" && text.includes("\nHunk requests in ")) {
                const payload = JSON.parse(text.slice(text.indexOf("\n[") + 1, text.lastIndexOf("]") + 1));
                assert.equal(payload.length, 1);
                const requestId = text.match(/# pi-hunk-reply:([0-9a-f-]{36})/)[1];
                const task = { ...payload[0], requestId, index };
                latest.set(task.noteId, task);
                if (!requests.some((item) => item.requestId === requestId)) requests.push(task);
            }
            if (message.role !== "assistant") continue;
            for (const block of message.content) {
                if (block.type !== "toolCall") continue;
                if (block.name === "foreground_marker") {
                    markers.add(block.arguments.noteId);
                    if (block.arguments.requestId) checked.add(block.arguments.requestId);
                } else if (block.name === "bash") {
                    const parsed = parseReplyCommand(block.arguments.command);
                    const task = parsed.requestId ? requests.find((item) => item.requestId === parsed.requestId)
                        : latest.get(parsed.noteId === "wrong-note" ? "user:9" : parsed.noteId);
                    if (task) attempted.add(task.requestId);
                    lastPost = task;
                }
            }
        }
        const last = transcript.messages.findLast((message) => message.role !== "system");
        if (last.role === "toolResult" && last.toolName === "bash" && lastPost?.noteId === "user:4") {
            const held = gate("user:4");
            held.started = true;
            await held.promise;
        }
        // New steering takes priority, but earlier Hunk requests remain addressable.
        const task = [...latest.values()].findLast((item) => item.index > takeover && !attempted.has(item.requestId));
        if (task) {
            if (task.noteId === "user:2") {
                assert(history.includes("Answer to user:1"));
                assert(history.includes("Explain this function"));
            }
            if (!checked.has(task.requestId)) {
                return fauxAssistantMessage(fauxToolCall("foreground_marker", { noteId: task.noteId, requestId: task.requestId }), { stopReason: "toolUse" });
            }
            const body = task.noteId === "user:7" ? `Answer to user:7: ${task.request}` : `Answer to ${task.noteId}`;
            const command = replyCommand(task.requestId, task.sessionId, task.noteId === "user:9" ? "wrong-note" : task.noteId, body);
            return fauxAssistantMessage(fauxToolCall("bash", {
                command: ["user:1", "user:2", "user:5", "user:7", "user:8", "user:9", "user:10"].includes(task.noteId)
                    ? command.slice(command.indexOf("\n") + 1) : command,
            }), { stopReason: "toolUse" });
        }
        const ordinary = [...transcript.messages.entries()].findLast(([index, message]) => index > takeover && message.role === "user" &&
            typeof message.content !== "string" && message.content.some((block) => ["hold foreground", "hold queued", "hold edited"].includes(block.text)))?.[1];
        const ordinaryText = ordinary?.content.map((block) => block.text ?? "").join("");
        if (ordinaryText === "hold queued" && !markers.has("queue-hold")) {
            return fauxAssistantMessage(fauxToolCall("foreground_marker", { noteId: "queue-hold" }), { stopReason: "toolUse" });
        }
        if (ordinaryText === "hold edited" && !markers.has("edit-hold")) {
            return fauxAssistantMessage(fauxToolCall("foreground_marker", { noteId: "edit-hold" }), { stopReason: "toolUse" });
        }
        if (ordinaryText === "hold foreground") {
            if (!markers.has("foreground")) return fauxAssistantMessage(fauxToolCall("foreground_marker", { noteId: "foreground" }), { stopReason: "toolUse" });
            if (!markers.has("foreground-after")) return fauxAssistantMessage(fauxToolCall("foreground_marker", { noteId: "foreground-after" }), { stopReason: "toolUse" });
            return fauxAssistantMessage("Ordinary foreground work finished.");
        }
        return fauxAssistantMessage(takeover >= 0 ? "Answer to ordinary takeover." : ""); // Never narrate Hunk replies.
    };
    faux.setResponses(Array(100).fill(response));
    const settingsManager = sdk.SettingsManager.inMemory({ packages: [], extensions: [], cacheWarming: "off", retry: { enabled: false } });
    const toolCalls = [];
    const loader = new sdk.DefaultResourceLoader({
        cwd: repo, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
        noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
        additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")],
        extensionFactories: [(pi) => {
            pi.on("tool_call", (event) => {
                toolCalls.push(event.toolName);
                if (event.toolName === "bash" && event.input.command.includes("Answer to user:5")) {
                    return { block: true, reason: `Denied: ${event.input.command}` };
                }
            });
        }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions[0].tools.size, 0);
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const manager = sdk.SessionManager.inMemory(repo);
    manager.appendMessage({ role: "user", content: "foreground-context-sentinel", timestamp: Date.now() });
    ({ session } = await sdk.createAgentSession({
        cwd: repo, agentDir: process.env.PI_CODING_AGENT_DIR, model: faux.getModel(), thinkingLevel: "off",
        modelRuntime, settingsManager, resourceLoader: loader, sessionManager: manager,
        customTools: [{
            name: "foreground_marker", label: "Main agent tool", description: "Verify normal main-agent tools work",
            parameters: Type.Object({ noteId: Type.String(), requestId: Type.Optional(Type.String()) }),
            async execute(_id, params) {
                if (["foreground", "foreground-after", "queue-hold", "edit-hold", "user:3", "user:7", "user:8", "user:10"].includes(params.noteId)) {
                    const held = gate(params.noteId);
                    held.started = true;
                    await held.promise;
                }
                return { content: [{ type: "text", text: "Checks passed" }], details: undefined };
            },
        }],
    }));
    const notifications = [];
    const extensionErrors = [];
    await assert.rejects(readFile(callsPath)); // Discovery/unbound sessions do not start processes.
    await session.bindExtensions({
        mode: "tui", onError: (error) => extensionErrors.push(error),
        uiContext: {
            notify: (text) => notifications.push(text), select: async () => undefined,
            setStatus: () => { throw new Error("No status-bar entry is allowed"); },
        },
    });
    const baselineTools = session.getActiveToolNames().sort();
    // session_start enables watching automatically; no /hunk on command needed.
    const notes = async () => JSON.parse(await readFile(notesPath, "utf8"));
    const hasReply = async (id) => (await notes()).some((item) => item.parentId === id);
    const addNotes = async (items) => {
        const list = await notes();
        for (const [id, body] of items) list.push({ ...note, noteId: id, body });
        await writeFile(notesPath, JSON.stringify(list));
    };
    const addNote = (id, body) => addNotes([[id, body]]);
    await until(() => hasReply("user:1"));
    await until(() => !session.isStreaming);
    assert.deepEqual(session.getActiveToolNames().sort(), baselineTools);
    assert.deepEqual(notifications, ["Hunk comment received.", SENT_NOTICE]);
    await session.prompt("/hunk on"); // Already-on commands still acknowledge the user.
    assert.equal(notifications.at(-1), "Hunk watching is on.");
    assert(manager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "pi-hunk-request" && entry.display === false));
    assert(!session.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text === SENT_NOTICE)));
    assert(session.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.name === "bash" && block.arguments.command.includes("Answer to user:1"))));

    // The actual Pi transcript component hides tagged commands, stdout and errors,
    // including partial argument streams and expansion. Normal commands still render.
    sdk.initTheme("dark");
    function renderTool(name, args, isError = false) {
        const definition = { ...session.getToolDefinition(name),
            ...session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name)) };
        const component = new sdk.ToolExecutionComponent(name, "render:1", args,
            { showImages: false }, definition, { requestRender() {} }, repo);
        assert.deepEqual(component.render(80), []); // No partial tool row, either.
        component.setArgsComplete();
        component.updateResult({ content: [{ type: "text", text: "Echoed SECRET REPLY" }], details: undefined, isError });
        component.setExpanded(true);
        return component.render(80).join("\n");
    }
    const hidden = { command: replyCommand(requests[0].requestId, "s", "user:1", "SECRET REPLY") };
    assert.equal(renderTool("bash", hidden), "");
    assert.equal(renderTool("bash", hidden, true), "");
    const markerless = { command: hidden.command.slice(hidden.command.indexOf("\n") + 1) };
    assert.equal(renderTool("bash", markerless), "");
    assert.equal(renderTool("bash", markerless, true), "");
    assert(renderTool("bash", { command: "echo normal-command-sentinel" }).includes("normal-command-sentinel"));
    assert(!renderTool("write", { path: join(process.env.PI_CODING_AGENT_DIR, "pi-hunk/replies", requests[0].requestId + ".md"), content: "SECRET REPLY" }).includes("SECRET REPLY"));

    // Steering is delivered at a tool boundary, before ordinary work continues
    // or its whole run settles. It does not abort the tool already running.
    let foregroundSettled = false;
    const foreground = session.prompt("hold foreground").then(() => { foregroundSettled = true; });
    await until(() => gate("foreground").started);
    await addNote("user:2", "Why?");
    await until(() => notifications.at(-1) === "Hunk comment received.");
    assert.equal(requests.length, 1);
    assert.equal(notifications.at(-1), "Hunk comment received.");
    assert(session.isStreaming);
    gate("foreground").done();
    await until(() => gate("foreground-after").started);
    assert.equal(await hasReply("user:2"), true);
    assert.equal(foregroundSettled, false);
    gate("foreground-after").done();
    await foreground;

    // A delivered steering request before posting must not be routed to Hunk.
    await addNote("user:3", "Another question");
    await until(() => gate("user:3").started);
    await session.steer("ordinary takeover");
    gate("user:3").done();
    await until(() => !session.isStreaming);
    assert.equal(await hasReply("user:3"), false);

    // Direct CLI delivery cannot be undone by aborting the later acknowledgment.
    await addNote("user:4", "A fourth question");
    await until(() => gate("user:4").started);
    assert.equal(await hasReply("user:4"), true);
    const abort = session.abort();
    gate("user:4").done();
    await abort;
    assert.equal(notifications.at(-1), SENT_NOTICE);
    assert.equal(notifications.filter((text) => text === SENT_NOTICE).length, 3); // No extra abort notification.

    // Later permission hooks still run and can deny the real bash posting call.
    await addNote("user:5", "Question requiring a denied reply");
    await until(() => requests.some((task) => task.noteId === "user:5"));
    await until(() => !session.isStreaming);
    assert.equal(await hasReply("user:5"), false);

    // Nonzero CLI exit after delivery is reconciled into an honest confirmation,
    // without leaking --summary stderr or generating duplicate posts.
    await addNote("user:6", "Question with a lost acknowledgment");
    await until(() => hasReply("user:6"));
    await until(() => !session.isStreaming);
    assert(session.messages.some((message) => message.role === "toolResult" && message.toolName === "bash" &&
        !message.isError && message.content.some((block) => block.text === "Reply confirmed in Hunk.")));
    assert.equal((await notes()).filter((item) => item.parentId === "user:6").length, 1);

    // Another Hunk comment steers an existing Hunk response. With all-at-once
    // delivery, both new targets and the earlier markerless target remain valid.
    session.setSteeringMode("all");
    await addNote("user:10", "Keep this first question pending");
    await until(() => gate("user:10").started);
    await addNotes([["user:11", "A new question while Hunk work is running"], ["user:12", "Another simultaneous question"]]);
    await until(() => notifications.at(-1) === "2 Hunk comments received.");
    assert.equal(await hasReply("user:10"), false);
    gate("user:10").done();
    await until(() => hasReply("user:10"));
    await until(() => !session.isStreaming);
    assert.equal(await hasReply("user:11"), true);
    assert.equal(await hasReply("user:12"), true);
    assert.deepEqual((await notes()).filter((item) => ["user:10", "user:11", "user:12"].includes(item.parentId))
        .map((item) => item.parentId), ["user:12", "user:11", "user:10"]);
    session.setSteeringMode("one-at-a-time");

    // Editing during coding prevents the original version's CLI call. The current
    // version then drains normally, rather than requiring a retry of stale work.
    await addNote("user:7", "Original");
    await until(() => gate("user:7").started);
    const list = await notes();
    list.find((item) => item.noteId === "user:7").body = "Edited";
    await writeFile(notesPath, JSON.stringify(list));
    gate("user:7").done();
    await until(() => hasReply("user:7"));
    await until(() => !session.isStreaming);
    assert.deepEqual((await notes()).filter((item) => item.parentId === "user:7").map((item) => item.body), ["Answer to user:7: Edited"]);

    // A comment edited/deleted while still queued cannot reach the model with
    // stale instructions. The latest edit is steered without waiting for idle.
    const edited = session.prompt("hold edited");
    await until(() => gate("edit-hold").started);
    await addNotes([["user:15", "STALE QUEUED QUESTION"], ["user:16", "DELETED QUEUED QUESTION"]]);
    await until(() => notifications.at(-1) === "2 Hunk comments received.");
    const queuedNotes = await notes();
    queuedNotes.find((item) => item.noteId === "user:15").body = "Latest queued question";
    await writeFile(notesPath, JSON.stringify(queuedNotes.filter((item) => item.noteId !== "user:16")));
    await until(() => notifications.at(-1) === "Hunk comment received.");
    gate("edit-hold").done();
    await edited;
    assert.equal(await hasReply("user:15"), true);
    assert.equal(await hasReply("user:16"), false);
    assert.deepEqual(requests.filter((task) => task.noteId === "user:15").map((task) => task.request), ["Latest queued question"]);
    assert(!requests.some((task) => task.noteId === "user:16"));
    assert(!JSON.stringify(session.messages).includes("STALE QUEUED QUESTION"));
    assert(!JSON.stringify(session.messages).includes("DELETED QUEUED QUESTION"));

    // Dropping the marker does not bypass matching the active target IDs.
    await addNote("user:9", "Reply to this note only");
    await until(() => requests.some((task) => task.noteId === "user:9"));
    await until(() => !session.isStreaming);
    assert.equal(await hasReply("wrong-note"), false);
    assert.equal(await hasReply("user:9"), false);

    // /hunk off neutralizes a steering message still queued behind a running
    // tool, without aborting that tool or clearing ordinary Pi messages.
    const queued = session.prompt("hold queued");
    await until(() => gate("queue-hold").started);
    await addNote("user:14", "CANCELLED QUESTION MUST NOT REACH MODEL");
    await until(() => notifications.at(-1) === "Hunk comment received.");
    await session.prompt("/hunk off");
    assert.equal(notifications.at(-1), "Hunk watching is off.");
    assert(session.isStreaming);
    gate("queue-hold").done();
    await queued;
    assert.equal(await hasReply("user:14"), false);
    assert(!requests.some((task) => task.noteId === "user:14"));
    assert(!JSON.stringify(session.messages).includes("CANCELLED QUESTION MUST NOT REACH MODEL"));
    await writeFile(notesPath, JSON.stringify((await notes()).filter((item) => item.noteId !== "user:14")));
    await session.prompt("/hunk on");
    assert.equal(notifications.at(-1), "Hunk watching is on.");

    // /hunk off also blocks a reply already delivered to the model.
    await addNote("user:8", "Cancel before posting");
    await until(() => gate("user:8").started);
    await session.prompt("/hunk off");
    assert.equal(notifications.at(-1), "Hunk watching is off.");
    assert(session.isStreaming);
    gate("user:8").done();
    await until(() => !session.isStreaming);
    assert.equal(await hasReply("user:8"), false);
    const calls = await readFile(callsPath, "utf8");
    await new Promise((done) => setTimeout(done, 5100));
    assert.equal(await readFile(callsPath, "utf8"), calls);
    await session.prompt("/hunk off"); // Already-off commands also acknowledge the user.
    assert.equal(notifications.at(-1), "Hunk watching is off.");
    await assert.rejects(stat(join(process.env.PI_CODING_AGENT_DIR, "pi-hunk/replies")), { code: "ENOENT" });
    assert.deepEqual(session.getActiveToolNames().sort(), baselineTools);
    assert(toolCalls.every((name) => ["foreground_marker", "bash"].includes(name)));
    assert(!JSON.stringify(notifications).includes("Answer to user:"));
    assert(!session.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text.includes("Answer to user:"))));
    assert.deepEqual(extensionErrors, []);
    await session.prompt("/hunk status");
    assert.match(notifications.pop(), /is off/);
    const beforeReload = notifications.length;
    await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
    assert.equal(notifications.length, beforeReload); // Automatic enabling stays quiet.
    await session.prompt("/hunk status");
    assert.match(notifications.pop(), /Hunk: on/);
    await session.extensionRunner.emit({ type: "session_before_tree", targetId: "unused" });
    assert.equal(notifications.at(-1), "Hunk watching is off.");
    const beforeTree = notifications.length;
    await session.extensionRunner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
    assert.equal(notifications.length, beforeTree); // No duplicate off notice.
    await session.extensionRunner.emit({ type: "session_shutdown" });
    assert(!renderTool("bash", hidden).includes("SECRET REPLY"));
    // Automatic startup stays quiet and never chooses between ambiguous windows. These cases must not start model work.
    const cliCalls = async () => (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    async function withStartup(options, inspect) {
        const cwd = options.cwd ?? repo;
        const startupLoader = new sdk.DefaultResourceLoader({
            cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
            noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
            additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")],
        });
        await startupLoader.reload();
        const created = await sdk.createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR,
            model: faux.getModel(), modelRuntime, settingsManager, resourceLoader: startupLoader,
            sessionManager: sdk.SessionManager.inMemory(cwd),
            ...(options.noBash ? { tools: ["read"] } : {}),
        });
        const messages = [], selections = [], errors = [];
        const beforePath = process.env.PATH;
        try {
            if (options.path) process.env.PATH = options.path;
            await created.session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error), uiContext: {
                notify: (text) => messages.push(text),
                select: async (_title, choices) => { selections.push(choices); return options.cancelSelection ? undefined : choices[1]; },
            } });
            await inspect(created.session, messages, selections);
            assert(!created.session.messages.some((message) => message.role === "custom" && message.customType === "pi-hunk-request"));
            assert.deepEqual(errors, []);
        } finally {
            await created.session.extensionRunner.emit({ type: "session_shutdown" });
            await created.session.abort();
            created.session.dispose();
            process.env.PATH = beforePath;
        }
    }
    await writeFile(notesPath, JSON.stringify([{ ...note, noteId: "user:startup" }]));
    await writeFile(sessionsPath, JSON.stringify([{ sessionId: "s", repoRoot: repo }, { sessionId: "s2", repoRoot: repo }]));
    const ambiguousOptions = { cancelSelection: true };
    await withStartup(ambiguousOptions, async (startup, messages, selections) => {
        assert.deepEqual(messages, []);
        assert.deepEqual(selections, []);
        await startup.prompt("/hunk status");
        assert.match(messages.pop(), /multiple sessions/);
        await writeFile(notesPath, "[]");
        await startup.prompt("/hunk on"); // Cancelling the selector leaves watching off.
        assert.equal(messages.at(-1), "Hunk watching is off.");
        ambiguousOptions.cancelSelection = false;
        await startup.prompt("/hunk on");
        assert.equal(messages.at(-1), "Hunk watching is on.");
        assert.equal(selections.length, 2);
        assert((await cliCalls()).some((args) => args[2] === "list" && args[3] === "s2"));
    });
    await writeFile(sessionsPath, "[]");
    await withStartup({}, async (startup, messages) => {
        assert.deepEqual(messages, []);
        await startup.prompt("/hunk status");
        assert.match(messages.pop(), /waiting for a Hunk session/);
        const before = (await cliCalls()).length;
        await writeFile(sessionsPath, JSON.stringify([{ sessionId: "s", repoRoot: repo }]));
        await until(async () => (await cliCalls()).slice(before).some((args) => args[2] === "list" && args[3] === "s"));
        await startup.prompt("/hunk status");
        assert.match(messages.pop(), /Hunk: on/);
    });
    const outside = join(root, "not-a-repo");
    await mkdir(outside);
    const gitOnly = join(root, "git-only");
    await mkdir(gitOnly);
    await symlink(execFileSync("which", ["git"]).toString().trim(), join(gitOnly, "git"));
    for (const options of [{ cwd: outside }, { path: gitOnly }, { noBash: true }]) {
        const before = (await cliCalls()).length;
        await withStartup(options, async (startup, messages) => {
            assert.deepEqual(messages, []); // No startup error/warning spam.
            await startup.prompt("/hunk status");
            assert.match(messages.pop(), /is off.*\nLast notice:/);
            assert.equal((await cliCalls()).length, before);
            await new Promise((done) => setTimeout(done, 5100));
            assert.equal((await cliCalls()).length, before); // Failed startup leaves no poll timer.
        });
    }
    console.log("SDK smoke passed: on/off notifications, automatic startup/reload, quiet missing prerequisites, waiting/ambiguous windows, native direct CLI, no new tools/files, quiet chat/history, busy/multiple steering, permissions, queued edits/cancellation, abort-after-post, lost acknowledgments, off/shutdown.");
} finally {
    for (const held of gates.values()) held.done();
    if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown" });
        await session.abort();
        session.dispose();
    }
    process.env.PATH = oldPath;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
}
