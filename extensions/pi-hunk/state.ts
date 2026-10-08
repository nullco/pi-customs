import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isNoteState } from "./watcher.ts";
import type { NoteState } from "./watcher.ts";

/** Private local journal: no Hunk messages or metadata are appended to the Pi chat. */
export class StateStore {
    readonly path: string;
    private readonly repo: string;

    constructor(agentDir: string, repo: string) {
        this.repo = repo;
        const directory = join(agentDir, "pi-hunk");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.path = join(directory, `${createHash("sha256").update(repo).digest("hex")}.jsonl`);
    }

    load(): NoteState[] {
        let text: string;
        try {
            text = readFileSync(this.path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
        return text.split("\n").filter((line) => line.trim()).map((line) => {
            const state: unknown = JSON.parse(line);
            if (!isNoteState(state) || state.repo !== this.repo) throw new Error(`Invalid pi-hunk state in ${this.path}`);
            return state;
        });
    }

    save(state: NoteState): void {
        if (state.repo !== this.repo) throw new Error("Cannot save Hunk state for another repository");
        appendFileSync(this.path, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    }
}
