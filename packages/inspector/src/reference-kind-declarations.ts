/**
 * THE declaration table: for every kind THE id resolver answers for, how its
 * ids come to exist.
 *
 * Round 12 (12.3): a registration hint's `discovery.profileIds` resolved
 * against a kind the consumer could not see how to fill, so the self-config
 * doctor sat at NOT VERIFIED (exit 2) forever. The loud skip was right; what
 * was missing is a guarantee that every referenceable kind is DECLARABLE. This
 * table is that guarantee's data:
 *
 *   - `Record<IdReferenceKind, …>` — a kind added to `ALL_ID_REFERENCE_KINDS`
 *     without a row is a compile error;
 *   - the r76 declarability lock declares one id through EVERY path of every
 *     row (a real pack under node_modules for a pack key) and proves the
 *     resolver lists it, so a row cannot name a path that fills nothing;
 *   - it has real consumers, so it cannot drift into a doc-only list: the
 *     doctor's loud-skip reason names how to fill an empty kind, its
 *     `*-missing` findings print `listVerb` as `next:`, and `shrk profiles
 *     list` renders its empty state from here.
 */
import type { IReferenceKindDeclaration } from './i-reference-kind-declaration.ts';
import type { IdReferenceKind, ReferenceKind } from './reference-registry.ts';

export const REFERENCE_KIND_DECLARATIONS: Readonly<Record<IdReferenceKind, IReferenceKindDeclaration>> =
  Object.freeze({
    template: {
      listVerb: 'shrk templates list',
      configKeys: ['templateFiles'],
      localFiles: ['sharkcraft/templates.ts', 'sharkcraft/knowledge/templates.ts'],
      packKeys: ['templateFiles'],
    },
    pipeline: {
      listVerb: 'shrk pipelines list',
      configKeys: ['pipelineFiles'],
      localFiles: ['sharkcraft/pipelines.ts', 'sharkcraft/knowledge/pipelines.ts'],
      packKeys: ['pipelineFiles'],
    },
    playbook: {
      listVerb: 'shrk playbooks list',
      configKeys: ['playbookFiles'],
      localFiles: ['sharkcraft/playbooks.ts', 'sharkcraft/playbooks/index.ts'],
      packKeys: ['playbookFiles'],
    },
    policy: {
      listVerb: 'shrk policy list',
      localFiles: ['sharkcraft/policies.ts'],
      packKeys: ['policyCheckFiles'],
    },
    construct: {
      listVerb: 'shrk constructs list',
      localFiles: ['sharkcraft/constructs.ts', 'sharkcraft/constructs.js', 'sharkcraft/constructs/index.ts'],
      packKeys: ['constructFiles'],
    },
    helper: {
      // The built-in HELPERS table ships empty — helpers are declared, not builtin.
      listVerb: 'shrk helper list',
      localFiles: ['sharkcraft/helpers.ts', 'sharkcraft/helpers/index.ts'],
      packKeys: ['helperFiles'],
    },
    'boundary-rule': {
      // `sharkcraft/boundaries.ts` is NOT read unless `boundaryFiles` lists it.
      listVerb: 'shrk boundaries list',
      configKeys: ['boundaryFiles'],
      packKeys: ['boundaryFiles'],
    },
    'path-convention': {
      listVerb: 'shrk paths list',
      configKeys: ['pathFiles'],
      localFiles: ['sharkcraft/paths.ts', 'sharkcraft/knowledge/paths.ts'],
      packKeys: ['pathFiles', 'pathConventionFiles'],
    },
    rule: {
      listVerb: 'shrk rules list',
      configKeys: ['ruleFiles'],
      localFiles: ['sharkcraft/rules.ts', 'sharkcraft/knowledge/rules.ts'],
      packKeys: ['ruleFiles'],
    },
    knowledge: {
      listVerb: 'shrk knowledge list',
      configKeys: ['knowledgeFiles', 'docsFiles'],
      localFiles: ['sharkcraft/knowledge.ts', 'sharkcraft/knowledge/index.ts'],
      packKeys: ['knowledgeFiles', 'docsFiles'],
    },
    decision: {
      listVerb: 'shrk self-config resolve <id>',
      localFiles: ['sharkcraft/decisions.ts', 'sharkcraft/decisions/*.md', 'docs/adr/*.md'],
      packKeys: ['decisionFiles'],
    },
    convention: {
      listVerb: 'shrk conventions list',
      configKeys: ['conventionFiles'],
      localFiles: ['sharkcraft/conventions.ts', 'sharkcraft/conventions/index.ts'],
      packKeys: ['conventionFiles'],
    },
    'contract-template': {
      listVerb: 'shrk contract template list',
      localFiles: ['sharkcraft/contract-templates.ts', 'sharkcraft/contract-templates/index.ts'],
      packKeys: ['contractTemplateFiles'],
    },
    'migration-profile': {
      listVerb: 'shrk profiles list --kind migration',
      localFiles: ['sharkcraft/migration-profiles.ts', 'sharkcraft/migration-profiles/index.ts'],
      packKeys: ['migrationProfileFiles'],
    },
    'workspace-profile': {
      // THE WorkspaceProfile vocabulary (@shrkcrft/workspace) — never empty.
      listVerb: 'shrk profiles list --kind workspace',
      builtin: true,
    },
    'routing-hint': {
      listVerb: 'shrk self-config resolve <id>',
      configKeys: ['taskRoutingHintFiles'],
      localFiles: ['sharkcraft/task-routing-hints.ts', 'sharkcraft/task-routing-hints/index.ts'],
      packKeys: ['taskRoutingHintFiles'],
    },
    'registration-hint': {
      listVerb: 'shrk registrations list',
      localFiles: ['sharkcraft/registration-hints.ts', 'sharkcraft/registration-hints/index.ts'],
      packKeys: ['registrationHintFiles'],
    },
    'scaffold-pattern': {
      listVerb: 'shrk scaffolds list',
      localFiles: ['sharkcraft/scaffold-patterns.ts'],
      packKeys: ['scaffoldPatternFiles'],
    },
  });

