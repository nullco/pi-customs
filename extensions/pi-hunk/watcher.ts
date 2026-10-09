import { createHash } from "node:crypto";
import { matchingSessions } from "./hunk.ts";
import type { HunkClient, HunkNote } from "./hunk.ts";
import { HUNK_INSTRUCTIONS } from "./instructions.ts";

export const STATE_ENTRY = "pi-hunk-state";

export interface NoteState {
    repo: string;
    sessionId: string;
    noteId: string;
    version: string;
    phase: "submitted" | "handled" | "retry";
    // Persist the intended reply before posting, so a lost acknowledgement can be reconciled.
    summary?: string;
}

export interface Task {
    sessionId: string;
    note: HunkNote;
    version: string;
    thread: HunkNote[];
}

export interface WatcherPorts {
    send(prompt: string, task: Task): void;
    save(state: NoteState): void;
    notify(text: string, level: "info" | "warning"): void;
    received?(count: number): void;
}

function key(sessionId: string, noteId: string): string {
    return JSON.stringify([sessionId, noteId]);
}

export function noteVersion(note: HunkNote): string {
    return createHash("sha256").update(JSON.stringify([
        note.body, note.filePath, note.parentId ?? null,
        note.oldRange ?? null, note.newRange ?? null, note.hunkIndex ?? null,
    ])).digest("hex");
}

export function isNoteState(value: unknown): value is NoteState {
    if (!value || typeof value !== "object") return false;
    const state = value as NoteState;
    return [state.repo, state.sessionId, state.noteId, state.version].every((v) => typeof v === "string") &&
        ["submitted", "handled", "retry"].includes(state.phase) &&
        (state.summary === undefined || typeof state.summary === "string");
}

export function threadFor(note: HunkNote, notes: HunkNote[]): HunkNote[] {
    const byId = new Map(notes.map((item) => [item.noteId, item]));
    function root(item: HunkNote): string {
        const seen = new Set<string>();
        while (item.parentId && byId.has(item.parentId) && !seen.has(item.noteId)) {
            seen.add(item.noteId);
            item = byId.get(item.parentId)!;
        }
        return item.noteId;
    }
    const rootId = root(note);
    return notes.filter((item) => root(item) === rootId);
}

export function taskPrompt(repo: string, tasks: Task[]): string {
    const payload = tasks.map(({ sessionId, note, version, thread }) => ({
        sessionId, noteId: note.noteId, version,
        file: note.filePath, oldRange: note.oldRange, newRange: note.newRange,
        hunk: note.hunkIndex === undefined ? undefined : note.hunkIndex + 1,
        request: note.body,
        // Keep the request intact; bound historical context, not the user's new note.
        thread: thread.slice(-30).map((item) => ({
            noteId: item.noteId, parentId: item.parentId, source: item.source, body: item.body.slice(0, 6000),
        })),
        threadTruncated: thread.length > 30 || thread.some((item) => item.body.length > 6000),
    }));
    return `${HUNK_INSTRUCTIONS}\n\nHunk requests in ${repo}:\n${JSON.stringify(payload, null, 2)}`;
}

export class HunkWatcher {
    private readonly abort = new AbortController();
    private readonly states = new Map<string, NoteState>();
    private readonly active = new Map<string, Task>();
    private readonly received = new Map<string, string>();
    private notes: HunkNote[] = [];
    private sessionId?: string;
    private polling = false;
    private lastProblem?: string;

    readonly repo: string;
    private readonly client: HunkClient;
    private readonly ports: WatcherPorts;
    private readonly pinnedSession?: string;

    constructor(repo: string, client: HunkClient, ports: WatcherPorts, initial: NoteState[] = [], pinnedSession?: string) {
        this.repo = repo;
        this.client = client;
        this.ports = ports;
        this.pinnedSession = pinnedSession;
        for (const state of initial) {
            if (state.repo === repo) this.states.set(key(state.sessionId, state.noteId), state);
        }
    }

    get stopped(): boolean { return this.abort.signal.aborted; }

    get needsSelection(): boolean {
        return !this.pinnedSession && this.lastProblem === "multiple sessions; select with /hunk on <session-id>";
    }

    stop(): void {
        this.abort.abort();
        this.active.clear();
    }

    private live(): void { this.abort.signal.throwIfAborted(); }

