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
