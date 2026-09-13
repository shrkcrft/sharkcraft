import type { KnowledgeReferenceKind } from '@shrkcrft/knowledge';
import { CommandResolutionStatus } from './command-resolution-status.ts';
import type { ICommandResolution } from './i-command-resolution.ts';
import type { ICommandResolveOptions } from './i-command-resolve-options.ts';
import type { IReferenceWarmOptions } from './i-reference-warm-options.ts';
import { ReferenceIdStatus } from './reference-id-status.ts';
import { listConstructs, warmConstructCache } from './construct-registry.ts';
import { listConventions } from './convention-registry.ts';
import { loadAllContractTemplates } from './contract-template-registry.ts';
import { listDecisions, loadTsDecisions } from './decision-records.ts';
import { listAllHelpers } from './helper-catalog.ts';
import { listMigrationProfilesFromPacks } from './migration-profile-registry.ts';
import { listPlaybooks, warmPlaybookCache } from './playbook-registry.ts';
import { listPolicyIds, warmPolicyCache } from './policy-registry.ts';
import { listWorkspaceProfileEntries } from './profile-registry.ts';
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
  | 'workspace-profile'
  | 'routing-hint'
  | 'registration-hint'
  | 'scaffold-pattern';

/**
 * Every kind that resolves against a registry of ids.
 *
 * `command` is deliberately absent: the command index lives in the CLI
 * package, ABOVE this layer, so it resolves through the resolver the CLI
 * injects ({@link resolveCommandReference}) — never by shape, and never by a
 * list this layer cannot see. `file` / `directory` / `symbol` / `package` /
 * `url` are not id registries at all.
 *
 * **List order is SPECIFICITY.** A rule and a path convention are knowledge
 * entries filtered by type, so `knowledge` is a SUPERSET of both and must come
 * after them: {@link referenceKindsOf} returns kinds in this order, so its first
 * element names the most specific registry. With `knowledge` listed first,
 * every rule id used to report `knowledge` as "the" kind it resolved as.
 *
 * **Every kind here is DECLARABLE** (round 12): `REFERENCE_KIND_DECLARATIONS`
 * is a `Record<IdReferenceKind, …>`, so a kind added here without a row saying
 * how its ids come to exist is a compile error, and the r76 declarability lock
 * proves every path in that row fills this resolver. `workspace-profile` is
 * the builtin WorkspaceProfile vocabulary — the applicability filters'
 * `profileIds` resolve against it (they were bound to `migration-profile`, a
 * readiness registry, and sat at NOT VERIFIED forever).
 */
export const ALL_ID_REFERENCE_KINDS = [
  'template',
  'pipeline',
  'playbook',
  'policy',
  'construct',
  'helper',
  'boundary-rule',
  'path-convention',
  'rule',
  'knowledge',
  'decision',
  'convention',
  'contract-template',
  'migration-profile',
  'workspace-profile',
  'routing-hint',
  'registration-hint',
  'scaffold-pattern',
] as const satisfies readonly ReferenceKind[];

/** A kind that resolves against a registry of ids — a member of {@link ALL_ID_REFERENCE_KINDS}. */
export type IdReferenceKind = (typeof ALL_ID_REFERENCE_KINDS)[number];

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
  // TS decisions (`sharkcraft/decisions.ts`, pack `decisionFiles`) reach the
  // sync `listDecisions` only after the warm loads them, so an unwarmed lookup
  // of a declared decision reads "missing" — a cache-backed kind, covered by
  // the same "could not look" safety net (round 12 review, R12-DOC-5).
  'decision',
];

/** Snapshot of the async-loaded kinds, per project root. */
const ASYNC_IDS = new Map<string, Map<ReferenceKind, readonly string[]>>();

/**
 * The injected command resolver, per inspection OBJECT.
 *
 * Keyed by the inspection rather than the project root so a resolver injected
 * for one run can never leak into an unrelated inspection of the same root —
 * an engine call that was never given one must stay `Unverifiable`. A later
 * warm WITHOUT a resolver (an inner engine call re-warming the same
 * inspection) keeps the one already injected.
 */
const COMMAND_RESOLVERS = new WeakMap<
  object,
  (raw: string, options?: ICommandResolveOptions) => ICommandResolution
>();

/** The command-REFERENCE reading: a bare command-word head names a shrk verb. */
const SHRK_COMMAND_REFERENCE: ICommandResolveOptions = Object.freeze({ assumeShrk: true });