    private save(state: NoteState): void {
        this.live();
        this.ports.save(state);
        this.states.set(key(state.sessionId, state.noteId), state);
    }

    private record(note: HunkNote, phase: NoteState["phase"], summary?: string): void {
        this.save({ repo: this.repo, sessionId: this.sessionId!, noteId: note.noteId, version: noteVersion(note), phase, summary });
    }

    private humans(): HunkNote[] {
        return this.notes.filter((note) => note.source === "user" && note.body.trim());
    }

    private state(note: HunkNote): NoteState | undefined {
        const state = this.states.get(key(this.sessionId!, note.noteId));
        return state?.version === noteVersion(note) ? state : undefined;
    }

    private pending(): HunkNote[] {
        return this.humans().filter((note) => !this.state(note) || this.state(note)?.phase === "retry");
    }

    status(): string {
        if (this.stopped) return "Hunk: off";
        if (this.lastProblem) return `Hunk: on · ${this.lastProblem}`;
        const queued = this.pending().length;
        const stalled = this.humans().filter((note) => this.state(note)?.phase === "submitted" &&
            !this.active.has(key(this.sessionId!, note.noteId))).length;
        return `Hunk: on · ${this.active.size ? `${this.active.size} active` : "watching"}${queued ? ` · ${queued} queued` : ""}${stalled ? ` · ${stalled} awaiting retry` : ""}`;
    }

    private problem(text: string): void {
        if (text !== this.lastProblem) this.ports.notify(text, "warning");
        this.lastProblem = text;
    }

