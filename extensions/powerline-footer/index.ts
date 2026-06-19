/**
 * Powerline Footer Extension — single-row powerline status bar.
 *
 * Segments are driven by a config file (powerline-footer.json). See below
 * for the config format and the built-in default.
 *
 * Config search order:
 *   1. ./.pi/powerline-footer.json              (project-local, trusted only)
 *   2. ~/.pi/agent/extensions/powerline-footer.json  (global, next to extension)
 *
 * Missing config or `!parse()?` false → built-in default (see DEFAULT_CONFIG).
 *
 * Toggle with /powerline.
 *
 *
 * ── Config format ─────────────────────────────────────────────────────────────
 *
 *   {
 *     "left": [       // segments from left to right
 *       { "kind": "git-branch", "bg": "success" },
 *       { "kind": "cwd",        "bg": "warning" },
 *       { "kind": "extension-status", "key": "vi-mode", "bg": "muted" },
 *       { "kind": "extension-status", "bg": "borderAccent" }
 *     ],
 *     "right": [      // segments from right to left
 *       { "kind": "usage", "bg": "muted" },
 *       { "kind": "cost",  "bg": "error" },
 *       { "kind": "model", "bg": "accent" }
 *     ]
 *   }
 *
 *   kind: "git-branch"       → git branch ( main), skipped when absent
 *   kind: "cwd"              → shortened cwd (~/project)
 *   kind: "extension-status" → extension status text
 *       - with "key": that specific extension's status (single segment)
 *       - without "key": all remaining extension statuses, joined with " · "
 *   kind: "usage"            → ↑input ↓output token counts
 *   kind: "cost"             → $0.123 total cost, omitted when still zero
 *   kind: "model"            → current model id
 *
 *   bg (optional): "accent" | "success" | "warning" | "muted" | "error" | "borderAccent"
 *   If omitted, each kind has a default bg (see DEFAULT_CONFIG).
 *
 *
 * Requires a powerline-patched font for triangle separators (U+E0B0/U+E0B2)
 * and the git-branch glyph (U+E0A0).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    ReadonlyFooterDataProvider,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Powerline glyphs ──────────────────────────────────────────────────────────
const RIGHT_TRIANGLE = "\uE0B0"; // 
const LEFT_TRIANGLE  = "\uE0B2"; // 
const BRANCH_GLYPH   = "\uE0A0"; // 

// ── Config types ──────────────────────────────────────────────────────────────

type SegmentBg =
    | "accent"
    | "success"
    | "warning"
    | "muted"
    | "error"
    | "borderAccent";

type SlotKind = "git-branch" | "cwd" | "extension-status" | "usage" | "cost" | "model";

interface ConfigSlot {
    kind: SlotKind;
    /** Key for extension-status — picks that single extension's status. */
    key?: string;
    /** Background colour override. Falls back to the kind's default. */
    bg?: SegmentBg;
}

interface Config {
    left: ConfigSlot[];
    right: ConfigSlot[];
}

interface Segment {
    text: string;
    bg: SegmentBg;
}

// ── Default config ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Config = {
    left: [
        { kind: "extension-status", key: "vi-mode", bg: "muted" },
        { kind: "git-branch", bg: "success" },
        { kind: "cwd", bg: "warning" },
        { kind: "extension-status", bg: "borderAccent" },
    ],
    right: [
        { kind: "usage", bg: "muted" },
        { kind: "cost", bg: "error" },
        { kind: "model", bg: "accent" },
    ],
};

// ── Config loading ────────────────────────────────────────────────────────────

function tryLoadConfig(cwd: string, isTrusted: boolean): Config | null {
    const candidates: string[] = [];
    if (isTrusted) {
        candidates.push(path.join(cwd, CONFIG_DIR_NAME, "powerline-footer.json"));
    }
    candidates.push(
        path.join(process.env.HOME ?? "~", CONFIG_DIR_NAME, "agent", "extensions", "powerline-footer.json"),
    );

    for (const p of candidates) {
        try {
            const raw = fs.readFileSync(p, "utf-8");
            const parsed: unknown = JSON.parse(raw);
            const cfg = parseConfig(parsed);
            if (cfg) return cfg;
        } catch {
            // missing / unreadable / invalid → try next
        }
    }
    return null;
}

function parseConfig(raw: unknown): Config | null {
    if (raw === null || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.left) || !Array.isArray(obj.right)) return null;

    const left = parseSlots(obj.left);
    const right = parseSlots(obj.right);
    if (!left || !right) return null;

    return { left, right };
}

