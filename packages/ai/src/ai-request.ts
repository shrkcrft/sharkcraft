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
