import { LIMITS } from './config/limits.ts';

export interface ISanitizedIssue {
  number: number;
  title: string;
  body: string;
  authorLogin: string;
}

export interface IRawIssue {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
}

const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const ZWJ_BIDI_RE = /[​-‏‪-‮⁠-⁩]/g;
const TRUNCATION_MARKER = ' …[truncated]';

function truncateBytes(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  if (bytes.length <= maxBytes) return input;

  const markerBytes = encoder.encode(TRUNCATION_MARKER);
  let cutoff = Math.max(0, maxBytes - markerBytes.length);
  // Walk back to a valid UTF-8 boundary so we never split a multibyte char.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (cutoff > 0) {
    try {
      const decoded = decoder.decode(bytes.subarray(0, cutoff));
      return decoded + TRUNCATION_MARKER;
    } catch {
      cutoff -= 1;
    }
  }
  return TRUNCATION_MARKER;
}

function stripUnsafeChars(s: string): string {
  return s.replace(CONTROL_CHARS_RE, '').replace(ZWJ_BIDI_RE, '');
}

function neutralizeFences(s: string): string {
  // Defang any standalone triple-backtick lines so issue content cannot break
  // out of the wrapping fence in the prompt template.
  return s.replace(/(^|\n)```/g, '$1\\`\\`\\`');
}

export function sanitize(issue: IRawIssue): ISanitizedIssue {
  const rawTitle = issue.title ?? '';
  const rawBody = issue.body ?? '';
  const title = stripUnsafeChars(truncateBytes(rawTitle, LIMITS.maxIssueTitleBytes));
  const body = neutralizeFences(stripUnsafeChars(truncateBytes(rawBody, LIMITS.maxIssueBodyBytes)));
  return {
    number: issue.number,
    title,
    body,
    authorLogin: issue.user.login,
  };
}
