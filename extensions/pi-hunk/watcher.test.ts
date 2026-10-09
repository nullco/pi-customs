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
    let failReply = false;
    let failRead = false;
    let delayRead: (() => Promise<void>) | undefined;
    const sent: string[] = [];
    const saved: NoteState[] = [];
    const notifications: string[] = [];
    const received: number[] = [];
    const replies: { sessionId: string; noteId: string; summary: string }[] = [];
    const client: HunkClient = {
        sessions: async () => sessions,
        notes: async () => {
            await delayRead?.();
            if (failRead) throw new Error("read failed");
            return notes;
        },
    };
    const post = async (sessionId: string, noteId: string, summary: string) => {
        replies.push({ sessionId, noteId, summary });
        notes.push({ ...human(`agent:${replies.length}`, summary), source: "agent", parentId: noteId, author: "pi-hunk", createdAt: "2026-10-08T11:00:00Z" });
        if (failReply) throw new Error("lost acknowledgement");
    };
    const ports: WatcherPorts = {
        send: (prompt) => sent.push(prompt),
        save: (state) => saved.push(state),
        notify: (text) => notifications.push(text),
        received: (count) => received.push(count),
    };
    const watcher = new HunkWatcher(repo, client, ports, initial.map((state) => ({ ...state, repo })), pinned);
    t.after(async () => watcher.stop());
    return {
        repo, watcher, client, post, ports, sent, saved, notifications, received, replies,
        get notes() { return notes; }, set notes(value: HunkNote[]) { notes = value; },
        get sessions() { return sessions; }, set sessions(value: HunkSession[]) { sessions = value; },
        set failReply(value: boolean) { failReply = value; },
        set failRead(value: boolean) { failRead = value; },
        set delayRead(value: (() => Promise<void>) | undefined) { delayRead = value; },
    };
}

async function reply(f: Awaited<ReturnType<typeof fixture>>, note = f.notes[0], summary = "Simplified; tests passed") {
    const version = noteVersion(note);
    if (await f.watcher.prepareReply("session:1", note.noteId, version, summary)) {
        await f.post("session:1", note.noteId, summary); // Simulate the main agent's direct CLI call.
        assert(await f.watcher.confirmReply("session:1", note.noteId, version, summary));
    }
}

test("human notes dispatch once and require a confirmed reply", async (t) => {
    const f = await fixture(t);
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
    assert.equal(f.saved[0].phase, "submitted");
    assert.match(f.sent[0], /"request": "Please simplify this"/);
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
    await reply(f);
    assert.equal(f.saved.at(-1)?.phase, "handled");
    await reply(f); // Repeated automatic posting is idempotent.
    assert.equal(f.replies.length, 1);
    f.watcher.settled();
    await f.watcher.poll();
    assert.equal(f.sent.length, 1);
});

test("queued steering is revalidated before delivery after edits or deletion", async (t) => {
    const f = await fixture(t);
    const original = f.notes[0];
    await f.watcher.poll();
    await f.watcher.validateTask("session:1", original.noteId, noteVersion(original));
    f.notes[0] = { ...original, body: "The current request" };
    await assert.rejects(f.watcher.validateTask("session:1", original.noteId, noteVersion(original)), /changed or vanished/);
    await f.watcher.poll(); // The edit steers immediately; no settlement needed.
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1], /The current request/);
    f.notes = [];
    await assert.rejects(f.watcher.validateTask("session:1", original.noteId, noteVersion({ ...original, body: "The current request" })), /changed or vanished/);
});

test("receipt notices batch new comments and edits once while all requests steer", async (t) => {
    const f = await fixture(t);
    f.notes.push(human("user:2", "Second comment"));
    await f.watcher.poll();
    await f.watcher.poll();
    assert.deepEqual(f.received, [2]);
    assert.equal(f.sent.length, 2);
    f.notes[0] = { ...f.notes[0], body: "Edited comment" };
    await f.watcher.poll();
    await f.watcher.poll();
    assert.deepEqual(f.received, [2, 1]);
    assert.equal(f.sent.length, 3);
});

test("comments added during a Hunk response steer without waiting for settlement", async (t) => {
    const f = await fixture(t);
    await f.watcher.poll();
    f.notes.push(human("user:2", "Another request"));
    await f.watcher.poll();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1], /Another request/);
    assert.match(f.watcher.status(), /2 active/);
    await reply(f, f.notes[1], "Second answer first");
    await reply(f, f.notes[0], "First answer second");
    f.watcher.settled();
    await f.watcher.poll();
    assert.equal(f.sent.length, 2);
    assert.deepEqual(f.replies.map((item) => item.noteId), ["user:2", "user:1"]);
});

test("settling one request does not release another queued request or newer version", async (t) => {
    const f = await fixture(t);
    const original = f.notes[0];
    await f.watcher.poll();
    f.notes[0] = { ...original, body: "Edited" };
    f.notes.push(human("user:2", "Another request"));
    await f.watcher.poll();
    f.watcher.settled([{ sessionId: "session:1", note: original, version: noteVersion(original), thread: [original] }]);
    assert.match(f.watcher.status(), /2 active/);
    await reply(f, f.notes[0]);
    await reply(f, f.notes[1]);
});

