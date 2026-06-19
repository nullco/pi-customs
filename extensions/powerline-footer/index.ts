/**
 * Powerline Footer Extension - replaces the default pi footer with a
 * two-row statusline:
 *   Row 1 — extension statuses (vi-mode, nvim-pipe, etc.), left-aligned.
 *   Row 2 — powerline bar (triangle separators) with git branch, cwd,
 *           token usage, cost, and model.
 *
 * Requires a powerline-patched font for the triangle (U+E0B0/U+E0B2) and
 * branch (U+E0A0) glyphs.
 *
 * Usage: drop in ~/.pi/agent/extensions/powerline-footer/ (or a project's
 * .pi/extensions/) and /reload. The footer auto-enables on session start.
 * Toggle with the /powerline command.
 *
 * Segments use the active theme's accent / success / warning / error / muted
 * foreground colors as backgrounds, so the bar stays theme-aware while using
 * proper, high-contrast powerline colors. Text color is chosen automatically
 * (white or black) for readability.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    ReadonlyFooterDataProvider,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Powerline glyphs (need a powerline-patched font) ──────────────────────────
const RIGHT_TRIANGLE = "\uE0B0"; //  - separator pointing right (left side)
const LEFT_TRIANGLE = "\uE0B2"; //  - separator pointing left (right side)
const BRANCH_GLYPH = "\uE0A0"; //  - git branch

// Theme foreground colors reused as powerline segment backgrounds. These are
// the "proper" statusline colors: blue, green, yellow, gray, red, cyan.
type SegmentBg =
    | "accent"
    | "success"
    | "warning"
    | "muted"
    | "error"
    | "borderAccent";

interface Segment {
    text: string;
    bg: SegmentBg;
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const DEFAULT_BG = "\x1b[49m";
const BOLD = "\x1b[1m";

/** Convert a ThemeColor into a background ANSI sequence. */
function bgAnsi(theme: Theme, color: SegmentBg): string {
    return theme.getFgAnsi(color).replace("38;", "48;");
}

/** Convert a ThemeColor into a foreground ANSI sequence. */
function fgAnsi(theme: Theme, color: SegmentBg): string {
    return theme.getFgAnsi(color);
}

// ── Contrast-aware text color ─────────────────────────────────────────────────

const ANSI_TRUECOLOR_WHITE = "\x1b[38;2;255;255;255m";
const ANSI_TRUECOLOR_BLACK = "\x1b[38;2;0;0;0m";
const ANSI_256_WHITE = "\x1b[38;5;15m";
const ANSI_256_BLACK = "\x1b[38;5;0m";

function index256ToRgb(index: number): { r: number; g: number; b: number } {
    if (index < 16) {
        const table = [
            [0, 0, 0],
            [205, 49, 49],
            [13, 188, 121],
            [229, 229, 16],
            [36, 114, 200],
            [188, 63, 188],
            [17, 168, 205],
            [229, 229, 229],
            [102, 102, 102],
            [241, 76, 76],
            [35, 209, 139],
            [245, 245, 67],
            [59, 142, 234],
            [214, 112, 214],
            [41, 184, 219],
            [255, 255, 255],
        ];
        const c = table[index] ?? [0, 0, 0];
        return { r: c[0], g: c[1], b: c[2] };
    }
    if (index < 232) {
        const n = index - 16;
        const r = Math.floor(n / 36);
        const g = Math.floor((n % 36) / 6);
        const b = n % 6;
        const values = [0, 95, 135, 175, 215, 255];
        return { r: values[r], g: values[g], b: values[b] };
    }
    const gray = 8 + (index - 232) * 10;
    return { r: gray, g: gray, b: gray };
}

