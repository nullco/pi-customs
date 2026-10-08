import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HunkWatcher, noteVersion, taskPrompt, threadFor } from "./watcher.ts";
import type { NoteState, WatcherPorts } from "./watcher.ts";
import type { HunkClient, HunkNote, HunkSession } from "./hunk.ts";

function human(id = "user:1", body = "Please simplify this", extra: Partial<HunkNote> = {}): HunkNote {
    return { noteId: id, source: "user", body, filePath: "src/app.ts", newRange: [12, 12], createdAt: "2026-10-08T10:00:00Z", ...extra };
}

async function fixture(t: { after(fn: () => Promise<void>): void }, initial: NoteState[] = [], pinned?: string) {
    const repo = await mkdtemp(join(tmpdir(), "pi-hunk-test-"));
    t.after(() => rm(repo, { recursive: true, force: true }));
    let sessions: HunkSession[] = [{ sessionId: "session:1", repoRoot: repo }];
    let notes = [human()];
    let idle = true;
    let failReply = false;
    let failRead = false;
    let delayRead: (() => Promise<void>) | undefined;
    const sent: string[] = [];
    const saved: NoteState[] = [];
    const notifications: string[] = [];
    const replies: { sessionId: string; noteId: string; summary: string }[] = [];
    const client: HunkClient = {
        sessions: async () => sessions,
        notes: async () => {
            await delayRead?.();
            if (failRead) throw new Error("read failed");
            return notes;
        },
        reply: async (sessionId, noteId, summary) => {
            replies.push({ sessionId, noteId, summary });
            notes.push({ ...human(`agent:${replies.length}`, summary), source: "agent", parentId: noteId, author: "pi-hunk", createdAt: "2026-10-08T11:00:00Z" });
            if (failReply) throw new Error("lost acknowledgement");
        },
    };
    const ports: WatcherPorts = {
        idle: () => idle,
        send: (prompt) => sent.push(prompt),
        save: (state) => saved.push(state),
        status: () => {},
        notify: (text) => notifications.push(text),
    };
    const watcher = new HunkWatcher(repo, client, ports, initial.map((state) => ({ ...state, repo })), pinned);
    t.after(async () => watcher.stop());
    return {
        repo, watcher, client, ports, sent, saved, notifications, replies,
        get notes() { return notes; }, set notes(value: HunkNote[]) { notes = value; },
        get sessions() { return sessions; }, set sessions(value: HunkSession[]) { sessions = value; },
        set idle(value: boolean) { idle = value; },
        set failReply(value: boolean) { failReply = value; },
        set failRead(value: boolean) { failRead = value; },
        set delayRead(value: (() => Promise<void>) | undefined) { delayRead = value; },
    };
}

function reply(f: Awaited<ReturnType<typeof fixture>>, note = f.notes[0], summary = "Simplified; tests passed") {
    return f.watcher.reply("session:1", note.noteId, noteVersion(note), summary);
}

test("human notes dispatch once and require a confirmed reply", async (t) => {
    const f = await fixture(t);
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
    assert.equal(f.saved[0].phase, "submitted");
    assert.match(f.sent[0], /pi_hunk_reply/);
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
    await reply(f);
    assert.equal(f.saved.at(-1)?.phase, "handled");
    await reply(f); // Duplicate tool call is idempotent.
    assert.equal(f.replies.length, 1);
    f.watcher.settled();
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
});

test("busy Pi queues notes but re-reads edits/deletions before dispatch", async (t) => {
    const f = await fixture(t);
    f.idle = false;
    await f.watcher.poll();
    assert.equal(f.sent.length, 0);
    f.notes = [human("user:2", "The current request")];
    f.idle = true;
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /The current request/);
    assert.doesNotMatch(f.sent[0], /Please simplify this/);
});

test("comments added during a run wait until the next poll after settlement", async (t) => {
    const f = await fixture(t);
    await f.watcher.poll();
    f.notes.push(human("user:2", "Another request"));
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
    await reply(f);
    f.watcher.settled();
    assert.equal(f.sent.length, 1);
    await f.watcher.poll();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1], /Another request/);
});

