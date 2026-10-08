import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StateStore } from "./state.ts";
import type { NoteState } from "./watcher.ts";

const state: NoteState = { repo: "/repo", sessionId: "s", noteId: "user:1", version: "v", phase: "submitted" };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
    const dir = await mkdtemp(join(tmpdir(), "pi-hunk-state-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return { dir, store: new StateStore(dir, state.repo) };
}

test("state lives outside the Pi conversation, in a private per-repo journal", async (t) => {
    const { dir, store } = await fixture(t);
    assert.deepEqual(store.load(), []);
    store.save(state);
    store.save({ ...state, phase: "handled", summary: "Answer" });
    assert.deepEqual(new StateStore(dir, "/repo").load(), [state, { ...state, phase: "handled", summary: "Answer" }]);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "pi-hunk"))).mode & 0o777, 0o700);
    assert.notEqual(new StateStore(dir, "/other-worktree").path, store.path);
});

test("corrupt state is reported instead of silently replaying completed work", async (t) => {
    const { store } = await fixture(t);
    await writeFile(store.path, "{broken\n");
    assert.throws(() => store.load());
    await writeFile(store.path, `${JSON.stringify({ ...state, phase: "unknown" })}\n`);
    assert.throws(() => store.load(), /Invalid pi-hunk state/);
    await writeFile(store.path, `${JSON.stringify({ ...state, repo: "/wrong" })}\n`);
    assert.throws(() => store.load(), /Invalid pi-hunk state/);
    assert.throws(() => store.save({ ...state, repo: "/wrong" }), /another repository/);
});
