// Pack-contributed knowledge entries. Plain TS objects — the SharkCraft
// loader recognizes any object with id/title/type/content. Ids are namespaced
// with the pack id so they do not collide with consumer-local entries.
//
// `import type` is erased at runtime (no plugin-api version coupling), and
// `satisfies` type-checks each entry where it is written: a misspelled field,
// a missing required one, or a reference `kind` outside the union fails the
// pack's typecheck instead of shipping.
import type { IKnowledgeEntry } from '@shrkcrft/plugin-api';

type PackKnowledgeEntry = Omit<IKnowledgeEntry, 'source'>;

export const packOverview = {
  id: 'pack.example.overview',
  title: 'Example pack overview',
  type: 'technical',
  priority: 'medium',
  scope: ['example'],
  tags: ['pack', 'example', 'overview'],
  appliesWhen: ['onboard'],
  content: `This pack demonstrates how a third-party SharkCraft pack
contributes knowledge / rules / paths / templates / pipelines to a consumer
repo. It is intentionally tiny and safe.`,
} satisfies PackKnowledgeEntry;

export const packPolicy = {
  id: 'pack.example.policy',
  title: 'Pack contributions vs local entries',
  type: 'convention',
  priority: 'high',
  scope: ['example', 'pack-system'],
  tags: ['pack', 'policy'],
  appliesWhen: ['review-code'],
  content: `Pack contributions act as defaults / shared conventions. The
consumer repo's local sharkcraft/ entries always win on duplicate ids. This
keeps packs useful without letting an upgrade silently override a project's
own rules.`,
  actionHints: {
    forbiddenActions: [
      'Do not silently override consumer-local rules from a pack.',
      'Do not embed secrets, API keys, or private code in a pack.',
    ],
  },
} satisfies PackKnowledgeEntry;

export default [packOverview, packPolicy];
