/**
 * CI permissions auto-fix preview.
 *
 * Reads the structured audit produced by `auditCiWorkflow` and returns a
 * suggested edit — never writes. Output formats: `patch`, `markdown`, `json`.
 *
 * Heuristics:
 *  - comment-posting step detected but no `pull-requests: write` → suggest
 *    adding a permissions block.
 *  - `pull-requests: write` requested but no comment-posting step → suggest
 *    narrowing to `contents: read`.
 *  - top-level permissions block missing → suggest the least-privilege
 *    default for the provider.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { ICiPermissionsAudit, CiProviderForAudit } from './ci-permissions.ts';

export const CI_PERMISSIONS_FIX_SCHEMA = 'sharkcraft.ci-permissions-fix/v1';

export type CiPermissionsFixFormat = 'patch' | 'markdown' | 'json';

export interface ICiPermissionsFixHint {
  code:
    | 'add-permissions-block'
    | 'add-pull-requests-write'
    | 'narrow-permissions-block'
    | 'remove-pull-requests-write'
    | 'pin-action-sha'
    | 'pin-image-digest'
    | 'no-action-required';
  severity: 'info' | 'warning' | 'error';
  message: string;
  explanation: string;
  /** Unified-diff style suggestion (best-effort, deterministic). */
  patch?: string;
  /** Plain text that an editor can paste in. */
  insertion?: string;
}

export interface ICiPermissionsFixPreview {
  schema: typeof CI_PERMISSIONS_FIX_SCHEMA;
  provider: CiProviderForAudit;
  workflowFile: string;
  hints: readonly ICiPermissionsFixHint[];
  /** Combined unified diff, or empty if no actionable hint. */
  combinedPatch: string;
}

function leastPrivilegeBlock(provider: CiProviderForAudit, withPullRequestsWrite: boolean): string {
  if (provider === 'github-actions') {
    return withPullRequestsWrite
      ? 'permissions:\n  contents: read\n  pull-requests: write\n'
      : 'permissions:\n  contents: read\n';
  }
  return '# (least-privilege block — provider-specific)\n';
}