function ansiToRgb(ansi: string): { r: number; g: number; b: number } | undefined {
    const tc = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
    if (tc) {
        return { r: +tc[1], g: +tc[2], b: +tc[3] };
    }
    const c256 = ansi.match(/\x1b\[38;5;(\d+)m/);
    if (c256) {
        return index256ToRgb(+c256[1]);
    }
    return undefined;
}

function isLight(rgb: { r: number; g: number; b: number }): boolean {
    const y = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return y > 0.55;
}

/** Pick white or black text for the given segment background. */
function textFgAnsi(theme: Theme, bg: SegmentBg): string {
    const rgb = ansiToRgb(theme.getFgAnsi(bg));
    const light = rgb ? isLight(rgb) : false;
    if (theme.getColorMode() === "truecolor") {
        return light ? ANSI_TRUECOLOR_BLACK : ANSI_TRUECOLOR_WHITE;
    }
    return light ? ANSI_256_BLACK : ANSI_256_WHITE;
}

/** A segment's content cell: ` text ` on the segment's bg with bold text. */
function segmentCell(theme: Theme, s: Segment): string {
    return `${bgAnsi(theme, s.bg)}${textFgAnsi(theme, s.bg)}${BOLD} ${s.text} `;
}

/**
 * Render the left group. Each separator uses the *current* segment's color as
 * the triangle foreground and the *next* segment's color (or the terminal
 * default background) as the cell background. This is the correct orientation
 * for U+E0B0.
 */
function renderLeft(theme: Theme, segs: Segment[]): string {
    if (segs.length === 0) return "";
    let out = "";
    for (let i = 0; i < segs.length; i++) {
        out += segmentCell(theme, segs[i]);
        if (i < segs.length - 1) {
            out += `${bgAnsi(theme, segs[i + 1].bg)}${fgAnsi(theme, segs[i].bg)}${RIGHT_TRIANGLE}`;
        } else {
            out += `${DEFAULT_BG}${fgAnsi(theme, segs[i].bg)}${RIGHT_TRIANGLE}`;
        }
    }
    return `${out}${RESET}`;
}

/**
 * Render the right group. Starts with a left-pointing triangle that enters
 * from the default background, then segments separated by U+E0B2 triangles.
 * Because U+E0B2 points left, the triangle itself takes the *next* segment's
 * color and the cell background takes the current/default color.
 */
function renderRight(theme: Theme, segs: Segment[]): string {
    if (segs.length === 0) return "";
    let out = `${fgAnsi(theme, segs[0].bg)}${DEFAULT_BG}${LEFT_TRIANGLE}`;
    for (let i = 0; i < segs.length; i++) {
        out += segmentCell(theme, segs[i]);
        if (i < segs.length - 1) {
            out += `${fgAnsi(theme, segs[i + 1].bg)}${bgAnsi(theme, segs[i].bg)}${LEFT_TRIANGLE}`;
        }
    }
    return `${out}${RESET}`;
}

// ── Status row ────────────────────────────────────────────────────────────────

/** Build the top row with extension statuses, left-aligned in dim style. */
function buildStatusRow(
    theme: Theme,
    footerData: ReadonlyFooterDataProvider,
    width: number,
): string | null {
    const statuses = footerData.getExtensionStatuses();
    if (statuses.size === 0) return null;

    // Sort by key so consumers can force ordering with prefixes (e.g.
    // "!vi-mode" sorts first and appears leftmost).
    const sorted = [...statuses.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
    );
    const text = sorted.map(([, v]) => v).join("  ");
    return truncateToWidth(
        `${RESET}${theme.getFgAnsi("dim")}${text}${RESET}`,
        width,
        "",
    );
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function fmt(n: number): string {
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Shorten a path to ~ + last two components for footer brevity. */
function shortenPath(cwd: string): string {
    const home = process.env.HOME;
    let p = cwd;
    if (home && (p === home || p.startsWith(home + "/"))) {
        p = "~" + p.slice(home.length);
    }
    const parts = p.split("/").filter(Boolean);
    if (parts.length <= 2) return p || "/";
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** Sum input/output tokens and total cost across the current branch. */
function sumUsage(ctx: ExtensionContext): { input: number; output: number; cost: number } {
    let input = 0;
    let output = 0;
    let cost = 0;
    for (const e of ctx.sessionManager.getBranch()) {
        if (e.type === "message" && e.message.role === "assistant") {
            const m = e.message as AssistantMessage;
            input += m.usage.input;
            output += m.usage.output;
            cost += m.usage.cost.total;
        }
    }
    return { input, output, cost };
}

function buildPowerlineRow(
    ctx: ExtensionContext,
    footerData: ReadonlyFooterDataProvider,
): { left: Segment[]; right: Segment[] } {
    const left: Segment[] = [];
    const right: Segment[] = [];

    // Git branch
    const branch = footerData.getGitBranch();
    if (branch) {
        left.push({ text: `${BRANCH_GLYPH} ${branch}`, bg: "success" });
    }

    // Working directory
    left.push({ text: shortenPath(ctx.cwd), bg: "warning" });

    // Token usage
    const usage = sumUsage(ctx);
    right.push({
        text: `↑${fmt(usage.input)} ↓${fmt(usage.output)}`,
        bg: "muted",
    });

    // Cost (only once nonzero, to avoid a $0.000 segment at startup)
    if (usage.cost > 0) {
        right.push({ text: `$${usage.cost.toFixed(3)}`, bg: "error" });
    }

    // Model (rightmost segment)
    right.push({ text: ctx.model?.id ?? "no-model", bg: "accent" });

    return { left, right };
}

function renderPowerlineRow(
    theme: Theme,
    leftSegs: Segment[],
    rightSegs: Segment[],
    width: number,
): string {
    let ls = leftSegs;
    let rs = rightSegs;
    const fits = () =>
        visibleWidth(renderLeft(theme, ls)) + visibleWidth(renderRight(theme, rs)) + 1 <= width;

    while (rs.length > 0 && !fits()) rs = rs.slice(0, -1);
    while (ls.length > 1 && !fits()) ls = ls.slice(0, -1);

    const left = renderLeft(theme, ls);
    const right = renderRight(theme, rs);
    const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return truncateToWidth(left + " ".repeat(pad) + right, width, "");
}

/**
 * Build the two-row footer:
 *   Row 1 — extension statuses (left-aligned dim text)
 *   Row 2 — powerline bar with branch, cwd, usage, cost, model
 */
function buildFooterLines(
    theme: Theme,
    ctx: ExtensionContext,
    footerData: ReadonlyFooterDataProvider,
    width: number,
): string[] {
    const { left, right } = buildPowerlineRow(ctx, footerData);
    const powerlineBar = renderPowerlineRow(theme, left, right, width);
    const statusRow = buildStatusRow(theme, footerData, width);

    const lines: string[] = [];
    if (statusRow) lines.push(statusRow);
    lines.push(powerlineBar);
    return lines;
}

// ── Extension wiring ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    let tuiRef: { requestRender: () => void } | undefined;
    let enabled = false;

    function enable(ctx: ExtensionContext): void {
        if (enabled) return;
        enabled = true;
        ctx.ui.setFooter((_tui, _theme, footerData) => {
            tuiRef = _tui;
            const unsub = footerData.onBranchChange(() => tuiRef?.requestRender());
            return {
                dispose: () => {
                    unsub();
                    tuiRef = undefined;
                },
                invalidate() {},
                render(width: number): string[] {
                    return buildFooterLines(ctx.ui.theme, ctx, footerData, width);
                },
            };
        });
    }

    function disable(ctx: ExtensionContext): void {
        if (!enabled) return;
        enabled = false;
        ctx.ui.setFooter(undefined);
        tuiRef = undefined;
    }

    pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") return;
        enabled = false;
        enable(ctx);
    });

    pi.on("session_shutdown", () => {
        enabled = false;
        tuiRef = undefined;
    });

    pi.on("model_select", () => tuiRef?.requestRender());
    pi.on("thinking_level_select", () => tuiRef?.requestRender());
    pi.on("agent_end", () => tuiRef?.requestRender());

    pi.registerCommand("powerline", {
        description: "Toggle the powerline footer on/off",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") return;
            if (enabled) {
                disable(ctx);
                ctx.ui.notify("Powerline footer disabled", "info");
            } else {
                enable(ctx);
                ctx.ui.notify("Powerline footer enabled", "info");
            }
        },
    });
}
