import {
  KNOWLEDGE_REFERENCE_KINDS,
  type IKnowledgeReference,
  type KnowledgeReferenceKind,
} from '../model/knowledge-entry.ts';

/**
 * Render one reference in the compact grammar `--reference` and a Markdown
 * `references:` frontmatter list accept: `file:src/x.ts`,
 * `template:app.service`, `symbol:Foo`, `symbol:Foo.bar@src/foo.ts`.
 *
 * Every renderer (stale-check text / markdown / html, `knowledge references`)
 * calls this, and {@link parseReferenceSpec} is its inverse:
 * `formatKnowledgeReference(parseReferenceSpec(s)) === s` for every kind
 * (`:required` aside — a flag, never rendered). A pinned symbol used to render
 * as its PATH (`symbol:src/foo.ts`) — the one thing it pins was the one thing
 * the output hid.
 *
 * A value that is not a reference object — a malformed item (a string the
 * grammar refused, a number) — renders as written, so an INVALID row names
 * what is in the file and no renderer crashes on it.
 */
export function formatKnowledgeReference(ref: IKnowledgeReference): string {
  const raw: unknown = ref;
  if (typeof raw === 'string') return raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return String(JSON.stringify(raw) ?? raw);
  if (ref.kind === 'symbol') {
    const sym = ref.symbol ?? '?';
    return ref.path ? `symbol:${sym}@${ref.path}` : `symbol:${sym}`;
  }
  return `${ref.kind}:${ref.id ?? ref.command ?? ref.path ?? ref.symbol ?? '?'}`;
}

/**
 * Parse a `kind:value[:required]` reference spec — the `--reference` grammar
 * (`shrk knowledge add|update --reference`) and a Markdown `references:`
 * frontmatter item. Returns null on input the grammar refuses
 * ({@link referenceSpecProblem} says why).
 *
 * A symbol may pin its declaring file — `symbol:<name>@<path>` — and address a
 * member — `symbol:Owner.member@<path>`. This is the inverse of
 * {@link formatKnowledgeReference}, so what the stale-check prints can be
 * pasted back as a `--reference` or a frontmatter item.
 *
 * The accepted kinds are {@link KNOWLEDGE_REFERENCE_KINDS} — the one
 * vocabulary the validator and the stale-check read — never a hand-copied list.
 * (Round 15: moved here from the CLI's authoring kit, which re-exports it, so
 * the Markdown loader reads the same grammar.)
 */
export function parseReferenceSpec(spec: string): IKnowledgeReference | null {
  const parts = spec.split(':');
  if (parts.length < 2) return null;
  const [kindRaw, ...rest] = parts;
  if (!KNOWLEDGE_REFERENCE_KINDS.includes(kindRaw as KnowledgeReferenceKind)) return null;
  const kind = kindRaw as KnowledgeReferenceKind;
  const required = rest[rest.length - 1] === 'required';
  if (required) rest.pop();
  const value = rest.join(':');
  if (!value) return null;
  switch (kind) {
    case 'file':
    case 'directory':
      return { kind, path: value, ...(required ? { required: true } : {}) };
    case 'symbol': {
      // `Name@path` pins the declaring file (a symbol name never contains `@`).
      const at = value.indexOf('@');
      if (at > 0 && at < value.length - 1) {
        return {
          kind,
          symbol: value.slice(0, at),
          path: value.slice(at + 1),
          ...(required ? { required: true } : {}),
        };
      }
      return { kind, symbol: value, ...(required ? { required: true } : {}) };
    }
    default:
      // Every other kind in the vocabulary is id-keyed (a command, a registry
      // id, a url) — a kind added to the vocabulary is accepted here at once.
      return { kind, id: value, ...(required ? { required: true } : {}) };
  }
}

/**
 * Why `spec` is not a reference spec — `undefined` when
 * {@link parseReferenceSpec} accepts it. THE wording every surface refusing a
 * compact reference prints.
 */
export function referenceSpecProblem(spec: string): string | undefined {
  if (parseReferenceSpec(spec) !== null) return undefined;
  const colon = spec.indexOf(':');
  if (colon <= 0) return 'expected kind:value (e.g. file:src/a.ts)';
  const kind = spec.slice(0, colon);
  if (!KNOWLEDGE_REFERENCE_KINDS.includes(kind as KnowledgeReferenceKind)) {
    return `unknown kind "${kind}" — expected one of: ${KNOWLEDGE_REFERENCE_KINDS.join(', ')}`;
  }
  const field = kind === 'file' || kind === 'directory' ? 'path' : kind === 'symbol' ? 'symbol' : 'id';
  return `"${kind}:" names no ${field}`;
}
