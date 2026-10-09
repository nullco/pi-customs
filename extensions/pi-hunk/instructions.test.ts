import assert from "node:assert/strict";
import { test } from "node:test";
import { HUNK_INSTRUCTIONS } from "./instructions.ts";

test("the injected prompt stays brief and preserves reply routing", () => {
    assert(HUNK_INSTRUCTIONS.split(/\s+/).length <= 100);
    assert.match(HUNK_INSTRUCTIONS, /use bash/);
    assert.match(HUNK_INSTRUCTIONS, /reply command/);
    assert.match(HUNK_INSTRUCTIONS, /out of chat/);
    assert.match(HUNK_INSTRUCTIONS, /including acknowledgments/);
    assert.match(HUNK_INSTRUCTIONS, /Continue other pending work/);
    assert.match(HUNK_INSTRUCTIONS, /extension reports delivery or failure/);
    assert.match(HUNK_INSTRUCTIONS, /without shell substitutions or chaining/);
});

test("reply guidance favors concise, readable answers", () => {
    assert.match(HUNK_INSTRUCTIONS, /clear and concise/);
    assert.match(HUNK_INSTRUCTIONS, /plain language, short sentences/);
    assert.match(HUNK_INSTRUCTIONS, /paragraph breaks or bullets when helpful/);
    assert.match(HUNK_INSTRUCTIONS, /Avoid unexplained jargon and dense shorthand/);
});
