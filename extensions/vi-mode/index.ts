/**
 * Vi Mode Extension - Full vim-like modal editing
 *
 * Usage: drop in ~/.pi/agent/extensions/vi-mode/ and /reload
 *
 * Normal mode motions:
 *   hjkl          - basic movement
 *   w, b, e       - word forward, word back, end of word
 *   W, B, E       - WORD forward/back/end (whitespace-delimited)
 *   0, $, ^       - line start, line end, first non-blank
 *   gg, G         - start/end of document
 *   {, }          - paragraph (empty-line) back/forward
 *   %             - jump to matching bracket
 *   f{char}       - find char forward on line
 *   F{char}       - find char backward on line
 *   t{char}       - till char forward (stop before)
 *   T{char}       - till char backward (stop after)
 *   ; ,           - repeat last f/t/F/T (; = same dir, , = reverse)
 *   Ctrl+d, Ctrl+u - page down/up
 *
 * Count prefix (e.g. 3w, 5j, 12x):
 *   {count}{cmd}  - repeat command count times
 *
 * Normal mode operators:
 *   x             - delete char
 *   X             - delete char before cursor
 *   dd            - delete line
 *   dw, de, db    - delete word / end of word / back word
 *   dW, dE, dB    - delete WORD
 *   d$, d0, d^    - delete to end / start / first non-blank
 *   D             - delete to end of line
 *   cc            - change line (delete + insert)
 *   cw, ce, cb    - change word
 *   cW, cE, cB    - change WORD
 *   C             - change to end of line
 *   s             - substitute char (delete + insert)
 *   S             - substitute line (delete + insert)
 *   r{char}       - replace char under cursor
 *   ~             - toggle case of char under cursor
 *   yy, Y         - yank (copy) line
 *   yw, ye, yb    - yank word
 *   yW, yE, yB    - yank WORD
 *   y$, y0, y^    - yank to end / start / first non-blank
 *   daw, ciw, yaw - delete/change/yank a word (with surrounding space)
 *   diw, caw, yiw - delete/change/yank inner word (no surrounding space)
 *   daW, ciW      - same with WORDs (whitespace-delimited)
 *   p             - paste after cursor
 *   P             - paste before cursor
 *   u             - undo
 *   Ctrl+r        - redo
 *
 * Command mode (from normal mode):
 *   :             - enter command line (e.g. :model, :new, :settings)
 *   Enter         - submit command
 *   Escape        - cancel back to normal
 *
 * Insert mode autocomplete (like vi):
 *   Ctrl+n       - next autocomplete suggestion
 *   Ctrl+p       - previous autocomplete suggestion
 *   Ctrl+y        - accept selected suggestion
 *
 * Insert mode entry:
 *   i, a          - insert, append
 *   I, A          - insert at line start, append at line end
 *   o, O          - open below, open above
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

type Mode = "normal" | "insert" | "command";

/** Operators that await a motion. */
type PendingOp = { op: "delete" | "change" | "yank" };

/** Last find/till for ; and , repeat. */
type LastFind = {
	char: string;
	forward: boolean;
	till: boolean; // true = t/T, false = f/F
};

// ── Helpers: text operations ─────────────────────────────────────────────────

function isWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t";
}

function isWordChar(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return (
		(code >= 48 && code <= 57) || // 0-9
		(code >= 65 && code <= 90) || // A-Z
		(code >= 97 && code <= 122) || // a-z
		code === 95 // _
	);
}

/** Find word-start before cursor (for `b` motion). */
function prevWordStart(lines: string[], line: number, col: number): { line: number; col: number } {
	if (col === 0) {
		if (line === 0) return { line, col };
		return { line: line - 1, col: lines[line - 1]!.length };
	}

	const curLine = lines[line]!;
	let c = col - 1;
	// skip backwards over whitespace
	while (c > 0 && isWhitespace(curLine[c]!)) c--;
	if (c === 0 && isWhitespace(curLine[c]!)) {
		if (line === 0) return { line: 0, col: 0 };
		return { line: line - 1, col: 0 };
	}

	const targetClass = isWordChar(curLine[c]!) ? "word" : "punct";
	// skip backwards within same class
	while (c > 0) {
		const ch = curLine[c]!;
		const cls = isWordChar(ch) ? "word" : "punct";
		if (cls !== targetClass) break;
		c--;
	}
	// If we stopped because class changed, move forward one to land on start
	if (c > 0 || (c === 0 && curLine[c] !== undefined)) {
		const ch = curLine[c]!;
		const cls = isWordChar(ch) ? "word" : "punct";
		if (cls !== targetClass) c++;
	}

	// if the character at c is whitespace, we hit a whitespace gap
	if (c < curLine.length && isWhitespace(curLine[c]!)) {
		c++;
	}

	return { line, col: Math.min(c, curLine.length) };
}

