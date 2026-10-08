import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

export interface HunkSession {
    sessionId: string;
    repoRoot: string;
    title?: string;
}

export interface HunkNote {
    noteId: string;
    source: string;
    body: string;
    filePath: string;
    parentId?: string;
    oldRange?: [number, number];
    newRange?: [number, number];
    hunkIndex?: number;
    createdAt?: string;
    updatedAt?: string;
    author?: string;
}

export interface HunkClient {
    sessions(signal: AbortSignal): Promise<HunkSession[]>;
    notes(sessionId: string, signal: AbortSignal): Promise<HunkNote[]>;
}

const exec = promisify(execFile);

export async function canonicalPath(path: string): Promise<string> {
    return realpath(resolve(path));
}

export async function repoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, signal, timeout: 5000 });
    return canonicalPath(stdout.trim());
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

export function parseSessions(value: unknown): HunkSession[] {
    if (!object(value) || !Array.isArray(value.sessions)) throw new Error("Unexpected Hunk session-list response");
    return value.sessions.map((item) => {
        if (!object(item) || typeof item.sessionId !== "string") throw new Error("Invalid Hunk session");
        // Non-VCS windows may not have a repo root and cannot match this checkout.
        if (item.repoRoot === undefined || item.repoRoot === null) return { sessionId: item.sessionId, repoRoot: "" };
        if (typeof item.repoRoot !== "string") throw new Error("Invalid Hunk repository path");
        return { sessionId: item.sessionId, repoRoot: item.repoRoot, title: typeof item.title === "string" ? item.title : undefined };
    });
}

export function parseNotes(value: unknown): HunkNote[] {
    if (!object(value) || !Array.isArray(value.comments)) throw new Error("Unexpected Hunk comment-list response");
    return value.comments.map((item) => {
        if (!object(item) || typeof item.noteId !== "string" || typeof item.source !== "string" ||
            typeof item.body !== "string" || typeof item.filePath !== "string") {
            throw new Error("Invalid Hunk review note");
        }
        for (const field of ["oldRange", "newRange"] as const) {
            const range = item[field];
            if (range !== undefined && (!Array.isArray(range) || range.length !== 2 ||
                !range.every((n) => Number.isInteger(n) && n > 0))) throw new Error("Invalid Hunk line range");
        }
        for (const field of ["parentId", "createdAt", "updatedAt", "author"] as const) {
            if (item[field] !== undefined && typeof item[field] !== "string") throw new Error(`Invalid Hunk ${field}`);
        }
        return item as unknown as HunkNote;
    });
}

export function createHunkClient(cwd: string): HunkClient {
    async function command(args: string[], signal: AbortSignal): Promise<unknown> {
        let stdout: string;
        try {
            ({ stdout } = await exec("hunk", args, { cwd, signal, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }));
        } catch (error) {
            if (signal.aborted) throw error;
            const failure = error as { stderr?: string; stdout?: string; message?: string };
            throw new Error((failure.stderr?.trim() || failure.stdout?.trim() || failure.message || "Hunk command failed").slice(0, 2000));
        }
        try {
            return JSON.parse(stdout);
        } catch {
            throw new Error("Hunk did not return valid JSON; check your Hunk CLI version");
        }
    }
    return {
        sessions: async (signal) => parseSessions(await command(["session", "list", "--json"], signal)),
        notes: async (id, signal) => parseNotes(await command(["session", "comment", "list", id, "--type", "all", "--json"], signal)),
    };
}

export async function matchingSessions(client: HunkClient, repo: string, signal: AbortSignal): Promise<HunkSession[]> {
    const matches: HunkSession[] = [];
    for (const session of await client.sessions(signal)) {
        if (!session.repoRoot) continue;
        try {
            if (await canonicalPath(session.repoRoot) === repo) matches.push(session);
        } catch {
            // A session for a deleted or inaccessible checkout cannot match.
        }
    }
    signal.throwIfAborted();
    return matches;
}
