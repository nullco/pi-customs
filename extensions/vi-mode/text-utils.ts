/**
 * Text classification and utility helpers for vi mode.
 */

export function isWhitespace(ch: string): boolean {
    return ch === " " || ch === "\t";
}

export function isWordChar(ch: string): boolean {
    const code = ch.charCodeAt(0);
    return (
        (code >= 48 && code <= 57) || // 0-9
        (code >= 65 && code <= 90) || // A-Z
        (code >= 97 && code <= 122) || // a-z
        code === 95 // _
    );
}

/** Skip past leading whitespace on a line. */
export function skipLeadingWhitespace(lines: string[], line: number): { line: number; col: number } {
    const curLine = lines[line]!;
    let c = 0;
    while (c < curLine.length && isWhitespace(curLine[c]!)) c++;
    return { line, col: c };
}

/** Column of the first non-blank character on a line. */
export function firstNonBlank(lines: string[], line: number): number {
    const curLine = lines[line]!;
    for (let c = 0; c < curLine.length; c++) {
        if (!isWhitespace(curLine[c]!)) return c;
    }
    return 0;
}
