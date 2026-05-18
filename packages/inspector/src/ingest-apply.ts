/**
 * Ingest adoption apply plan.
 *
 * Builds a `sharkcraft.plan/v1` plan (compatible with the existing
 * generator + apply pipeline) that materialises selected entries from an
 * `IIngestAdoptionPlan`. The plan only targets `sharkcraft/**` and
 * `sharkcraft/docs/tasks/**` — nothing else.
 *
 * Default is dry-run. `shrk ingest adopt apply <plan>` is the explicit
 * write step and goes through `shrk apply --verify-signature`, inheriting
 * every existing plan-safety guarantee.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { createHmac } from 'node:crypto';
import {
  IngestAdoptionStatus,
  type IIngestAdoptionPlan,
} from './ingest-adoption.ts';
import { extractIngestBody } from './ingest-body-extractor.ts';

export const INGEST_APPLY_PLAN_SCHEMA = 'sharkcraft.plan/v1';

export type IngestApplyChangeType = 'create' | 'append';

export interface IIngestApplyExpectedChange {
  type: IngestApplyChangeType;
  relativePath: string;
  sizeBytes: number;
}

export interface IIngestApplyPlan {
  schema: typeof INGEST_APPLY_PLAN_SCHEMA;
  templateId: 'ingest.adopt';
  variables: Readonly<Record<string, string>>;
  projectRoot: string;
  createdAt: string;
  expectedChanges: readonly IIngestApplyExpectedChange[];
  note?: string;
  signature?: {
    algo: 'sha256';
    hmac: string;
    signedAt: string;
  };
}

const ALLOWED_TARGET_DIRS: readonly string[] = [
  'sharkcraft/',
  'sharkcraft/docs/tasks/',
];

export interface IBuildIngestApplyPlanOptions {
  plan: IIngestAdoptionPlan;
  /** Statuses that are eligible — default ['safe-append']. */
  include?: readonly IngestAdoptionStatus[];
  /** Optional: include manual-review entries (will appear in the plan but with operation note). */
  includeManualReview?: boolean;
  /** Note that lands inside the plan file. */
  note?: string;
  /**
   * When true, attempt to extract the real entry body from the
   * originating draft TS file (sharkcraft/ingestion/generated/<X>.draft.ts).
   * Falls back to the comment stub if extraction is unsafe.
   */
  includeBody?: boolean;
}

export interface IIngestBodyStatus {
  entryId: string;
  target: string;
  status: 'materialised' | 'stubbed' | 'skipped' | 'conflict';
  reason?: string;
}

export interface IBuildIngestApplyPlanResult {
  plan: IIngestApplyPlan;
  /** Bodies the apply step should write, keyed by relative path. */
  files: Readonly<Record<string, string>>;
  /** Entries that were skipped, with a reason. */
  skipped: readonly { entryId: string; target: string; reason: string }[];
  /** Per-entry body extraction status. */
  bodyStatuses?: readonly IIngestBodyStatus[];
}

function ensureSafeTarget(target: string): boolean {
  const normalized = target.replace(/\\/g, '/');
  if (normalized.includes('..')) return false;
  if (nodePath.isAbsolute(normalized)) return false;
  for (const prefix of ALLOWED_TARGET_DIRS) {
    if (normalized.startsWith(prefix)) return true;
  }
  return false;
}