function parseSlots(arr: unknown[]): ConfigSlot[] | null {
    const out: ConfigSlot[] = [];
    for (const item of arr) {
        if (item === null || typeof item !== "object") return null;
        const s = item as Record<string, unknown>;
        const kind = s.kind;
        if (typeof kind !== "string" || !isSlotKind(kind)) return null;
        const slot: ConfigSlot = { kind };
        if (s.key !== undefined) {
            if (typeof s.key !== "string") return null;
            slot.key = s.key;
        }
        if (s.bg !== undefined) {
            if (typeof s.bg !== "string" || !isSegmentBg(s.bg)) return null;
            slot.bg = s.bg;
        }
        out.push(slot);
    }
    return out;
}

function isSlotKind(v: string): v is SlotKind {
    return ["git-branch", "cwd", "extension-status", "usage", "cost", "model"].includes(v);
}

function isSegmentBg(v: string): v is SegmentBg {
    return ["accent", "success", "warning", "muted", "error", "borderAccent"].includes(v);
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const RESET       = "\x1b[0m";
const DEFAULT_BG  = "\x1b[49m";
const BOLD        = "\x1b[1m";

function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "");
}

function bgAnsi(theme: Theme, color: SegmentBg): string {
    return theme.getFgAnsi(color).replace("38;", "48;");
}

function fgAnsi(theme: Theme, color: SegmentBg): string {
    return theme.getFgAnsi(color);
}

// ── Contrast-aware text colour ────────────────────────────────────────────────

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

function segmentCell(theme: Theme, s: Segment): string {
    return `${bgAnsi(theme, s.bg)}${textFgAnsi(theme, s.bg)}${BOLD} ${s.text} `;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

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

// ── Segment builder ───────────────────────────────────────────────────────────

function createSlotDefaultBg(kind: SlotKind): SegmentBg {
    switch (kind) {
        case "git-branch":       return "success";
        case "cwd":              return "warning";
        case "extension-status": return "borderAccent";
        case "usage":            return "muted";
        case "cost":             return "error";
        case "model":            return "accent";
    }
}

/**
 * Expand config slots into concrete segments, resolving extension-status
 * slots against the live status map.
 */
function buildSegments(
    slots: ConfigSlot[],
    ctx: ExtensionContext,
    footerData: ReadonlyFooterDataProvider,
): Segment[] {
    const statuses = footerData.getExtensionStatuses();
    // Track which extension-status keys are explicitly claimed by a "key" slot
    // so the catch-all (no-key) slot doesn't duplicate them.
    const claimed = new Set<string>();
    const out: Segment[] = [];

    const usage = sumUsage(ctx);

    for (const slot of slots) {
        const bg = slot.bg ?? createSlotDefaultBg(slot.kind);

        switch (slot.kind) {
            case "git-branch": {
                const branch = footerData.getGitBranch();
                if (branch) {
                    out.push({ text: `${BRANCH_GLYPH} ${branch}`, bg });
                }
                break;
            }
            case "cwd": {
                out.push({ text: shortenPath(ctx.cwd), bg });
                break;
            }
            case "extension-status": {
                if (slot.key !== undefined) {
                    // Single extension status
                    claimed.add(slot.key);
                    const raw = statuses.get(slot.key);
                    if (raw) {
                        const text = stripAnsi(raw).trim();
                        if (text) out.push({ text, bg });
                    }
                } else {
                    // Catch-all: all extension statuses not already claimed
                    const parts: string[] = [];
                    for (const [k, raw] of statuses) {
                        if (claimed.has(k)) continue;
                        const text = stripAnsi(raw).trim();
                        if (text) parts.push(text);
                    }
                    if (parts.length > 0) {
                        out.push({ text: parts.join(" · "), bg });
                    }
                }
                break;
            }
            case "usage": {
                out.push({
                    text: `↑${fmt(usage.input)} ↓${fmt(usage.output)}`,
                    bg,
                });
                break;
            }
            case "cost": {
                if (usage.cost > 0) {
                    out.push({ text: `$${usage.cost.toFixed(3)}`, bg });
                }
                break;
            }
            case "model": {
                out.push({ text: ctx.model?.id ?? "no-model", bg });
                break;
            }
        }
    }

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

    // Drop right segments first (least important), then left (keep at least one)
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
    let config: Config = DEFAULT_CONFIG;

    function enable(ctx: ExtensionContext): void {
        if (enabled) return;
        enabled = true;

        // Load config once on first enable
        config = tryLoadConfig(ctx.cwd, ctx.isProjectTrusted()) ?? DEFAULT_CONFIG;

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
                    const left  = buildSegments(config.left, ctx, footerData);
                    const right = buildSegments(config.right, ctx, footerData);
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
