import { REQUEST_TYPE } from "./cli.ts";

interface Message {
    role: string;
    customType?: string;
    details?: unknown;
}

/** Keep each reply associated with its delivered steering request. */
export class HunkRequest {
    readonly requestId: string;
    started = false;
    interrupted = false;
    confirmed = false;
    notified = false;
    attempted = false;

    constructor(requestId: string) { this.requestId = requestId; }

    get canPost(): boolean { return this.started && !this.interrupted; }

    messageStart(message: Message): void {
        const details = message.details as { requestId?: unknown } | undefined;
        if (message.role === "custom" && message.customType === REQUEST_TYPE && details?.requestId === this.requestId) {
            this.started = true;
        } else if (this.started && (message.role === "user" ||
            (message.role === "custom" && message.customType !== REQUEST_TYPE))) {
            this.interrupted = true;
        }
    }
}