function bodyFor(entry: { id: string; kind: string; reason: string; bodyExcerpt?: string }): string {
  if (entry.bodyExcerpt && entry.bodyExcerpt.length > 0) return entry.bodyExcerpt + '\n';
  // Conservative inline snippet: record the entry id + reason as a comment so
  // append is always safe to read by humans.
  const safeReason = entry.reason.replace(/\*\//g, '*\\/');
  return [
    `// ingest-adopt — ${entry.id} (${entry.kind})`,
    `// reason: ${safeReason}`,
    '',
  ].join('\n');
}

export function buildIngestApplyPlan(
  options: IBuildIngestApplyPlanOptions,
): IBuildIngestApplyPlanResult {
  const include = new Set(options.include ?? [IngestAdoptionStatus.SafeAppend]);
  if (options.includeManualReview) include.add(IngestAdoptionStatus.ManualReview);

  const files: Record<string, string> = {};
  const skipped: { entryId: string; target: string; reason: string }[] = [];
  const bodyStatuses: IIngestBodyStatus[] = [];
  const grouped = new Map<string, string[]>();

  for (const entry of options.plan.entries) {
    if (!include.has(entry.status)) {
      skipped.push({ entryId: entry.id, target: entry.target, reason: `status ${entry.status} not in include set` });
      continue;
    }
    if (!ensureSafeTarget(entry.target)) {
      skipped.push({ entryId: entry.id, target: entry.target, reason: 'target outside sharkcraft/ — refused' });
      continue;
    }
    // When --include-body is requested, attempt to materialise the
    // real entry body from the draft TS file.
    let resolved: { id: string; kind: string; reason: string; bodyExcerpt?: string } = entry;
    if (options.includeBody) {
      const ext = extractIngestBody({
        projectRoot: options.plan.projectRoot,
        target: entry.target,
        entryId: entry.id,
      });
      if (ext.status === 'materialised' && ext.body) {
        resolved = { ...entry, bodyExcerpt: ext.body };
        bodyStatuses.push({ entryId: entry.id, target: entry.target, status: 'materialised' });
      } else {
        bodyStatuses.push({
          entryId: entry.id,
          target: entry.target,
          status: ext.status === 'materialised' ? 'stubbed' : ext.status,
          ...(ext.reason ? { reason: ext.reason } : {}),
        });
      }
    }
    const cur = grouped.get(entry.target) ?? [];
    cur.push(bodyFor(resolved));
    grouped.set(entry.target, cur);
  }

  const expectedChanges: IIngestApplyExpectedChange[] = [];
  for (const [target, chunks] of grouped) {
    const body = chunks.join('\n');
    files[target] = body;
    expectedChanges.push({
      type: 'append',
      relativePath: target,
      sizeBytes: Buffer.byteLength(body, 'utf8'),
    });
  }

  const plan: IIngestApplyPlan = {
    schema: INGEST_APPLY_PLAN_SCHEMA,
    templateId: 'ingest.adopt',
    variables: { source: 'ingest-adopt' },
    projectRoot: options.plan.projectRoot,
    createdAt: new Date().toISOString(),
    expectedChanges,
    ...(options.note ? { note: options.note } : {}),
  };

  return {
    plan,
    files,
    skipped,
    ...(bodyStatuses.length > 0 ? { bodyStatuses } : {}),
  };
}

function canonicalJson(plan: IIngestApplyPlan): string {
  // Strip signature; sort keys for deterministic HMAC.
  const { signature: _sig, ...rest } = plan;
  void _sig;
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortKeys((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(rest));
}

export function signIngestApplyPlan(plan: IIngestApplyPlan, secret: string): IIngestApplyPlan {
  const body = canonicalJson(plan);
  const hmac = createHmac('sha256', secret).update(body).digest('hex');
  return {
    ...plan,
    signature: { algo: 'sha256', hmac, signedAt: new Date().toISOString() },
  };
}

export function verifyIngestApplyPlan(plan: IIngestApplyPlan, secret: string): boolean {
  if (!plan.signature) return false;
  const body = canonicalJson(plan);
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return expected === plan.signature.hmac;
}

export function saveIngestApplyPlan(plan: IIngestApplyPlan, file: string): void {
  const dir = nodePath.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(plan, null, 2) + '\n', 'utf8');
}

export function loadIngestApplyPlan(file: string): IIngestApplyPlan | null {
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if ((parsed as { schema?: string }).schema !== INGEST_APPLY_PLAN_SCHEMA) return null;
    return parsed as IIngestApplyPlan;
  } catch {
    return null;
  }
}

export function renderIngestApplyReviewMarkdown(plan: IIngestApplyPlan): string {
  const lines: string[] = [];
  lines.push('# Ingest adopt — review');
  lines.push('');
  lines.push(`- Project root: \`${plan.projectRoot}\``);
  lines.push(`- Template: \`${plan.templateId}\``);
  lines.push(`- Files touched: **${plan.expectedChanges.length}**`);
  if (plan.signature) lines.push(`- Signature: \`${plan.signature.algo}\` (signed at ${plan.signature.signedAt})`);
  else lines.push(`- Signature: _none — set SHARKCRAFT_PLAN_SECRET to sign_`);
  lines.push('');
  lines.push('| Target | Op | Bytes |');
  lines.push('|---|---|---|');
  for (const c of plan.expectedChanges) {
    lines.push(`| \`${c.relativePath}\` | ${c.type} | ${c.sizeBytes} |`);
  }
  lines.push('');
  lines.push('Apply with:');
  lines.push('');
  lines.push('```');
  lines.push('shrk ingest adopt apply <plan.json> --verify-signature');
  lines.push('```');
  return lines.join('\n');
}

export interface IApplyIngestPlanOptions {
  plan: IIngestApplyPlan;
  files: Readonly<Record<string, string>>;
  requireSignature?: boolean;
  secret?: string;
}

export interface IApplyIngestPlanResult {
  applied: readonly { path: string; bytesWritten: number }[];
  skipped: readonly { path: string; reason: string }[];
}

export function applyIngestPlan(opts: IApplyIngestPlanOptions): IApplyIngestPlanResult {
  if (opts.requireSignature) {
    if (!opts.secret) throw new Error('signature required but SHARKCRAFT_PLAN_SECRET is not set');
    if (!verifyIngestApplyPlan(opts.plan, opts.secret)) throw new Error('plan signature invalid');
  }
  const applied: { path: string; bytesWritten: number }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const change of opts.plan.expectedChanges) {
    if (!ensureSafeTarget(change.relativePath)) {
      skipped.push({ path: change.relativePath, reason: 'unsafe target — refused' });
      continue;
    }
    const abs = nodePath.join(opts.plan.projectRoot, change.relativePath);
    const dir = nodePath.dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const body = opts.files[change.relativePath] ?? '';
    if (change.type === 'append' && existsSync(abs)) {
      const current = readFileSync(abs, 'utf8');
      const next = current.endsWith('\n') ? current + body : current + '\n' + body;
      writeFileSync(abs, next, 'utf8');
      applied.push({ path: abs, bytesWritten: Buffer.byteLength(body, 'utf8') });
    } else {
      writeFileSync(abs, body, 'utf8');
      applied.push({ path: abs, bytesWritten: Buffer.byteLength(body, 'utf8') });
    }
  }
  return { applied, skipped };
}