    async poll(): Promise<void> {
        if (this.stopped || this.polling) return;
        this.polling = true;
        try {
            const matches = await matchingSessions(this.client, this.repo, this.abort.signal);
            this.live();
            const session = this.pinnedSession
                ? matches.find((item) => item.sessionId === this.pinnedSession)
                : matches.length === 1 ? matches[0] : undefined;
            if (!session) {
                this.sessionId = undefined;
                this.notes = [];
                this.problem(!this.pinnedSession && matches.length > 1
                    ? "multiple sessions; select with /hunk on <session-id>"
                    : "waiting for a Hunk session in this repo");
                return;
            }
            const notes = await this.client.notes(session.sessionId, this.abort.signal);
            this.live();
            this.sessionId = session.sessionId;
            this.notes = notes;
            this.lastProblem = undefined;

            for (const note of this.humans()) {
                const state = this.states.get(key(this.sessionId, note.noteId));
                const replies = notes.filter((item) => item.source === "agent" && item.parentId === note.noteId);
                // Reconcile a reply that reached Hunk but whose CLI acknowledgement was lost.
                if (state?.version === noteVersion(note) && state.phase === "submitted" && state.summary &&
                    replies.some((item) => item.body === state.summary)) {
                    this.record(note, "handled", state.summary);
                    this.active.delete(key(this.sessionId, note.noteId));
                } else if (!state || (state.version === noteVersion(note) && state.phase === "submitted" &&
                    !state.summary && !this.active.has(key(this.sessionId, note.noteId)))) {
                    const answer = replies.find((item) => {
                        const replyTime = Date.parse(item.createdAt ?? "");
                        const noteTime = Date.parse(note.updatedAt ?? note.createdAt ?? "");
                        return (!state || item.author === "pi-hunk") && Number.isFinite(replyTime) &&
                            Number.isFinite(noteTime) && replyTime >= noteTime;
                    });
                    // Existing answered history, including replies missed by the old
                    // marker-only guard. Never infer an in-flight or edited version.
                    if (answer) this.record(note, "handled", state ? answer.body : undefined);
                }
            }

            let newlyReceived = 0;
            for (const note of this.pending()) {
                const id = key(this.sessionId, note.noteId);
                const version = noteVersion(note);
                if (this.received.get(id) !== version) {
                    this.received.set(id, version);
                    newlyReceived++;
                }
            }
            if (newlyReceived) this.ports.received?.(newlyReceived);

            // Each comment steers the main run without waiting for idle or for an
            // earlier Hunk response. Keep separate targets for exact reply routing.
            for (const note of this.pending()) {
                this.live();
                const task = { sessionId: this.sessionId!, note, version: noteVersion(note), thread: threadFor(note, notes) };
                this.record(note, "submitted");
                this.active.set(key(task.sessionId, note.noteId), task);
                try {
                    this.ports.send(taskPrompt(this.repo, [task]), task);
                } catch (error) {
                    this.active.delete(key(task.sessionId, note.noteId));
                    throw error;
                }
            }
        } catch (error) {
            if (!this.stopped) this.problem(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.polling = false;
        }
    }

    settled(tasks: Task[] = [...this.active.values()]): void {
        if (this.stopped) return;
        const unfinished = tasks.filter((task) => {
            const state = this.states.get(key(task.sessionId, task.note.noteId));
            return state?.version === task.version && state.phase === "submitted" &&
                this.notes.some((note) => note.noteId === task.note.noteId && noteVersion(note) === task.version);
        });
        for (const task of tasks) {
            const id = key(task.sessionId, task.note.noteId);
            if (this.active.get(id)?.version === task.version) this.active.delete(id);
        }
        if (unfinished.length) this.ports.notify(`${unfinished.length} Hunk request(s) have no confirmed reply. Inspect the outcome, then use /hunk retry.`, "warning");
    }

    retry(): void {
        this.live();
        if (this.active.size) throw new Error("Wait for the current Hunk requests to finish before retrying");
        for (const note of this.humans()) {
            if (this.state(note)?.phase === "submitted") this.record(note, "retry");
        }
    }

    /** Recheck queued steering at delivery, as well as immediately before posting. */
    async validateTask(sessionId: string, noteId: string, version: string, signal?: AbortSignal): Promise<HunkNote[]> {
        this.live();
        const task = this.active.get(key(sessionId, noteId));
        if (!task || task.version !== version) throw new Error("This comment version is not an active pi-hunk request");
        const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
        const matches = await matchingSessions(this.client, this.repo, combined);
        if (!matches.some((item) => item.sessionId === sessionId)) throw new Error("The Hunk session closed or no longer belongs to this repo");
        const notes = await this.client.notes(sessionId, combined);
        this.live();
        const current = notes.find((note) => note.noteId === noteId && note.source === "user");
        if (!current || noteVersion(current) !== version) throw new Error("The Hunk comment changed or vanished; do not reply to its old version");
        combined.throwIfAborted();
        if (this.active.get(key(sessionId, noteId))?.version !== version) {
            throw new Error("This comment version is not an active pi-hunk request");
        }
        return notes;
    }

    /** Preflight only; the main agent's normal bash tool performs the actual CLI call. */
    async prepareReply(sessionId: string, noteId: string, version: string, summary: string, signal?: AbortSignal): Promise<boolean> {
        this.live();
        if (!summary.trim()) throw new Error("A nonempty reply summary is required");
        const prior = this.states.get(key(sessionId, noteId));
        if (prior?.version === version && prior.phase === "handled") return false;
        const notes = await this.validateTask(sessionId, noteId, version, signal);
        const state: NoteState = { repo: this.repo, sessionId, noteId, version, phase: "submitted", summary };
        this.save(state);
        if (notes.some((note) => note.source === "agent" && note.parentId === noteId && note.body === summary)) {
            this.save({ ...state, phase: "handled" });
            this.active.delete(key(sessionId, noteId));
            return false;
        }
        return true;
    }

    /** Verify delivery in Hunk, including a CLI error/abort after the reply reached it. */
    async confirmReply(sessionId: string, noteId: string, version: string, summary: string): Promise<boolean> {
        this.live();
        const state = this.states.get(key(sessionId, noteId));
        if (!state || (state.version === version && state.summary !== summary)) return false;
        if (state.version === version && state.phase === "handled") return true;
        const matches = await matchingSessions(this.client, this.repo, this.abort.signal);
        if (!matches.some((item) => item.sessionId === sessionId)) return false;
        const notes = await this.client.notes(sessionId, this.abort.signal);
        this.live();
        if (!notes.some((note) => note.source === "agent" && note.parentId === noteId && note.body === summary)) return false;
        const current = this.states.get(key(sessionId, noteId));
        // A newer version may have steered while the old CLI call was running.
        // Confirm actual delivery without replacing the newer version's tracking.
        if (current?.version === version && current.summary === summary) {
            this.save({ ...current, phase: "handled" });
            if (this.active.get(key(sessionId, noteId))?.version === version) this.active.delete(key(sessionId, noteId));
        }
        return true;
    }
}
