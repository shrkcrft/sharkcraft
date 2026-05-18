/**
 * Derive the canonical `spec.json` view from a parsed `spec.md`.
 *
 * Pure transformation: parsed frontmatter + body → `ISpecJson`. The
 * frontmatterHash / bodyHash are sha256 hex digests. Frontmatter
 * canonicalization sorts keys recursively so the hash is stable
 * across YAML formatting changes that preserve semantics.
 */

import { createHash } from 'node:crypto';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import type { FrontmatterValue, IParsedSpecMd } from './spec-frontmatter.ts';
import {
  knownTopLevelKeys,
  SPEC_SCHEMA_V1,
  SpecStatus,
  type ISpecAcceptanceCriterion,
  type ISpecAffectedAreas,
  type ISpecBoundaryPrediction,
  type ISpecExternalLinks,
  type ISpecJson,
  type ISpecPlanRef,
  type ISpecProposedTemplate,
  type ISpecRisk,
  type ISpecVerificationCommandRef,
} from './spec-model.ts';

export function deriveSpecJson(parsed: IParsedSpecMd): Result<ISpecJson, AppError> {
  const fm = parsed.frontmatter.fields;
  const knownKeys = new Set(knownTopLevelKeys());
  const unknownKeys: string[] = [];
  for (const k of Object.keys(fm)) {
    if (!knownKeys.has(k)) unknownKeys.push(k);
  }

  const id = asString(fm['id']);
  const slug = asString(fm['slug']);
  const title = asString(fm['title']);
  const status = asSpecStatus(fm['status']);
  const createdAt = asString(fm['createdAt']);
  const updatedAt = asString(fm['updatedAt']);
  const intent = asString(fm['intent']);
  const motivation = asString(fm['motivation']);

  if (!id) {
    return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'spec.md frontmatter missing required "id"'));
  }

  const acceptanceCriteria = readAcceptanceCriteria(fm['acceptanceCriteria']);
  const affectedAreas = readAffectedAreas(fm['affectedAreas']);
  const relevantRules = readScalarArray(fm['relevantRules']);
  const relevantKnowledge = readScalarArray(fm['relevantKnowledge']);
  const relevantPaths = readScalarArray(fm['relevantPaths']);
  const proposedTemplates = readProposedTemplates(fm['proposedTemplates']);
  const risks = readRisks(fm['risks']);
  const outOfScope = readScalarArray(fm['outOfScope']);
  const externalLinks = readExternalLinks(fm['externalLinks']);
  const boundariesCheck = readBoundariesCheck(fm['boundariesCheck']);
  const verificationCommands = readVerificationCommandRefs(fm['verificationCommands']);
  const plan = readPlanRef(fm['plan']);

  const bodyHash = sha256(parsed.body);
  // The frontmatter hash includes EVERYTHING in the frontmatter EXCEPT
  // the `plan` block (which is added after implement). That way the
  // hash is stable from create → review → implement.
  const hashableFm: Record<string, FrontmatterValue> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'plan') continue;
    hashableFm[k] = v;
  }
  const frontmatterHash = sha256(canonicalJson(hashableFm));

  const json: ISpecJson = {
    schema: SPEC_SCHEMA_V1,
    id,
    slug: slug || '',
    title: title || '',
    status,
    createdAt: createdAt || '',
    updatedAt: updatedAt || '',
    intent: intent || '',
    motivation: motivation || '',
    acceptanceCriteria,
    affectedAreas,
    relevantRules,
    relevantKnowledge,
    relevantPaths,
    proposedTemplates,
    risks,
    outOfScope,
    externalLinks,
    boundariesCheck: { predicted: boundariesCheck },
    verificationCommands,
    ...(plan ? { plan } : {}),
    frontmatterHash,
    bodyHash,
    unknownKeys,
  };
  return ok(json);
}

function asString(v: FrontmatterValue | undefined): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function asSpecStatus(v: FrontmatterValue | undefined): SpecStatus {
  const s = typeof v === 'string' ? v : '';
  if ((Object.values(SpecStatus) as string[]).includes(s)) return s as SpecStatus;
  return SpecStatus.Draft;
}

function readAcceptanceCriteria(
  v: FrontmatterValue | undefined,
): readonly ISpecAcceptanceCriterion[] {
  if (!Array.isArray(v)) return [];
  const out: ISpecAcceptanceCriterion[] = [];
  for (const item of v as readonly unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj['id'] === 'string' ? obj['id'] : '';
    const text = typeof obj['text'] === 'string' ? obj['text'] : '';
    const verifiedByRaw = obj['verifiedBy'];
    const verifiedBy = readVerifiedBy(verifiedByRaw);
    out.push({ id, text, verifiedBy });
  }
  return out;
}

