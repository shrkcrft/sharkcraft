import { AgentError, ErrorCategory } from './errors.ts';

export interface IPostIssueCommentOptions {
  fetchFn?: typeof fetch;
  token?: string;
  repository?: string;
}

export async function postIssueComment(
  issueNumber: number,
  body: string,
  options: IPostIssueCommentOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const repo = options.repository ?? process.env.GITHUB_REPOSITORY;

  if (!token) {
    throw new AgentError(ErrorCategory.CommentPostFailed, 'GITHUB_TOKEN is not set');
  }
  if (!repo) {
    throw new AgentError(ErrorCategory.CommentPostFailed, 'GITHUB_REPOSITORY is not set');
  }

  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'sharkcraft-ai-issue-agent',
      },
      body: JSON.stringify({ body }),
    });
  } catch (err) {
    throw new AgentError(
      ErrorCategory.CommentPostFailed,
      `GitHub fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AgentError(
      ErrorCategory.CommentPostFailed,
      `GitHub API ${res.status}: ${text.slice(0, 500)}`,
    );
  }
}
