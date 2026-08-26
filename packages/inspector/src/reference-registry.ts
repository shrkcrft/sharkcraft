import type { KnowledgeReferenceKind } from '@shrkcrft/knowledge';
import { listConstructs, warmConstructCache } from './construct-registry.ts';
import { listConventions } from './convention-registry.ts';
import { loadAllContractTemplates } from './contract-template-registry.ts';
import { listDecisions } from './decision-records.ts';
import { HELPERS } from './helper-registry.ts';
import { listMigrationProfilesFromPacks } from './migration-profile-registry.ts';
import { listPackHelpers } from './pack-helper-registry.ts';
import { listPlaybooks, warmPlaybookCache } from './playbook-registry.ts';
import { listPolicyIds, warmPolicyCache } from './policy-registry.ts';
import { listRegistrationHints } from './registration-hint-registry.ts';
import { loadScaffoldPatternsFromInspection } from './scaffold-patterns.ts';
import { listTaskRoutingHints } from './task-routing-hint-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * The id sets a knowledge/doc reference can resolve against.
 *
 * `knowledge-stale` already answered "does this id exist?" per kind, one
 * private `*Exists` helper at a time. The doc-reference linter needs the same
 * answer AND the candidate LIST (to suggest what the author meant), so the
 * lookup moves here and both consume it. Two implementations of "which
 * template ids exist" would eventually disagree, and the one nobody runs would
 * be the wrong one.
 *
 * Every list is read defensively off the inspection: these registries are
 * populated by different layers and a repo may legitimately have none of a
 * given kind, which must read as "no candidates", never as a crash.
 */

/**
 * Kinds a DOC reference may resolve against.
 *
 * A superset of `KnowledgeReferenceKind`: `pipeline` is a real registry that
 * prose cites constantly (`the spine pipelines (engine.feature-dev, …)`) but
 * that a knowledge entry has never had a structured reference kind for. The
 * doc plane owns its own list rather than widening the knowledge contract for
 * a need only this surface has.
 */
export type DocReferenceKind = KnowledgeReferenceKind | 'pipeline';

/**
 * EVERY kind this engine can answer "does this id exist?" for.
 *
 * A superset of `DocReferenceKind`: the self-config doctor cross-references
 * kinds prose never cites (a decision record, a scaffold pattern, a routing
 * hint). It used to answer for them from its OWN lookup sets, built from its
 * own sources — so "one definition of does-this-id-exist" was a doc claim, not
 * a property of the code, and the two answers agreed only by coincidence. They
 * did not always: `sharkcraft.mcp-read-only` is a declared policy that the
 * doctor's pack-only policy set reported as unknown.
 *
 * `docReferences[].resolvesAs` is unchanged — it still accepts exactly the
 * `DocReferenceKind`s. Widening the RESOLVER is not widening the config.
 */
export type ReferenceKind =
  | DocReferenceKind
  | 'knowledge'
  | 'rule'
  | 'decision'
  | 'convention'
  | 'contract-template'
  | 'migration-profile'
  | 'routing-hint'
  | 'registration-hint'
  | 'scaffold-pattern';

/**
 * Every kind that resolves against a registry of ids.
 *
 * `command` is deliberately absent: the catalog lives in the CLI package,
 * ABOVE this layer, so it resolves by shape instead of by list. `file` /
 * `directory` / `symbol` / `package` / `url` are not id registries at all.
 */
export const ALL_ID_REFERENCE_KINDS: readonly ReferenceKind[] = [
  'template',
  'pipeline',
  'playbook',
  'policy',
  'construct',
  'helper',
  'boundary-rule',
  'path-convention',
  'knowledge',
  'rule',
  'decision',
  'convention',
  'contract-template',
  'migration-profile',
  'routing-hint',
  'registration-hint',
  'scaffold-pattern',
];

/** Narrow structural view of a registry that can list `{ id }` records. */
interface IListable {
  list?: () => readonly { id: string }[];
}

function listIds(reg: IListable | undefined): string[] {
  if (!reg || typeof reg.list !== 'function') return [];
  return (reg.list() ?? []).map((r) => r.id);
}

/**
 * Kinds whose ids only exist after an ASYNC load.
 *
 * The resolver is synchronous — a doc linter walks lines, and a lookup set is
 * built once — so these are read from a snapshot that {@link
 * warmReferenceRegistries} fills. An unwarmed snapshot is empty, which reads as
 * "no such id" for every id; {@link emptyReferenceKinds} is the safety net for
 * when a caller forgets.
 */
