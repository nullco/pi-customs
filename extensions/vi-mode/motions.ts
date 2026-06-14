/**
 * Pure motion functions for vi mode — all operate on lines[] and return {line, col}.
 */

import { isWhitespace, isWordChar, skipLeadingWhitespace } from "./text-utils";
import { BRACKET_PAIRS } from "./types";

// ── Word movement ────────────────────────────────────────────────────────────

/** Find word-start before cursor (for `b` motion). */
export function prevWordStart(lines: string[], line: number, col: number): { line: number; col: number } {
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
export function nextWordStart(lines: string[], line: number, col: number): { line: number; col: number } {
    const curLine = lines[line]!;
    if (col >= curLine.length) {
        if (line >= lines.length - 1) return { line, col };
        return skipLeadingWhitespace(lines, line + 1);
    }

    if (!isWhitespace(curLine[col]!)) {
        // skip through current word
        const startClass = isWordChar(curLine[col]!) ? "word" : "punct";
        let c = col;
        while (c < curLine.length) {
            const cls = isWordChar(curLine[c]!) ? "word" : "punct";
            if (cls !== startClass) break;
            c++;
        }
        col = c;
    }

    // skip whitespace
    let c = col;
    while (c < curLine.length && isWhitespace(curLine[c]!)) c++;

    if (c >= curLine.length) {
        if (line >= lines.length - 1) return { line, col: curLine.length };
        return skipLeadingWhitespace(lines, line + 1);
    }

    return { line, col: c };
}

/** Find word-end from cursor (for `e` motion). */
export function nextWordEnd(lines: string[], line: number, col: number): { line: number; col: number } {
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

// ── WORD movement (whitespace-delimited) ────────────────────────────────────

/** Next WORD start after cursor. */
export function nextWORDStart(lines: string[], line: number, col: number): { line: number; col: number } {
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
export function prevWORDStart(lines: string[], line: number, col: number): { line: number; col: number } {
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
export function nextWORDEnd(lines: string[], line: number, col: number): { line: number; col: number } {
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

export function prevParagraphStart(lines: string[], line: number): number {
    // skip blank lines backwards
    let l = line;
    while (l > 0 && (lines[l] ?? "").trim() === "") l--;
    // skip non-blank lines backwards
    while (l > 0 && (lines[l] ?? "").trim() !== "") l--;
    // land on first non-blank
    while (l > 0 && (lines[l] ?? "").trim() === "") l--;
    return l;
}

export function nextParagraphStart(lines: string[], line: number): number {
    // skip non-blank lines forwards
    let l = line;
    while (l < lines.length - 1 && (lines[l] ?? "").trim() !== "") l++;
    // skip blank lines forwards
    while (l < lines.length - 1 && (lines[l] ?? "").trim() === "") l++;
    return l;
}

// ── Find/till on current line ───────────────────────────────────────────────

export function findCharOnLine(line: string, col: number, char: string, forward: boolean, till: boolean): number {
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

export function findMatchingBracket(lines: string[], line: number, col: number): { line: number; col: number } | null {
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
