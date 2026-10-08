import assert from "node:assert/strict";
import { test } from "node:test";
import { HUNK_INSTRUCTIONS } from "./instructions.ts";

test("the injected prompt stays minimal and only explains reply routing", () => {
    assert(HUNK_INSTRUCTIONS.split(/\s+/).length <= 60);
    assert.match(HUNK_INSTRUCTIONS, /use bash/);
    assert.match(HUNK_INSTRUCTIONS, /reply command/);
    assert.match(HUNK_INSTRUCTIONS, /out of chat/);
    assert.match(HUNK_INSTRUCTIONS, /Finish without a chat response/);
    assert.match(HUNK_INSTRUCTIONS, /extension reports delivery or failure/);
    assert.match(HUNK_INSTRUCTIONS, /without shell substitutions or chaining/);
});