/** Find word-start after cursor (for `w` motion). */
function nextWordStart(lines: string[], line: number, col: number): { line: number; col: number } {
	const curLine = lines[line]!;
	if (col >= curLine.length) {
		if (line >= lines.length - 1) return { line, col };
		return skipLeadingWhitespace(lines, line + 1);
	}

	const startClass = isWordChar(curLine[col]!) ? "word" : "punct";
	let c = col;

	if (!isWhitespace(curLine[col]!)) {
		// skip through current word
		const startClass = isWordChar(curLine[col]!) ? "word" : "punct";
		while (c < curLine.length) {
			const cls = isWordChar(curLine[c]!) ? "word" : "punct";
			if (cls !== startClass) break;
			c++;
		}
	}

	// skip whitespace
	while (c < curLine.length && isWhitespace(curLine[c]!)) c++;

	if (c >= curLine.length) {
		if (line >= lines.length - 1) return { line, col: curLine.length };
		return skipLeadingWhitespace(lines, line + 1);
	}

	return { line, col: c };
}

/** Find word-end from cursor (for `e` motion). */
function nextWordEnd(lines: string[], line: number, col: number): { line: number; col: number } {
	const curLine = lines[line]!;
	if (col >= curLine.length) {
		if (line >= lines.length - 1) return { line, col: curLine.length };
		return nextWordEnd(lines, line + 1, 0);
	}

	let c = col;
	const chAtCursor = curLine[c]!;

	// If cursor is on whitespace, skip to next non-whitespace.
	if (isWhitespace(chAtCursor)) {
		while (c < curLine.length && isWhitespace(curLine[c]!)) c++;
		if (c >= curLine.length) {
			if (line >= lines.length - 1) return { line, col: curLine.length };
			return nextWordEnd(lines, line + 1, 0);
		}
	} else {
		// Cursor is on a word char. In vim, `e` always moves to the end
		// of the *current* word first. But if the cursor is already at
		// the end of the current word, `e` moves to the end of the next.
		// Detect if we are at the last char of the current word.
		const cursorClass = isWordChar(chAtCursor) ? "word" : "punct";
		const nextChar = c + 1 < curLine.length ? curLine[c + 1] : null;
		const atWordEnd = nextChar === null
			|| isWhitespace(nextChar)
			|| (isWordChar(nextChar) ? "word" : "punct") !== cursorClass;

		if (atWordEnd) {
			// Skip rest of current word (just the current char), then whitespace,
			// then move to end of next word.
			c++;
			while (c < curLine.length && isWhitespace(curLine[c]!)) c++;
			if (c >= curLine.length) {
				if (line >= lines.length - 1) return { line, col: curLine.length };
				return nextWordEnd(lines, line + 1, 0);
			}
		} else {
			// Not at word end: move forward and snap to current word end.
			c++;
			while (c < curLine.length) {
				const cls = isWordChar(curLine[c]!) ? "word" : "punct";
				if (cls !== cursorClass) break;
				c++;
			}
			return { line, col: c - 1 };
		}
	}

	// c is now at the start of the next word — move to its end
	const targetClass = isWordChar(curLine[c]!) ? "word" : "punct";
	c++;
	while (c < curLine.length) {
		const cls = isWordChar(curLine[c]!) ? "word" : "punct";
		if (cls !== targetClass) break;
		c++;
	}
	return { line, col: c - 1 };
}

function skipLeadingWhitespace(lines: string[], line: number): { line: number; col: number } {
	const curLine = lines[line]!;
	let c = 0;
	while (c < curLine.length && isWhitespace(curLine[c]!)) c++;
	return { line, col: c };
}

function firstNonBlank(lines: string[], line: number): number {
	const curLine = lines[line]!;
	for (let c = 0; c < curLine.length; c++) {
		if (!isWhitespace(curLine[c]!)) return c;
	}
	return 0;
}

// ── WORD movement (whitespace-delimited) ────────────────────────────────────

/** Next WORD start after cursor. */
function nextWORDStart(lines: string[], line: number, col: number): { line: number; col: number } {
	const curLine = lines[line]!;
	// skip non-whitespace
	while (col < curLine.length && !isWhitespace(curLine[col]!)) col++;
	// skip whitespace
	while (col < curLine.length && isWhitespace(curLine[col]!)) col++;
	if (col >= curLine.length) {
		if (line >= lines.length - 1) return { line, col: curLine.length };
		return skipLeadingWhitespace(lines, line + 1);
	}
	return { line, col };
}