function makeAddPermissionsBlockPatch(
  file: string,
  body: string,
  withPullRequestsWrite: boolean,
): string {
  const block = leastPrivilegeBlock('github-actions', withPullRequestsWrite);
  // Insert after the first `name:` line at the top level.
  const lines = body.split(/\r?\n/);
  let nameLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^name:\s+/.test(lines[i]!)) {
      nameLine = i;
      break;
    }
  }
  if (nameLine < 0) nameLine = 0;
  const blockLines = block.split(/\r?\n/).filter((l) => l.length > 0);
  const patch = [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${nameLine + 1},1 +${nameLine + 1},${1 + blockLines.length} @@`,
    ` ${lines[nameLine] ?? ''}`,
    ...blockLines.map((l) => `+${l}`),
  ];
  return patch.join('\n') + '\n';
}

function makeNarrowPermissionsPatch(file: string, body: string): string {
  // Find the broad permission lines and propose replacing each with
  // `contents: read`.
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(contents|pull-requests|issues|deployments|actions):\s*write\b/.exec(lines[i]!);
    if (m) {
      const indent = m[1] ?? '';
      const scope = m[2] ?? 'contents';
      out.push(`--- a/${file}`);
      out.push(`+++ b/${file}`);
      out.push(`@@ -${i + 1},1 +${i + 1},1 @@`);
      out.push(`-${lines[i] ?? ''}`);
      out.push(`+${indent}${scope === 'pull-requests' ? 'pull-requests: read' : 'contents: read'}`);
    }
  }
  return out.length === 0 ? '' : out.join('\n') + '\n';
}

export function buildCiPermissionsFixPreview(audit: ICiPermissionsAudit): ICiPermissionsFixPreview {
  const hints: ICiPermissionsFixHint[] = [];
  if (!audit.exists) {
    hints.push({
      code: 'no-action-required',
      severity: 'error',
      message: 'Workflow file does not exist — nothing to fix.',
      explanation: 'Run `shrk ci scaffold` first to produce a workflow, then re-run the audit.',
    });
    return {
      schema: CI_PERMISSIONS_FIX_SCHEMA,
      provider: audit.provider,
      workflowFile: audit.workflowFile,
      hints,
      combinedPatch: '',
    };
  }
  let body = '';
  try {
    body = existsSync(audit.workflowFile) ? readFileSync(audit.workflowFile, 'utf8') : '';
  } catch {
    body = '';
  }
  const isGha = audit.provider === 'github-actions';
  const missingPermsBlock = audit.findings.some((f) => f.code === 'permissions-block-missing');
  // Case 1: comment-posting requested but no permissions block (or no pull-requests: write).
  if (isGha && audit.postsComments && !audit.requestsWritePermissions) {
    hints.push({
      code: 'add-pull-requests-write',
      severity: 'error',
      message:
        'Workflow posts PR comments but does not declare `pull-requests: write`. The comment step will 403 at runtime.',
      explanation:
        'Add a top-level `permissions:` block with `contents: read` + `pull-requests: write`. Scope to the comment-posting job if possible.',
      patch: body ? makeAddPermissionsBlockPatch(audit.workflowFile, body, true) : undefined,
      insertion: leastPrivilegeBlock(audit.provider, true),
    });
  }
  // Case 2: pull-requests: write requested but no comment-posting step.
  if (isGha && audit.requestsWritePermissions && !audit.postsComments) {
    hints.push({
      code: 'remove-pull-requests-write',
      severity: 'warning',
      message:
        '`pull-requests: write` requested but no comment-posting step detected — narrow to `contents: read`.',
      explanation:
        'Wider permission tokens leak more credentials when an action is compromised. Only enable write scopes on the step that needs them.',
      patch: body ? makeNarrowPermissionsPatch(audit.workflowFile, body) : undefined,
      insertion: leastPrivilegeBlock(audit.provider, false),
    });
  }
  // Case 3: no permissions block at all.
  if (isGha && missingPermsBlock && !audit.postsComments) {
    hints.push({
      code: 'add-permissions-block',
      severity: 'info',
      message:
        'No top-level `permissions:` block — workflow inherits the repository default. Add `contents: read` to lock down the token explicitly.',
      explanation:
        'Even if the repo default looks read-only, explicit permissions blocks are reviewer-friendly and survive default changes.',
      patch: body ? makeAddPermissionsBlockPatch(audit.workflowFile, body, false) : undefined,
      insertion: leastPrivilegeBlock(audit.provider, false),
    });
  }
  // Supply-chain hints.
  if (audit.externalActions.length > 0) {
    hints.push({
      code: 'pin-action-sha',
      severity: 'info',
      message: `Uses ${audit.externalActions.length} external action(s). Pin each to an immutable SHA when reproducibility matters.`,
      explanation:
        'Tag-based references (`@v4`) are mutable. Pinning the action SHA mitigates supply-chain swap-outs.',
    });
  }
  if (audit.externalImages.length > 0) {
    hints.push({
      code: 'pin-image-digest',
      severity: 'info',
      message: `Uses ${audit.externalImages.length} external image(s). Consider pinning by digest.`,
      explanation:
        'Tag-based image references can be rewritten after a vulnerability. Pinning to `@sha256:…` is sturdier.',
    });
  }
  if (hints.length === 0) {
    hints.push({
      code: 'no-action-required',
      severity: 'info',
      message: 'Permissions audit looks tight — no automated fix to suggest.',
      explanation:
        'The workflow already requests least privilege for its detected steps. Continue to review external actions on each upgrade.',
    });
  }
  const combinedPatch = hints
    .map((h) => h.patch)
    .filter((p): p is string => Boolean(p))
    .join('\n');
  return {
    schema: CI_PERMISSIONS_FIX_SCHEMA,
    provider: audit.provider,
    workflowFile: audit.workflowFile,
    hints,
    combinedPatch,
  };
}

export function renderCiPermissionsFixPreview(
  preview: ICiPermissionsFixPreview,
  format: CiPermissionsFixFormat,
): string {
  if (format === 'json') return JSON.stringify(preview, null, 2) + '\n';
  if (format === 'patch') {
    if (preview.combinedPatch) return preview.combinedPatch;
    return '# No actionable diff — see the markdown report for explanation.\n';
  }
  const lines: string[] = [];
  lines.push(`# CI permissions fix preview — \`${preview.workflowFile}\``);
  lines.push('');
  lines.push(`Provider: \`${preview.provider}\``);
  lines.push('');
  for (const h of preview.hints) {
    lines.push(`## ${h.code} _(${h.severity})_`);
    lines.push('');
    lines.push(h.message);
    lines.push('');
    lines.push(h.explanation);
    if (h.insertion) {
      lines.push('');
      lines.push('Suggested insertion:');
      lines.push('');
      lines.push('```yaml');
      lines.push(h.insertion.trimEnd());
      lines.push('```');
    }
    if (h.patch) {
      lines.push('');
      lines.push('Suggested patch:');
      lines.push('');
      lines.push('```diff');
      lines.push(h.patch.trimEnd());
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}
