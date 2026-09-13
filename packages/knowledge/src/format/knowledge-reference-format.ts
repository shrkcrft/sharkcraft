import type { IKnowledgeReference } from '../model/knowledge-entry.ts';

/**
 * Render one reference in the same compact grammar `--reference` accepts:
 * `file:src/x.ts`, `template:app.service`, `symbol:Foo`, `symbol:Foo.bar@src/foo.ts`.
 *
 * Every renderer (stale-check text / markdown / html, `knowledge references`)
 * calls this, and `parseReferenceSpec` is its inverse. A pinned symbol used to
 * render as its PATH (`symbol:src/foo.ts`) — the one thing it pins was the one
 * thing the output hid.
 */
export function formatKnowledgeReference(ref: IKnowledgeReference): string {
  if (ref.kind === 'symbol') {
    const sym = ref.symbol ?? '?';
    return ref.path ? `symbol:${sym}@${ref.path}` : `symbol:${sym}`;
  }
  return `${ref.kind}:${ref.id ?? ref.command ?? ref.path ?? ref.symbol ?? '?'}`;
}