const CACHE_BACKED_KINDS: readonly ReferenceKind[] = [
  'playbook',
  'construct',
  'policy',
  'helper',
  'convention',
  'contract-template',
  'migration-profile',
  'routing-hint',
  'registration-hint',
  'scaffold-pattern',
];

/** Snapshot of the async-loaded kinds, per project root. */
const ASYNC_IDS = new Map<string, Map<ReferenceKind, readonly string[]>>();

async function safeIds(load: () => Promise<readonly string[]>): Promise<readonly string[]> {
  try {
    return await load();
  } catch {
    // A registry that will not load is its OWN surface's problem to report.
    // Resolution must degrade to "no candidates", never to a crash — but never
    // silently to "your id is wrong" either, which is what the empty-kind guard
    // is for.
    return [];
  }
}

/**
 * Populate the snapshot the synchronous accessors read.
 *
 * Call this once, from the async layer that owns the inspection, before
 * resolving anything. Without it a correct playbook — or convention, or
 * scaffold pattern — resolves to nothing, which is exactly how a correct id got
 * reported as an error twice.
 */
export async function warmReferenceRegistries(inspection: ISharkcraftInspection): Promise<void> {
  await Promise.all([
    warmPlaybookCache(inspection),
    warmConstructCache(inspection),
    warmPolicyCache(inspection),
  ]);
  const [
    packHelpers,
    conventions,
    contractTemplates,
    migrationProfiles,
    routingHints,
    registrationHints,
    scaffoldPatterns,
  ] = await Promise.all([
    safeIds(async () => (await listPackHelpers(inspection)).map((e) => e.helper.id)),
    safeIds(async () => (await listConventions(inspection)).map((e) => e.convention.id)),
    safeIds(async () => (await loadAllContractTemplates(inspection)).entries.map((e) => e.template.id)),
    safeIds(async () => (await listMigrationProfilesFromPacks(inspection)).map((p) => p.id)),
    safeIds(async () => (await listTaskRoutingHints(inspection)).map((e) => e.hint.id)),
    safeIds(async () => (await listRegistrationHints(inspection)).map((e) => e.hint.id)),
    safeIds(async () =>
      (await loadScaffoldPatternsFromInspection(inspection)).patterns.map((e) => e.pattern.id),
    ),
  ]);
  ASYNC_IDS.set(
    inspection.projectRoot,
    new Map<ReferenceKind, readonly string[]>([
      // Built-in helpers need no load; pack-contributed ones do. The doc
      // resolver used to see only the built-ins (an empty frozen array) while
      // the doctor saw both — a live divergence between the two paths.
      ['helper', [...HELPERS.map((h) => h.id), ...packHelpers]],
      ['convention', conventions],
      ['contract-template', contractTemplates],
      ['migration-profile', migrationProfiles],
      ['routing-hint', routingHints],
      ['registration-hint', registrationHints],
      ['scaffold-pattern', scaffoldPatterns],
    ]),
  );
}

function asyncIds(inspection: ISharkcraftInspection, kind: ReferenceKind): readonly string[] {
  return ASYNC_IDS.get(inspection.projectRoot)?.get(kind) ?? [];
}

/**
 * Every registered id of `kind`, for existence checks and for suggesting what
 * an unresolved token might have meant.
 *
 * **The invariant:** each kind reads the SAME source its `list` verb reads.
 * `template` goes through `templateRegistry` because that is what `shrk
 * templates list` prints — not the `templates` array it happens to be built
 * from today, which would agree only until someone filters one of them.
 */