function declarationOf(kind: ReferenceKind): IReferenceKindDeclaration | undefined {
  return Object.prototype.hasOwnProperty.call(REFERENCE_KIND_DECLARATIONS, kind)
    ? REFERENCE_KIND_DECLARATIONS[kind as IdReferenceKind]
    : undefined;
}

/**
 * Every way `kind` can be filled, as display strings — `builtin`, `pack key
 * <key>`, `config key <key>`, then local files — or `[]` for a kind with no
 * row (`command`, `file`, … are not id registries).
 */
export function referenceKindDeclarationPaths(kind: ReferenceKind): readonly string[] {
  const d = declarationOf(kind);
  if (!d) return [];
  return [
    ...(d.builtin ? ['builtin (always populated)'] : []),
    ...(d.packKeys ?? []).map((k) => `pack key ${k}`),
    ...(d.configKeys ?? []).map((k) => `config key ${String(k)}`),
    ...(d.localFiles ?? []),
  ];
}

/**
 * THE declarability answer: can ANY declaration (builtin, config key, local
 * file, pack key) fill `kind`'s registry? A reference to a kind for which this
 * is false can never resolve — the contributions report files it as
 * `undeclarable-kind`, never as a fixable empty registry. The r76 lock keeps
 * it true for every kind the resolver lists.
 */
export function isReferenceKindDeclarable(kind: ReferenceKind): boolean {
  return referenceKindDeclarationPaths(kind).length > 0;
}

/** `pack key migrationProfileFiles · sharkcraft/migration-profiles.ts` — the one wording every surface prints. */
export function formatReferenceKindDeclaration(kind: ReferenceKind): string {
  const paths = referenceKindDeclarationPaths(kind);
  return paths.length > 0 ? paths.join(' · ') : 'nothing — no builtin, config key, local file or pack key declares it';
}

/** The command that shows `kind`'s ids (its `listVerb`), or `undefined` for a kind with no row. */
export function referenceKindListVerb(kind: ReferenceKind): string | undefined {
  return declarationOf(kind)?.listVerb;
}
