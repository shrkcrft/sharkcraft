export const LIMITS = {
  maxIssueTitleBytes: 512,
  maxIssueBodyBytes: 16 * 1024,
  maxShrkContextBytes: 64 * 1024,
  maxInputTokens: 150_000,
  maxOutputTokens: 8_192,
  runnerDeadlineMs: 10 * 60 * 1000,
  shrkTaskTimeoutMs: 60 * 1000,
} as const;
