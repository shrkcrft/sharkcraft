import {
  FrontmatterScalarMode,
  parseFrontmatter,
  parseInlineScalar,
  splitFrontmatter,
  type FrontmatterValue,
  type IParseFrontmatterOptions,
} from '@shrkcrft/core';
import { KnowledgePriority, KnowledgeType } from '@shrkcrft/knowledge';
import type { IImportedEntry } from '../model/imported-entry.ts';
import type { ICursorRuleParse } from './i-cursor-rule-parse.ts';
import { keywordTags, slugify } from './slugify.ts';

/**
 * Parse a single .cursor/rules/*.mdc file. MDC format = YAML frontmatter
 * (between `---` markers) + markdown body. We extract:
 *   - `description` → entry title
 *   - `globs` / `tags` → tags
 *   - `priority` (if present) → KnowledgePriority
 *   - the body → content
 *
 * The frontmatter is read by THE parser (`splitFrontmatter` +
 * `parseFrontmatter`, @shrkcrft/core — round 15 follow-up, F6) in its `Text`
 * scalar mode: Cursor writes values bare (`globs: *.ts, *.tsx`,
 * `description: Fix #12`), and they are read verbatim, as the old line
 * splitter read them. A comma-separated `globs` / `tags` string is read as
 * THE parser's inline list, so a quoted item or a brace glob (`*.{ts,tsx}`)
 * stays one item. Only the four keys the importer reads are parsed, each on
 * its own; any other key is skipped unparsed (`IParseFrontmatterOptions.keys`).
 */
export interface ICursorRuleOptions {
  origin: string;
  idPrefix: string;
}

/** The keys the importer reads as lists — `description` / `priority` are one value each. */
const MDC_LIST_KEYS: readonly string[] = Object.freeze(['globs', 'tags']);

/**
 * `.mdc` values are text by contract — read verbatim (no YAML typing, no
 * ` # comment` strip). Only `globs` / `tags` read an inline `[…]` as a list
 * (`listKeys`, round 15 closing A1): `description: [WIP]` is the title `[WIP]`,
 * as the old splitter read it (it was ignored as "a list").
 */
const MDC_FRONTMATTER: IParseFrontmatterOptions = Object.freeze({
  scalars: FrontmatterScalarMode.Text,
  listKeys: MDC_LIST_KEYS,
});

/** The frontmatter keys the importer reads; every other key (`alwaysApply`, a tool's `metadata:`) is skipped unparsed. */
const MDC_KEYS: readonly string[] = Object.freeze(['description', 'globs', 'tags', 'priority']);

/** What the frontmatter says, once read. */
interface ICursorFrontmatter {
  description?: string;
  tags?: string[];
  globs?: string[];
  priority?: string;
}

interface ICursorFrontmatterRead {
  readonly fm: ICursorFrontmatter;
  readonly body: string;
  readonly problems: readonly string[];
}

function shapeOf(value: FrontmatterValue): string {
  if (!Array.isArray(value)) return 'a map';
  return (value as readonly unknown[]).some((v) => v !== null && typeof v === 'object') ? 'a list of maps' : 'a list';
}

/**
 * A comma-separated value (`globs: src/**\/*.ts, test/**`) read through THE
 * parser's inline-list grammar: quote-aware and bracket/brace-aware, so
 * `"a, b"` and `*.{ts,tsx}` each stay one item.
 */
function listFromText(value: string): readonly string[] | undefined {
  const r = parseInlineScalar(`[${value}]`, 0, MDC_FRONTMATTER);
  if (!r.ok || !Array.isArray(r.value)) return undefined;
  return (r.value as readonly unknown[]).filter((v) => v !== null && String(v).length > 0).map((v) => String(v));
}

