/**
 * Powerline Footer Extension — single-row powerline status bar.
 *
 * Left side:  MODE > BRANCH > CWD
 *   - MODE  comes from vi-mode's setStatus (NORMAL/INSERT/COMMAND)
 *   - BRANCH from footerData.getGitBranch()
 *   - CWD    from ctx.cwd (shortened to ~/… format)
 * Right side: usage, cost, model (truncated when terminal is narrow).
 *
 * Requires a powerline-patched font for triangle separators (U+E0B0/U+E0B2)
 * and the git-branch glyph (U+E0A0).
 *
 * Toggle with /powerline.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    ReadonlyFooterDataProvider,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Powerline glyphs ──────────────────────────────────────────────────────────
const RIGHT_TRIANGLE = "\uE0B0"; // 
const LEFT_TRIANGLE  = "\uE0B2"; // 
const BRANCH_GLYPH   = "\uE0A0"; // 

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

const RESET       = "\x1b[0m";
const DEFAULT_BG  = "\x1b[49m";
const BOLD        = "\x1b[1m";

/** Strip all ANSI escape sequences to get visible text. */
function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "");
}

function bgAnsi(theme: Theme, color: SegmentBg): string {
    return theme.getFgAnsi(color).replace("38;", "48;");
}

function fgAnsi(theme: Theme, color: SegmentBg): string {
    return theme.getFgAnsi(color);
}

// ── Contrast-aware text color ─────────────────────────────────────────────────

const ANSI_TRUECOLOR_WHITE = "\x1b[38;2;255;255;255m";
const ANSI_TRUECOLOR_BLACK = "\x1b[38;2;0;0;0m";
const ANSI_256_WHITE       = "\x1b[38;5;15m";
const ANSI_256_BLACK       = "\x1b[38;5;0m";

function index256ToRgb(index: number): { r: number; g: number; b: number } {
    if (index < 16) {
        const table = [
            [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
            [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
            [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
            [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
        ];
        const c = table[index] ?? [0, 0, 0];
        return { r: c[0], g: c[1], b: c[2] };
    }
    if (index < 232) {
        const n = index - 16;
        return {
            r: [0, 95, 135, 175, 215, 255][Math.floor(n / 36)]!,
            g: [0, 95, 135, 175, 215, 255][Math.floor((n % 36) / 6)]!,
            b: [0, 95, 135, 175, 215, 255][n % 6]!,
        };
    }
    const g = 8 + (index - 232) * 10;
    return { r: g, g, b: g };
}

function ansiToRgb(ansi: string): { r: number; g: number; b: number } | undefined {
    const tc = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
    if (tc) return { r: +tc[1], g: +tc[2], b: +tc[3] };
    const c256 = ansi.match(/\x1b\[38;5;(\d+)m/);
    if (c256) return index256ToRgb(+c256[1]);
    return undefined;
}

function isLight(rgb: { r: number; g: number; b: number }): boolean {
    return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255 > 0.55;
}

function textFgAnsi(theme: Theme, bg: SegmentBg): string {
    const rgb = ansiToRgb(theme.getFgAnsi(bg));
    const light = rgb ? isLight(rgb) : false;
    if (theme.getColorMode() === "truecolor") {
        return light ? ANSI_TRUECOLOR_BLACK : ANSI_TRUECOLOR_WHITE;
    }
    return light ? ANSI_256_BLACK : ANSI_256_WHITE;
}

/** Render a single segment: ` BOLD_TEXT ` on coloured background. */
function segmentCell(theme: Theme, s: Segment): string {
    return `${bgAnsi(theme, s.bg)}${textFgAnsi(theme, s.bg)}${BOLD} ${s.text} `;
}

/** Render left-aligned segments separated by U+E0B0 triangles. */
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

/** Render right-aligned segments separated by U+E0B2 triangles. */
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

// ── Data helpers ──────────────────────────────────────────────────────────────

function fmt(n: number): string {
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}

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

function sumUsage(ctx: ExtensionContext): { input: number; output: number; cost: number } {
    let input = 0, output = 0, cost = 0;
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

/** Extract the vi-mode label from extension statuses. */
function getVimMode(footerData: ReadonlyFooterDataProvider): string | null {
    const statuses = footerData.getExtensionStatuses();
    // vi-mode registers with key "!vi-mode" (the ! forces sort-first order).
    const raw = statuses.get("!vi-mode");
    if (!raw) return null;
    return stripAnsi(raw).trim();
}

// ── Layout ────────────────────────────────────────────────────────────────────

function buildLeftSegments(
    ctx: ExtensionContext,
    footerData: ReadonlyFooterDataProvider,
): Segment[] {
    const out: Segment[] = [];

    // 1. MODE (from vi-mode)
    const mode = getVimMode(footerData);
    if (mode) {
        // Pick bg based on mode for visual flair
        const bg: SegmentBg =
            mode === "INSERT" ? "success" :
            mode === "COMMAND" ? "accent" :
            /* NORMAL / d / c */ "muted";
        out.push({ text: mode, bg });
    }

    // 2. BRANCH
    const branch = footerData.getGitBranch();
    if (branch) {
        out.push({ text: `${BRANCH_GLYPH} ${branch}`, bg: "success" });
    }

    // 3. CWD
    out.push({ text: shortenPath(ctx.cwd), bg: "warning" });

    return out;
}

function buildRightSegments(ctx: ExtensionContext): Segment[] {
    const out: Segment[] = [];
    const usage = sumUsage(ctx);

    out.push({ text: `↑${fmt(usage.input)} ↓${fmt(usage.output)}`, bg: "muted" });
    if (usage.cost > 0) {
        out.push({ text: `$${usage.cost.toFixed(3)}`, bg: "error" });
    }
    out.push({ text: ctx.model?.id ?? "no-model", bg: "accent" });

    return out;
}

function renderBar(
    theme: Theme,
    leftSegs: Segment[],
    rightSegs: Segment[],
    width: number,
): string {
    let ls = leftSegs;
    let rs = rightSegs;
    const fits = () =>
        visibleWidth(renderLeft(theme, ls)) + visibleWidth(renderRight(theme, rs)) + 1 <= width;

    // Drop right segments first (least important), then left (but keep at least MODE)
    while (rs.length > 0 && !fits()) rs = rs.slice(0, -1);
    while (ls.length > 1 && !fits()) ls = ls.slice(0, -1);

    const left  = renderLeft(theme, ls);
    const right = renderRight(theme, rs);
    const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return truncateToWidth(left + " ".repeat(pad) + right, width, "");
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
                    const theme = ctx.ui.theme;
                    const left  = buildLeftSegments(ctx, footerData);
                    const right = buildRightSegments(ctx);
                    return [renderBar(theme, left, right, width)];
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
