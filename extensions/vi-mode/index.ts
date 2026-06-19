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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ViEditor } from "./editor";

export default function (pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {
        // Capture the full live Theme (reflects theme switches / hot-reload) so the
        // editor can use colors beyond the EditorTheme's borderColor (e.g. `dim`).
        const fullTheme = ctx.ui.theme;
        const setStatus = (text: string | undefined) => ctx.ui.setStatus("vi-mode", text);
        ctx.ui.setEditorComponent((tui, theme, kb) => new ViEditor(tui, theme, kb, fullTheme, setStatus));
    });

    pi.on("session_shutdown", (_event, ctx) => {
        ctx.ui.setStatus("vi-mode", undefined);
    });
}
