import { MODEL_ID } from '../config/model.ts';
import { AgentError, ErrorCategory } from '../errors.ts';
import type { IAgentRunInput, IAgentRunOutput, IAgentRunner } from './types.ts';

export interface IClaudePlanRunnerConfig {
  apiKey: string;
  systemPrompt: string;
  userPromptTemplate: string;
  fetchFn?: typeof fetch;
}

interface IAnthropicTextBlock {
  type: string;
  text?: string;
}

interface IAnthropicResponse {
  content?: IAnthropicTextBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Conservative byte->token heuristic for the pre-call cap (~1 token per 4 chars).
const BYTES_PER_TOKEN = 4;

export class ClaudePlanRunner implements IAgentRunner {
  private readonly apiKey: string;
  private readonly systemPrompt: string;
  private readonly userPromptTemplate: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: IClaudePlanRunnerConfig) {
    this.apiKey = config.apiKey;
    this.systemPrompt = config.systemPrompt;
    this.userPromptTemplate = config.userPromptTemplate;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  async run(input: IAgentRunInput): Promise<IAgentRunOutput> {
    const userMessage = this.buildUserMessage(input);

    const estimatedTokens = Math.ceil(
      (this.systemPrompt.length + userMessage.length) / BYTES_PER_TOKEN,
    );
    if (estimatedTokens > input.limits.maxInputTokens) {
      throw new AgentError(
        ErrorCategory.RunnerTokenLimit,
        `estimated ${estimatedTokens} input tokens exceeds cap ${input.limits.maxInputTokens}`,
      );
    }

    const start = Date.now();
    let res: Response;
    try {
      res = await this.fetchFn(ANTHROPIC_URL, {
        method: 'POST',
        signal: input.signal,
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL_ID,
          max_tokens: input.limits.maxOutputTokens,
          system: this.systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new AgentError(
          ErrorCategory.RunnerTimeout,
          'Anthropic call aborted before completion',
          err,
        );
      }
      throw new AgentError(
        ErrorCategory.RunnerApiError,
        `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AgentError(
        ErrorCategory.RunnerApiError,
        `Anthropic API ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    const data = (await res.json()) as IAnthropicResponse;
    const text = (data.content ?? [])
      .filter((c): c is { type: string; text: string } => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');

    if (!text.trim()) {
      throw new AgentError(ErrorCategory.RunnerApiError, 'empty response content from Anthropic');
    }

    return {
      commentMarkdown: text,
      telemetry: {
        modelId: MODEL_ID,
        inputTokens: data.usage?.input_tokens ?? null,
        outputTokens: data.usage?.output_tokens ?? null,
        durationMs: Date.now() - start,
      },
    };
  }

  private buildUserMessage(input: IAgentRunInput): string {
    const replacements: Record<string, string> = {
      '{{REPO_CONTEXT}}': input.context.shrkTaskOutput,
      '{{ISSUE_NUMBER}}': String(input.issue.number),
      '{{ISSUE_AUTHOR}}': input.issue.authorLogin,
      '{{ISSUE_TITLE}}': input.issue.title,
      '{{ISSUE_BODY}}': input.issue.body,
    };
    let out = this.userPromptTemplate;
    for (const [key, value] of Object.entries(replacements)) {
      out = out.split(key).join(value);
    }
    return out;
  }
}
