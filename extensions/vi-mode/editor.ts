/**
 * ViEditor class — vim-like modal editing via CustomEditor.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { Mode, PendingOp, LastFind } from "./types";
import { ESC } from "./types";
import { isWhitespace, isWordChar, firstNonBlank } from "./text-utils";
import {
    prevWordStart,
    nextWordStart,
    nextWordEnd,
    nextWORDStart,
    prevWORDStart,
    nextWORDEnd,
    prevParagraphStart,
    nextParagraphStart,
    findCharOnLine,
    findMatchingBracket,
} from "./motions";

export class ViEditor extends CustomEditor {
    private viTheme: any;

    constructor(tui: any, theme: any, kb: any) {
        super(tui, theme, kb);
        this.viTheme = theme;
    }

    private mode: Mode = "insert";
    private pendingOp: PendingOp | null = null;
    /** For two-key sequences (gg, yy) and operators awaiting motion. */
    private pendingKey: string | null = null;
    /** Text object prefix (a/i) for daw, ciw, etc. */
    private textObjectPrefix: string | null = null;
    /** Clipboard for yank/delete */
    private clipboard: string = "";
    /** True if the clipboard came from a linewise operation */
    private clipboardLinewise: boolean = false;
    /** Buffer for command-line mode (`:`) */
    private commandBuffer: string = "";
    /** Accumulated count prefix (e.g. "3", then "2" for 32) */
    private countBuf: string = "";
    /** Last find/till for ; and , repeat */
    private lastFind: LastFind | null = null;

    handleInput(data: string): void {
        // ── Command mode: delegate ──────────────────────────────
        if (this.mode === "command") {
            this.handleCommandInput(data);
            return;
        }

        // ── Escape ──────────────────────────────────────────────
        if (matchesKey(data, "escape")) {
            if (this.mode === "insert") {
                this.mode = "normal";
                this.pendingOp = null;
                this.pendingKey = null;
                this.textObjectPrefix = null;
                this.countBuf = "";
                // move cursor left one (vim convention: escape moves back one in insert mode)
                super.handleInput(ESC.LEFT);
            } else {
                // In normal mode, clear pending state and abort
                this.pendingOp = null;
                this.pendingKey = null;
                this.textObjectPrefix = null;
                this.countBuf = "";
                super.handleInput(data); // app-level escape (abort agent, etc.)
            }
            return;
        }

        // ── Ctrl+C ──────────────────────────────────────────────
        if (matchesKey(data, "ctrl+c")) {
            this.pendingOp = null;
            this.pendingKey = null;
            super.handleInput(data);
            return;
        }

        // ── Ctrl+R (redo) ───────────────────────────────────────
        if (matchesKey(data, "ctrl+r")) {
            if (this.mode === "normal") {
                this.pendingOp = null;
                this.pendingKey = null;
                // Ctrl+R cancels the undo and effectively re-applies
                // We send undo twice as a simple redo approximation
                super.handleInput(ESC.UNDO);
                super.handleInput(ESC.UNDO);
                return;
            }
        }

        // ── Insert mode ──────────────────────────────────────────
        if (this.mode === "insert") {
            // Vi-style autocomplete: Ctrl+n/p cycle, Ctrl+y accept
            if (this.isShowingAutocomplete()) {
                if (matchesKey(data, "ctrl+n")) {
                    super.handleInput("\x1b[B"); // down arrow
                    return;
                }
                if (matchesKey(data, "ctrl+p")) {
                    super.handleInput("\x1b[A"); // up arrow
                    return;
                }
                if (matchesKey(data, "ctrl+y")) {
                    super.handleInput("\x0d"); // enter (confirm selection)
                    return;
                }
            }
            super.handleInput(data);
            return;
        }

        // ═══════════════════════════════════════════════════════════
        // NORMAL MODE
        // ═══════════════════════════════════════════════════════════

        // ── Count prefix accumulation ────────────────────────────
        if (/^[1-9][0-9]*$/.test(data)) {
            if (this.countBuf === "" && data === "0") {
                // "0" alone is a motion, not a count
                this.consumeCountPrefix();
                this.normalCommand("0");
                return;
            }
            this.countBuf += data;
            return;
        }

        // ── Resolve pending two-key sequences ────────────────────
        if (this.pendingKey !== null) {
            const prev = this.pendingKey;
            this.pendingKey = null;
            const count = this.consumeCountPrefix();

            // r{char} — replace character
            if (prev === "r") {
                this.doWithCount(count, () => {
                    if (data.length === 1 && data.charCodeAt(0) >= 32) {
                        super.handleInput(ESC.DEL);
                        this.mode = "insert";
                        super.handleInput(data);
                        this.mode = "normal";
                        super.handleInput(ESC.LEFT);
                    }
                });
                return;
            }

            // f / F / t / T — find/till char
            if (prev === "f" || prev === "F" || prev === "t" || prev === "T") {
                this.doWithCount(count, () => {
                    const lines = this.getLines();
                    const cur = this.getCursor();
                    const forward = prev === "f" || prev === "t";
                    const till = prev === "t" || prev === "T";
                    const col = findCharOnLine(lines[cur.line] ?? "", cur.col, data, forward, till);
                    if (col >= 0) {
                        this.lastFind = { char: data, forward, till };
                        this.setCursorPosition(cur.line, col);
                    }
                });
                return;
            }

            // gg: go to first line
            if (prev === "g" && data === "g") { this.moveToStart(); return; }
            // yy / Y: yank line
            if (prev === "y" && (data === "y" || data === "Y")) { this.yankLine(); return; }
            // y + other key → yank operator + motion
            if (prev === "y") {
                this.pendingOp = { op: "yank" };
                this.doWithCount(count, () => this.handleOperatorMotion({ op: "yank" }, data));
                return;
            }
            // Unknown two-key sequence — ignore
            return;
        }

        // ── Pending operator (d, c) ──────────────────────────────
        if (this.pendingOp !== null) {
            // Handle text object prefix: d a w, c i w, y a W, etc.
            if (data === "a" || data === "i") {
                this.textObjectPrefix = data;
                return;
            }
            const op = this.pendingOp;
            this.pendingOp = null;
            const prefix = this.textObjectPrefix;
            this.textObjectPrefix = null;
            const count = this.consumeCountPrefix();
            if (prefix) {
                this.doWithCount(count, () => this.handleTextObject(op, prefix, data));
            } else {
                this.doWithCount(count, () => this.handleOperatorMotion(op, data));
            }
            return;
        }

        // ── Clear count on Escape ────────────────────────────────
        if (this.countBuf !== "") {
            // Non-digit, non-command after count: interpret as motion
            const count = this.consumeCountPrefix();
            this.doWithCount(count, () => this.normalCommand(data));
            return;
        }

        // ── Delegate to normal command handler ───────────────────
        this.normalCommand(data);
    }

    // ── Normal mode command dispatch ─────────────────────────────────────

    /** Handle a single normal-mode command (motion, operator, etc.). */
    private normalCommand(data: string): void {
        // ── Operators (start pending) ────────────────────────────
        switch (data) {
            case "d": this.pendingOp = { op: "delete" }; this.pendingKey = null; return;
            case "c": this.pendingOp = { op: "change" }; this.pendingKey = null; return;
            case "y": this.pendingKey = "y"; return;
            case "g": this.pendingKey = "g"; return;
        }

        // ── f / F / t / T — find/till (await char) ──────────────
        if (data === "f" || data === "F" || data === "t" || data === "T") {
            this.pendingKey = data;
            return;
        }

        // ── Navigation (hjkl w b e W B E) ────────────────────────
        switch (data) {
            case "h": super.handleInput(ESC.LEFT); return;
            case "j": super.handleInput(ESC.DOWN); return;
            case "k": super.handleInput(ESC.UP); return;
            case "l": super.handleInput(ESC.RIGHT); return;
            case "w": { const c = nextWordStart(this.getLines(), this.getCursor().line, this.getCursor().col); this.setCursorPosition(c.line, c.col); return; }
            case "b": { const c = prevWordStart(this.getLines(), this.getCursor().line, this.getCursor().col); this.setCursorPosition(c.line, c.col); return; }
            case "e": { const c = nextWordEnd(this.getLines(), this.getCursor().line, this.getCursor().col); this.setCursorPosition(c.line, c.col); return; }
            case "W": { const c = nextWORDStart(this.getLines(), this.getCursor().line, this.getCursor().col); this.setCursorPosition(c.line, c.col); return; }
            case "B": { const c = prevWORDStart(this.getLines(), this.getCursor().line, this.getCursor().col); this.setCursorPosition(c.line, c.col); return; }
            case "E": { const c = nextWORDEnd(this.getLines(), this.getCursor().line, this.getCursor().col); this.setCursorPosition(c.line, c.col); return; }
        }

        // ── Line navigation ──────────────────────────────────────
        switch (data) {
            case "0": super.handleInput(ESC.HOME); return;
            case "$": super.handleInput(ESC.END); return;
            case "^": { const lines = this.getLines(); const cur = this.getCursor(); this.setCursorPosition(cur.line, firstNonBlank(lines, cur.line)); return; }
            case "G": this.moveToEnd(); return;
        }

        // ── Paragraph ({ / }) ────────────────────────────────────
        if (data === "{" || data === "}") {
            const lines = this.getLines();
            const cur = this.getCursor();
            const target = data === "{" ? prevParagraphStart(lines, cur.line) : nextParagraphStart(lines, cur.line);
            if (target !== cur.line) {
                this.setCursorPosition(target, firstNonBlank(lines, target));
            }
            return;
        }

        // ── % matching bracket ───────────────────────────────────
        if (data === "%") {
            const lines = this.getLines();
            const cur = this.getCursor();
            const match = findMatchingBracket(lines, cur.line, cur.col);
            if (match) this.setCursorPosition(match.line, match.col);
            return;
        }

        // ── Page scrolling ───────────────────────────────────────
        if (matchesKey(data, "ctrl+d")) { super.handleInput(ESC.PAGE_DOWN); super.handleInput(ESC.PAGE_DOWN); return; }
        if (matchesKey(data, "ctrl+u")) { super.handleInput(ESC.PAGE_UP); super.handleInput(ESC.PAGE_UP); return; }

        // ── Single-char operations ───────────────────────────────
        switch (data) {
            case "x": this.clipboard = this.getCharAtCursor(); this.clipboardLinewise = false; super.handleInput(ESC.DEL); return;
            case "X": this.clipboard = this.getCharBeforeCursor(); this.clipboardLinewise = false; super.handleInput(ESC.BS); return;
            case "~": { const ch = this.getCharAtCursor(); if (ch) { const toggled = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(); super.handleInput(ESC.DEL); this.mode = "insert"; super.handleInput(toggled); this.mode = "normal"; } return; }
            case "r": this.pendingKey = "r"; return;
            case "s": super.handleInput(ESC.DEL); this.mode = "insert"; return;
        }

        // ── Linewise operations ──────────────────────────────────
        switch (data) {
            case "D": { const lines = this.getLines(); const cur = this.getCursor(); this.clipboard = (lines[cur.line] ?? "").slice(cur.col); this.clipboardLinewise = false; super.handleInput(ESC.DEL_LINE_END); return; }
            case "C": super.handleInput(ESC.DEL_LINE_END); this.mode = "insert"; return;
            case "Y": this.yankLine(); return;
            case "S": super.handleInput(ESC.HOME); super.handleInput(ESC.DEL_LINE_START); super.handleInput(ESC.DEL_LINE_END); this.mode = "insert"; return;
        }

        // ── Paste ────────────────────────────────────────────────
        if (data === "p") { this.paste(false); return; }
        if (data === "P") { this.paste(true); return; }

        // ── Undo / Redo ──────────────────────────────────────────
        if (data === "u") { super.handleInput(ESC.UNDO); return; }

        // ── Repeat last find (; / ,) ─────────────────────────────
        if (data === ";" || data === ",") { this.repeatFind(data === ","); return; }

        // ── Enter command mode ───────────────────────────────────
        if (data === ":") {
            this.mode = "command";
            this.commandBuffer = "";
            this.pendingOp = null;
            this.pendingKey = null;
            this.countBuf = "";
            super.setText("/");
            return;
        }

        // ── Mode switches ────────────────────────────────────────
        switch (data) {
            case "i": this.mode = "insert"; return;
            case "a": this.mode = "insert"; super.handleInput(ESC.RIGHT); return;
            case "I": { const lines = this.getLines(); const cur = this.getCursor(); this.setCursorPosition(cur.line, firstNonBlank(lines, cur.line)); this.mode = "insert"; return; }
            case "A": super.handleInput(ESC.END); this.mode = "insert"; return;
            case "o": super.handleInput(ESC.END); super.handleInput(ESC.ENTER); this.mode = "insert"; return;
            case "O": super.handleInput(ESC.HOME); super.handleInput(ESC.ENTER); super.handleInput(ESC.UP); this.mode = "insert"; return;
        }

        // ── Ignore other printable characters in normal mode ─────
        if (data.length === 1 && data.charCodeAt(0) >= 32) return;

        // Pass through control sequences and anything else
        super.handleInput(data);
    }

    // ── Command mode handling ────────────────────────────────────────────

    private handleCommandInput(data: string): void {
        if (matchesKey(data, "escape")) {
            this.mode = "normal";
            this.commandBuffer = "";
            super.setText("");
            return;
        }
        if (matchesKey(data, "enter")) {
            // Submit — editor already has "/command", just send it
            this.mode = "normal";
            this.commandBuffer = "";
            super.handleInput("\x0d");
            return;
        }
        // Vi-style autocomplete cycling in command mode
        if (this.isShowingAutocomplete()) {
            if (matchesKey(data, "ctrl+n")) {
                super.handleInput("\x1b[B"); // down arrow
                return;
            }
            if (matchesKey(data, "ctrl+p")) {
                super.handleInput("\x1b[A"); // up arrow
                return;
            }
            if (matchesKey(data, "ctrl+y")) {
                super.handleInput("\x0d"); // enter (confirm)
                return;
            }
        }
        // All other keys: route through editor (autocomplete, Tab, arrows)
        super.handleInput(data);
        // Track buffer from editor text for the top border label
        const text = super.getText();
        if (text.startsWith("/")) {
            this.commandBuffer = text.slice(1);
        }
    }

    // ── Operator + motion handling ───────────────────────────────────────

    private handleOperatorMotion(op: PendingOp, motion: string): void {
        const cursorBefore = this.getCursor();

        // ── Handle linewise double-tap: dd / cc / yy ────────────
        if (motion === "d") {
            if (op.op === "delete") {
                this.yankLine();
                super.handleInput(ESC.HOME);
                super.handleInput(ESC.DEL_LINE_START);
                super.handleInput(ESC.DEL_LINE_END);
                super.handleInput(ESC.DEL);
            } else if (op.op === "change") {
                super.handleInput(ESC.HOME);
                super.handleInput(ESC.DEL_LINE_START);
                super.handleInput(ESC.DEL_LINE_END);
                this.mode = "insert";
            } else if (op.op === "yank") {
                this.yankLine();
            }
            return;
        }

        // ── Apply motion first ───────────────────────────────────
        if (motion === "w") this.setCursorToWordForward();
        else if (motion === "b") this.setCursorToWordBackward();
        else if (motion === "e") this.setCursorToWordEnd();
        else if (motion === "W") this.setCursorToWORDFwd();
        else if (motion === "B") this.setCursorToWORDBack();
        else if (motion === "E") this.setCursorToWORDEnd();
        else if (motion === "0" || motion === "^") {
            this.handleLineStartMotion(op, motion, cursorBefore);
            return;
        }
        else if (motion === "$") {
            this.handleLineEndMotion(op, cursorBefore);
            return;
        }
        else if (motion === "G") {
            this.moveToEnd();
        }
        else if (motion === "g") {
            return; // gg caught earlier
        }
        else {
            return; // Unknown motion
        }

        // For motions that moved the cursor (w, b, e, W, B, E, G):
        const cursorAfter = this.getCursor();
        const isForward = this.isCursorAfter(cursorBefore, cursorAfter);

        if (op.op === "delete" || op.op === "yank") {
            this.clipboardLinewise = false;
            this.clipboard = this.getTextRange(cursorBefore, cursorAfter, isForward);
        }

        if (op.op === "delete" || op.op === "change") {
            if (isForward) {
                this.deleteRange(cursorBefore, cursorAfter.line, cursorAfter.col);
            } else {
                this.deleteRange(cursorAfter, cursorBefore.line, cursorBefore.col);
                this.setCursorPosition(cursorAfter.line, cursorAfter.col);
            }
        }
        if (op.op === "change") this.mode = "insert";
    }

    private handleLineStartMotion(op: PendingOp, motion: string, cursorBefore: { line: number; col: number }): void {
        const lines = this.getLines();
        const cursor = this.getCursor();
        const endCol = motion === "^" ? firstNonBlank(lines, cursor.line) : 0;
        const lineText = lines[cursor.line] ?? "";
        if (op.op === "delete" || op.op === "yank") {
            this.clipboard = lineText.slice(endCol, cursor.col);
            this.clipboardLinewise = false;
        }
        this.setCursorPosition(cursor.line, endCol);
        if (op.op === "delete" || op.op === "change") {
            this.deleteRange(cursorBefore, cursor.line, endCol);
        }
        if (op.op === "change") this.mode = "insert";
    }

    private handleLineEndMotion(op: PendingOp, cursorBefore: { line: number; col: number }): void {
        const cursor = this.getCursor();
        const lines = this.getLines();
        const lineText = lines[cursor.line] ?? "";
        const range = lineText.slice(cursor.col, lineText.length + 1);
        if (op.op === "delete" || op.op === "yank") {
            this.clipboard = range;
            this.clipboardLinewise = false;
        }
        if (op.op !== "yank") {
            super.handleInput(ESC.DEL_LINE_END);
        }
        if (op.op === "change") this.mode = "insert";
    }

    // ── Text objects ─────────────────────────────────────────────────────

    /** Handle d[a/i]w, c[a/i]w, y[a/i]w, d[a/i]W, etc. */
    private handleTextObject(op: PendingOp, prefix: string, obj: string): void {
        const inner = prefix === "i";
        if (obj === "w" || obj === "W") {
            const isWORD = obj === "W";
            const lines = this.getLines();
            const cur = this.getCursor();
            const curLine = lines[cur.line] ?? "";

            // Find boundaries of the current word/WORD
            let start = cur.col;
            let end = cur.col;

            if (isWORD) {
                // WORD: delimited by whitespace only
                while (start > 0 && !isWhitespace(curLine[start - 1]!)) start--;
                while (end < curLine.length && !isWhitespace(curLine[end]!)) end++;
            } else {
                // word: delimited by word-char class changes + whitespace
                const cursorClass = cur.col < curLine.length && !isWhitespace(curLine[cur.col]!)
                    ? (isWordChar(curLine[cur.col]!) ? "word" : "punct")
                    : null;

                if (cursorClass) {
                    while (start > 0) {
                        const ch = curLine[start - 1]!;
                        if (isWhitespace(ch)) break;
                        const cls = isWordChar(ch) ? "word" : "punct";
                        if (cls !== cursorClass) break;
                        start--;
                    }
                    while (end < curLine.length) {
                        const ch = curLine[end]!;
                        if (isWhitespace(ch)) break;
                        const cls = isWordChar(ch) ? "word" : "punct";
                        if (cls !== cursorClass) break;
                        end++;
                    }
                } else {
                    // Cursor on whitespace
                    while (start > 0 && isWhitespace(curLine[start - 1]!)) start--;
                    while (end < curLine.length && isWhitespace(curLine[end]!)) end++;
                }
            }

            if (!inner) {
                // aw / aW: include trailing whitespace (or leading if at end)
                if (end < curLine.length && isWhitespace(curLine[end]!)) {
                    while (end < curLine.length && isWhitespace(curLine[end]!)) end++;
                } else if (start > 0 && isWhitespace(curLine[start - 1]!)) {
                    while (start > 0 && isWhitespace(curLine[start - 1]!)) start--;
                }
            }

            // Save to clipboard
            if (op.op === "delete" || op.op === "yank") {
                this.clipboard = curLine.slice(start, end);
                this.clipboardLinewise = false;
            }

            // Perform delete/change
            if (op.op === "delete" || op.op === "change") {
                this.setCursorPosition(cur.line, start);
                this.deleteRange(
                    { line: cur.line, col: start },
                    cur.line,
                    end,
                );
            }
            if (op.op === "change") this.mode = "insert";
        }
    }

    // ── Cursor movement via motions (apply and set) ──────────────────────

    private setCursorToWordForward(): void {
        const lines = this.getLines();
        const cursor = this.getCursor();
        const c = nextWordStart(lines, cursor.line, cursor.col);
        this.setCursorPosition(c.line, c.col);
    }

    private setCursorToWordBackward(): void {
        const lines = this.getLines();
        const cursor = this.getCursor();
        const c = prevWordStart(lines, cursor.line, cursor.col);
        this.setCursorPosition(c.line, c.col);
    }

    private setCursorToWordEnd(): void {
        const lines = this.getLines();
        const cursor = this.getCursor();
        const c = nextWordEnd(lines, cursor.line, cursor.col);
        this.setCursorPosition(c.line, c.col);
    }

    private setCursorToWORDFwd(): void {
        const lines = this.getLines();
        const cursor = this.getCursor();
        const c = nextWORDStart(lines, cursor.line, cursor.col);
        this.setCursorPosition(c.line, c.col);
    }

    private setCursorToWORDBack(): void {
        const lines = this.getLines();
        const cursor = this.getCursor();
        const c = prevWORDStart(lines, cursor.line, cursor.col);
        this.setCursorPosition(c.line, c.col);
    }

    private setCursorToWORDEnd(): void {
        const lines = this.getLines();
        const cursor = this.getCursor();
        const c = nextWORDEnd(lines, cursor.line, cursor.col);
        this.setCursorPosition(c.line, c.col);
    }

    // ── Find repeat ──────────────────────────────────────────────────────

    private repeatFind(reverse: boolean): void {
        if (!this.lastFind) return;
        const { char, forward, till } = this.lastFind;
        const lines = this.getLines();
        const cur = this.getCursor();
        const dir = reverse ? !forward : forward;
        const col = findCharOnLine(lines[cur.line] ?? "", cur.col, char, dir, till);
        if (col >= 0) this.setCursorPosition(cur.line, col);
    }

    // ── Count helpers ────────────────────────────────────────────────────

    private consumeCountPrefix(): number {
        const n = this.countBuf ? parseInt(this.countBuf, 10) : 1;
        this.countBuf = "";
        return n;
    }

    private doWithCount(count: number, fn: () => void): void {
        for (let i = 0; i < count; i++) fn();
    }

    // ── Document navigation ──────────────────────────────────────────────

    private moveToStart(): void {
        const lines = this.getLines();
        let c = 0;
        while (c < lines.length && c < 50) {
            super.handleInput(ESC.UP);
            c++;
        }
        super.handleInput(ESC.HOME);
    }

    private moveToEnd(): void {
        const lines = this.getLines();
        let c = 0;
        while (c < lines.length && c < 50) {
            super.handleInput(ESC.DOWN);
            c++;
        }
        super.handleInput(ESC.END);
    }

    // ── Cursor helpers ───────────────────────────────────────────────────

    private setCursorPosition(line: number, col: number): void {
        const cursor = this.getCursor();
        const lines = this.getLines();
        const safeLine = Math.max(0, Math.min(line, lines.length - 1));
        const safeCol = Math.max(0, Math.min(col, (lines[safeLine] ?? "").length));

        // Move vertically
        const rowDiff = safeLine - cursor.line;
        if (rowDiff > 0) {
            for (let i = 0; i < rowDiff; i++) super.handleInput(ESC.DOWN);
        } else if (rowDiff < 0) {
            for (let i = 0; i < -rowDiff; i++) super.handleInput(ESC.UP);
        }
        // Reset to home and then move right
        super.handleInput(ESC.HOME);
        for (let i = 0; i < safeCol; i++) super.handleInput(ESC.RIGHT);
    }

    private isCursorAfter(a: { line: number; col: number }, b: { line: number; col: number }): boolean {
        if (b.line > a.line) return true;
        if (b.line < a.line) return false;
        return b.col >= a.col;
    }

    private getTextRange(
        start: { line: number; col: number },
        end: { line: number; col: number },
        forward: boolean,
    ): string {
        const lines = this.getLines();
        if (!forward) {
            [start, end] = [end, start];
        }

        if (start.line === end.line) {
            return (lines[start.line] ?? "").slice(start.col, end.col);
        }

        const parts: string[] = [];
        parts.push((lines[start.line] ?? "").slice(start.col));
        for (let l = start.line + 1; l < end.line; l++) {
            parts.push("\n" + (lines[l] ?? ""));
        }
        if (end.line > start.line) {
            parts.push("\n" + (lines[end.line] ?? "").slice(0, end.col));
        }
        return parts.join("");
    }

    private deleteRange(start: { line: number; col: number }, targetLine: number, targetCol: number): void {
        const cursor = this.getCursor();

        if (cursor.line === targetLine) {
            // Single line: delete from cursor to target
            if (targetCol <= cursor.col) {
                for (let i = 0; i < cursor.col - targetCol; i++) {
                    super.handleInput(ESC.BS);
                }
            } else {
                for (let i = 0; i < targetCol - cursor.col; i++) {
                    super.handleInput(ESC.DEL);
                }
            }
            return;
        }

        // Multi-line: delete to end of current line, then delete lines, then delete from start of target
        if (targetLine > cursor.line) {
            super.handleInput(ESC.DEL_LINE_END);
            for (let i = 0; i < targetLine - cursor.line; i++) {
                super.handleInput(ESC.DEL); // delete newline + empty line
            }
            super.handleInput(ESC.HOME);
            for (let i = 0; i < targetCol; i++) {
                super.handleInput(ESC.DEL);
            }
        } else {
            // targetLine < cursor.line
            super.handleInput(ESC.HOME);
            for (let i = 0; i < cursor.col; i++) {
                super.handleInput(ESC.BS);
            }
            for (let i = 0; i < cursor.line - targetLine; i++) {
                super.handleInput(ESC.UP);
                super.handleInput(ESC.DEL_LINE_END);
                super.handleInput(ESC.DEL); // join with next
            }
            super.handleInput(ESC.HOME);
            for (let i = 0; i < targetCol; i++) {
                super.handleInput(ESC.RIGHT);
            }
        }
    }

    // ── Character at cursor ──────────────────────────────────────────────

    private getCharAtCursor(): string {
        const lines = this.getLines();
        const cursor = this.getCursor();
        const curLine = lines[cursor.line] ?? "";
        return curLine[cursor.col] ?? "";
    }

    private getCharBeforeCursor(): string {
        const lines = this.getLines();
        const cursor = this.getCursor();
        const curLine = lines[cursor.line] ?? "";
        return curLine[cursor.col - 1] ?? "";
    }

    // ── Yank / Paste ─────────────────────────────────────────────────────

    private yankLine(): void {
        const lines = this.getLines();
        const cursor = this.getCursor();
        this.clipboard = (lines[cursor.line] ?? "") + "\n";
        this.clipboardLinewise = true;
    }

    private paste(before: boolean): void {
        if (!this.clipboard) return;
        const oldMode = this.mode;
        this.mode = "insert";

        if (this.clipboardLinewise && before) {
            super.handleInput(ESC.HOME);
        } else if (!before && !this.clipboardLinewise) {
            super.handleInput(ESC.RIGHT);
        }

        // Insert the clipboard text character by character
        for (let i = 0; i < this.clipboard.length; i++) {
            super.handleInput(this.clipboard[i]!);
        }

        this.mode = oldMode;
    }

    // ── Rendering ────────────────────────────────────────────────────────

    render(width: number): string[] {
        const lines = super.render(width);
        if (lines.length === 0) return lines;

        // Add mode indicator to top border
        let rawLabel: string;
        if (this.mode === "command") {
            rawLabel = " COMMAND ";
        } else if (this.mode === "insert") {
            rawLabel = " INSERT ";
        } else if (this.pendingOp) {
            rawLabel = this.pendingOp.op === "delete" ? " d " : " c ";
        } else {
            rawLabel = " NORMAL ";
        }

        const label = this.viTheme.borderColor(rawLabel);

        // Insert label into the top border line and truncate if needed
        if (lines[0] !== undefined && visibleWidth(lines[0]) >= visibleWidth(label)) {
            lines[0] = truncateToWidth(label + lines[0]!, width, "");
        }

        // In command mode, swap "/" → ":" in rendered editor lines for vi-style display
        if (this.mode === "command") {
            for (let i = 0; i < lines.length; i++) {
                lines[i] = lines[i]!.replace(/^((?:\x1b\[[0-9;]*m)*)\//, "$1:");
            }
        }

        return lines;
    }
}
