/**
 * Templates update apply splicer.
 *
 * Mutates an existing template literal in place by replacing or inserting
 * top-level fields. Used by `shrk templates update --apply`.
 *
 * Supported top-level fields:
 *   - `name`, `description` (scalar strings)
 *   - `tags`, `scope`, `appliesWhen`, `related` (string arrays)
 *
 * Array merge modes:
 *   - Array fields accept `{ mode: 'add' | 'remove' | 'set', values }`. A
 *     bare array is treated as `{ mode: 'set', values }` for back-compat.
 *     `add` merges (dedupe, preserve original order, append new),
 *     `remove` drops matching values, `set` is wholesale replace.
 *   - `metadata.*` nested merge. Known scalar fields (booleans,
 *     numbers, strings) replace; known string-array fields
 *     (`requiredAnchors`, `requiredProfileIds`, `forbiddenPathFragments`,
 *     `requiredVerificationCommandIds`) accept add/remove/set the same
 *     way top-level arrays do.
 *
 * Refused:
 *   - `files`, `changes`, `targetPath`, `content` — function resolvers.
 *   - `variables` — structural, not a simple replacement target.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  findEntryRange,
  findNestedObjectRange,
  readStringArrayField,
  upsertScalarField,
  type IEntryRange,
} from './entry-mutator.ts';

export type StringArrayOp =
  | readonly string[]
  | { readonly mode: 'add' | 'remove' | 'set'; readonly values: readonly string[] };

export type MetadataArrayField =
  | 'requiredAnchors'
  | 'requiredProfileIds'
  | 'forbiddenPathFragments'
  | 'requiredVerificationCommandIds';

export type MetadataScalarField =
  | 'priority'
  | 'maturity'
  | 'dryRunOnly'
  | 'requiresApproval';

export interface ITemplateUpdateApplyInput {
  readonly cwd: string;
  readonly targetPath: string;
  readonly templateId: string;
  readonly fields: {
    readonly name?: string;
    readonly description?: string;
    readonly tags?: StringArrayOp;
    readonly scope?: StringArrayOp;
    readonly appliesWhen?: StringArrayOp;
    readonly related?: StringArrayOp;
    readonly metadata?: {
      readonly [K in MetadataScalarField]?: string | number | boolean;
    } & {
      readonly [K in MetadataArrayField]?: StringArrayOp;
    };
  };
  readonly write: boolean;
}

export interface ITemplateUpdateApplyResult {
  readonly ok: boolean;
  readonly refusal?: string;
  readonly targetAbs: string;
  readonly templateId: string;
  readonly originalLength: number;
  readonly nextLength: number;
  readonly fieldChanges: ReadonlyArray<{
    field: string;
    mode: 'replace' | 'insert';
    /** For arrays, the merge mode the caller asked for. */
    arrayMode?: 'add' | 'remove' | 'set';
  }>;
  readonly diff?: string;
  readonly wrote: boolean;
}

function normaliseArrayOp(op: StringArrayOp): { mode: 'add' | 'remove' | 'set'; values: readonly string[] } {
  if (Array.isArray(op)) return { mode: 'set', values: op };
  const o = op as { mode: 'add' | 'remove' | 'set'; values: readonly string[] };
  return { mode: o.mode, values: o.values };
}

function mergeArray(
  current: readonly string[] | null,
  op: { mode: 'add' | 'remove' | 'set'; values: readonly string[] },
): readonly string[] {
  if (op.mode === 'set') return op.values;
  const base = current ?? [];
  if (op.mode === 'add') {
    const set = new Set(base);
    const out = [...base];
    for (const v of op.values) {
      if (!set.has(v)) {
        out.push(v);
        set.add(v);
      }
    }
    return out;
  }
  // mode === 'remove'
  const removeSet = new Set(op.values);
  return base.filter((v) => !removeSet.has(v));
}

function escapesCwd(cwd: string, absPath: string): boolean {
  const rel = nodePath.relative(cwd, absPath);
  return rel.startsWith('..') || nodePath.isAbsolute(rel);
}

