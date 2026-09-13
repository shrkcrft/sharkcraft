import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  normalizeKnowledgeId,
  parseFrontmatter,
  RejectionCause,
  splitFrontmatter,
  toKebabCase,
  type FrontmatterValue,
  type IRejectedEntry,
} from '@shrkcrft/core';
import type { IKnowledgeEntry, IKnowledgeReference } from '../model/knowledge-entry.ts';
import type { ILoadedKnowledge, IKnowledgeLoader } from './knowledge-loader.ts';
import { KnowledgeType } from '../model/knowledge-type.ts';
import { KnowledgePriority } from '../model/knowledge-priority.ts';
import { frontmatterReferences, MARKDOWN_COUNT_REFUSAL } from './frontmatter-references.ts';

/**
 * Why an opening `---` with no closing `---` line is refused (round 15 closing,
 * A2) — the decision-record reader's wording. It read as "no frontmatter" and
 * the entry loaded under its file-name id with the block as body text.
 */
const UNTERMINATED_FRONTMATTER = 'frontmatter: an opening --- line has no closing --- line';

/**
 * The frontmatter keys this loader maps onto the entry. Every other key is
 * dropped — so {@link unsupportedFrontmatterKeys} names it and the loader
 * warns, instead of the value vanishing silently.
 */
const ENTRY_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'id',
  'title',
  'type',
  'priority',
  'scope',
  'tags',
  'appliesWhen',
  'summary',
  'related',
  'verifiedOn',
  'seeAlso',
  'see-also',
  'supersededBy',
  'superseded-by',
  // Round 15 (15.2): a Markdown entry declares references like a TypeScript one.
  'references',
]);

/**
 * The entry fields the loader reads as LISTS (`read.list`); every other field
 * is ONE value. Passed to the parser as `listKeys` (round 15 closing), so an
 * inline `title: [WIP]` is the title `[WIP]` — as the pre-round-15 line reader
 * read it — never a one-item list the scalar reader refuses. The decision and
 * `.mdc` readers declare theirs the same way. `references:` is parsed on its
 * own and keeps every list form.
 */
const ENTRY_LIST_KEYS: readonly string[] = Object.freeze([
  'scope',
  'tags',
  'appliesWhen',
  'related',
  'seeAlso',
  'see-also',
  'supersededBy',
  'superseded-by',
]);

/** One top-level frontmatter block: a key line plus the indented / list / comment lines under it. */
interface IFrontmatterBlock {
  /** The key, or undefined for a top-level line that names none (`just text`). */
  readonly key: string | undefined;
  /** First line (0-based, within the frontmatter). */
  readonly start: number;
  /** One past the last line. */
  readonly end: number;
}

/**
 * Split frontmatter lines into top-level blocks. An unindented line opens a
 * block; indented lines, list items and comments belong to whatever block is
 * open. THE block reading {@link unsupportedFrontmatterKeys} and the loader
 * share, so "what was dropped" and "what was parsed" cannot disagree.
 */
function frontmatterBlocks(lines: readonly string[]): IFrontmatterBlock[] {
  const out: IFrontmatterBlock[] = [];
  let key: string | undefined;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const topLevel = line.length > 0 && !/^\s/.test(line) && !line.startsWith('-') && !line.startsWith('#');
    if (!topLevel) continue;
    if (start >= 0) out.push({ key, start, end: i });
    const idx = line.indexOf(':');
    key = idx > 0 ? line.slice(0, idx).trim() : undefined;
    start = i;
  }
  if (start >= 0) out.push({ key, start, end: lines.length });
  return out;
}

/**
 * Every TOP-LEVEL frontmatter key this loader does NOT carry onto the entry, in
 * file order, each with its raw block (the key line plus the indented lines
 * under it). THE answer to "what did the Markdown loader drop?" — the loader's
 * warnings and the custom-checks registry (a Markdown rule whose `metadata`
 * held `checks`) both read it, so the two cannot disagree.
 *
 * `metadata` is the notable one: a Markdown rule cannot carry
 * `metadata.checks[]` (or any metadata) — only a TypeScript entry can.
 */
export function unsupportedFrontmatterKeys(
  text: string,
): readonly { readonly key: string; readonly block: string }[] {
  // THE delimiter split (@shrkcrft/core): a BOM / CRLF file reads like any other.
  const frontmatter = splitFrontmatter(text).frontmatter;
  if (frontmatter === undefined) return [];
  const lines = frontmatter.split('\n');
  const out: { key: string; block: string }[] = [];
  for (const b of frontmatterBlocks(lines)) {
    if (b.key === undefined || ENTRY_FRONTMATTER_KEYS.has(b.key) || out.some((o) => o.key === b.key)) continue;
    out.push({ key: b.key, block: lines.slice(b.start, b.end).join('\n') });
  }
  return out;
}

function unsupportedKeyWarning(filePath: string, key: string): string {
  if (key === 'metadata') {
    return (
      `${filePath}: frontmatter key "metadata" was dropped — the Markdown loader does not support metadata; ` +
      'attach metadata (e.g. metadata.checks) in a TypeScript rule file'
    );
  }
  return (
    `${filePath}: frontmatter key "${key}" was dropped — it is not a field the Markdown loader reads ` +
    `(reads: ${[...ENTRY_FRONTMATTER_KEYS].join(', ')})`
  );
}