/** The loud-skip message every consumer prints for an un-injected command index. */
export const COMMAND_INDEX_NOT_INJECTED = 'command index not injected — NOT VERIFIED';

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
 *
 * `options.commandResolver` is the CLI's command-string resolver (the command
 * index lives above this layer). Without one, every `command` reference is
 * `Unverifiable` — see {@link resolveCommandReference}.
 */
export async function warmReferenceRegistries(
  inspection: ISharkcraftInspection,
  options: IReferenceWarmOptions = {},
): Promise<void> {
  if (options.commandResolver) COMMAND_RESOLVERS.set(inspection, options.commandResolver);
  await Promise.all([
    warmPlaybookCache(inspection),
    warmConstructCache(inspection),
    warmPolicyCache(inspection),
    // TS decisions (`sharkcraft/decisions.ts`, pack `decisionFiles`) reach the
    // sync `listDecisions` only through this cache. Unwarmed, a declared
    // decision resolved as nothing — the r76 declarability lock found it.
    loadTsDecisions(inspection).catch(() => []),
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
    // THE helper catalog — the same list `shrk helper list` prints.
    safeIds(async () => (await listAllHelpers(inspection)).entries.map((h) => h.id)),
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
      // Built-ins ∪ pack/local helpers, from the one catalog `helper
      // list|get|plan` read — so list ≡ resolve by construction. (The doc
      // resolver used to see only the built-ins while the doctor saw both,
      // and `helper get` saw neither.)
      ['helper', packHelpers],
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
    case 'workspace-profile':
      // THE builtin WorkspaceProfile vocabulary — the same function `shrk
      // profiles list --kind workspace` prints, so list ≡ resolve by
      // construction. Sync and never empty: it can never loud-skip.
      return listWorkspaceProfileEntries(inspection).map((e) => e.id);
    case 'helper':
    case 'convention':
    case 'contract-template':
    case 'migration-profile':
    case 'routing-hint':
    case 'registration-hint':
    case 'scaffold-pattern':
      return asyncIds(inspection, kind);
    case 'command':
      // The command index lives in the CLI package, ABOVE this layer, so it
      // cannot be listed here. Existence goes through the injected resolver
      // (`resolveCommandReference`) — never through a list this layer cannot
      // see, and never through the shape of the string.
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
 *
 * `command` has no list; it can resolve exactly when a resolver was injected.
 * Without one it is reported here — nothing could resolve, so every command
 * would be reported wrong (or, before round 11, every `shrk …` string right).
 */
export function emptyReferenceKinds(
  inspection: ISharkcraftInspection,
  kinds: readonly ReferenceKind[],
): readonly ReferenceKind[] {
  return kinds.filter((kind) =>
    kind === 'command'
      ? !hasCommandResolver(inspection)
      : referenceIdsFor(inspection, kind).length === 0,
  );
}

/** True when the CLI injected its command resolver for this inspection. */
export function hasCommandResolver(inspection: ISharkcraftInspection): boolean {
  return COMMAND_RESOLVERS.has(inspection);
}

/**
 * True once {@link warmReferenceRegistries} ran for this inspection's root.
 *
 * The cache-backed kinds read EMPTY until then, so a consumer that resolves
 * them (a test runner checking `expectedPlaybooks`) can report "could not look"
 * instead of "your correct id does not exist".
 */
export function isReferenceCacheWarm(inspection: ISharkcraftInspection): boolean {
  return ASYNC_IDS.has(inspection.projectRoot);
}

/** Ok / PrefixOnly / NotShrk: the string resolves (or is not ours to judge). */
export function isCommandResolved(resolution: ICommandResolution): boolean {
  return (
    resolution.status === CommandResolutionStatus.Ok ||
    resolution.status === CommandResolutionStatus.PrefixOnly ||
    resolution.status === CommandResolutionStatus.NotShrk
  );
}

/**
 * THE function every consumer calls to resolve a command string: knowledge
 * `command` references and anchors, the self-config doctor's command probes,
 * agent-test `expectedCommands`, the query resolver.
 *
 * The command index lives in the CLI, above this layer, so the answer comes
 * from the resolver the CLI injected via `warmReferenceRegistries(inspection,
 * { commandResolver })`. Without one the answer is `Unverified` — the string
 * was NOT checked. It used to be `id.startsWith('shrk ')`, which certified
 * every `shrk …` string (including three dead ones in shrk's own knowledge) as
 * a real command, forever.
 */
export function resolveCommandReference(
  inspection: ISharkcraftInspection,
  raw: string,
  options: ICommandResolveOptions = {},
): ICommandResolution {
  const resolver = COMMAND_RESOLVERS.get(inspection);
  if (!resolver) {
    return { status: CommandResolutionStatus.Unverified, reason: COMMAND_INDEX_NOT_INJECTED };
  }
  return resolver(raw, options);
}

/**
 * THE reading of a `command` REFERENCE — a knowledge `command` reference or
 * anchor, an agent test's `expectedCommands`, the `command` reference kind.
 *
 * Such a string names a shrk command, so a bare form is read as one: `doctor`
 * resolves, `frobnicate` is an unknown verb (see {@link ICommandResolveOptions}).
 * knowledge-stale, the self-config doctor's reference probes and the agent-test
 * runner all call THIS — they used to normalise the same string three ways
 * (`frobnicate` was `ok` in one, `not-shrk` in another and `unknown-verb` in
 * the third). Free shell text (a playbook step) goes through
 * {@link resolveCommandReference} without the assumption.
 */
export function resolveShrkCommandReference(
  inspection: ISharkcraftInspection,
  command: string,
): ICommandResolution {
  return resolveCommandReference(inspection, command, SHRK_COMMAND_REFERENCE);
}

/**
 * Tri-state existence: `Exists` / `Missing` / `Unverifiable`.
 *
 * For `command`: Ok, PrefixOnly and NotShrk are `Exists`; every Unknown* is
 * `Missing`; no injected resolver is `Unverifiable` (report it as NOT VERIFIED,
 * never as Ok). Read as a command REFERENCE ({@link resolveShrkCommandReference}).
 * Every other kind is `Exists` / `Missing` against its registry.
 */
export function referenceIdStatus(
  inspection: ISharkcraftInspection,
  kind: ReferenceKind,
  id: string,
): ReferenceIdStatus {
  if (kind === 'command') {
    const resolution = resolveShrkCommandReference(inspection, id);
    if (resolution.status === CommandResolutionStatus.Unverified) {
      return ReferenceIdStatus.Unverifiable;
    }
    return isCommandResolved(resolution) ? ReferenceIdStatus.Exists : ReferenceIdStatus.Missing;
  }
  return referenceIdsFor(inspection, kind).includes(id)
    ? ReferenceIdStatus.Exists
    : ReferenceIdStatus.Missing;
}

/** True when `kind`'s ids come from an async-populated cache. */
export function isCacheBackedKind(kind: ReferenceKind): boolean {
  return CACHE_BACKED_KINDS.includes(kind);
}

/**
 * Whether `id` is registered under `kind` — `true` only for
 * {@link ReferenceIdStatus.Exists}.
 *
 * For `command` this is `false` when no resolver was injected: an unverifiable
 * command is not an existing one. A caller that must tell "missing" from
 * "could not look" reads {@link referenceIdStatus} instead.
 */
export function referenceIdExists(
  inspection: ISharkcraftInspection,
  kind: ReferenceKind,
  id: string,
): boolean {
  return referenceIdStatus(inspection, kind, id) === ReferenceIdStatus.Exists;
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

/**
 * EVERY kind whose registry lists `id`, most specific first (the order of
 * {@link ALL_ID_REFERENCE_KINDS}) — empty when nothing does.
 *
 * Ids carry no namespace prefix, so one id can legitimately live in several
 * registries: a rule is also a knowledge entry, and a template may share an id
 * with a construct. "Which namespace did this resolve into?" therefore has a
 * LIST as its honest answer; {@link referenceKindOf} is its first element.
 */
export function referenceKindsOf(
  inspection: ISharkcraftInspection,
  id: string,
): readonly ReferenceKind[] {
  return ALL_ID_REFERENCE_KINDS.filter((kind) => referenceIdsFor(inspection, kind).includes(id));
}

/** The most specific kind that accepted `id`, or `undefined` — for "resolved as what?" output. */
export function referenceKindOf(
  inspection: ISharkcraftInspection,
  id: string,
): ReferenceKind | undefined {
  return referenceKindsOf(inspection, id)[0];
}

/**
 * One-shot projection of {@link referenceIdsFor} over every kind, for O(1)
 * membership when a caller resolves many ids at once (the declared
 * cross-reference collector walks every asset). Not a second source: each set
 * is built from `referenceIdsFor`, so list ≡ resolve still holds per kind.
 * Snapshot semantics — rebuild it after a warm.
 */
export function referenceIdSets(
  inspection: ISharkcraftInspection,
): ReadonlyMap<ReferenceKind, ReadonlySet<string>> {
  const out = new Map<ReferenceKind, ReadonlySet<string>>();
  for (const kind of ALL_ID_REFERENCE_KINDS) out.set(kind, new Set(referenceIdsFor(inspection, kind)));
  return out;
}