function readVerifiedBy(raw: unknown): readonly string[] {
  if (typeof raw === 'string') {
    // YAML inline arrays aren't supported by our parser; allow a comma-list as a courtesy.
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(raw)) {
    return (raw as readonly unknown[])
      .map((v) => (typeof v === 'string' ? v : String(v ?? '')))
      .filter((s) => s.length > 0);
  }
  return [];
}

function readAffectedAreas(v: FrontmatterValue | undefined): ISpecAffectedAreas {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return { files: [], packages: [], layers: [] };
  }
  const obj = v as Record<string, unknown>;
  return {
    files: readScalarArrayLike(obj['files']),
    packages: readScalarArrayLike(obj['packages']),
    layers: readScalarArrayLike(obj['layers']),
  };
}

function readScalarArrayLike(v: unknown): readonly string[] {
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(v)) {
    return (v as readonly unknown[])
      .map((x) => (typeof x === 'string' ? x : String(x ?? '')))
      .filter((s) => s.length > 0);
  }
  return [];
}

function readScalarArray(v: FrontmatterValue | undefined): readonly string[] {
  if (Array.isArray(v)) {
    return (v as readonly unknown[])
      .map((x) => (typeof x === 'string' ? x : String(x ?? '')))
      .filter((s) => s.length > 0);
  }
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

function readProposedTemplates(v: FrontmatterValue | undefined): readonly ISpecProposedTemplate[] {
  if (!Array.isArray(v)) return [];
  const out: ISpecProposedTemplate[] = [];
  for (const item of v as readonly unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const templateId = typeof obj['templateId'] === 'string' ? obj['templateId'] : '';
    if (!templateId) continue;
    const note = typeof obj['note'] === 'string' ? obj['note'] : undefined;
    const variables: Record<string, string> = {};
    const rawVars = obj['variables'];
    if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) {
      for (const [k, val] of Object.entries(rawVars as Record<string, unknown>)) {
        variables[k] = typeof val === 'string' ? val : String(val ?? '');
      }
    }
    out.push(note !== undefined ? { templateId, variables, note } : { templateId, variables });
  }
  return out;
}

function readRisks(v: FrontmatterValue | undefined): readonly ISpecRisk[] {
  if (!Array.isArray(v)) return [];
  const out: ISpecRisk[] = [];
  for (const item of v as readonly unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj['id'] === 'string' ? obj['id'] : '';
    const text = typeof obj['text'] === 'string' ? obj['text'] : '';
    if (!id || !text) continue;
    const mitigation = typeof obj['mitigation'] === 'string' ? obj['mitigation'] : undefined;
    out.push(mitigation !== undefined ? { id, text, mitigation } : { id, text });
  }
  return out;
}

function readExternalLinks(v: FrontmatterValue | undefined): ISpecExternalLinks {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return { issue: null, pr: null };
  }
  const obj = v as Record<string, unknown>;
  return {
    issue: scalarOrNull(obj['issue']),
    pr: scalarOrNull(obj['pr']),
  };
}

function scalarOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (v === null || v === undefined) return null;
  return String(v);
}

function readBoundariesCheck(v: FrontmatterValue | undefined): readonly ISpecBoundaryPrediction[] {
  // Support either `boundariesCheck: { predicted: [...] }` (nested) or
  // `boundariesCheck:` shorthand with predicted as the direct array.
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  const obj = v as Record<string, unknown>;
  const raw = obj['predicted'];
  if (!Array.isArray(raw)) return [];
  const out: ISpecBoundaryPrediction[] = [];
  for (const item of raw as readonly unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const from = typeof o['from'] === 'string' ? o['from'] : '';
    const to = typeof o['to'] === 'string' ? o['to'] : '';
    const reason = typeof o['reason'] === 'string' ? o['reason'] : '';
    if (!from || !to) continue;
    out.push({ from, to, reason });
  }
  return out;
}

function readVerificationCommandRefs(
  v: FrontmatterValue | undefined,
): readonly ISpecVerificationCommandRef[] {
  if (Array.isArray(v)) {
    const out: ISpecVerificationCommandRef[] = [];
    for (const item of v as readonly unknown[]) {
      if (typeof item === 'string') {
        if (item.length > 0) out.push({ id: item });
      } else if (item && typeof item === 'object') {
        const id = (item as Record<string, unknown>)['id'];
        if (typeof id === 'string' && id.length > 0) out.push({ id });
      }
    }
    return out;
  }
  return [];
}

function readPlanRef(v: FrontmatterValue | undefined): ISpecPlanRef | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as Record<string, unknown>;
  const planPath = typeof obj['planPath'] === 'string' ? obj['planPath'] : '';
  const planHash = typeof obj['planHash'] === 'string' ? obj['planHash'] : '';
  if (!planPath || !planHash) return undefined;
  const signedAt = typeof obj['signedAt'] === 'string' ? obj['signedAt'] : undefined;
  return signedAt !== undefined ? { planPath, planHash, signedAt } : { planPath, planHash };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
  }
  return '{' + parts.join(',') + '}';
}