/** Previous WORD start before cursor. */
function prevWORDStart(lines: string[], line: number, col: number): { line: number; col: number } {
	const curLine = lines[line]!;
	if (col === 0) {
		if (line === 0) return { line: 0, col: 0 };
		const prevLine = lines[line - 1]!;
		const last = prevLine.length;
		// Find last WORD start on previous line
		let c = last - 1;
		while (c >= 0 && isWhitespace(prevLine[c]!)) c--;
		while (c >= 0 && !isWhitespace(prevLine[c]!)) c--;
		return { line: line - 1, col: c + 1 };
	}
	let c = col - 1;
	// skip whitespace backwards
	while (c >= 0 && isWhitespace(curLine[c]!)) c--;
	if (c < 0) {
		if (line === 0) return { line: 0, col: 0 };
		return prevWORDStart(lines, line, 0);
	}
	// skip non-whitespace backwards
	while (c >= 0 && !isWhitespace(curLine[c]!)) c--;
	return { line, col: c + 1 };
}

/** End of current/next WORD from cursor. */
function nextWORDEnd(lines: string[], line: number, col: number): { line: number; col: number } {
	const curLine = lines[line]!;
	// skip whitespace
	while (col < curLine.length && isWhitespace(curLine[col]!)) col++;
	if (col >= curLine.length) {
		if (line >= lines.length - 1) return { line, col: curLine.length };
		return nextWORDEnd(lines, line + 1, 0);
	}
	// advance to end of WORD
	while (col < curLine.length && !isWhitespace(curLine[col]!)) col++;
	return { line, col: col - 1 };
}

// ── Paragraph movement ──────────────────────────────────────────────────────

function prevParagraphStart(lines: string[], line: number): number {
	// skip blank lines backwards
	let l = line;
	while (l > 0 && (lines[l] ?? "").trim() === "") l--;
	// skip non-blank lines backwards
	while (l > 0 && (lines[l] ?? "").trim() !== "") l--;
	// land on first non-blank
	while (l > 0 && (lines[l] ?? "").trim() === "") l--;
	return l;
}

function nextParagraphStart(lines: string[], line: number): number {
	// skip non-blank lines forwards
	let l = line;
	while (l < lines.length - 1 && (lines[l] ?? "").trim() !== "") l++;
	// skip blank lines forwards
	while (l < lines.length - 1 && (lines[l] ?? "").trim() === "") l++;
	return l;
}

// ── Find/till on current line ───────────────────────────────────────────────

function findCharOnLine(line: string, col: number, char: string, forward: boolean, till: boolean): number {
	if (forward) {
		let c = col + 1;
		while (c < line.length) {
			if (line[c] === char) return till ? c - 1 : c;
			c++;
		}
	} else {
		let c = col - 1;
		while (c >= 0) {
			if (line[c] === char) return till ? c + 1 : c;
			c--;
		}
	}
	return -1; // not found
}

// ── Matching bracket ────────────────────────────────────────────────────────

const BRACKET_PAIRS: Record<string, string> = {
	"(": ")", ")": "(",
	"[": "]", "]": "[",
	"{": "}", "}": "{",
};

function findMatchingBracket(lines: string[], line: number, col: number): { line: number; col: number } | null {
	const ch = (lines[line] ?? "")[col];
	if (!ch || !(ch in BRACKET_PAIRS)) return null;
	const target = BRACKET_PAIRS[ch]!;
	const forward = ch === "(" || ch === "[" || ch === "{";
	let depth = 0;
	let l = line;
	let c = col;
	while (l >= 0 && l < lines.length) {
		const curLine = lines[l] ?? "";
		while (forward ? c < curLine.length : c >= 0) {
			const cur = curLine[c];
			if (cur === ch) depth++;
			else if (cur === target) {
				depth--;
				if (depth === 0) return { line: l, col: c };
			}
			forward ? c++ : c--;
		}
		l += forward ? 1 : -1;
		c = forward ? 0 : (lines[l] ?? "").length - 1;
		if (l < 0 || l >= lines.length) break;
		// after wrapping, re-check index bounds
		if (c < 0) c = 0;
	}
	return null;
}

// ── Esc sequences for editor operations ──────────────────────────────────────

