import { AiMessageRole, type IAiMessage } from '../ai-request.ts';

export interface BuildPromptInput {
  systemPreamble?: string;
  context?: string;
  task: string;
  userMessage?: string;
}

export function buildPromptMessages(input: BuildPromptInput): IAiMessage[] {
  const messages: IAiMessage[] = [];
  const systemParts: string[] = [];
  if (input.systemPreamble) systemParts.push(input.systemPreamble.trim());
  if (input.context) {
    systemParts.push(
      '## Repository context\n\nUse this context as authoritative ground truth.\n\n' +
        input.context.trim(),
    );
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
