export enum ErrorCategory {
  ContextCollectionFailed = 'context_collection_failed',
  RunnerTokenLimit = 'runner_token_limit',
  RunnerTimeout = 'runner_timeout',
  RunnerApiError = 'runner_api_error',
  CommentPostFailed = 'comment_post_failed',
  UnknownError = 'unknown_error',
}

export class AgentError extends Error {
  public readonly category: ErrorCategory;
  public readonly cause: unknown;

  constructor(category: ErrorCategory, message: string, cause?: unknown) {
    super(message);
    this.name = 'AgentError';
    this.category = category;
    this.cause = cause;
  }
}

export function classify(err: unknown): ErrorCategory {
  if (err instanceof AgentError) return err.category;
  if (err instanceof Error && err.name === 'AbortError') {
    return ErrorCategory.RunnerTimeout;
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return ErrorCategory.RunnerTimeout;
  }
  return ErrorCategory.UnknownError;
}
