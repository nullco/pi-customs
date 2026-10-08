// Real main Pi session, native bash/transcript rendering, scripted model, fake Hunk.
// Pass the installed @earendil-works/pi-coding-agent directory as argv[2].
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { replyCommand, SENT_NOTICE } from "./cli.ts";

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
    const note = { noteId: "user:1", source: "user", body: "Explain this function", filePath: "app.ts", newRange: [1, 1] };
    await writeFile(notesPath, JSON.stringify([note]));
    const executable = join(bin, "hunk");
    await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(args)+'\\n');const notes=JSON.parse(fs.readFileSync(${JSON.stringify(notesPath)},'utf8'));if(args[2]==='add'){notes.push({noteId:'agent:'+notes.length,source:'agent',filePath:'app.ts',body:args[args.indexOf('--summary')+1],parentId:args[args.indexOf('--reply-to')+1]});fs.writeFileSync(${JSON.stringify(notesPath)},JSON.stringify(notes));if(args[args.indexOf('--reply-to')+1]==='user:6'){console.error('Lost acknowledgement: '+args.join(' '));process.exit(1);}}console.log(JSON.stringify(args[1]==='list'?{sessions:[{sessionId:'s',repoRoot:process.cwd()}]}:args[2]==='list'?{comments:notes}:{commentId:'agent:1'}));`);
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
        const message = transcript.messages.findLast((item) => item.role === "user");
        const text = typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join("");
        if (text.includes("hold foreground")) {
            const held = gate("foreground");
            held.started = true;
            await held.promise;
            return fauxAssistantMessage("Ordinary foreground work finished.");
        }
        if (text.includes("ordinary takeover")) return fauxAssistantMessage("Answer to ordinary takeover.");
        const start = text.indexOf("\n[");
        const payload = JSON.parse(text.slice(start + 1, text.lastIndexOf("]") + 1));
        assert.equal(payload.length, 1);
        const task = payload[0];
        const requestId = text.match(/# pi-hunk-reply:([0-9a-f-]{36})/)[1];
        const last = transcript.messages.findLast((item) => item.role !== "system");
        if (last.role === "toolResult" && last.toolName === "bash") {
            if (task.noteId === "user:4") {
                const held = gate("user:4");
                held.started = true;
                await held.promise;
            }
            return fauxAssistantMessage(""); // Delivery/failure is an extension notification.
        }
        if (last.role === "toolResult") {
            const body = task.noteId === "user:7" ? `Answer to user:7: ${task.request}` : `Answer to ${task.noteId}`;
            const command = replyCommand(requestId, task.sessionId, task.noteId === "user:9" ? "wrong-note" : task.noteId, body);
            return fauxAssistantMessage(fauxToolCall("bash", {
                // Reproduce live models dropping the shell-comment marker.
                command: ["user:1", "user:2", "user:5", "user:7", "user:8", "user:9"].includes(task.noteId)
                    ? command.slice(command.indexOf("\n") + 1) : command,
            }), { stopReason: "toolUse" });
        }
        if (task.noteId === "user:2") {
            assert(history.includes("Answer to user:1"));
            assert(history.includes("Explain this function"));
        }
        requests.push({ ...task, requestId });
        return fauxAssistantMessage(fauxToolCall("foreground_marker", { noteId: task.noteId }), { stopReason: "toolUse" });
    };
    faux.setResponses(Array(40).fill(response));
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
            parameters: Type.Object({ noteId: Type.String() }),
            async execute(_id, params) {
                if (["user:3", "user:7", "user:8"].includes(params.noteId)) {
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
    await session.bindExtensions({
        mode: "tui", onError: (error) => extensionErrors.push(error),
        uiContext: {
            notify: (text) => notifications.push(text), select: async () => undefined,
            setStatus: () => { throw new Error("No status-bar entry is allowed"); },
        },
    });
    const baselineTools = session.getActiveToolNames().sort();
    await assert.rejects(readFile(callsPath)); // Opt-in only.
    await session.prompt("/hunk on");
    const notes = async () => JSON.parse(await readFile(notesPath, "utf8"));
    const hasReply = async (id) => (await notes()).some((item) => item.parentId === id);
    const addNote = async (id, body) => {
        const list = await notes();
        list.push({ ...note, noteId: id, body });
        await writeFile(notesPath, JSON.stringify(list));
    };
    await until(() => hasReply("user:1"));
    await until(() => !session.isStreaming);
    assert.deepEqual(session.getActiveToolNames().sort(), baselineTools);
    assert.deepEqual(notifications, ["Hunk comment received.", SENT_NOTICE]);
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

    // New Hunk requests wait for busy main Pi, but receipt notices do not.
    const foreground = session.prompt("hold foreground");
    await until(() => gate("foreground").started);
    await addNote("user:2", "Why?");
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(requests.length, 1);
    assert.equal(notifications.at(-1), "Hunk comment received.");
    gate("foreground").done();
    await foreground;
    await until(() => hasReply("user:2"));

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

    // Dropping the marker does not bypass matching the active target IDs.
    await addNote("user:9", "Reply to this note only");
    await until(() => requests.some((task) => task.noteId === "user:9"));
    await until(() => !session.isStreaming);
    assert.equal(await hasReply("wrong-note"), false);
    assert.equal(await hasReply("user:9"), false);

    // /hunk off blocks a not-yet-authorized reply without aborting the main agent.
    await addNote("user:8", "Cancel before posting");
    await until(() => gate("user:8").started);
    await session.prompt("/hunk off");
    assert(session.isStreaming);
    gate("user:8").done();
    await until(() => !session.isStreaming);
    assert.equal(await hasReply("user:8"), false);
    const calls = await readFile(callsPath, "utf8");
    await new Promise((done) => setTimeout(done, 1100));
    assert.equal(await readFile(callsPath, "utf8"), calls);
    await assert.rejects(stat(join(process.env.PI_CODING_AGENT_DIR, "pi-hunk/replies")), { code: "ENOENT" });
    assert.deepEqual(session.getActiveToolNames().sort(), baselineTools);
    assert(toolCalls.every((name) => ["foreground_marker", "bash"].includes(name)));
    assert(!JSON.stringify(notifications).includes("Answer to user:"));
    assert(!session.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text.includes("Answer to user:"))));
    assert.deepEqual(extensionErrors, []);
    await session.prompt("/hunk status");
    assert.match(notifications.pop(), /is off/);
    await session.extensionRunner.emit({ type: "session_shutdown" });
    assert(!renderTool("bash", hidden).includes("SECRET REPLY"));
    console.log("SDK smoke passed: native direct CLI, no reply files/new tools, quiet chat/history/expansion, main question/reply context, busy receipts, permissions, edits, abort-after-post, lost acknowledgments, off/shutdown.");
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
