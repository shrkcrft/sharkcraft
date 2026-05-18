import { AiMessageRole } from "../ai-request.js";
export function buildPromptMessages(input) {
    const messages = [];
    const systemParts = [];
    if (input.systemPreamble)
        systemParts.push(input.systemPreamble.trim());
    if (input.context) {
        systemParts.push('## Repository context\n\nUse this context as authoritative ground truth.\n\n' +
            input.context.trim());
    }
    if (systemParts.length) {
        messages.push({ role: AiMessageRole.System, content: systemParts.join('\n\n') });
    }
    const userContent = input.userMessage
        ? `${input.task}\n\n${input.userMessage}`
        : input.task;
    messages.push({ role: AiMessageRole.User, content: userContent });
    return messages;
}