const ESC = {
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

// ── ViEditor ─────────────────────────────────────────────────────────────────

class ViEditor extends CustomEditor {
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
			case "w": { const c = this.moveToWordForward(); this.setCursorPosition(c.line, c.col); return; }
			case "b": { const c = this.moveToWordBackward(); this.setCursorPosition(c.line, c.col); return; }
			case "e": { const c = this.moveToWordEnd(); this.setCursorPosition(c.line, c.col); return; }
			case "W": { const c = this.moveToWORDFwd(); this.setCursorPosition(c.line, c.col); return; }
			case "B": { const c = this.moveToWORDBack(); this.setCursorPosition(c.line, c.col); return; }
			case "E": { const c = this.moveToWORDEnd(); this.setCursorPosition(c.line, c.col); return; }
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

	// ── Command mode handling ──────────────────────────────────
	// Routes everything through super.handleInput for autocomplete.
	// Editor internally uses "/" prefix (for pi's slash-command detection),
	// but render() swaps it to ":" for vi-style display.
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

	private syncCommandBuffer(): void {
		// kept for enter handler
		const text = super.getText();
		if (text.startsWith(":")) {
			this.commandBuffer = text.slice(1);
		}
	}

	// ── Operator + motion handling ──────────────────────────────────────

	private handleOperatorMotion(op: PendingOp, motion: string): void {
		const cursorBefore = this.getCursor();

		// ── Handle motions that are single characters ────────────
		if (motion === "d") {
			// dd / cc / yy
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
		if (motion === "w") this.moveToWordForward();
		else if (motion === "b") this.moveToWordBackward();
		else if (motion === "e") this.moveToWordEnd();
		else if (motion === "W") this.moveToWORDFwd();
		else if (motion === "B") this.moveToWORDBack();
		else if (motion === "E") this.moveToWORDEnd();
		else if (motion === "0" || motion === "^") {
			// d0 / d^ — special: delete backwards from cursor
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
			return;
		}
		else if (motion === "$") {
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
			return;
		}
		else if (motion === "G") {
			this.moveToEnd();
		}
		else if (motion === "g") {
			// Actually shouldn't happen — gg is caught earlier
			return;
		}
		else {
			// Unknown motion — bail
			return;
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

	// ── Text objects ───────────────────────────────────────────────────

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

			if (inner) {
				// iw / iW: only the word itself, no surrounding whitespace
			} else {
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
				// Cursor stays at start
			}
			if (op.op === "change") this.mode = "insert";
		}
	}

	// ── Word movement ───────────────────────────────────────────────────

	private moveToWordForward(): { line: number; col: number } {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return nextWordStart(lines, cursor.line, cursor.col);
	}

	private moveToWordBackward(): { line: number; col: number } {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return prevWordStart(lines, cursor.line, cursor.col);
	}

	private moveToWordEnd(): { line: number; col: number } {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return nextWordEnd(lines, cursor.line, cursor.col);
	}

	// ── WORD movement (whitespace-delimited) ─────────────────────────────

	private moveToWORDFwd(): { line: number; col: number } {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return nextWORDStart(lines, cursor.line, cursor.col);
	}

	private moveToWORDBack(): { line: number; col: number } {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return prevWORDStart(lines, cursor.line, cursor.col);
	}

	private moveToWORDEnd(): { line: number; col: number } {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return nextWORDEnd(lines, cursor.line, cursor.col);
	}

	// ── Find repeat ───────────────────────────────────────────────────────

	private repeatFind(reverse: boolean): void {
		if (!this.lastFind) return;
		const { char, forward, till } = this.lastFind;
		const lines = this.getLines();
		const cur = this.getCursor();
		const dir = reverse ? !forward : forward;
		const col = findCharOnLine(lines[cur.line] ?? "", cur.col, char, dir, till);
		if (col >= 0) this.setCursorPosition(cur.line, col);
	}

	// ── Count helpers ─────────────────────────────────────────────────────

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
		const end = { line: targetLine, col: targetCol };

		if (cursor.line === targetLine) {
			// Single line: delete from cursor to target
			if (targetCol <= cursor.col) {
				// delete to left
				for (let i = 0; i < cursor.col - targetCol; i++) {
					super.handleInput(ESC.BS);
				}
			} else {
				// delete to right
				for (let i = 0; i < targetCol - cursor.col; i++) {
					super.handleInput(ESC.DEL);
				}
			}
			return;
		}

		// Multi-line: delete to end of current line, then delete lines, then delete from start of target
		if (targetLine > cursor.line) {
			super.handleInput(ESC.DEL_LINE_END);
			// delete full lines between
			for (let i = 0; i < targetLine - cursor.line; i++) {
				super.handleInput(ESC.DEL); // delete newline + empty line
			}
			// delete from start of target line to targetCol
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
			// go up and delete lines
			for (let i = 0; i < cursor.line - targetLine; i++) {
				super.handleInput(ESC.UP);
				super.handleInput(ESC.DEL_LINE_END);
				super.handleInput(ESC.DEL); // join with next
			}
			// at target line, delete from targetCol to end
			super.handleInput(ESC.HOME);
			for (let i = 0; i < targetCol; i++) {
				super.handleInput(ESC.RIGHT);
			}
			// Now cursor is at position before the deleted range
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
				// Replace only leading "/" (with possible ANSI codes before it) with ":"
				lines[i] = lines[i]!.replace(/^((?:\x1b\[[0-9;]*m)*)\//, "$1:");
			}
		}

		return lines;
	}
}

// ── Extension export ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new ViEditor(tui, theme, kb));
	});
}
