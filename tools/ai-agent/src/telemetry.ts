export interface ITelemetryRecord {
  mode: 'plan' | 'implement';
  model: string;
  runUrl: string;
  tokens: number | null;
}

export function buildRunUrl(env: NodeJS.ProcessEnv = process.env): string {
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const repo = env.GITHUB_REPOSITORY ?? '';
  const runId = env.GITHUB_RUN_ID ?? '';
  if (!repo || !runId) return server;
  return `${server}/${repo}/actions/runs/${runId}`;
}

function formatTokens(tokens: number | null): string {
  return tokens != null ? `~${tokens.toLocaleString()}` : '—';
}

export function formatTelemetryComment(t: ITelemetryRecord): string {
  return `\n\n---\nmode: ${t.mode} | model: ${t.model} | tokens: ${formatTokens(t.tokens)} | run: ${t.runUrl}\n`;
}

export function formatTelemetrySummary(t: ITelemetryRecord): string {
  return [
    '### AI Issue Run',
    '',
    `- mode: \`${t.mode}\``,
    `- model: \`${t.model}\``,
    `- tokens: ${formatTokens(t.tokens)}`,
    `- run: ${t.runUrl}`,
    '',
  ].join('\n');
}
