import assert from "node:assert/strict";
import { test } from "node:test";
import { isReplyCommand, parseReplyCommand, replyCommand, shellQuote } from "./cli.ts";

const id = "00000000-0000-4000-8000-000000000001";

test("literal reply commands round-trip quotes, Unicode, newlines and shell-looking text", () => {
    for (const body of ["A concise answer", "Don't interpolate $(touch nope); `echo oops`\nSecond line ✓", "'\"\\$;&|<>[]{}*?~#"]) {
        const command = replyCommand(id, "session:'one", "user:1", body);
        assert(isReplyCommand(command));
        assert.deepEqual(parseReplyCommand(command), { requestId: id, sessionId: "session:'one", noteId: "user:1", summary: body });
    }
    assert.equal(shellQuote("don't"), "'don'\\''t'");
    assert(!isReplyCommand("hunk session list --json"));
    assert(!isReplyCommand(undefined));
});

test("markerless literal replies are recognized without weakening command validation", () => {
    const marked = replyCommand(id, "s", "n", "Don't interpolate $HOME");
    const plain = marked.slice(marked.indexOf("\n") + 1);
    assert(isReplyCommand(plain));
    assert.deepEqual(parseReplyCommand(plain), { requestId: undefined, sessionId: "s", noteId: "n", summary: "Don't interpolate $HOME" });
    assert(isReplyCommand(plain.replace("--author pi-hunk", "--author 'pi-hunk'")));
    assert(!isReplyCommand(plain.replace("--author pi-hunk", "--author human")));
    for (const suffix of ["; echo nope", "\necho nope", " > file", " && true"]) {
        assert(isReplyCommand(plain + suffix));
        assert.throws(() => parseReplyCommand(plain + suffix));
    }
});

test("supported literal quoting and option reordering retain the exact reply", () => {
    const command = "# pi-hunk-reply:" + id + '\nhunk session comment add s --json --author pi-hunk --summary "Dollar \\$HOME and \\`tick\\`" --reply-to n';
    assert.equal(parseReplyCommand(command).summary, "Dollar $HOME and `tick`");
    const apostrophe = `# pi-hunk-reply:${id}\nhunk session comment add s --reply-to n --summary 'don'"'"'t' --author pi-hunk --json`;
    assert.equal(parseReplyCommand(apostrophe).summary, "don't");
});

test("rejects substitutions, shell operators, extra commands, wrong flags and empty replies", () => {
    const good = replyCommand(id, "s", "n", "Answer");
    for (const command of [good + "; echo nope", good + "\necho nope", good + " | cat", good + " > file",
        good + " && true", good + " --summary 'Other'", good.replace("--author pi-hunk", "--author human"),
        good.replace("'Answer'", "\"$(echo body)\""), good.replace("'Answer'", "\"$BODY\""),
        good.replace("'Answer'", "`echo body`"), good.replace("'Answer'", "<(echo body)"),
        good.replace("'Answer'", "*.md"), good.replace("'Answer'", "' '"),
        good.replace("hunk session", "env hunk session"), good.replace("--json", ""),
        good.replace("'Answer'", "'Unclosed"), good.replace(id, "not-a-request-id")]) {
        assert.throws(() => parseReplyCommand(command));
    }
    assert.throws(() => parseReplyCommand(replyCommand(id, "s", "n", "x".repeat(65537))), /shorter/);
});
