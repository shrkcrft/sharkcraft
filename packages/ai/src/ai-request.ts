export enum AiMessageRole {
  System = 'system',
  User = 'user',
  Assistant = 'assistant',
}

export interface IAiMessage {
  role: AiMessageRole;
  content: string;
}

export interface IAiRequest {
  messages: readonly IAiMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  context?: string;
  responseFormat?: IAiResponseFormat;
  /**
   * Optional callback invoked with each newly-decoded token chunk as
   * generation streams in. Providers that don't natively stream
   * (HTTP Gemini / Claude in our non-SSE adapter) ignore this; the
   * llamacpp provider forwards chunks live. Useful for stderr "live
   * preview" in CLI commands and for an agent who wants to display
   * progress without the synchronous wait.
   */
  onTokenStream?: (chunk: string) => void;
  /**
   * Per-call wall-clock timeout in milliseconds. When set and exceeded, the
   * provider aborts the in-flight request and returns an `AppError` with code
   * `TIMEOUT`. Bounds slow local models so a single call can never hang the
   * command. Takes precedence over the provider's `config.timeoutMs`; when
   * neither is set, no timeout is applied.
   */
  timeoutMs?: number;
}

export interface IAiResponse {
  content: string;
  model: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  raw?: unknown;
}

export interface IAiProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export interface IAiResponseFormat {
  type: 'json_object' | 'json_schema';
  schema?: Record<string, unknown>;
  schemaName?: string;
}