function buildUnifiedDiff(rel: string, a: string, b: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  let prefix = 0;
  while (prefix < aLines.length && prefix < bLines.length && aLines[prefix] === bLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < aLines.length - prefix &&
    suffix < bLines.length - prefix &&
    aLines[aLines.length - 1 - suffix] === bLines[bLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const aMid = aLines.slice(prefix, aLines.length - suffix);
  const bMid = bLines.slice(prefix, bLines.length - suffix);
  const head = `--- ${rel}\n+++ ${rel}\n@@ -${prefix + 1},${aMid.length} +${prefix + 1},${bMid.length} @@\n`;
  return (
    head +
    aMid.map((l) => `-${l}`).join('\n') +
    (aMid.length ? '\n' : '') +
    bMid.map((l) => `+${l}`).join('\n')
  );
}

export function applyTemplateUpdate(
  input: ITemplateUpdateApplyInput,
): ITemplateUpdateApplyResult {
  const cwd = nodePath.resolve(input.cwd);
  const targetAbs = nodePath.resolve(cwd, input.targetPath);
  if (escapesCwd(cwd, targetAbs)) {
    return {
      ok: false,
      refusal: `Target path escapes the project root (cwd=${cwd}).`,
      targetAbs,
      templateId: input.templateId,
      originalLength: 0,
      nextLength: 0,
      fieldChanges: [],
      wrote: false,
    };
  }
  if (!existsSync(targetAbs)) {
    return {
      ok: false,
      refusal: `Target file not found: ${targetAbs}`,
      targetAbs,
      templateId: input.templateId,
      originalLength: 0,
      nextLength: 0,
      fieldChanges: [],
      wrote: false,
    };
  }
  const body = readFileSync(targetAbs, 'utf8');
  let workingBody = body;
  let range = findEntryRange(workingBody, input.templateId);
  if (!range) {
    return {
      ok: false,
      refusal: `Template "${input.templateId}" not found in ${nodePath.relative(cwd, targetAbs)}.`,
      targetAbs,
      templateId: input.templateId,
      originalLength: body.length,
      nextLength: body.length,
      fieldChanges: [],
      wrote: false,
    };
  }
  const fieldChanges: { field: string; mode: 'replace' | 'insert'; arrayMode?: 'add' | 'remove' | 'set' }[] = [];

  function applyScalar(field: 'name' | 'description', value: string): void {
    const literal = JSON.stringify(value);
    const fragment = `${field}: ${literal},`;
    const result = upsertScalarField(workingBody, range!, field, literal, fragment);
    workingBody = result.body;
    range = findEntryRange(workingBody, input.templateId);
    if (range) fieldChanges.push({ field, mode: result.mode });
  }

  function applyArray(
    field: 'tags' | 'scope' | 'appliesWhen' | 'related',
    op: StringArrayOp,
  ): void {
    const norm = normaliseArrayOp(op);
    const current = readStringArrayField(workingBody, range!, field);
    const next = mergeArray(current, norm);
    const literal = JSON.stringify(next);
    const fragment = `${field}: ${literal},`;
    const result = upsertScalarField(workingBody, range!, field, literal, fragment);
    workingBody = result.body;
    range = findEntryRange(workingBody, input.templateId);
    if (range) fieldChanges.push({ field, mode: result.mode, arrayMode: norm.mode });
  }

  function applyMetadataArray(
    parentRange: IEntryRange,
    field: MetadataArrayField,
    op: StringArrayOp,
  ): IEntryRange | null {
    const norm = normaliseArrayOp(op);
    const current = readStringArrayField(workingBody, parentRange, field);
    const next = mergeArray(current, norm);
    const literal = JSON.stringify(next);
    const fragment = `${field}: ${literal},`;
    const result = upsertScalarField(workingBody, parentRange, field, literal, fragment);
    workingBody = result.body;
    const reroot = findEntryRange(workingBody, input.templateId);
    if (!reroot) return null;
    const next1 = findNestedObjectRange(workingBody, reroot, 'metadata');
    if (next1) fieldChanges.push({ field: `metadata.${field}`, mode: result.mode, arrayMode: norm.mode });
    return next1;
  }

  function applyMetadataScalar(
    parentRange: IEntryRange,
    field: MetadataScalarField,
    value: string | number | boolean,
  ): IEntryRange | null {
    const literal = JSON.stringify(value);
    const fragment = `${field}: ${literal},`;
    const result = upsertScalarField(workingBody, parentRange, field, literal, fragment);
    workingBody = result.body;
    const reroot = findEntryRange(workingBody, input.templateId);
    if (!reroot) return null;
    const next1 = findNestedObjectRange(workingBody, reroot, 'metadata');
    if (next1) fieldChanges.push({ field: `metadata.${field}`, mode: result.mode });
    return next1;
  }

  if (input.fields.name !== undefined) applyScalar('name', input.fields.name);
  if (input.fields.description !== undefined) applyScalar('description', input.fields.description);
  if (input.fields.tags !== undefined) applyArray('tags', input.fields.tags);
  if (input.fields.scope !== undefined) applyArray('scope', input.fields.scope);
  if (input.fields.appliesWhen !== undefined) applyArray('appliesWhen', input.fields.appliesWhen);
  if (input.fields.related !== undefined) applyArray('related', input.fields.related);

  if (input.fields.metadata && range) {
    // Insert a stub metadata block if absent so the nested merge has a
    // landing pad. The stub is empty `{}` so subsequent upserts add fields.
    let metadataRange = findNestedObjectRange(workingBody, range, 'metadata');
    if (!metadataRange) {
      const stub = 'metadata: {},';
      const result = upsertScalarField(workingBody, range, 'metadata', '{}', stub);
      workingBody = result.body;
      range = findEntryRange(workingBody, input.templateId);
      if (range) {
        metadataRange = findNestedObjectRange(workingBody, range, 'metadata');
        if (metadataRange) {
          fieldChanges.push({ field: 'metadata', mode: result.mode });
        }
      }
    }
    if (metadataRange) {
      const meta = input.fields.metadata;
      // Scalar fields first (order is deterministic so diffs are stable).
      const scalarKeys: MetadataScalarField[] = ['priority', 'maturity', 'dryRunOnly', 'requiresApproval'];
      for (const key of scalarKeys) {
        const v = meta[key];
        if (v !== undefined) {
          const next = applyMetadataScalar(metadataRange, key, v);
          if (next) metadataRange = next;
        }
      }
      const arrayKeys: MetadataArrayField[] = [
        'requiredAnchors',
        'requiredProfileIds',
        'forbiddenPathFragments',
        'requiredVerificationCommandIds',
      ];
      for (const key of arrayKeys) {
        const op = meta[key];
        if (op !== undefined) {
          const next = applyMetadataArray(metadataRange, key, op);
          if (next) metadataRange = next;
        }
      }
    }
  }

  if (fieldChanges.length === 0) {
    return {
      ok: false,
      refusal:
        `No supported fields to apply for "${input.templateId}". Supported: name, description, tags, scope, appliesWhen, related, metadata.{priority, maturity, dryRunOnly, requiresApproval, requiredAnchors, requiredProfileIds, forbiddenPathFragments, requiredVerificationCommandIds}.`,
      targetAbs,
      templateId: input.templateId,
      originalLength: body.length,
      nextLength: body.length,
      fieldChanges: [],
      wrote: false,
    };
  }
  let wrote = false;
  if (input.write && workingBody !== body) {
    writeFileSync(targetAbs, workingBody, 'utf8');
    wrote = true;
  }
  const rel = nodePath.relative(cwd, targetAbs) || nodePath.basename(targetAbs);
  const diff = buildUnifiedDiff(rel, body, workingBody);
  return {
    ok: true,
    targetAbs,
    templateId: input.templateId,
    originalLength: body.length,
    nextLength: workingBody.length,
    fieldChanges,
    diff,
    wrote,
  };
}