export function referenceIdsFor(
  inspection: ISharkcraftInspection,
  kind: ReferenceKind,
): readonly string[] {
  switch (kind) {
    case 'template':
      return listIds(inspection.templateRegistry as unknown as IListable);
    case 'pipeline':
      return listIds(inspection.pipelineRegistry as unknown as IListable);
    case 'rule':
      return listIds(inspection.ruleService as unknown as IListable);
    case 'boundary-rule':
      return listIds(inspection.boundaryRegistry as unknown as IListable);
    case 'path-convention':
      return listIds(inspection.pathService as unknown as IListable);
    case 'knowledge':
      return inspection.knowledgeEntries.map((k: { id: string }) => k.id);
    case 'decision':
      try {
        return listDecisions(inspection).map((d) => d.id);
      } catch {
        return [];
      }
    case 'playbook':
      return listPlaybooks(inspection).map((p) => p.id);
    case 'construct':
      return listConstructs(inspection).map((c) => c.id);
    case 'policy':
      // Declarations only — `evaluatePolicy` is the one that RUNS them.
      return listPolicyIds(inspection);
    case 'helper':
    case 'convention':
    case 'contract-template':
    case 'migration-profile':
    case 'routing-hint':
    case 'registration-hint':
    case 'scaffold-pattern':
      return asyncIds(inspection, kind);
    case 'command':
      // The command catalog lives in the CLI package, ABOVE this layer, so it
      // cannot be imported here. `referenceIdExists` keeps the permissive
      // shape check instead of pretending to a list it cannot see.
      return [];
    default:
      // `file` / `directory` / `symbol` / `package` / `url` are not id
      // registries; they resolve against the filesystem or not at all.
      return [];
  }
}

/**
 * Kinds among `kinds` whose registry is EMPTY in this repo.
 *
 * This is the generalisation of the bug that prompted it: resolving against an
 * empty registry cannot succeed, so every id checked against it is reported
 * wrong — a gate confidently flagging CORRECT usage, which is the fastest way
 * to get a gate switched off. Emptiness is repo-dependent (a project may simply
 * have no playbooks), so it cannot be a config-time error; the caller surfaces
 * it as a loud refusal at run time instead.
 */
export function emptyReferenceKinds(
  inspection: ISharkcraftInspection,
  kinds: readonly ReferenceKind[],
): readonly ReferenceKind[] {
  return kinds.filter(
    (kind) => kind !== 'command' && referenceIdsFor(inspection, kind).length === 0,
  );
}

/** True when `kind`'s ids come from an async-populated cache. */
export function isCacheBackedKind(kind: ReferenceKind): boolean {
  return CACHE_BACKED_KINDS.includes(kind);
}

/**
 * Whether `id` is registered under `kind`.
 *
 * `command` keeps its historical permissiveness: the catalog is not always
 * populated, and a repo citing `shrk gen …` should not be told its own CLI
 * does not exist because an optional catalog was absent.
 */
export function referenceIdExists(
  inspection: ISharkcraftInspection,
  kind: ReferenceKind,
  id: string,
): boolean {
  if (kind === 'command') {
    const catalog = (inspection as { commandCatalog?: readonly { id: string }[] }).commandCatalog;
    if (Array.isArray(catalog) && catalog.some((c) => c.id === id)) return true;
    return id.startsWith('shrk ') || id.startsWith('bun ');
  }
  return referenceIdsFor(inspection, kind).includes(id);
}

/**
 * The union of candidate ids across `kinds`, deduped and sorted.
 *
 * A doc token is checked against several registries at once (a `nge.foo` might
 * be a template OR a playbook), so the suggester needs one pool rather than
 * per-kind lists that would each propose their own nearest miss.
 */
export function referenceIdPool(
  inspection: ISharkcraftInspection,
  kinds: readonly ReferenceKind[],
): readonly string[] {
  const pool = new Set<string>();
  for (const kind of kinds) {
    for (const id of referenceIdsFor(inspection, kind)) pool.add(id);
  }
  return [...pool].sort();
}

/**
 * Whether `id` is registered under ANY kind.
 *
 * For cross-references that do not name a kind — a search-tuning entry boosts
 * "some id", a decision record relates to "some id". That union used to be
 * hand-written as a chain of `lookups.x.has(id) || lookups.y.has(id) || …`,
 * which is a list that silently goes stale: it omitted policies, decisions and
 * scaffold patterns, so seven of shrk's own correctly-registered ids were
 * reported unknown. Reading the kind list means adding a kind widens the union
 * automatically.
 */
export function referenceIdExistsInAnyKind(
  inspection: ISharkcraftInspection,
  id: string,
): boolean {
  return ALL_ID_REFERENCE_KINDS.some((kind) => referenceIdsFor(inspection, kind).includes(id));
}

/** The kind that accepted `id`, or `undefined` — for "resolved as what?" output. */
export function referenceKindOf(
  inspection: ISharkcraftInspection,
  id: string,
): ReferenceKind | undefined {
  return ALL_ID_REFERENCE_KINDS.find((kind) => referenceIdsFor(inspection, kind).includes(id));
}
