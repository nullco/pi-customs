/** Operators that await a motion. */
export type Mode = "normal" | "insert" | "command";

/** Operators that await a motion. */
export type PendingOp = { op: "delete" | "change" | "yank" };

/** Last find/till for ; and , repeat. */
export type LastFind = {
    char: string;
    forward: boolean;
    till: boolean; // true = t/T, false = f/F
};

// ── Esc sequences for editor operations ──────────────────────────────────────

export const ESC = {
    LEFT: "\x1b[D",
    RIGHT: "\x1b[C",
    UP: "\x1b[A",
    DOWN: "\x1b[B",
    HOME: "\x01", // ctrl+a -> line start
    END: "\x05", // ctrl+e -> line end
    DEL: "\x1b[3~", // delete forward
    BS: "\x7f", // backspace (ctrl+h)
    DEL_WORD_BACK: "\x17", // ctrl+w
    DEL_WORD_FWD: "\x1b[3:5~", // alt+d
    DEL_LINE_START: "\x15", // ctrl+u
    DEL_LINE_END: "\x0b", // ctrl+k
    ENTER: "\x0d",
    UNDO: "\x1b_", // ctrl+_, maps to ctrl+-
    PAGE_UP: "\x1b[5~",
    PAGE_DOWN: "\x1b[6~",
} as const;

// ── Matching bracket ────────────────────────────────────────────────────────

export const BRACKET_PAIRS: Record<string, string> = {
    "(": ")", ")": "(",
    "[": "]", "]": "[",
    "{": "}", "}": "{",
};
