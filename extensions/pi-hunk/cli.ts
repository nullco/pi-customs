export const REPLY_MARKER = "# pi-hunk-reply:";
export const SENT_NOTICE = "Reply sent to Hunk.";
export const REQUEST_TYPE = "pi-hunk-request";

export interface ReplyCommand {
    requestId?: string;
    sessionId: string;
    noteId: string;
    summary: string;
}

export function shellQuote(text: string): string {
    return `'${text.replaceAll("'", "'\\''")}'`;
}

export function replyCommand(requestId: string, sessionId: string, noteId: string, summary = "REPLY"): string {
    return `${REPLY_MARKER}${requestId}\nhunk session comment add ${shellQuote(sessionId)} --reply-to ${shellQuote(noteId)} --summary ${shellQuote(summary)} --author pi-hunk --json`;
}

export function isReplyCommand(command: unknown): command is string {
    return typeof command === "string" && (command.trimStart().startsWith(REPLY_MARKER) ||
        (/^hunk\s+session\s+comment\s+add\s/.test(command.trimStart()) &&
            /--author\s+(?:pi-hunk|'pi-hunk'|"pi-hunk")(?=\s|$)/.test(command)));
}

/** A deliberately small literal-word grammar, not a general shell parser. */
function literalWords(command: string): string[] {
    const words: string[] = [];
    let word = "", started = false, quote = "";
    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (quote === "'") {
            if (char === "'") quote = "";
            else word += char;
        } else if (quote === '"') {
            if (char === '"') quote = "";
            else if (char === "$" || char === "`") throw new Error("Shell expansions are not allowed in a Hunk reply");
            else if (char === "\\") {
                const next = command[++i];
                if (next === undefined || next === "\n" || next === "\r") throw new Error("Incomplete shell escape");
                word += ['"', "\\", "$", "`"].includes(next) ? next : `\\${next}`;
            } else word += char;
        } else if (/[ \t\n]/.test(char)) {
            if (started) { words.push(word); word = ""; started = false; }
        } else {
            started = true;
            if (char === "'" || char === '"') quote = char;
            else if (char === "\\") {
                const next = command[++i];
                if (next === undefined || next === "\n" || next === "\r") throw new Error("Incomplete shell escape");
                word += next;
            } else if (/[|&;<>()$`#*?\[\]{}~]/.test(char)) throw new Error("Use one literal Hunk reply command, without shell operators");
            else word += char;
        }
    }
    if (quote) throw new Error("Incomplete shell quote");
    if (started) words.push(word);
    return words;
}

export class ReplyCommandError extends Error {}

export function parseReplyCommand(command: string): ReplyCommand {
    try { return parseCommand(command); }
    catch (error) { throw new ReplyCommandError(error instanceof Error ? error.message : "Invalid Hunk reply command"); }
}

function parseCommand(command: string): ReplyCommand {
    // Keep the shell -c argument below typical OS limits, including quote expansion.
    if (command.includes("\0")) throw new Error("NUL bytes are not allowed in a Hunk reply command");
    if (Buffer.byteLength(command, "utf8") > 96 * 1024) throw new Error("Prepare a shorter Hunk reply");
    const header = command.trimStart().match(/^# pi-hunk-reply:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\r?\n/);
    if (!header && command.trimStart().startsWith(REPLY_MARKER)) throw new Error("Use the supplied Hunk reply marker");
    // Models sometimes omit shell comments. The reserved author and matching active
    // session/note still associate a literal posting command with its request.
    const words = literalWords(command.trimStart().slice(header?.[0].length ?? 0));
    if (words.slice(0, 4).join(" ") !== "hunk session comment add" || !words[4]) throw new Error("Use the supplied Hunk reply command");
    const options = new Map<string, string>();
    for (let i = 5; i < words.length; i++) {
        const flag = words[i];
        if (options.has(flag)) throw new Error("Duplicate Hunk reply option");
        if (flag === "--json") options.set(flag, "true");
        else if (["--reply-to", "--summary", "--author"].includes(flag) && i + 1 < words.length) options.set(flag, words[++i]);
        else throw new Error("Use only the supplied Hunk reply options");
    }
    const summary = options.get("--summary");
    if (options.size !== 4 || !options.get("--reply-to") || options.get("--author") !== "pi-hunk" ||
        !options.has("--json") || !summary?.trim()) throw new Error("Use the supplied command with a nonempty literal reply");
    if (Buffer.byteLength(summary, "utf8") > 64 * 1024) throw new Error("Prepare a shorter Hunk reply");
    return { requestId: header?.[1], sessionId: words[4], noteId: options.get("--reply-to")!, summary };
}