function readCursorFrontmatter(raw: string): ICursorFrontmatterRead {
  const split = splitFrontmatter(raw);
  const problems: string[] = [];
  if (split.unterminated) {
    problems.push('frontmatter: an opening --- line has no closing --- line — the whole file is read as the body');
  }
  if (split.frontmatter === undefined) return { fm: {}, body: split.body, problems };
  const at: IParseFrontmatterOptions = { ...MDC_FRONTMATTER, lineOffset: split.lineOffset };
  // The top-level structure alone (no key read): a line that names no key
  // means the block is not frontmatter THE parser can read at all.
  const structure = parseFrontmatter(split.frontmatter, { ...at, keys: [] });
  if (!structure.ok) {
    problems.push(
      `frontmatter not read (${structure.error.message}) — description, globs, tags and priority are ignored; the title comes from the body`,
    );
    return { fm: {}, body: split.body, problems };
  }
  // Each key the importer reads, parsed on its own — every other block is
  // skipped unparsed (`alwaysApply`, a tool's `metadata:`): YAML the parser
  // does not speak under one key costs that key alone, never its siblings (the
  // old splitter read every other line regardless).
  const fields: Record<string, FrontmatterValue> = {};
  for (const key of MDC_KEYS) {
    const read = parseFrontmatter(split.frontmatter, { ...at, keys: [key] });
    if (!read.ok) {
      problems.push(`${key}: not read (${read.error.message}) — ignored${key === 'description' ? '; the title comes from the body' : ''}`);
      continue;
    }
    const value = read.value[key];
    if (value !== undefined) fields[key] = value;
  }
  const text = (key: string): string | undefined => {
    const v = fields[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') return v.trim().length > 0 ? v : undefined;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    problems.push(`${key}: must be a single value (got ${shapeOf(v)}) — ignored`);
    return undefined;
  };
  const list = (key: string): string[] | undefined => {
    const v = fields[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') {
      const items = listFromText(v);
      if (items === undefined) {
        problems.push(`${key}: "${v}" is not a comma-separated list — ignored`);
        return undefined;
      }
      return [...items];
    }
    if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
    const items = Array.isArray(v) ? (v as readonly unknown[]) : undefined;
    if (items === undefined || items.some((x) => x !== null && typeof x === 'object')) {
      problems.push(`${key}: must be a list of plain values or a comma-separated string (got ${shapeOf(v)}) — ignored`);
      return undefined;
    }
    return items.filter((x) => x !== null && String(x).length > 0).map((x) => String(x));
  };
  const fm: ICursorFrontmatter = {};
  const description = text('description');
  if (description !== undefined) fm.description = description;
  const tags = list('tags');
  if (tags !== undefined) fm.tags = tags;
  const globs = list('globs');
  if (globs !== undefined) fm.globs = globs;
  const priority = text('priority');
  if (priority !== undefined) fm.priority = priority;
  return { fm, body: split.body, problems };
}

function priorityFromString(input: string | undefined): KnowledgePriority {
  switch ((input ?? '').toLowerCase()) {
    case 'critical':
      return KnowledgePriority.Critical;
    case 'high':
      return KnowledgePriority.High;
    case 'low':
      return KnowledgePriority.Low;
    default:
      return KnowledgePriority.Medium;
  }
}

/**
 * Parse one `.mdc` rule, with every reason (part of) its frontmatter was not
 * read — the importer surfaces each as a warning (round 15 follow-up, F6: the
 * old line splitter skipped an unreadable line, a block list or a whole BOM /
 * `--- ` file without a word).
 */
export function parseCursorRule(raw: string, options: ICursorRuleOptions): ICursorRuleParse {
  const { fm, body, problems } = readCursorFrontmatter(raw);
  const title = fm.description ?? body.split('\n').find((l) => l.trim().length > 0) ?? options.idPrefix;
  const baseSlug = slugify(title) || slugify(options.idPrefix);
  const tags = [
    ...new Set([
      ...(fm.tags ?? []),
      ...(fm.globs ?? []).map((g) => g.replace(/[*?]/g, '')).map((g) => slugify(g)).filter(Boolean),
      ...keywordTags(title),
    ]),
  ];
  const entry: IImportedEntry = {
    id: `${options.idPrefix}.${baseSlug}`,
    title: title.slice(0, 100),
    type: KnowledgeType.Rule,
    priority: priorityFromString(fm.priority),
    section: 'cursor-rules',
    tags,
    content: body.trim(),
    origin: options.origin,
  };
  return { entry, problems };
}

/** {@link parseCursorRule}'s entry alone (the frontmatter problems are dropped — `importCursorRules` reports them). */
export function parseCursorRuleFile(raw: string, options: ICursorRuleOptions): IImportedEntry {
  return parseCursorRule(raw, options).entry;
}