/** The frontmatter as read: the parsed fields, the body, and every reason it could not be read as declared. */
interface IReadFrontmatter {
  readonly fields: Readonly<Record<string, FrontmatterValue>>;
  readonly body: string;
  readonly problems: readonly string[];
  /** The raw `id:` line's value — names a rejected entry when the parse failed. */
  readonly idHint?: string;
}

/** The line a `line N` in a parser message names. */
const LINE_OF = /line (\d+)/;

/** Why the `references:` block does not parse — named for the three refusals authors hit. */
function referencesParseProblem(blockLines: readonly string[], message: string): string {
  if (blockLines.some((l) => /^\s+(?:-\s+)?count\s*:/.test(l))) {
    return `references: a \`count\` ${MARKDOWN_COUNT_REFUSAL} (${message})`;
  }
  if (/^Mixed array kinds/.test(message)) {
    const line = LINE_OF.exec(message)?.[1];
    return (
      `references: mixed string and map items in one list${line ? ` (line ${line})` : ''} — write every item as a map ` +
      '(- kind: file, then path: … on the next line) or every item as a kind:value string; quote all compact strings or none (an unquoted ":" makes an item a map)'
    );
  }
  return `references: ${message}`;
}

/**
 * Read the frontmatter through THE split and THE parser (`splitFrontmatter` +
 * `parseFrontmatter`, @shrkcrft/core — round 15 closing, A2: the loader's own
 * delimiter regex missed a BOM file's frontmatter and read an unterminated
 * block as no frontmatter, silently). An opening `---` that never closes is a
 * problem, so the entry is REFUSED, never loaded from the block as body text.
 * Lines under a key the loader never reads are blanked first (line numbers stay
 * true), so a dropped key in a YAML dialect the parser does not speak warns as
 * before instead of costing the document; the `references:` block is parsed on
 * its own, so its refusal is named for what it is.
 */
