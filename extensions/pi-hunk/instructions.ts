export const HUNK_SKILL_INSTRUCTIONS = "Read the hunk-review skill unless its instructions are already in context. If its location is not listed, use bash to run `hunk skill path` and read the returned file.";

export const HUNK_INSTRUCTIONS = `Address the Hunk comment below. When done, use bash to run the supplied reply command, replacing REPLY with your shell-quoted answer. Keep Hunk comments and replies out of chat, including acknowledgments; the extension reports delivery or failure. Continue other pending work. Use one literal command, without shell substitutions or chaining.`;