test("ignore agent/AI notes and already-answered history, but handle human follow-ups", async (t) => {
    const f = await fixture(t);
    const agent = { ...human("agent:1", "Earlier answer"), source: "agent", parentId: "user:1", createdAt: "2026-10-08T11:00:00Z" };
    f.notes = [human(), agent, { ...human("ai:1"), source: "ai" }, human("user:2", "Why?", { parentId: "agent:1" })];
    await f.watcher.poll();
    assert.equal(f.saved[0].phase, "handled");
    assert.equal(f.saved[1].noteId, "user:2");
    assert.equal(f.saved.length, 2);
    assert.match(f.sent[0], /Earlier answer/);
});

test("observed edits reopen a handled note even with its existing agent reply", async (t) => {
    const f = await fixture(t);
    await f.watcher.poll();
    await reply(f);
    f.watcher.settled();
    f.notes[0] = { ...f.notes[0], body: "Actually remove it entirely" };
    await f.watcher.poll();
    assert.equal(f.sent.length, 2);
    assert.equal(f.saved.at(-1)?.version, noteVersion(f.notes[0]));
});

test("refuse stale, deleted, unauthorized, and empty replies", async (t) => {
    const f = await fixture(t);
    const original = f.notes[0];
    await f.watcher.poll();
    f.notes[0] = { ...original, body: "Edited" };
    await assert.rejects(reply(f, original), /changed or vanished/);
    f.notes = [];
    await assert.rejects(reply(f, original), /changed or vanished/);
    await assert.rejects(reply(f, human("user:unknown")), /not an active/);
    await assert.rejects(reply(f, original, " "), /nonempty/);
    assert.equal(f.replies.length, 0);
});

test("session closing or moving to another checkout prevents replies", async (t) => {
    const f = await fixture(t);
    await f.watcher.poll();
    f.sessions = [{ sessionId: "session:1", repoRoot: tmpdir() }];
    await assert.rejects(reply(f), /no longer belongs/);
    assert.equal(f.replies.length, 0);
});

test("multiple matching windows pause unless explicitly selected", async (t) => {
    const f = await fixture(t);
    f.sessions.push({ sessionId: "session:2", repoRoot: f.repo });
    await f.watcher.poll();
    assert.equal(f.sent.length, 0);
    assert.match(f.watcher.status(), /multiple sessions/);
    const pinned = new HunkWatcher(f.repo, f.client, f.ports, [], "session:2");
    t.after(async () => pinned.stop());
    await pinned.poll();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /session:2/);
});

test("no session waits and resumes automatically when a matching window opens", async (t) => {
    const f = await fixture(t);
    f.sessions = [];
    await f.watcher.poll();
    assert.equal(f.sent.length, 0);
    assert.match(f.watcher.status(), /waiting/);
    f.sessions = [{ sessionId: "session:1", repoRoot: f.repo }];
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
});

test("matching handles symlinks but does not conflate worktrees", async (t) => {
    const f = await fixture(t);
    const alias = join(f.repo, "alias");
    await symlink(f.repo, alias);
    await mkdir(join(f.repo, "other-worktree"));
    f.sessions = [
        { sessionId: "unrelated", repoRoot: join(f.repo, "other-worktree") },
        { sessionId: "session:1", repoRoot: alias },
    ];
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /session:1/);
});

test("persisted handled versions deduplicate reloads; newer versions dispatch", async (t) => {
    const note = human();
    const state: NoteState = { repo: "replaced", sessionId: "session:1", noteId: note.noteId, version: noteVersion(note), phase: "handled" };
    const f = await fixture(t, [state]);
    await f.watcher.poll();
    assert.equal(f.sent.length, 0);
    f.notes[0] = { ...note, body: "Edited since reload" };
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
});

test("unfinished attempts do not spin agent turns; explicit retry resubmits", async (t) => {
    const f = await fixture(t);
    await f.watcher.poll();
    assert.throws(() => f.watcher.retry(), /Wait/);
    f.watcher.settled();
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
    assert.match(f.watcher.status(), /awaiting retry/);
    f.watcher.retry();
    await f.watcher.poll();
    assert.equal(f.sent.length, 2);
});