function readFrontmatter(text: string): IReadFrontmatter {
  const split = splitFrontmatter(text);
  if (split.unterminated) return { fields: {}, body: split.body, problems: [UNTERMINATED_FRONTMATTER] };
  if (split.frontmatter === undefined) return { fields: {}, body: split.body, problems: [] };
  const body = split.body;
  const lines = split.frontmatter.split('\n');
  // Lines before the frontmatter's first line — so `line N` is the FILE's line N.
  const lineOffset = split.lineOffset;
  const blocks = frontmatterBlocks(lines);
  const keyAt = (i: number): { readonly inBlock: boolean; readonly key: string | undefined } => {
    const b = blocks.find((x) => i >= x.start && i < x.end);
    return { inBlock: b !== undefined, key: b?.key };
  };
  const keep = (predicate: (inBlock: boolean, key: string | undefined) => boolean): string =>
    lines
      .map((line, i) => {
        const at = keyAt(i);
        return predicate(at.inBlock, at.key) ? line : '';
      })
      .join('\n');
  const idHint = /^id:[ \t]*["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?$/m.exec(split.frontmatter)?.[1]?.trim();

  const problems: string[] = [];
  // A top-level line naming no key (and anything above the first key) stays in:
  // it is malformed frontmatter, and the parse says where.
  const rest = parseFrontmatter(
    keep((inBlock, key) => !inBlock || key === undefined || (key !== 'references' && ENTRY_FRONTMATTER_KEYS.has(key))),
    { lineOffset, listKeys: ENTRY_LIST_KEYS },
  );
  if (!rest.ok) problems.push(`frontmatter: ${rest.error.message}`);
  const fields: Record<string, FrontmatterValue> = rest.ok ? { ...rest.value } : {};
  if (blocks.some((b) => b.key === 'references')) {
    const refs = parseFrontmatter(
      keep((inBlock, key) => inBlock && key === 'references'),
      { lineOffset },
    );
    if (refs.ok) {
      const value = refs.value['references'];
      if (value !== undefined) fields['references'] = value;
    } else {
      const blockLines = blocks
        .filter((b) => b.key === 'references')
        .flatMap((b) => lines.slice(b.start, b.end));
      problems.push(referencesParseProblem(blockLines, refs.error.message));
    }
  }
  return { fields, body, problems, ...(idHint ? { idHint } : {}) };
}

/** `a list`, `a map` — how a field's shape is named in a refusal. */
function shapeOf(value: FrontmatterValue): string {
  if (Array.isArray(value)) return (value as readonly unknown[]).some((v) => v !== null && typeof v === 'object') ? 'a list of maps' : 'a list';
  return typeof value === 'object' && value !== null ? 'a map' : typeof value;
}

/**
 * Reads each frontmatter field the entry is built from. A field whose SHAPE the
 * entry cannot hold (a list where one value belongs, a map where a list does)
 * is a problem: the entry cannot be built as declared, so it is rejected — it
 * used to be flattened into garbage or dropped.
 */
class FieldReader {
  readonly problems: string[] = [];

  constructor(private readonly fields: Readonly<Record<string, FrontmatterValue>>) {}

  scalar(key: string): string | undefined {
    const value = this.fields[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    this.problems.push(`${key}: must be a single value (got ${shapeOf(value)})`);
    return undefined;
  }

  list(key: string): string[] | undefined {
    const value = this.fields[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }
    if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
    if (Array.isArray(value)) {
      const items = value as readonly unknown[];
      if (items.some((v) => v !== null && typeof v === 'object')) {
        this.problems.push(`${key}: must be a list of plain values (got ${shapeOf(value)})`);
        return undefined;
      }
      return items.filter((v) => v !== null && v !== undefined && String(v).length > 0).map((v) => String(v));
    }
    this.problems.push(`${key}: must be a list or a comma-separated string (got ${shapeOf(value)})`);
    return undefined;
  }
}

export class MarkdownKnowledgeLoader implements IKnowledgeLoader {
  canLoad(filePath: string): boolean {
    return extname(filePath).toLowerCase() === '.md';
  }

  async load(filePath: string): Promise<ILoadedKnowledge> {
    const warnings: string[] = [];
    const entries: IKnowledgeEntry[] = [];
    const sourceFiles: string[] = [];
    const rejected: IRejectedEntry[] = [];

    if (!existsSync(filePath)) {
      warnings.push(`Markdown file not found: ${filePath}`);
      return { entries, warnings, sourceFiles, rejected };
    }

    sourceFiles.push(filePath);

    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (e) {
      warnings.push(`Failed to read ${filePath}: ${(e as Error).message}`);
      return { entries, warnings, sourceFiles, rejected };
    }

    const fm = readFrontmatter(text);
    // Parsed-then-dropped keys used to vanish without a word; the drop is said out loud.
    for (const { key } of unsupportedFrontmatterKeys(text)) warnings.push(unsupportedKeyWarning(filePath, key));
    const baseName = basename(filePath, '.md');
    const derivedId = `doc.${toKebabCase(baseName)}`;
    const read = new FieldReader(fm.fields);
    const id = read.scalar('id');
    const title = read.scalar('title');
    const type = read.scalar('type');
    const priority = read.scalar('priority');
    const summary = read.scalar('summary');
    const verifiedOn = read.scalar('verifiedOn');
    const scope = read.list('scope') ?? [];
    const tags = read.list('tags') ?? [];
    const appliesWhen = read.list('appliesWhen') ?? [];
    const related = read.list('related');
    // Both spellings: YAML authors reach for kebab-case keys.
    const seeAlso = read.list('seeAlso') ?? read.list('see-also') ?? [];
    const supersededBy = read.list('supersededBy') ?? read.list('superseded-by') ?? [];
    const refs = frontmatterReferences(fm.fields['references']);

    // Frontmatter that cannot be read as declared is REFUSED through the
    // loader's rejected channel (accepted + rejected = declared, per file) —
    // never an entry built from a partial reading, never a silent drop.
    const problems = [...fm.problems, ...read.problems, ...refs.refusals];
    if (problems.length > 0) {
      const named = id ?? fm.idHint;
      rejected.push({
        file: filePath,
        index: -1,
        entryId: named ? normalizeKnowledgeId(named) : derivedId,
        reasons: problems,
        cause: RejectionCause.Invalid,
      });
      return { entries, warnings, sourceFiles, rejected };
    }

    const titleFromBody = /^#\s+(.+)$/m.exec(fm.body)?.[1]?.trim();
    const entry: IKnowledgeEntry = {
      id: id ? normalizeKnowledgeId(id) : derivedId,
      title: title || titleFromBody || baseName,
      type: type || KnowledgeType.Technical,
      priority: priority || KnowledgePriority.Medium,
      scope: Object.freeze(scope),
      tags: Object.freeze(tags.length > 0 ? tags : ['markdown', 'doc']),
      appliesWhen: Object.freeze(appliesWhen),
      content: fm.body.trim(),
      summary,
      related: related ? Object.freeze(related) : undefined,
      source: { origin: filePath, loader: 'markdown' },
      // Carried verbatim; the validator (not the loader) decides whether it is a
      // real date, so a typo surfaces as an `invalid-verified-on` issue instead
      // of vanishing.
      ...(verifiedOn !== undefined && verifiedOn.length > 0 ? { verifiedOn } : {}),
      ...(seeAlso.length > 0 ? { seeAlso: Object.freeze(seeAlso) } : {}),
      ...(supersededBy.length > 0 ? { supersededBy: Object.freeze(supersededBy) } : {}),
      // Round 15 (15.2): the same objects a TypeScript entry declares — a
      // malformed item or a non-list value is carried AS DECLARED, so the one
      // validator and the stale engine report it exactly as they report TS.
      ...(refs.references !== undefined ? { references: refs.references as readonly IKnowledgeReference[] } : {}),
    };

    entries.push(entry);
    return { entries, warnings, sourceFiles, rejected };
  }
}
