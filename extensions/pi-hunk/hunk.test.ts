import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHunkClient, parseNotes, parseSessions } from "./hunk.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { replyCommand } from "./cli.ts";

test("parses the documented Hunk JSON shapes and rejects malformed responses", () => {
    assert.deepEqual(parseSessions({ sessions: [{ sessionId: "s", repoRoot: "/repo", title: "review", snapshot: {} }] }),
        [{ sessionId: "s", repoRoot: "/repo", title: "review" }]);
    assert.equal(parseSessions({ sessions: [{ sessionId: "non-vcs" }] })[0].repoRoot, "");
    assert.equal(parseNotes({ comments: [{ noteId: "user:1", source: "user", body: "Fix it", filePath: "app.ts", newRange: [10, 12] }] }).length, 1);
    for (const value of [null, {}, { sessions: [{}] }]) assert.throws(() => parseSessions(value));
    for (const value of [null, {}, { comments: [{}] }, {
        comments: [{ noteId: "user:1", source: "user", body: "Fix it", filePath: "app.ts", newRange: [0, 2] }],
    }]) assert.throws(() => parseNotes(value));
});

test("direct bash CLI uses exact IDs and shell-quoted literal reply text",  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hunk-cli-"));
    const oldPath = process.env.PATH;
    t.after(async () => {
        process.env.PATH = oldPath;
        await rm(dir, { recursive: true, force: true });
    });
    const executable = join(dir, "hunk");
    await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');\nconst args = process.argv.slice(2);\nconsole.log(JSON.stringify(args[1] === 'list' ? {sessions: []} : args[2] === 'list' ? {comments: []} : {commentId: 'agent:1'}));\n`);
    await chmod(executable, 0o755);
    process.env.PATH = `${dir}:${oldPath}`;
    const client = createHunkClient(dir);
    const signal = new AbortController().signal;
    await client.sessions(signal);
    await client.notes("session:exact", signal);
    const summary = "Don't interpolate $(touch injected); `echo oops`\nSecond line";
    await promisify(execFile)("bash", ["-c", replyCommand("00000000-0000-4000-8000-000000000001", "session:exact", "user:1", summary)], { cwd: dir, signal });
    const calls = (await readFile(join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
        ["session", "list", "--json"],
        ["session", "comment", "list", "session:exact", "--type", "all", "--json"],
        ["session", "comment", "add", "session:exact", "--reply-to", "user:1", "--summary", summary, "--author", "pi-hunk", "--json"],
    ]);
    await assert.rejects(readFile(join(dir, "injected")));
});