test("ignore agent/AI notes and already-answered history, but handle human follow-ups", async (t) => {
    const f = await fixture(t);
    const agent = { ...human("agent:1", "Earlier answer"), source: "agent", parentId: "user:1", createdAt: "2026-10-08T11:00:00Z" };
    f.notes = [human(), agent, { ...human("ai:1"), source: "ai" }, human("user:2", "Why?", { parentId: "agent:1" })];
    await f.watcher.poll();
    assert.equal(f.saved[0].phase, "handled");
    assert.equal(f.saved[1].noteId, "user:2");
    assert.equal(f.saved.length, 2);
    assert.deepEqual(f.received, [1]); // No receipt spam for agent notes or answered history.
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
    assert(f.watcher.needsSelection);
    const pinned = new HunkWatcher(f.repo, f.client, f.ports, [], "session:2");
    t.after(async () => pinned.stop());
    await pinned.poll();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /session:2/);
    assert(!pinned.needsSelection);
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

test("reload reconciles replies missed by the old marker-only guard", async (t) => {
    const note = human();
    const state: NoteState = { repo: "replaced", sessionId: "session:1", noteId: note.noteId, version: noteVersion(note), phase: "submitted" };
    const f = await fixture(t, [state]);
    await f.post("session:1", note.noteId, "Already delivered");
    await f.watcher.poll();
    assert.equal(f.sent.length, 0);
    assert.equal(f.saved.at(-1)?.phase, "handled");
    assert.equal(f.saved.at(-1)?.summary, "Already delivered");
    assert.doesNotMatch(f.watcher.status(), /awaiting retry/);
});

test("legacy reconciliation requires a newer direct pi-hunk reply and never infers an active run", async (t) => {
    const state: NoteState = { repo: "replaced", sessionId: "session:1", noteId: "user:1", version: noteVersion(human()), phase: "submitted" };
    for (const extra of [{ author: "other" }, { parentId: "other" }, { createdAt: "2026-10-07T11:00:00Z" }]) {
        const f = await fixture(t, [state]);
        await f.post("session:1", "user:1", "Answer");
        Object.assign(f.notes.at(-1)!, extra);
        await f.watcher.poll();
        assert.match(f.watcher.status(), /awaiting retry/);
        assert.equal(f.saved.length, 0);
    }
    const f = await fixture(t);
    await f.watcher.poll();
    await f.post("session:1", "user:1", "Unguarded response during a run");
    await f.watcher.poll();
    assert.equal(f.saved.at(-1)?.phase, "submitted");
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

test("preflight only records intent; confirmation requires the actual matching Hunk reply", async (t) => {
    const f = await fixture(t);
    const note = f.notes[0];
    const version = noteVersion(note);
    await f.watcher.poll();
    assert(await f.watcher.prepareReply("session:1", note.noteId, version, "Answer"));
    assert.equal(f.replies.length, 0); // The extension never performs the posting operation.
    assert.equal(f.saved.at(-1)?.summary, "Answer");
    assert.equal(await f.watcher.confirmReply("session:1", note.noteId, version, "Answer"), false);
    f.notes.push({ ...human("agent:unrelated", "Answer"), source: "agent", parentId: "user:other" });
    assert.equal(await f.watcher.confirmReply("session:1", note.noteId, version, "Answer"), false);
    await f.post("session:1", note.noteId, "Answer");
    assert(await f.watcher.confirmReply("session:1", note.noteId, version, "Answer"));
    assert.equal(f.saved.at(-1)?.phase, "handled");
});

test("a version edited after preflight remains queued even if the old CLI reply was delivered", async (t) => {
    const f = await fixture(t);
    const original = f.notes[0];
    const version = noteVersion(original);
    await f.watcher.poll();
    await f.watcher.prepareReply("session:1", original.noteId, version, "Old reply");
    f.notes[0] = { ...original, body: "Newer comment" };
    await f.post("session:1", original.noteId, "Old reply");
    assert(await f.watcher.confirmReply("session:1", original.noteId, version, "Old reply"));
    f.watcher.settled();
    await f.watcher.poll();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1], /Newer comment/);
    assert.equal(f.saved.at(-1)?.version, noteVersion(f.notes[0]));
});

test("confirming an old in-flight CLI reply cannot replace a newer steering version", async (t) => {
    const f = await fixture(t);
    const original = f.notes[0];
    const version = noteVersion(original);
    await f.watcher.poll();
    await f.watcher.prepareReply("session:1", original.noteId, version, "Old reply");
    f.notes[0] = { ...original, body: "Edited while CLI was running" };
    await f.watcher.poll();
    await f.post("session:1", original.noteId, "Old reply");
    assert(await f.watcher.confirmReply("session:1", original.noteId, version, "Old reply"));
    assert.equal(f.saved.at(-1)?.version, noteVersion(f.notes[0]));
    assert.equal(f.saved.at(-1)?.phase, "submitted");
    assert.match(f.watcher.status(), /1 active/);
    await reply(f, f.notes[0], "New reply");
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

test("one comment per steering message preserves multiple reply targets and ignores blank notes", async (t) => {
    const f = await fixture(t);
    const notes = Array.from({ length: 7 }, (_, i) => human(`user:${i}`));
    f.notes = [...notes, human("user:blank", "  ")];
    await f.watcher.poll();
    assert.equal(f.sent.length, 7);
    for (let i = 0; i < notes.length; i++) {
        const payload = JSON.parse(f.sent[i].slice(f.sent[i].indexOf("\n[") + 1));
        assert.equal(payload.length, 1);
        assert.equal(payload[0].noteId, notes[i].noteId);
        await reply(f, notes[i]);
    }
    f.watcher.settled();
    await f.watcher.poll();
    assert.equal(f.sent.length, 7);
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
