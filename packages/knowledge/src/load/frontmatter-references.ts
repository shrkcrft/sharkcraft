import type { FrontmatterValue } from '@shrkcrft/core';
import { parseReferenceSpec } from '../format/knowledge-reference-format.ts';
import { KNOWLEDGE_REFERENCE_KINDS } from '../model/knowledge-entry.ts';
import type { IFrontmatterReferences } from './i-frontmatter-references.ts';

const KINDS: ReadonlySet<string> = new Set(KNOWLEDGE_REFERENCE_KINDS);

/** The fields of a reference map (`IAssetReference`) — a lone one is a map missing its `kind`, not a compact item. */
const REFERENCE_FIELDS: ReadonlySet<string> = new Set([
  'kind',
  'path',
  'symbol',
  'id',
  'command',
  'required',
  'note',
  'contains',
  'matches',
  'scan',
  'count',
  // Round 15 follow-up (F7): `root: pack` on a map item — the compact string grammar stays unchanged.
  'root',
]);

/** The refusal a `count` carries — its `source` selector is nested deeper than frontmatter maps go. */
export const MARKDOWN_COUNT_REFUSAL =
  'nested selectors are not supported in Markdown frontmatter — declare this entry in TypeScript';

/** `{ kind: file, path: src/a.ts }` inside an inline list — the frontmatter parser reads it as one string. */
const FLOW_MAP = /^\{[\s\S]*\}$/;

/** The field a compact `<kind>: <value>` map puts its value in (what `parseReferenceSpec` would). */
function valueField(kind: string): 'path' | 'symbol' | 'id' {
  if (kind === 'file' || kind === 'directory') return 'path';
  if (kind === 'symbol') return 'symbol';
  return 'id';
}

/**
 * Read a Markdown `references:` frontmatter value into `entry.references` —
 * the SAME `IKnowledgeReference` objects a TypeScript entry declares, handed
 * unchanged to the one validator and the stale engine (no Markdown-specific
 * validator). Three item shapes:
 *
 *   1. a map whose keys are reference fields — `- kind: symbol` / `symbol: Foo`
 *      / `path: src/foo.ts` / `contains: "export class Foo"` / `required: true`;
 *   2. a string in the `--reference` grammar — `references: [file:src/a.ts,
 *      "symbol:Foo@src/foo.ts"]` (read by {@link parseReferenceSpec});
 *   3. a block item `- file:src/a.ts` — the frontmatter parser yields a
 *      single-key map `{ file: 'src/a.ts' }` for it (an unquoted `:` makes an
 *      item a map), read here as the compact form.
 *
 * Refused (the entry is rejected, each with its reason): a `count` (its
 * `source` selector nests deeper than frontmatter maps go) and a flow map
 * (`{ kind: file, … }`). A mixed string/map list never reaches here — the
 * parser refuses it. A string the grammar refuses and a map with an unknown
 * kind or a missing field pass through AS DECLARED, so they fail exactly like
 * the same item in TypeScript: `invalid-reference` in the doctor, INVALID in
 * the stale-check. A non-list value is kept verbatim for the same reason.
 */
export function frontmatterReferences(value: FrontmatterValue | undefined): IFrontmatterReferences {
  if (value === undefined || value === null) return { refusals: [] };
  if (!Array.isArray(value)) return { references: value, refusals: [] };
  const refusals: string[] = [];
  const references = (value as readonly unknown[]).map((item, i): unknown => {
    const at = `references[${i}]`;
    if (typeof item === 'string') {
      if (FLOW_MAP.test(item.trim())) {
        refusals.push(
          `${at}: a flow map ({ … }) is not supported — write a block map (- kind: file, then path: … on the next line) or the compact string file:src/a.ts`,
        );
        return item;
      }
      return parseReferenceSpec(item) ?? item;
    }
    if (item === null || typeof item !== 'object') return item;
    const map = item as Readonly<Record<string, unknown>>;
    if ('count' in map) {
      refusals.push(`${at}.count: ${MARKDOWN_COUNT_REFUSAL}`);
      return map;
    }
    const keys = Object.keys(map);
    const kind = keys.length === 1 ? keys[0]! : undefined;
    if (kind === undefined) return map;
    if (!KINDS.has(kind)) {
      const v = map[kind];
      // `- bogus:x` / `- https://x`: the compact form with a kind the grammar
      // refuses — carried as the string it was written as, so the refusal names
      // it (`not a reference spec: unknown kind "bogus"`), exactly as the
      // inline `[bogus:x]` does. A lone FIELD (`- path: src/a.ts`) stays a map:
      // a reference missing its `kind`.
      if (!REFERENCE_FIELDS.has(kind) && (v === null || typeof v !== 'object')) {
        return v === null || v === undefined ? `${kind}:` : `${kind}:${String(v)}`;
      }
      return map;
    }
    // `- file:src/a.ts`: the compact form, read by the one grammar.
    const v = map[kind];
    if (v === null || v === undefined) return { kind };
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return parseReferenceSpec(`${kind}:${String(v)}`) ?? { kind, [valueField(kind)]: v };
    }
    // A list or a map under the kind: carried where the value belongs, so the
    // shape check names the field (`has a non-string path`).
    return { kind, [valueField(kind)]: v };
  });
  return { references: Object.freeze(references), refusals };
}
