import assert from "node:assert/strict";
import { test } from "node:test";
import { HUNK_INSTRUCTIONS } from "./instructions.ts";

test("the injected prompt stays minimal and explains skill loading and reply routing", () => {
    assert(HUNK_INSTRUCTIONS.split(/\s+/).length <= 100);
    assert.match(HUNK_INSTRUCTIONS, /hunk-review skill/);
    assert.match(HUNK_INSTRUCTIONS, /already in context/);
    assert.match(HUNK_INSTRUCTIONS, /hunk skill path/);
    assert.match(HUNK_INSTRUCTIONS, /use bash/);
    assert.match(HUNK_INSTRUCTIONS, /reply command/);
    assert.match(HUNK_INSTRUCTIONS, /out of chat/);
    assert.match(HUNK_INSTRUCTIONS, /including acknowledgments/);
    assert.match(HUNK_INSTRUCTIONS, /Continue other pending work/);
    assert.match(HUNK_INSTRUCTIONS, /extension reports delivery or failure/);
    assert.match(HUNK_INSTRUCTIONS, /without shell substitutions or chaining/);
});