test("a lost reply acknowledgement is reconciled without duplicate posts", async (t) => {
    const f = await fixture(t);
    await f.watcher.poll();
    f.failReply = true;
    await assert.rejects(reply(f), /lost acknowledgement/);
    assert.equal(f.saved.at(-1)?.phase, "submitted");
    await f.watcher.poll();
    assert.equal(f.saved.at(-1)?.phase, "handled");
    assert.equal(f.replies.length, 1);
    f.watcher.settled();
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
});

test("reply intent from a previous runtime reconciles after reload", async (t) => {
    const state: NoteState = { repo: "replaced", sessionId: "session:1", noteId: "user:1", version: noteVersion(human()), phase: "submitted", summary: "Done" };
    const f = await fixture(t, [state]);
    f.notes.push({ ...human("agent:1", "Done"), source: "agent", parentId: "user:1" });
    await f.watcher.poll();
    assert.equal(f.saved.at(-1)?.phase, "handled");
    assert.equal(f.sent.length, 0);
});

test("stopping during an outstanding read prevents dispatch and persistence", async (t) => {
    const f = await fixture(t);
    let release!: () => void;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    f.delayRead = () => { reading(); return new Promise<void>((resolve) => { release = resolve; }); };
    const poll = f.watcher.poll();
    await started;
    f.watcher.stop();
    release();
    await poll;
    assert.equal(f.sent.length, 0);
    assert.equal(f.saved.length, 0);
    await assert.rejects(reply(f));
});

test("overlapping polls are ignored, and failures can recover without notification spam", async (t) => {
    const f = await fixture(t);
    f.failRead = true;
    await f.watcher.poll();
    await f.watcher.poll();
    assert.equal(f.notifications.length, 1);
    f.failRead = false;
    await Promise.all([f.watcher.poll(), f.watcher.poll()]);
    assert.equal(f.sent.length, 1);
});

test("failed dispatch remains available for explicit retry", async (t) => {
    const f = await fixture(t);
    const watcher = new HunkWatcher(f.repo, f.client, { ...f.ports, send: () => { throw new Error("cannot send"); } });
    t.after(async () => watcher.stop());
    await watcher.poll();
    watcher.retry(); // Does not remain stuck in-flight when send throws.
    assert.equal(f.saved.at(-1)?.phase, "retry");
});

test("batching is bounded, blank notes ignored, and remaining comments drain", async (t) => {
    const f = await fixture(t);
    f.notes = Array.from({ length: 7 }, (_, i) => human(`user:${i}`));
    f.notes.push(human("user:blank", "  "));
    await f.watcher.poll();
    assert.equal(f.saved.length, 5);
    for (const note of f.notes.slice(0, 5)) await reply(f, note);
    f.watcher.settled();
    await f.watcher.poll();
    assert.equal(f.sent.length, 2);
    assert.equal(f.saved.filter((state) => state.phase === "submitted" && !state.summary).length, 7);
});

test("fingerprints track content/anchor changes, not timestamps", () => {
    const note = human();
    assert.equal(noteVersion(note), noteVersion({ ...note, updatedAt: "now" }));
    assert.notEqual(noteVersion(note), noteVersion({ ...note, newRange: [13, 13] }));
    assert.notEqual(noteVersion(note), noteVersion({ ...note, body: "new request" }));
});

test("thread context includes the full thread; cycles are bounded; requests remain intact", () => {
    const root = human();
    const agent = { ...human("agent:1", "Answer"), source: "agent", parentId: root.noteId };
    const followup = human("user:2", "Why?", { parentId: agent.noteId });
    assert.equal(threadFor(followup, [root, agent, followup, human("unrelated")]).length, 3);
    const a = human("a", "A", { parentId: "b" });
    const b = human("b", "B", { parentId: "a" });
    assert.doesNotThrow(() => threadFor(a, [a, b]));
    const large = human("long", "x".repeat(7000));
    assert.match(taskPrompt("/repo", [{ sessionId: "s", note: large, version: noteVersion(large), thread: [large] }]), new RegExp(`"request": "${large.body}"`));
});
