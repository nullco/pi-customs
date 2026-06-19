/**
 * Powerline Footer Extension - replaces the default pi footer with a
 * powerline-style statusline: colored segments joined by triangle separators
 * ( , ), with model / git branch / cwd on the left and token usage / cost /
 * extension statuses on the right.
 *
 * Requires a powerline-patched font for the triangle (U+E0B0/U+E0B2) and
 * branch (U+E0A0) glyphs.
 *
 * Usage: drop in ~/.pi/agent/extensions/powerline-footer/ (or a project's
 * .pi/extensions/) and /reload. The footer auto-enables on session start.
 * Toggle with the /powerline command.
 *
 * Segments use the active theme's background colors, so the bar adapts to
 * theme switches and hot-reload.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    ReadonlyFooterDataProvider,
    Theme,
    ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Powerline glyphs (need a powerline-patched font) ──────────────────────────
const RIGHT_TRIANGLE = "\uE0B0"; //  - separator pointing right (left side)
const LEFT_TRIANGLE = "\uE0B2"; //  - separator pointing left (right side)
const BRANCH_GLYPH = "\uE0A0"; //  - git branch

// The theme exposes six background colors; reuse them as segment backgrounds.
type BgColor =
    | "selectedBg"
    | "userMessageBg"
    | "customMessageBg"
    | "toolPendingBg"
    | "toolSuccessBg"
    | "toolErrorBg";

interface Segment {
    text: string; // raw (no ANSI), kept short
    bg: BgColor;
    fg: ThemeColor;
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

/**
 * Return the ANSI code that sets `bg` as a *foreground* color.
 * getBgAnsi emits `\x1b[48;...m` (background); swapping the `48;` prefix to
 * `38;` turns it into the equivalent foreground code. This lets a separator
 * glyph adopt the next segment's background as its foreground, producing the
 * seamless powerline transition.
 */
function bgAsFgAnsi(theme: Theme, bg: BgColor): string {
    return theme.getBgAnsi(bg).replace("48;", "38;");
}

/** A segment's content cell: ` text ` on the segment's bg/fg. No trailing reset. */
function segmentCell(theme: Theme, s: Segment): string {
    return `${theme.getBgAnsi(s.bg)}${theme.getFgAnsi(s.fg)} ${s.text} `;
}

/**
 * Render the left group. Segments flow left→right; each is followed by a
 * right-pointing triangle (U+E0B0) whose bg is the current segment and whose
 * fg is the next segment's bg (or default for the trailing one).
 */
function renderLeft(theme: Theme, segs: Segment[]): string {
    if (segs.length === 0) return "";
    let out = "";
    for (let i = 0; i < segs.length; i++) {
        out += segmentCell(theme, segs[i]);
        if (i < segs.length - 1) {
            out += `${theme.getBgAnsi(segs[i].bg)}${bgAsFgAnsi(theme, segs[i + 1].bg)}${RIGHT_TRIANGLE}`;
        } else {
            // Trailing triangle fades into the default background.
            out += `${theme.getBgAnsi(segs[i].bg)}\x1b[39m${RIGHT_TRIANGLE}`;
        }
    }
    return `${out}\x1b[49m\x1b[39m`;
}

/**
 * Render the right group. Starts with a left-pointing triangle (U+E0B2) that
 * enters from the default background, then segments separated by U+E0B2
 * triangles whose bg is the next segment and whose fg is the current one.
 */
function renderRight(theme: Theme, segs: Segment[]): string {
    if (segs.length === 0) return "";
    let out = `${theme.getBgAnsi(segs[0].bg)}\x1b[39m${LEFT_TRIANGLE}`;
    for (let i = 0; i < segs.length; i++) {
        out += segmentCell(theme, segs[i]);
        if (i < segs.length - 1) {
            out += `${theme.getBgAnsi(segs[i + 1].bg)}${bgAsFgAnsi(theme, segs[i].bg)}${LEFT_TRIANGLE}`;
        }
    }
    return `${out}\x1b[49m\x1b[39m`;
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

function buildSegments(
    ctx: ExtensionContext,
    footerData: ReadonlyFooterDataProvider,
): { left: Segment[]; right: Segment[] } {
    const left: Segment[] = [];
    const right: Segment[] = [];

    // Model
    left.push({ text: ctx.model?.id ?? "no-model", bg: "toolPendingBg", fg: "accent" });

    // Git branch
    const branch = footerData.getGitBranch();
    if (branch) {
        left.push({ text: `${BRANCH_GLYPH} ${branch}`, bg: "toolSuccessBg", fg: "text" });
    }

    // Working directory
    left.push({ text: shortenPath(ctx.cwd), bg: "customMessageBg", fg: "text" });

    // Token usage
    const usage = sumUsage(ctx);
    right.push({
        text: `↑${fmt(usage.input)} ↓${fmt(usage.output)}`,
        bg: "userMessageBg",
        fg: "text",
    });

    // Cost (only once nonzero, to avoid a $0.000 segment at startup)
    if (usage.cost > 0) {
        right.push({ text: `$${usage.cost.toFixed(3)}`, bg: "selectedBg", fg: "warning" });
    }

    // Extension statuses (set via ctx.ui.setStatus by other extensions)
    const statuses = footerData.getExtensionStatuses();
    if (statuses.size > 0) {
        right.push({
            text: [...statuses.values()].join(" │ "),
            bg: "toolErrorBg",
            fg: "text",
        });
    }

    return { left, right };
}

/**
 * Build the full footer line: [left bar] [padding] [right bar].
 * Drops right-side then left-side segments when the terminal is too narrow.
 */
function buildFooterLine(
    theme: Theme,
    ctx: ExtensionContext,
    footerData: ReadonlyFooterDataProvider,
    width: number,
): string {
    const { left: leftSegs, right: rightSegs } = buildSegments(ctx, footerData);

    let ls = leftSegs;
    let rs = rightSegs;
    const fits = () => visibleWidth(renderLeft(theme, ls)) + visibleWidth(renderRight(theme, rs)) + 1 <= width;

    while (rs.length > 0 && !fits()) rs = rs.slice(0, -1);
    while (ls.length > 1 && !fits()) ls = ls.slice(0, -1);

    const left = renderLeft(theme, ls);
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
                    // Read the live theme so the bar adapts to theme switches.
                    return [buildFooterLine(ctx.ui.theme, ctx, footerData, width)];
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
        enabled = false; // reset for the new session
        enable(ctx);
    });

    pi.on("session_shutdown", () => {
        enabled = false;
        tuiRef = undefined;
    });

    // Re-render on changes the TUI doesn't automatically refresh for.
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
