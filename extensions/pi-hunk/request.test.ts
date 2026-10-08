import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_TYPE } from "./cli.ts";
import { HunkRequest } from "./request.ts";

function start(request: HunkRequest, id = request.requestId) {
    request.messageStart({ role: "custom", customType: REQUEST_TYPE, details: { requestId: id } });
}

test("posting is scoped to the matching main-agent request, not earlier foreground work", () => {
    const request = new HunkRequest("ours");
    request.messageStart({ role: "user" });
    start(request, "other");
    assert(!request.canPost);
    start(request);
    assert(request.canPost);
});

test("delivered steering/custom input prevents subsequent posting for the old comment", () => {
    for (const role of ["user", "custom"]) {
        const request = new HunkRequest("ours");
        start(request);
        request.messageStart({ role, details: null });
        assert(!request.canPost);
        start(request); // A duplicate old marker cannot reset a takeover.
        assert(!request.canPost);
    }
});

test("later takeover cannot undo delivery or erase its notification", () => {
    const request = new HunkRequest("ours");
    start(request);
    assert(!request.confirmed && !request.notified);
    request.confirmed = request.notified = true;
    request.messageStart({ role: "user" });
    assert(request.confirmed && request.notified);
    assert(!request.canPost);
});
