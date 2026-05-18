/**
 * `markdown-frontmatter-loose` extractor.
 *
 * Accepts any markdown file with YAML-shaped frontmatter (delimited
 * by `---`). Reuses the spec frontmatter parser. Field-map remaps
 * team-specific keys to canonical IExtractedPlan keys, with one
 * documented level of nesting (`affectedAreas.files`, etc.).
 *
 * Designed for: Claude-SDD-plugin output, Cursor / Aider plans,
 * homegrown markdown plan templates. The parser is tolerant of
 * unknown keys — they pass through into `raw` for traceability but
 * do not become IExtractedPlan fields unless field-mapped.
 */

import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import { splitSpecMd, type FrontmatterValue } from '../../spec/spec-frontmatter.ts';
import {
  EXTRACTED_PLAN_SCHEMA,
  type IExtractedAcceptanceCriterion,
  type IExtractedPlan,
  type IExtractedProposedTemplate,
} from '../extracted-plan.ts';
import type { ExtractorFieldMap, IExtractorContext, IPlanExtractor } from '../extractor.ts';

export const MARKDOWN_FRONTMATTER_LOOSE_EXTRACTOR_ID = 'markdown-frontmatter-loose';

const CANONICAL_KEYS = new Set<string>([
  'intent',
  'motivation',
  'title',
  'affectedFiles',
  'affectedAreas.files',
  'affectedPackages',
  'affectedAreas.packages',
  'acceptanceCriteria',
  'relevantRules',
  'relevantKnowledge',
  'relevantPaths',
  'proposedTemplates',
  'verificationCommandIds',
]);

export const markdownFrontmatterLooseExtractor: IPlanExtractor = {
  id: MARKDOWN_FRONTMATTER_LOOSE_EXTRACTOR_ID,
  description: 'Any markdown file with YAML-shaped frontmatter. Use --field-map to remap keys.',
  accepts(path: string): boolean {
    return path.endsWith('.md') || path.endsWith('.mdx');
  },
  extract(raw: string, ctx: IExtractorContext): Result<IExtractedPlan, AppError> {
    const split = splitSpecMd(raw);
    if (!split.ok) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          'markdown-frontmatter-loose: file is missing `---` frontmatter delimiters',
          { cause: split.error },
        ),
      );
    }
    const fm = split.value.frontmatter.fields;
    const fieldMap = ctx.fieldMap ?? {};
    const resolved = applyFieldMap(fm, fieldMap);
    const view: IExtractedPlan = {
      schema: EXTRACTED_PLAN_SCHEMA,
      source: ctx.source,
      extractorId: MARKDOWN_FRONTMATTER_LOOSE_EXTRACTOR_ID,
      intent: asString(resolved.intent),
      motivation: asString(resolved.motivation),
      title: asString(resolved.title),
      affectedFiles: readScalarArray(resolved.affectedFiles ?? resolved['affectedAreas.files']),
      affectedPackages: readScalarArray(resolved.affectedPackages ?? resolved['affectedAreas.packages']),
      acceptanceCriteria: readAcceptance(resolved.acceptanceCriteria),
      relevantRules: readScalarArray(resolved.relevantRules),
      relevantKnowledge: readScalarArray(resolved.relevantKnowledge),
      relevantPaths: readScalarArray(resolved.relevantPaths),
      proposedTemplates: readProposedTemplates(resolved.proposedTemplates),
      verificationCommandIds: readScalarArray(resolved.verificationCommandIds),
      raw: fm,
    };
    return ok(view);
  },
};

function applyFieldMap(
  fm: Readonly<Record<string, FrontmatterValue>>,
  fieldMap: ExtractorFieldMap,
): Record<string, FrontmatterValue> {
  if (Object.keys(fieldMap).length === 0) {
    return { ...fm };
  }
  const out: Record<string, FrontmatterValue> = { ...fm };
  for (const [externalKey, canonicalKey] of Object.entries(fieldMap)) {
    if (!CANONICAL_KEYS.has(canonicalKey)) continue;
    const value = fm[externalKey];
    if (value === undefined) continue;
    out[canonicalKey] = value;
  }
  return out;
}

function asString(v: FrontmatterValue | undefined): string | undefined {
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function readScalarArray(v: FrontmatterValue | undefined): readonly string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const out = (v as readonly unknown[])
      .map((x) => (typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : ''))
      .filter((s) => s.length > 0);
    return out.length > 0 ? out : undefined;
  }
  if (typeof v === 'string') {
    const out = v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

function readAcceptance(v: FrontmatterValue | undefined): readonly IExtractedAcceptanceCriterion[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: IExtractedAcceptanceCriterion[] = [];
  for (const item of v as readonly unknown[]) {
    if (typeof item === 'string' && item.length > 0) {
      out.push({ text: item });
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const text = typeof obj['text'] === 'string' ? obj['text'] : undefined;
      if (!text) continue;
      const id = typeof obj['id'] === 'string' ? obj['id'] : undefined;
      const verifiedBy = readScalarArray(obj['verifiedBy'] as FrontmatterValue);
      out.push({
        ...(id !== undefined ? { id } : {}),
        text,
        ...(verifiedBy !== undefined ? { verifiedBy } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

function readProposedTemplates(v: FrontmatterValue | undefined): readonly IExtractedProposedTemplate[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: IExtractedProposedTemplate[] = [];
  for (const item of v as readonly unknown[]) {
    if (typeof item === 'string' && item.length > 0) {
      out.push({ templateId: item });
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const templateId = typeof obj['templateId'] === 'string' ? obj['templateId'] : undefined;
      if (!templateId) continue;
      const rawVars = obj['variables'];
      const variables: Record<string, string> = {};
      if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) {
        for (const [k, val] of Object.entries(rawVars as Record<string, unknown>)) {
          variables[k] = typeof val === 'string' ? val : String(val ?? '');
        }
      }
      out.push({
        templateId,
        ...(Object.keys(variables).length > 0 ? { variables } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}
