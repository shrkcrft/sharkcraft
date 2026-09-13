/**
 * Self-config doctor v2.
 *
 * True cross-reference graph validation. Same read-only contract as v1, but
 * with a richer finding schema and additional checks the v1 walker did not
 * perform:
 *
 *   - agent-tests   → helpers / commands / playbooks / policies
 *   - policies      → rules / commands / paths
 *   - pipelines     → templates / commands (via step.cliCommands)
 *   - playbooks     → templates / helpers / commands / profiles
 *   - registration-hints → templates / conventions / profiles
 *   - decisions     → related rules / commands / files / knowledge / templates / playbooks / policies / constructs
 *
 * The v1 schema (sharkcraft.self-config-doctor/v1) is kept; v2 is opt-in by
 * default from the CLI but can be requested explicitly via `--schema v2`.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  coverageShortfall,
  DEAD_SELECTOR_CAUSES,
  formatCoverage,
  RejectionCause,
  settleUnitLiveness,
  UnitDeadCause,
  UnitDeadWeight,
  UnitLivenessState,
  type ISettledUnitLiveness,
  type IUnitLiveness,
  type IUnitObservation,
} from '@shrkcrft/core';
import type { ISearchTuningKeyProbe } from './i-search-tuning-key-probe.ts';
import { searchTuningKeyProbes } from './search-tuning-key-probes.ts';
import { ContributionKind } from './contribution-kind.ts';
import { resolveEntryFile } from './contribution-load-failures.ts';
import type { IUnresolvableReference } from './i-unresolvable-reference.ts';
import type { IUnresolvableReferenceScan } from './i-unresolvable-reference-scan.ts';
import { UnresolvableReason } from './unresolvable-reason.ts';
import {
  listTaskRoutingHintIssues,
  loadTaskRoutingHints,
  listTaskRoutingHints,
  routingHintCanMatch,
} from './task-routing-hint-registry.ts';
import { buildRegistrationHintDoctorReport, listRegistrationHints } from './registration-hint-registry.ts';
import { listDecisions, loadTsDecisions } from './decision-records.ts';
import {
  COMMAND_INDEX_NOT_INJECTED,
  emptyReferenceKinds,
  hasCommandResolver,
  referenceIdExists,
  referenceIdsFor,
  referenceKindsOf,
  resolveCommandReference,
  resolveShrkCommandReference,
  warmReferenceRegistries,
  type ReferenceKind,
} from './reference-registry.ts';
import { nearestIds } from './nearest-id.ts';
import {
  formatReferenceKindDeclaration,
  isReferenceKindDeclarable,
  referenceKindListVerb,
} from './reference-kind-declarations.ts';
import { PROBED_ID_FIELDS } from './probed-id-fields.ts';
import { ProbedIdSource } from './probed-id-source.ts';
import { listConventions } from './convention-registry.ts';
import {
  ROUTING_RECOMMENDS_CHANNEL_KEYS,
  ROUTING_RECOMMENDS_CHANNELS,
} from './routing-recommends-channels.ts';
import {
  doctorScaffoldPatterns,
  enumerateScaffoldPatternCandidates,
  loadScaffoldPatternsFromInspection,
  scaffoldPatternCoverage,
} from './scaffold-patterns.ts';
import { lintSearchTuning } from './search-tuning-lint.ts';
import { listSearchTuningIssues, loadSearchTuning, type ISearchTuningDoctorIssue } from './search-tuning-registry.ts';
import { resolveSearchTuningKey } from './search-tuning-key-resolver.ts';
import { SearchTuningKeyStatus } from './search-tuning-key-status.ts';
import { CommandResolutionStatus } from './command-resolution-status.ts';
import type { IVerdictCoverage } from '@shrkcrft/core';
import {
  collectDeclaredXrefs,
  declaredXrefCoverage,
  declaredXrefSummaryLine,
} from './declared-cross-references.ts';
import { DeclaredXrefStatus } from './declared-xref-status.ts';
import type { IDeclaredXrefReport } from './i-declared-xref-report.ts';
import { listConstructs } from './construct-registry.ts';
import { listPlaybooks, loadPlaybooksWithIssues } from './playbook-registry.ts';
import {
  buildPackContributionsInventoryAsync,
  type IPackContributionsInventory,
} from './pack-contributions-inventory.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const SELF_CONFIG_DOCTOR_V2_SCHEMA = 'sharkcraft.self-config-doctor/v2';

export enum SelfConfigSeverityV2 {
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
}

/**
 * Source / target kind taxonomy. Open string for forward-compat with
 * pack-contributed kinds, but the engine emits one of these values:
 *
 *   - every reference kind maps onto ITSELF (THE table behind `selfKindOf`);
 *   - `search-document` — a `<prefix>:<id>` search document whose prefix has no
 *     id registry (`doc:README.md`), or the cap summary's "N more document(s)":
 *     it exists (or cannot be checked) — it is never "unknown";
 *   - `schema` — a declaration-shape finding (relation `validates`) whose target
 *     id is the field path (`taskHints[1].whenTokens`, `facets.bad-kind[k1]`);
 *   - `self-config` — the doctor itself (its own probe summaries);
 *   - every contribution kind maps onto a finding kind (THE table behind
 *     `rejectionFindingOf`), so a rejected entry of any loader-backed slot —
 *     a construct facet, a feedback rule, a gate-plane rule — has a kind;
 *   - `unknown` — RESERVED for a target id that resolves in NO registry, as THE
 *     id resolver / THE key resolver answered. Only `selfKindOf(undefined)`
 *     produces it (a source lock holds that; round 12, 12.4).
 */
export type SelfConfigKind =
  | 'knowledge'
  | 'command'
  | 'helper'
  | 'template'
  | 'playbook'
  | 'pipeline'
  | 'policy'
  | 'rule'
  | 'path'
  | 'convention'
  | 'registration-hint'
  | 'routing-hint'
  | 'agent-test'
  | 'decision'
  | 'construct'
  | 'preset'
  | 'migration-profile'
  | 'workspace-profile'
  | 'contract-template'
  | 'pack'
  | 'schema'
  | 'file'
  | 'directory'
  | 'symbol'
  | 'package'
  | 'url'
  | 'path-convention'
  | 'boundary-rule'
  | 'scaffold-pattern'
  | 'search-tuning'
  | 'search-document'
  | 'self-config'
  | 'construct-facet'
  | 'feedback-rule'
  | 'context-test'
  | 'docs'
  | 'delegate-recipe'
  | 'framework-extractor'
  | 'wiring-rule'
  | 'registry'
  | 'registration-idiom'
  | 'policy-rule'
  | 'reuse-primitive'
  | 'baseline'
  | 'generated-artifact'
  | 'doc-reference'
  | 'unknown';

/**
 * Edge relation taxonomy. Open string to allow future relations.
 */
export type SelfConfigRelation =
  | 'references'
  | 'expects'
  | 'validates'
  | 'requires'
  | 'produces'
  | 'routes-to'
  | 'tunes'
  | 'documents'
  | 'supersedes'
  | 'related';

export interface ISelfConfigFindingV2 {
  readonly id: string;
  readonly severity: SelfConfigSeverityV2;
  readonly code: string;
  readonly sourceKind: SelfConfigKind;
  readonly sourceId: string;
  readonly targetKind: SelfConfigKind;
  readonly targetId: string;
  readonly relation: SelfConfigRelation;
  readonly file?: string;
  readonly message: string;
  readonly suggestedFix?: string;
  readonly nextCommand?: string;
  /**
   * Reporter confidence in this finding.
   *   - high   — extracted from authoritative loader output
   *   - medium — extracted from authoritative loader but relation is weak
   *   - low    — derived from regex / fallback parsing
   */
  readonly confidence: 'high' | 'medium' | 'low';
  /**
   * How many times the same (source, relation, target, code) was found — one
   * finding per repeat, never N identical ones sharing a "unique" id.
   */
  readonly occurrences?: number;
}

export interface ISelfConfigDoctorReportV2 {
  readonly schema: typeof SELF_CONFIG_DOCTOR_V2_SCHEMA;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly findings: readonly ISelfConfigFindingV2[];
  readonly totals: Readonly<{
    error: number;
    warning: number;
    info: number;
    byRelation: Readonly<Record<string, number>>;
    bySourceKind: Readonly<Record<string, number>>;
    byTargetKind: Readonly<Record<string, number>>;
  }>;
  /**
   * `errors` when any error finding; else `unverified` when any `coverage`
   * record has a shortfall (a dead or unverifiable unit — the CLI exits 2);
   * else `warnings` / `ok`.
   */
  readonly verdict: 'ok' | 'warnings' | 'errors' | 'unverified';
  readonly nextCommands: readonly string[];
  /**
   * Per-unit coverage of every probe family — the ONE list both the verdict
   * above and the CLI's settled exit are derived from (core's
   * `coverageShortfall`): `command strings`, `search tuning` boost keys and
   * task hints, `routing hints` and their recommended ids, `registration
   * hints` discovery selectors and related ids, `scaffold patterns` globs and
   * patterns. A family with no units contributes no record.
   */
  readonly coverage: readonly IVerdictCoverage[];
  /** Every UNMARKED dead unit (a selector that matches nothing, a boost that never fires), labelled — THE families' settled `dead`. */
  readonly deadUnits: readonly string[];
  /**
   * Round 13: every selector unit THE families' settles did not find live —
   * dead, intended-empty (its acceptance rides in {@link coverage}), went-live
   * (a stale `expectEmpty` marker) or unproven — with its state and marker.
   * What `--fail-on-dead-units` decides on (`selectorUnitFails`, through
   * `assetDoctorProposedExit`), so a stale LOCAL marker fails there too.
   */
  readonly selectorUnits: readonly IUnitLiveness[];
  /**
   * Every declared reference the REFERENCE probes could not check — its kind's
   * registry is empty here (`registry-empty`), or nothing can ever fill it
   * (`undeclarable-kind`) — attributed to its file and field (round 12,
   * ONE-CHANGE). Each is an unexamined unit of a coverage record above; `shrk
   * packs contributions` groups the same list per contributed file.
   */
  readonly unresolvableReferences: readonly IUnresolvableReference[];
  /**
   * What the probe passes looked at. `command` covers every command string an
   * asset prescribes (agent tests, routing / registration hints, pipeline
   * steps, playbooks, constructs, presets, knowledge action hints and
   * references, decisions), deduped per (asset, command), each resolved
   * through the injected command resolver. `unverified > 0` means no resolver
   * was injected (outside the CLI): those strings were NOT checked.
   */
  readonly probes: Readonly<{
    command: Readonly<{
      probed: number;
      /** Resolved to a real command (`ok`). */
      exists: number;
      /** Verb proven, internally-dispatched tail not provable — counted, never flagged. */
      prefixOnly: number;
      /** Not a command this engine checks (git, tsc, …) — skipped, counted. */
      notShrk: number;
      /** Did not resolve — one `unknown-command` finding each. */
      unknown: number;
      /** Not checked: no command resolver injected. */
      unverified: number;
    }>;
    /**
     * Distinct search-tuning boost keys (`<kind>:<id>` search-document ids),
     * resolved within the named kind through THE key resolver.
     */
    'search-tuning-target': Readonly<{
      probed: number;
      resolved: number;
      missing: number;
      unprefixed: number;
      unknownKind: number;
      unverified: number;
    }>;
    /** Non-command routing-hint `recommends` ids, one per (hint, channel, id). */
    'routing-hint-target': Readonly<{
      probed: number;
      resolved: number;
      missing: number;
      unverified: number;
    }>;
  }>;
  /**
   * The declared cross-reference pass (round 11, 4.2): every id in a
   * `related`-style asset field, resolved through the reference registry by
   * THE collector (`declared-cross-references.ts`). What it examined is
   * reported even when nothing dangles, so a pass over zero ids never reads as
   * a clean one; its coverage record rides in {@link coverage}.
   */
  readonly crossReferences?: Readonly<{
    examined: IDeclaredXrefReport['examined'];
    counts: IDeclaredXrefReport['counts'];
    summary: string;
  }>;
}

interface IIdLookupsV2 {
  knowledge: Set<string>;
  rules: Set<string>;
  paths: Set<string>;
  templates: Set<string>;
  pipelines: Set<string>;
  policies: Set<string>;
  playbooks: Set<string>;
  conventions: Set<string>;
  contractTemplates: Set<string>;
  helpers: Set<string>;
  routingHints: Set<string>;
  registrationHints: Set<string>;
  decisions: Set<string>;
  scaffoldPatterns: Set<string>;
}

async function buildLookupsV2(
  inspection: ISharkcraftInspection,
): Promise<IIdLookupsV2> {
  // Every set is a projection of the SHARED reference registry — the same
  // module the prose linter and the structured-`references[]` validator use.
  //
  // These sets used to be built here from their own sources, and the doc claim
  // "there is one definition of does-this-id-exist, not two" was true only by
  // coincidence. It was not always true: `policies` came from the pack
  // contributions inventory alone, so every LOCALLY declared policy read as
  // unknown; `scaffoldPatterns` had no set at all; `commands` read a
  // `repositoryCommands` property nothing assigns. Seven of shrk's own
  // correctly-registered ids were reported missing.
  await warmReferenceRegistries(inspection);
  const ids = (kind: ReferenceKind): Set<string> =>
    new Set<string>(referenceIdsFor(inspection, kind));

  return {
    knowledge: ids('knowledge'),
    rules: ids('rule'),
    paths: ids('path-convention'),
    templates: ids('template'),
    pipelines: ids('pipeline'),
    policies: ids('policy'),
    playbooks: ids('playbook'),
    conventions: ids('convention'),
    contractTemplates: ids('contract-template'),
    helpers: ids('helper'),
    routingHints: ids('routing-hint'),
    registrationHints: ids('registration-hint'),
    decisions: ids('decision'),
    scaffoldPatterns: ids('scaffold-pattern'),
    // No `commands` set: it was initialised EMPTY (the command index lives in
    // the CLI, above this layer), so every command in every hint and agent test
    // was reported missing — correct ones included, and an agent test's correct
    // `expectedCommands` failed the doctor at error severity. Commands resolve
    // through the injected resolver instead — see `checkCommandStrings`.
  };
}

function findingId(parts: {
  sourceKind: SelfConfigKind;
  sourceId: string;
  targetKind: SelfConfigKind;
  targetId: string;
  relation: SelfConfigRelation;
}): string {
  return `${parts.sourceKind}:${parts.sourceId}|${parts.relation}|${parts.targetKind}:${parts.targetId}`;
}

interface IFindingInput {
  severity: SelfConfigSeverityV2;
  code: string;
  sourceKind: SelfConfigKind;
  sourceId: string;
  targetKind: SelfConfigKind;
  targetId: string;
  relation: SelfConfigRelation;
  file?: string | undefined;
  message: string;
  suggestedFix?: string | undefined;
  nextCommand?: string | undefined;
  confidence?: 'high' | 'medium' | 'low';
  occurrences?: number | undefined;
}

/**
 * Append a finding — or MERGE it into an existing one with the same id and
 * code (bumping `occurrences`), so the documented unique id is unique for
 * every check. The same tuning key in three task hints used to be three
 * identical warnings sharing one id. A same-id finding with a DIFFERENT code
 * keeps its own entry, its id suffixed with `|<code>`.
 */
function pushFinding(out: ISelfConfigFindingV2[], input: IFindingInput): void {
  const baseId = findingId(input);
  const codedId = `${baseId}|${input.code}`;
  const same = out.findIndex((f) => (f.id === baseId || f.id === codedId) && f.code === input.code);
  if (same >= 0) {
    const prev = out[same]!;
    out[same] = { ...prev, occurrences: (prev.occurrences ?? 1) + (input.occurrences ?? 1) };
    return;
  }
  const entry: ISelfConfigFindingV2 = {
    id: out.some((f) => f.id === baseId) ? codedId : baseId,
    severity: input.severity,
    code: input.code,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    relation: input.relation,
    message: input.message,
    confidence: input.confidence ?? 'high',
    ...(input.file !== undefined ? { file: input.file } : {}),
    ...(input.suggestedFix !== undefined ? { suggestedFix: input.suggestedFix } : {}),
    ...(input.nextCommand !== undefined ? { nextCommand: input.nextCommand } : {}),
    ...(input.occurrences !== undefined && input.occurrences > 1 ? { occurrences: input.occurrences } : {}),
  };
  out.push(entry);
}

function severityV2(s: 'info' | 'warning' | 'error'): SelfConfigSeverityV2 {
  return s === 'error'
    ? SelfConfigSeverityV2.Error
    : s === 'warning'
      ? SelfConfigSeverityV2.Warning
      : SelfConfigSeverityV2.Info;
}

/**
 * THE reference-kind → finding-kind table: every kind maps onto ITSELF. The
 * mapped type makes a kind added to `ReferenceKind` without a row here a
 * compile error, and a row naming a kind `SelfConfigKind` lacks a compile error
 * in `selfKindOf`. This was a `switch` whose default was `'unknown'`, so any
 * kind it forgot rendered every resolvable id of that kind `unknown:`.
 */
const SELF_KIND_OF_REFERENCE_KIND: { readonly [K in ReferenceKind]: K } = Object.freeze({
  file: 'file',
  directory: 'directory',
  symbol: 'symbol',
  command: 'command',
  package: 'package',
  url: 'url',
  template: 'template',
  pipeline: 'pipeline',
  playbook: 'playbook',
  policy: 'policy',
  construct: 'construct',
  helper: 'helper',
  'boundary-rule': 'boundary-rule',
  'path-convention': 'path-convention',
  rule: 'rule',
  knowledge: 'knowledge',
  decision: 'decision',
  convention: 'convention',
  'contract-template': 'contract-template',
  'migration-profile': 'migration-profile',
  'workspace-profile': 'workspace-profile',
  'routing-hint': 'routing-hint',
  'registration-hint': 'registration-hint',
  'scaffold-pattern': 'scaffold-pattern',
});

/** The ONE place a finding's `unknown` kind comes from: a target THE resolvers placed in no registry. */
const RESOLVED_NOWHERE: SelfConfigKind = 'unknown';

/**
 * A reference kind's finding kind. `undefined` — the caller's resolver placed
 * the id in NO registry — is `unknown`, and nothing else is: a caller holding a
 * resolvable id must pass the kind it resolved in (round 12, 12.4).
 */
function selfKindOf(kind: ReferenceKind | undefined): SelfConfigKind {
  return kind === undefined ? RESOLVED_NOWHERE : SELF_KIND_OF_REFERENCE_KIND[kind];
}

/** The `<field>` a validator issue message (`<field>: <message>`) names. */
function validatorField(message: string): string {
  const at = message.indexOf(':');
  return at > 0 ? message.slice(0, at) : message;
}

/**
 * THE contribution kind → rejection-finding table (round 12, 12.1): the
 * finding kind a rejected entry is labelled with (also its code prefix,
 * `<kind>-invalid` / `<kind>-duplicate-id`) and the doctor that shows the
 * loader's own view of it. A mapped type over the enum: a contribution kind
 * without a row is a compile error, so a new kind can never fall to a borrowed
 * label (the `unknown:` alarm of 12.4). The routing / registration hint codes
 * (`routing-hint-invalid`, `registration-hint-duplicate-id`, …) are the ones
 * those families always emitted.
 */
const REJECTION_FINDING: {
  readonly [K in ContributionKind]: { readonly kind: SelfConfigKind; readonly doctor: string };
} = Object.freeze({
  [ContributionKind.Knowledge]: { kind: 'knowledge', doctor: 'shrk doctor' },
  [ContributionKind.Rule]: { kind: 'rule', doctor: 'shrk doctor' },
  [ContributionKind.Path]: { kind: 'path-convention', doctor: 'shrk doctor' },
  [ContributionKind.PathConvention]: { kind: 'path-convention', doctor: 'shrk doctor' },
  [ContributionKind.Docs]: { kind: 'docs', doctor: 'shrk doctor' },
  [ContributionKind.Template]: { kind: 'template', doctor: 'shrk templates doctor' },
  [ContributionKind.Pipeline]: { kind: 'pipeline', doctor: 'shrk pipelines list' },
  [ContributionKind.Preset]: { kind: 'preset', doctor: 'shrk presets list' },
  [ContributionKind.Boundary]: { kind: 'boundary-rule', doctor: 'shrk check boundaries' },
  [ContributionKind.ScaffoldPattern]: { kind: 'scaffold-pattern', doctor: 'shrk scaffolds doctor' },
  [ContributionKind.Policy]: { kind: 'policy', doctor: 'shrk policy list' },
  [ContributionKind.Construct]: { kind: 'construct', doctor: 'shrk constructs list' },
  [ContributionKind.ConstructFacet]: { kind: 'construct-facet', doctor: 'shrk constructs list' },
  [ContributionKind.Playbook]: { kind: 'playbook', doctor: 'shrk playbooks list' },
  [ContributionKind.SearchTuning]: { kind: 'search-tuning', doctor: 'shrk search tuning doctor' },
  [ContributionKind.FeedbackRule]: { kind: 'feedback-rule', doctor: 'shrk packs contributions' },
  [ContributionKind.Decision]: { kind: 'decision', doctor: 'shrk packs contributions' },
  [ContributionKind.ContractTemplate]: { kind: 'contract-template', doctor: 'shrk contract template list' },
  [ContributionKind.MigrationProfile]: { kind: 'migration-profile', doctor: 'shrk profiles doctor' },
  [ContributionKind.ContextTest]: { kind: 'context-test', doctor: 'shrk test context' },
  [ContributionKind.AgentTest]: { kind: 'agent-test', doctor: 'shrk test agent' },
  [ContributionKind.Helper]: { kind: 'helper', doctor: 'shrk helper doctor' },
  [ContributionKind.TaskRoutingHint]: { kind: 'routing-hint', doctor: 'shrk packs contributions' },
  [ContributionKind.RegistrationHint]: { kind: 'registration-hint', doctor: 'shrk registrations doctor' },
  [ContributionKind.Convention]: { kind: 'convention', doctor: 'shrk conventions doctor' },
  [ContributionKind.DelegateRecipe]: { kind: 'delegate-recipe', doctor: 'shrk packs contributions' },
  [ContributionKind.FrameworkExtractor]: { kind: 'framework-extractor', doctor: 'shrk packs contributions' },
  [ContributionKind.WiringRule]: { kind: 'wiring-rule', doctor: 'shrk gates coverage' },
  [ContributionKind.Registry]: { kind: 'registry', doctor: 'shrk gates coverage' },
  [ContributionKind.RegistrationIdiom]: { kind: 'registration-idiom', doctor: 'shrk gates coverage' },
  [ContributionKind.PolicyRule]: { kind: 'policy-rule', doctor: 'shrk gates coverage' },
  [ContributionKind.ReusePrimitive]: { kind: 'reuse-primitive', doctor: 'shrk reuse coverage' },
  [ContributionKind.Baseline]: { kind: 'baseline', doctor: 'shrk gates coverage' },
  [ContributionKind.GeneratedArtifact]: { kind: 'generated-artifact', doctor: 'shrk gates coverage' },
  [ContributionKind.DocReference]: { kind: 'doc-reference', doctor: 'shrk docs references check' },
});

/** A rejected entry's finding kind and code — THE table above, never a fallback. */
export function rejectionFindingOf(
  kind: ContributionKind,
  cause: RejectionCause,
): { readonly kind: SelfConfigKind; readonly code: string; readonly doctor: string } {
  const row = REJECTION_FINDING[kind];
  return {
    kind: row.kind,
    code: `${row.kind}-${cause === RejectionCause.DuplicateId ? 'duplicate-id' : 'invalid'}`,
    doctor: row.doctor,
  };
}

/**
 * Probe ids of one registry kind through THE id resolver. A kind whose
 * registry is EMPTY here cannot resolve anything, so its ids are counted
 * `unverified` — never reported missing — and the kind is remembered, so the
 * coverage reason can say how to fill it (THE declaration table).
 */
interface IIdProbe {
  probed: number;
  resolved: number;
  missing: number;
  unverified: number;
  readonly unverifiedLabels: string[];
  /**
   * The same unverified ids, structured and attributed to their file and field
   * (round 12, ONE-CHANGE) — pushed at the one site `unverifiedLabels` is, so
   * the coverage record and the contributions report cannot disagree.
   */
  readonly unverifiedRefs: IUnresolvableReference[];
  /** Kinds whose registry was empty, first-seen order — named in the loud-skip reason. */
  readonly emptyKinds: ReferenceKind[];
}

function newIdProbe(): IIdProbe {
  return {
    probed: 0,
    resolved: 0,
    missing: 0,
    unverified: 0,
    unverifiedLabels: [],
    unverifiedRefs: [],
    emptyKinds: [],
  };
}

/** Where a probed id is declared: the asset, its field, and its file (as the asset records it). */
interface IProbeSite {
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly field: string;
  /** Absolute, project- or pack-relative (resolved with `packageName`). */
  readonly file?: string | undefined;
  readonly packageName?: string | undefined;
}

/**
 * The loud-skip reason. It names how to fill each empty kind, from THE
 * declaration table (`REFERENCE_KIND_DECLARATIONS`), so a NOT VERIFIED unit is
 * actionable instead of a dead end: `… — declare migration-profile via pack
 * key migrationProfileFiles · sharkcraft/migration-profiles.ts …`.
 */
function emptyRegistryReason(probe: IIdProbe): string {
  const base = "could not be checked (their kind's registry is empty in this workspace";
  if (probe.emptyKinds.length === 0) return `${base})`;
  const how = probe.emptyKinds.map((k) => `${k} via ${formatReferenceKindDeclaration(k)}`).join('; ');
  return `${base} — declare ${how})`;
}

/** Read a dotted id-list field (`discovery.profileIds`) off an asset; anything but an array reads as absent. */
function readIdList(asset: unknown, field: string): readonly unknown[] | undefined {
  let cur: unknown = asset;
  for (const part of field.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return Array.isArray(cur) ? cur : undefined;
}

/** How a `*-missing` message ends: a workspace profile id is a vocabulary word, not a registration. */
function notResolvedTail(kind: ReferenceKind): string {
  return kind === 'workspace-profile' ? ', which is not a WorkspaceProfile id' : ' but it is not registered';
}

/**
 * THE "this finding reports a reference that resolved nowhere" predicate: a
 * `*-missing` code (an id, or a referenced file), any severity — the family
 * r73 reads as "unknown id". The CLI's exit-0 line counts the INFO-severity
 * ones instead of certifying "every checked probe resolved" over them.
 */
export function isUnresolvedReferenceFinding(finding: Pick<ISelfConfigFindingV2, 'code'>): boolean {
  return finding.code.endsWith('-missing');
}

/**
 * THE "this reference resolved, but only as a kind its field does not accept"
 * predicate: a `*-wrong-kind` code (`xref-wrong-kind`, a pipeline step naming a
 * construct). Not unresolved — `unknown:` is reserved for that — and not a
 * clean resolution either, so the CLI's exit-0 line counts an info-severity one
 * instead of certifying "every checked probe resolved".
 */
export function isWrongKindReferenceFinding(finding: Pick<ISelfConfigFindingV2, 'code'>): boolean {
  return finding.code.endsWith('-wrong-kind');
}

function probeIds(
  inspection: ISharkcraftInspection,
  kind: ReferenceKind,
  ids: readonly unknown[] | undefined,
  probe: IIdProbe,
  label: (id: string) => string,
  onMissing: (id: string, nearest: string | undefined) => void,
  site?: IProbeSite,
): void {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const empty = emptyReferenceKinds(inspection, [kind]).length > 0;
  for (const raw of ids) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    probe.probed += 1;
    if (empty) {
      probe.unverified += 1;
      probe.unverifiedLabels.push(label(raw));
      if (site) {
        probe.unverifiedRefs.push({
          ...(site.file ? { file: resolveEntryFile(inspection, site.file, site.packageName) } : {}),
          ...(site.packageName ? { packageName: site.packageName } : {}),
          sourceKind: site.sourceKind,
          sourceId: site.sourceId,
          field: site.field,
          kind,
          id: raw,
          // THE declarability authority: an empty registry nothing can EVER
          // fill is a different fact from one this workspace has not filled.
          reason: isReferenceKindDeclarable(kind) ? UnresolvableReason.RegistryEmpty : UnresolvableReason.UndeclarableKind,
        });
      }
      if (!probe.emptyKinds.includes(kind)) probe.emptyKinds.push(kind);
      continue;
    }
    if (referenceIdExists(inspection, kind, raw)) {
      probe.resolved += 1;
      continue;
    }
    probe.missing += 1;
    onMissing(raw, nearestIds(raw, referenceIdsFor(inspection, kind), 1)[0]?.id);
  }
}

function idProbeCoverage(subject: string, unit: string, probe: IIdProbe): IVerdictCoverage[] {
  if (probe.probed === 0) return [];
  return [
    {
      subject,
      unit,
      expected: probe.probed,
      examined: probe.probed - probe.unverified,
      ...(probe.unverified > 0
        ? { unexamined: probe.unverifiedLabels.slice(0, 20), unexaminedTotal: probe.unverified }
        : {}),
      reason: emptyRegistryReason(probe),
    },
  ];
}

// ─── 1. Knowledge → file references ───────────────────────────────────────

function checkKnowledgeFileRefs(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): void {
  for (const k of inspection.knowledgeEntries) {
    for (const ref of k.references ?? []) {
      if (ref.kind !== 'file' || !ref.path) continue;
      const abs = nodePath.isAbsolute(ref.path)
        ? ref.path
        : nodePath.join(inspection.projectRoot, ref.path);
      if (existsSync(abs)) continue;
      pushFinding(findings, {
        severity: ref.required
          ? SelfConfigSeverityV2.Error
          : SelfConfigSeverityV2.Warning,
        code: 'knowledge-ref-missing-file',
        sourceKind: 'knowledge',
        sourceId: k.id,
        targetKind: 'file',
        targetId: ref.path,
        relation: 'references',
        file: k.source?.origin ?? undefined,
        message: `Knowledge "${k.id}" references missing file "${ref.path}".`,
        suggestedFix: `Create the file or update the knowledge reference.`,
        nextCommand: 'shrk knowledge stale-check --ci',
      });
    }
  }
}

// ─── 2. Search-tuning targets ─────────────────────────────────────────────

interface IFamilyResult {
  readonly coverage: readonly IVerdictCoverage[];
  readonly deadUnits: readonly string[];
  /** A reference-probe family's probe — its unverified ids are unresolvable references. */
  readonly refProbe?: IIdProbe;
  /** A selector family's settles (round 13) — their non-live units become the report's `selectorUnits`. */
  readonly liveness?: readonly ISettledUnitLiveness[];
}

/**
 * The search-tuning boost keys as a REFERENCE probe (round 13): the key probes
 * THE lint judged (`searchTuningKeyProbes`), one per (entry, key), and every
 * one THE key resolver could not check — its kind's registry is empty here
 * (`registry-empty`), or its document kind has no id registry at all
 * (`undeclarable-kind`, kind `search-document`). `packs contributions` reads
 * this, so it and `search tuning doctor` can no longer disagree about the same
 * contributed boost.
 */
function tuningReferenceProbe(inspection: ISharkcraftInspection, probes: readonly ISearchTuningKeyProbe[]): IIdProbe {
  const probe = newIdProbe();
  for (const p of probes) {
    const r = p.resolution;
    probe.probed += 1;
    if (r.status === SearchTuningKeyStatus.Resolved) probe.resolved += 1;
    else if (r.status === SearchTuningKeyStatus.Missing) probe.missing += 1;
    if (r.status !== SearchTuningKeyStatus.Unverified) continue;
    const kind = r.referenceKind;
    probe.unverified += 1;
    probe.unverifiedLabels.push(`${p.tuningId} → ${kind ?? 'search-document'} ${kind !== undefined ? r.id : p.key}`);
    probe.unverifiedRefs.push({
      ...(p.sourceFile ? { file: resolveEntryFile(inspection, p.sourceFile, p.packageName) } : {}),
      ...(p.packageName ? { packageName: p.packageName } : {}),
      sourceKind: 'search-tuning',
      sourceId: p.tuningId,
      field: p.lists[0] ?? 'boostIds',
      kind: kind ?? 'search-document',
      id: kind !== undefined ? r.id : p.key,
      reason:
        kind !== undefined && isReferenceKindDeclarable(kind)
          ? UnresolvableReason.RegistryEmpty
          : UnresolvableReason.UndeclarableKind,
    });
    if (kind !== undefined && !probe.emptyKinds.includes(kind)) probe.emptyKinds.push(kind);
  }
  return probe;
}

/**
 * THE search-tuning lint (`lintSearchTuning`, shared with `shrk search tuning
 * doctor`), each issue prefixed `search-tuning-`.
 *
 * A boost key is a search-document id, `<kind>:<id>`. This used to look the
 * WHOLE prefixed key up in bare-id registries, so every correctly prefixed key
 * (which fires) was reported missing and a bare key (which never fires)
 * passed — the exact inverse of the truth. The key is now split on its first
 * `:` and resolved within the named kind; a bare key is `key-unprefixed`.
 */
async function checkSearchTuning(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): Promise<IFamilyResult & { probes: ISelfConfigDoctorReportV2['probes']['search-tuning-target'] }> {
  const lint = await lintSearchTuning(inspection);
  for (const issue of lint.issues) {
    const fix =
      issue.code === 'target-missing'
        ? issue.suggestion
          ? `Use "${issue.suggestion}", or register ${issue.referenceKind} "${issue.targetId}", or remove the boost.`
          : `Register ${issue.referenceKind} "${issue.targetId}" or remove the boost.`
        : issue.code === 'key-unprefixed' || issue.code === 'key-unknown-kind'
          ? issue.suggestion
            ? `Rewrite the key as "${issue.suggestion}".`
            : 'Prefix the key with its document kind (`knowledge:`, `rule:`, `template:`, …) or remove it.'
          : issue.suggestion
            ? `Did you mean "${issue.suggestion}"?`
            : undefined;
    const target = searchTuningTarget(issue);
    pushFinding(findings, {
      severity: severityV2(issue.severity),
      code: `search-tuning-${issue.code}`,
      sourceKind: 'search-tuning',
      sourceId: issue.tuningId,
      targetKind: target.targetKind,
      targetId: target.targetId,
      relation: target.relation,
      file: issue.source,
      message: issue.message,
      suggestedFix: fix,
      nextCommand: 'shrk search tuning doctor',
      occurrences: issue.occurrences,
    });
  }
  return {
    probes: lint.probes,
    coverage: lint.coverage,
    deadUnits: lint.deadUnits,
    liveness: lint.liveness,
    refProbe: tuningReferenceProbe(inspection, lint.keyProbes),
  };
}

/** What a search-tuning finding is about — the locators a lint / loader issue carries. */
interface ISearchTuningTargetInput {
  readonly code: string;
  readonly key?: string | undefined;
  readonly status?: SearchTuningKeyStatus | undefined;
  readonly referenceKind?: ReferenceKind | undefined;
  readonly targetId?: string | undefined;
  readonly docId?: string | undefined;
  readonly moreDocuments?: number | undefined;
  readonly field?: string | undefined;
}

interface ISearchTuningTarget {
  readonly targetKind: SelfConfigKind;
  readonly targetId: string;
  readonly relation: SelfConfigRelation;
}

/**
 * THE label of a search-tuning finding's target, in order:
 *
 *   1. a kind THE key resolver (or the index) placed it in → `<kind>:<id>`
 *      (a missing / excluded / resolvable bare key, a capped document);
 *   2. a document with no id registry, or the cap summary → `search-document`;
 *   3. a key no registry can be asked about (`doc:`, `preset:`, …) →
 *      `search-document`;
 *   4. a key that resolves NOWHERE (a bare id no registry lists, an unknown
 *      `<kind>:` prefix) → `unknown:<the whole key>` — the genuine case;
 *   5. a declaration-shape finding (triggers, vocabulary) → `schema:<field>`.
 *
 * Everything without a `referenceKind` used to fall to `unknown`, so a capped
 * document (`unknown:knowledge:gamma.entry`), a resolvable bare key, a tag, a
 * doc id and the finding CODE itself rendered `unknown:` — while the one really
 * missing id did not (round 12, 12.4).
 */
function searchTuningTarget(t: ISearchTuningTargetInput): ISearchTuningTarget {
  if (t.referenceKind !== undefined) {
    return {
      targetKind: selfKindOf(t.referenceKind),
      targetId: t.targetId ?? t.key ?? t.docId ?? t.code,
      relation: 'tunes',
    };
  }
  if (t.docId !== undefined) return { targetKind: 'search-document', targetId: t.docId, relation: 'tunes' };
  if (t.moreDocuments !== undefined) {
    return { targetKind: 'search-document', targetId: `${t.moreDocuments} more document(s)`, relation: 'tunes' };
  }
  if (t.key !== undefined) {
    if (t.status === SearchTuningKeyStatus.Unverified) {
      return { targetKind: 'search-document', targetId: t.key, relation: 'tunes' };
    }
    // The WHOLE key: an unknown prefix's right-hand id may well exist.
    return { targetKind: selfKindOf(undefined), targetId: t.key, relation: 'tunes' };
  }
  return { targetKind: 'schema', targetId: t.field ?? t.code, relation: 'validates' };
}

/**
 * A loader issue's target. A file-level issue (load-failed, missing-file, an
 * entry with no id) is about the file. A clamped `boostIds` key is a
 * search-document id, labelled through THE key resolver exactly like the lint's
 * keys (the registries are warm: `buildLookupsV2` and the lint both warmed
 * them); a clamped tag / source / kind name is no id at all — it is the
 * declaration `schema:<map>.<name>`. Every clamped key used to read
 * `unknown:<key>`: a resolvable id, or a tag labelled an unknown id.
 */
function searchTuningLoadTarget(
  inspection: ISharkcraftInspection,
  i: ISearchTuningDoctorIssue,
): Pick<ISearchTuningTarget, 'targetKind' | 'targetId'> {
  if (i.key === undefined) return { targetKind: 'file', targetId: i.source ?? i.code };
  if (i.field === 'boostIds' || i.field?.endsWith('.boostIds') === true) {
    const r = resolveSearchTuningKey(inspection, i.key);
    const t = searchTuningTarget({
      code: i.code,
      key: i.key,
      status: r.status,
      referenceKind: r.referenceKind,
      targetId: r.id,
    });
    return { targetKind: t.targetKind, targetId: t.targetId };
  }
  return { targetKind: 'schema', targetId: i.field !== undefined ? `${i.field}.${i.key}` : i.key };
}

/**
 * The tuning loader's own issues (a file that failed to import, a clamped
 * boost). A `missing-id` entry is a REJECTED entry: THE rejection family
 * reports it (error, `search-tuning-invalid`) — never a second time here.
 */
function checkSearchTuningLoadIssues(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): void {
  for (const i of listSearchTuningIssues(inspection)) {
    // A refused entry (no id; round 13: a malformed boost value or marker) is
    // THE rejection family's to report — once, as an error.
    if (i.code === 'missing-id' || i.code === 'invalid-entry') continue;
    const target = searchTuningLoadTarget(inspection, i);
    pushFinding(findings, {
      severity: severityV2(i.severity),
      code: `search-tuning-${i.code}`,
      sourceKind: 'search-tuning',
      sourceId: i.tuningId ?? i.source ?? 'search-tuning',
      targetKind: target.targetKind,
      targetId: target.targetId,
      relation: 'validates',
      file: i.source,
      message: i.message,
      nextCommand: 'shrk search tuning doctor',
    });
  }
}

// ─── 3. Agent-tests → helpers / commands / playbooks / policies ───────────

async function checkAgentTests(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): Promise<void> {
  type IAgentTestLite = {
    id: string;
    expectedKnowledge?: readonly string[];
    expectedTemplates?: readonly string[];
    expectedHelpers?: readonly string[];
    expectedPlaybooks?: readonly string[];
    expectedPolicies?: readonly string[];
    expectedCommands?: readonly string[];
  };
  let agentTests: readonly IAgentTestLite[] = [];
  try {
    const { loadAgentContractTests } = await import('./test-runner.ts');
    agentTests = (await loadAgentContractTests(inspection)) as unknown as readonly IAgentTestLite[];
  } catch {
    return;
  }

  const probe = (
    t: IAgentTestLite,
    ids: readonly string[] | undefined,
    targetKind: SelfConfigKind,
    lookup: Set<string>,
    relation: SelfConfigRelation,
  ): void => {
    if (!ids) return;
    for (const id of ids) {
      if (lookup.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Error,
        code: `agent-test-${targetKind}-missing`,
        sourceKind: 'agent-test',
        sourceId: t.id,
        targetKind,
        targetId: id,
        relation,
        message: `Agent test "${t.id}" expects unknown ${targetKind} id "${id}".`,
        suggestedFix: `Register the ${targetKind} or drop the expectation.`,
      });
    }
  };

  for (const t of agentTests) {
    probe(t, t.expectedKnowledge, 'knowledge', lookups.knowledge, 'expects');
    probe(t, t.expectedTemplates, 'template', lookups.templates, 'expects');
    probe(t, t.expectedHelpers, 'helper', lookups.helpers, 'expects');
    probe(t, t.expectedPlaybooks, 'playbook', lookups.playbooks, 'expects');
    probe(t, t.expectedPolicies, 'policy', lookups.policies, 'expects');
    // `expectedCommands` go through `checkCommandStrings` (the injected resolver).
  }
}

// ─── 4. Templates → conventions / helpers / profiles / registration hints ─

/**
 * Template `metadata` id fields, each probed through THE id resolver per THE
 * binding table (`PROBED_ID_FIELDS`): `requiredProfileIds` → workspace-profile,
 * `requiredConventionIds` → convention, `requiredHelperIds` → helper,
 * `registrationHintIds` → registration-hint.
 *
 * This used bare `lookups.X.has(id)` loops: `requiredProfileIds` resolved
 * against the MIGRATION registry, and every field warned "not registered"
 * over an EMPTY registry — while the same id in a registration hint was a loud
 * skip. One question, two answers (round 12, 12.3b). An id checked against an
 * empty registry is now an unexamined unit (NOT VERIFIED), never a warning.
 */
function checkTemplateMetadata(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): IFamilyResult {
  const templates = (inspection.templates ?? []) as readonly { id: string; metadata?: unknown }[];
  const rows = PROBED_ID_FIELDS.filter((r) => r.source === ProbedIdSource.Template);
  const probe = newIdProbe();
  for (const t of templates) {
    if (!t.metadata) continue;
    const src = inspection.templateSources?.get(t.id);
    for (const row of rows) {
      probeIds(
        inspection,
        row.kind,
        readIdList(t, row.field),
        probe,
        // The unexamined label names the KIND resolved against (the report's
        // `kind`), never the code label — `profile` was ambiguous once
        // `workspace-profile` existed (round 12 review, T4).
        (id) => `${t.id} → ${row.kind} ${id}`,
        (id, nearest) =>
          pushFinding(findings, {
            severity: SelfConfigSeverityV2.Warning,
            code: `template-${row.label}-missing`,
            sourceKind: 'template',
            sourceId: t.id,
            targetKind: selfKindOf(row.kind),
            targetId: id,
            relation: 'requires',
            message: `Template "${t.id}" ${row.field} names ${row.label} "${id}"${notResolvedTail(row.kind)}.`,
            ...(nearest ? { suggestedFix: `Did you mean "${nearest}"?` } : {}),
            nextCommand: referenceKindListVerb(row.kind),
          }),
        { sourceKind: 'template', sourceId: t.id, field: row.field, file: src?.file, packageName: src?.packageName },
      );
    }
  }
  return { coverage: idProbeCoverage('templates', 'required ids', probe), deadUnits: [], refProbe: probe };
}

// ─── 5. Routing hints → commands / templates / helpers / playbooks / profiles ───

/**
 * Routing hints: the loader's issues (which had NO consumer), whether each
 * hint can match at all, and every `recommends` id through THE channel table
 * and THE id resolver. The old probe list skipped the declared `knowledge` and
 * `policies` channels entirely. An invalid hint or a duplicate id is a
 * REJECTED entry: THE rejection family reports it (`routing-hint-invalid` /
 * `routing-hint-duplicate-id`, one reporter) — this pass skips those codes.
 */
async function checkRoutingHints(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): Promise<IFamilyResult & { probes: ISelfConfigDoctorReportV2['probes']['routing-hint-target'] }> {
  const loaded = await loadTaskRoutingHints(inspection);
  const entries = loaded.entries;
  for (const i of await listTaskRoutingHintIssues(inspection)) {
    if (i.code === 'invalid-hint' || i.code === 'duplicate-id') continue;
    pushFinding(findings, {
      severity: severityV2(i.severity),
      code: `routing-hint-${i.code}`,
      sourceKind: 'routing-hint',
      sourceId: i.hintId ?? i.source ?? 'routing-hints',
      targetKind: i.code === 'load-failed' || i.code === 'missing-file' ? 'file' : 'schema',
      targetId: i.code,
      relation: 'validates',
      file: i.source,
      message: i.message,
    });
  }
  const probe = newIdProbe();
  // A hint that can never match is dead by SHAPE (out of expectEmpty scope — no
  // target can ever make it match); it still settles through THE liveness
  // authority, unmarked, so this file's dead list has one derivation.
  const hintObservations: IUnitObservation[] = [];
  for (const e of entries) {
    const canMatch = routingHintCanMatch(e.hint);
    hintObservations.push({
      list: 'routing hints',
      unit: e.hint.id,
      exists: canMatch,
      live: canMatch,
      ...(canMatch
        ? {}
        : { cause: UnitDeadCause.Defect, deadReason: 'declares no criterion the matcher scores, so it can never match' }),
    });
    const rec = (e.hint.recommends ?? {}) as Readonly<Record<string, readonly unknown[] | undefined>>;
    for (const channel of ROUTING_RECOMMENDS_CHANNEL_KEYS) {
      const spec = ROUTING_RECOMMENDS_CHANNELS[channel];
      // `recommends.commands` go through `checkCommandStrings` (the injected resolver).
      if (spec.kind === 'command') continue;
      const kind = spec.kind;
      probeIds(
        inspection,
        kind,
        rec[channel],
        probe,
        (id) => `${e.hint.id} → ${kind} ${id}`,
        (id, nearest) =>
          pushFinding(findings, {
            severity: SelfConfigSeverityV2.Info,
            code: `routing-hint-${spec.label}-missing`,
            sourceKind: 'routing-hint',
            sourceId: e.hint.id,
            // THE kind the id was resolved against — no relabel. (`profile` was a
            // display alias no registry or list verb has; round 12, 12.3.)
            targetKind: selfKindOf(kind),
            targetId: id,
            relation: 'routes-to',
            file: e.sourceFile,
            message: `Routing hint "${e.hint.id}" recommends ${kind === 'migration-profile' ? 'migration profile' : spec.label} "${id}" (recommends.${channel}) but it is not registered.`,
            ...(nearest ? { suggestedFix: `Did you mean "${nearest}"?` } : {}),
            nextCommand: referenceKindListVerb(kind),
          }),
        {
          sourceKind: 'routing-hint',
          sourceId: e.hint.id,
          field: `recommends.${channel}`,
          file: e.sourceFile,
          packageName: e.packageName,
        },
      );
    }
  }
  const hints = settleUnitLiveness({
    subject: 'routing hints',
    unitLabel: 'hints',
    weight: UnitDeadWeight.Coverage,
    observations: hintObservations,
    marks: [],
    deadSummary: 'declare no criterion the matcher scores (keyword, phrase, compiling regex), so they can never match',
  });
  const coverage: IVerdictCoverage[] = [...hints.coverage];
  // A hint file that failed to import (or a pack-declared one that is absent)
  // hides every hint in it: the file is unexamined, never a healthy registry.
  const brokenHintFiles = [
    ...new Set(
      loaded.issues
        .filter((i) => i.code === 'load-failed' || i.code === 'missing-file')
        .map((i) => nodePath.relative(inspection.projectRoot, i.source ?? '') || (i.source ?? '?')),
    ),
  ];
  if (loaded.files > 0) {
    coverage.push({
      subject: 'routing hints',
      unit: 'hint files',
      expected: loaded.files,
      examined: Math.max(0, loaded.files - brokenHintFiles.length),
      ...(brokenHintFiles.length > 0
        ? { unexamined: brokenHintFiles.slice(0, 20), unexaminedTotal: brokenHintFiles.length }
        : {}),
      reason: 'failed to load or are missing, so none of their hints are known',
    });
  }
  coverage.push(...idProbeCoverage('routing hints', 'recommended ids', probe));
  return {
    probes: { probed: probe.probed, resolved: probe.resolved, missing: probe.missing, unverified: probe.unverified },
    coverage,
    deadUnits: hints.dead.map((u) => `routing hint ${u.unit} (can never match)`),
    refProbe: probe,
    liveness: [hints],
  };
}

// ─── 6. Pipelines → templates / commands (via cliCommands) ────────────────

function checkPipelines(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): void {
  const pipelines =
    inspection.pipelineRegistry?.list?.() ??
    ((inspection.pipelines ?? []) as readonly {
      id: string;
      steps?: readonly {
        id: string;
        cliCommands?: readonly string[];
        references?: readonly string[];
      }[];
      source?: { origin?: string };
    }[]);
  for (const p of pipelines as readonly {
    id: string;
    steps?: readonly {
      id: string;
      cliCommands?: readonly string[];
      references?: readonly string[];
    }[];
    source?: { origin?: string };
  }[]) {
    for (const step of p.steps ?? []) {
      // A step reference names a knowledge entry / template / path convention
      // (`IPipelineStep.references`), or a convention / helper.
      for (const ref of step.references ?? []) {
        if (
          lookups.templates.has(ref) ||
          lookups.knowledge.has(ref) ||
          lookups.conventions.has(ref) ||
          lookups.paths.has(ref) ||
          lookups.helpers.has(ref)
        )
          continue;
        // Not an accepted kind — but THE resolver may still place it (a
        // construct id): that is the wrong kind, never "unknown". It used to
        // read `references unknown:<id>` for an id `self-config resolve` finds.
        const kinds = referenceKindsOf(inspection, ref);
        const resolvedAs = kinds[0];
        pushFinding(findings, {
          severity: SelfConfigSeverityV2.Info,
          code: resolvedAs === undefined ? 'pipeline-reference-missing' : 'pipeline-reference-wrong-kind',
          sourceKind: 'pipeline',
          sourceId: p.id,
          targetKind: selfKindOf(resolvedAs),
          targetId: ref,
          relation: 'references',
          file: p.source?.origin ?? undefined,
          message:
            resolvedAs === undefined
              ? `Pipeline "${p.id}" step "${step.id}" references unknown id "${ref}".`
              : `Pipeline "${p.id}" step "${step.id}" references "${ref}", which is a ${kinds.join(' | ')} — a step reference names a knowledge entry, template, path convention, convention or helper.`,
          nextCommand: `shrk self-config resolve ${ref}`,
          confidence: 'medium',
        });
      }
    }
  }
}

// ─── 7. Playbooks → templates / helpers / commands / profiles ─────────────

/**
 * Playbooks: the loader's issues (an import failure used to be swallowed, so a
 * broken `playbooks.ts` reported a healthy, merely smaller registry), file
 * coverage, and each playbook's template / pipeline ids. Reads the LOADER —
 * the cache-only `listPlaybooks` answered "no playbooks" whenever nothing had
 * warmed it.
 */
async function checkPlaybooks(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): Promise<IFamilyResult> {
  const { playbooks, issues, files } = await loadPlaybooksWithIssues(inspection);
  const brokenFiles: string[] = [];
  for (const i of issues) {
    const rel = nodePath.relative(inspection.projectRoot, i.source) || i.source;
    if (!brokenFiles.includes(rel)) brokenFiles.push(rel);
    pushFinding(findings, {
      severity: severityV2(i.severity),
      code: `playbook-${i.code}`,
      sourceKind: 'playbook',
      sourceId: i.packageName ? `${i.packageName}:${rel}` : rel,
      targetKind: 'file',
      targetId: i.code,
      relation: 'validates',
      file: i.source,
      message: i.message,
    });
  }
  for (const p of playbooks) {
    for (const id of p.recommendedTemplateIds ?? []) {
      if (lookups.templates.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Warning,
        code: 'playbook-template-missing',
        sourceKind: 'playbook',
        sourceId: p.id,
        targetKind: 'template',
        targetId: id,
        relation: 'requires',
        file: p.sourceFile,
        message: `Playbook "${p.id}" recommends template "${id}" but it is not registered.`,
      });
    }
    for (const id of p.recommendedPipelineIds ?? []) {
      if (lookups.pipelines.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Warning,
        code: 'playbook-pipeline-missing',
        sourceKind: 'playbook',
        sourceId: p.id,
        targetKind: 'pipeline',
        targetId: id,
        relation: 'requires',
        file: p.sourceFile,
        message: `Playbook "${p.id}" recommends pipeline "${id}" but it is not registered.`,
      });
    }
  }
  const coverage: IVerdictCoverage[] =
    files > 0
      ? [
          {
            subject: 'playbooks',
            unit: 'playbook files',
            expected: files,
            examined: Math.max(0, files - brokenFiles.length),
            ...(brokenFiles.length > 0
              ? { unexamined: brokenFiles.slice(0, 20), unexaminedTotal: brokenFiles.length }
              : {}),
            reason: 'failed to load or are missing, so none of their playbooks are known',
          },
        ]
      : [];
  return { coverage, deadUnits: [] };
}

// ─── 8. Registration hints → templates / conventions / profiles ───────────

/**
 * Registration hints, through THE discovery authority
 * (`buildRegistrationHintDoctorReport` — the one `registrations doctor` and
 * `preview` read): load issues, dead / ambiguous / capped discovery, missing
 * anchors. Plus the hint's real cross-references, `discovery.conventionIds` /
 * `discovery.profileIds`. This used to read `relatedTemplateIds` & co. through
 * a cast to fields `IRegistrationHint` does not declare — a probe that could
 * never fire.
 */
async function checkRegistrationHints(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): Promise<IFamilyResult> {
  const report = await buildRegistrationHintDoctorReport(inspection);
  for (const i of report.issues) {
    // An invalid hint / a duplicate id is a REJECTED entry — THE rejection
    // family reports it (`registration-hint-invalid` / `-duplicate-id`).
    if (i.code === 'invalid-hint' || i.code === 'duplicate-id') continue;
    pushFinding(findings, {
      severity: severityV2(i.severity),
      code: `registration-hint-${i.code}`,
      sourceKind: 'registration-hint',
      sourceId: i.hintId ?? i.source ?? 'registration-hints',
      targetKind: 'file',
      targetId: i.target ?? i.code,
      relation: 'validates',
      file: i.source,
      message: i.message,
      nextCommand: 'shrk registrations doctor',
    });
  }
  const ids = await probeRegistrationHintIds(inspection, findings);
  return {
    coverage: [...report.coverage, ...ids.coverage],
    deadUnits: report.deadUnits,
    ...(ids.refProbe ? { refProbe: ids.refProbe } : {}),
    liveness: [report.liveness],
  };
}

/**
 * A registration hint's cross-references — THE reference-probe half of the
 * family, with no discovery walk, so `collectUnresolvableReferences` runs
 * exactly what the doctor runs.
 */
async function probeRegistrationHintIds(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): Promise<IFamilyResult> {
  // `discovery.conventionIds` / `discovery.profileIds`, per THE binding table:
  // profileIds are WorkspaceProfile ids (`workspace-profile`). They were bound
  // to `migration-profile` and relabelled `profile` — NOT VERIFIED forever with
  // no migration profiles, a false "not registered" with any (round 12, 12.3).
  const probe = newIdProbe();
  const rows = PROBED_ID_FIELDS.filter((r) => r.source === ProbedIdSource.RegistrationHint);
  for (const e of await listRegistrationHints(inspection)) {
    for (const row of rows) {
      probeIds(
        inspection,
        row.kind,
        readIdList(e.hint, row.field),
        probe,
        (id) => `${e.hint.id} → ${row.kind} ${id}`,
        (id, nearest) =>
          pushFinding(findings, {
            severity: SelfConfigSeverityV2.Info,
            code: `registration-hint-${row.label}-missing`,
            sourceKind: 'registration-hint',
            sourceId: e.hint.id,
            targetKind: selfKindOf(row.kind),
            targetId: id,
            relation: 'related',
            file: e.sourceFile,
            message: `Registration hint "${e.hint.id}" ${row.field} references ${row.label} "${id}"${notResolvedTail(row.kind)}.`,
            ...(nearest ? { suggestedFix: `Did you mean "${nearest}"?` } : {}),
            nextCommand: referenceKindListVerb(row.kind),
          }),
        {
          sourceKind: 'registration-hint',
          sourceId: e.hint.id,
          field: row.field,
          file: e.sourceFile,
          packageName: e.packageName,
        },
      );
    }
  }
  return { coverage: idProbeCoverage('registration hints', 'related ids', probe), deadUnits: [], refProbe: probe };
}

// ─── 8b. Conventions → applicability profile ids ──────────────────────────

/**
 * A convention's `appliesTo` id fields, per THE binding table — today
 * `appliesTo.profileIds` → `workspace-profile`. It was never probed at all, so
 * a typo'd profile id could never surface. Resolution only: `conventions
 * check` does not yet FILTER on profileIds (making a firing gate fire less is
 * not strictly more honest), which the field's JSDoc says.
 */
async function checkConventionApplicability(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): Promise<IFamilyResult> {
  let entries: Awaited<ReturnType<typeof listConventions>>;
  try {
    entries = await listConventions(inspection);
  } catch {
    // A convention file that will not load is `conventions doctor`'s to report.
    return { coverage: [], deadUnits: [] };
  }
  const rows = PROBED_ID_FIELDS.filter((r) => r.source === ProbedIdSource.Convention);
  const probe = newIdProbe();
  for (const e of entries) {
    for (const row of rows) {
      probeIds(
        inspection,
        row.kind,
        readIdList(e.convention, row.field),
        probe,
        (id) => `${e.convention.id} → ${row.kind} ${id}`,
        (id, nearest) =>
          pushFinding(findings, {
            severity: SelfConfigSeverityV2.Info,
            code: `convention-${row.label}-missing`,
            sourceKind: 'convention',
            sourceId: e.convention.id,
            targetKind: selfKindOf(row.kind),
            targetId: id,
            relation: 'related',
            file: e.sourceFile,
            message: `Convention "${e.convention.id}" ${row.field} names ${row.label} "${id}"${notResolvedTail(row.kind)}.`,
            ...(nearest ? { suggestedFix: `Did you mean "${nearest}"?` } : {}),
            nextCommand: referenceKindListVerb(row.kind),
          }),
        {
          sourceKind: 'convention',
          sourceId: e.convention.id,
          field: row.field,
          file: e.sourceFile,
          packageName: e.packageName,
        },
      );
    }
  }
  return {
    coverage: idProbeCoverage('conventions', 'applicability profile ids', probe),
    deadUnits: [],
    refProbe: probe,
  };
}

/**
 * Scaffold patterns' dead selectors: a `matchPaths` glob matching no file, a
 * pattern matching none after `excludePaths` — counted by THE enumeration
 * `infer templates` attributes candidates with. (The definition checks stay
 * `shrk scaffolds doctor`'s.)
 */
async function checkScaffoldPatterns(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): Promise<IFamilyResult> {
  let patterns: Awaited<ReturnType<typeof loadScaffoldPatternsFromInspection>>['patterns'];
  try {
    patterns = (await loadScaffoldPatternsFromInspection(inspection)).patterns;
  } catch {
    return { coverage: [], deadUnits: [] };
  }
  if (patterns.length === 0) return { coverage: [], deadUnits: [] };
  const enumeration = enumerateScaffoldPatternCandidates(inspection.projectRoot, patterns);
  for (const i of doctorScaffoldPatterns(patterns, inspection, enumeration)) {
    if (!i.code) continue;
    pushFinding(findings, {
      severity: severityV2(i.severity),
      code: `scaffold-pattern-${i.code}`,
      sourceKind: 'scaffold-pattern',
      sourceId: i.patternId,
      targetKind: 'file',
      targetId: i.target ?? '(any file)',
      relation: 'references',
      message: `Scaffold pattern "${i.patternId}" ${i.message}.`,
      nextCommand: 'shrk scaffolds doctor',
    });
  }
  return scaffoldPatternCoverage(patterns, enumeration);
}

/**
 * Decision records are parsed from Markdown via the heading text; the
 * "Related ..." sections can contain prose ("(none directly — runtime gate)")
 * instead of structured ids. Filter those out so the doctor doesn't report
 * "missing policy '(none directly)'" as a broken link.
 */
function looksLikeId(value: string): boolean {
  if (!value) return false;
  if (value.length > 128) return false;
  // IDs are dotted/kebab identifiers, no spaces, parens, or punctuation.
  return /^[A-Za-z_][\w.\-]*$/.test(value);
}

// ─── 9. Decisions → related rules / commands / files / knowledge / etc. ───

function checkDecisions(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): void {
  let decisions: readonly {
    id: string;
    relatedRules: readonly string[];
    relatedPolicies: readonly string[];
    relatedConstructs: readonly string[];
    relatedFiles: readonly string[];
  }[] = [];
  try {
    decisions = listDecisions(inspection);
  } catch {
    return;
  }
  for (const d of decisions) {
    for (const id of d.relatedRules) {
      if (!looksLikeId(id) || lookups.rules.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Info,
        code: 'decision-rule-missing',
        sourceKind: 'decision',
        sourceId: d.id,
        targetKind: 'rule',
        targetId: id,
        relation: 'related',
        message: `Decision "${d.id}" references missing rule "${id}".`,
        confidence: 'medium',
      });
    }
    for (const id of d.relatedPolicies) {
      if (!looksLikeId(id) || lookups.policies.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Info,
        code: 'decision-policy-missing',
        sourceKind: 'decision',
        sourceId: d.id,
        targetKind: 'policy',
        targetId: id,
        relation: 'related',
        message: `Decision "${d.id}" references missing policy "${id}".`,
        confidence: 'medium',
      });
    }
    for (const filePath of d.relatedFiles) {
      // A "Related file" must look like a path. Skip prose.
      if (!filePath || /\s/.test(filePath.trim()) || filePath.length > 240) continue;
      const abs = nodePath.isAbsolute(filePath)
        ? filePath
        : nodePath.join(inspection.projectRoot, filePath);
      if (existsSync(abs)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Info,
        code: 'decision-file-missing',
        sourceKind: 'decision',
        sourceId: d.id,
        targetKind: 'file',
        targetId: filePath,
        relation: 'references',
        message: `Decision "${d.id}" references missing file "${filePath}".`,
        confidence: 'medium',
      });
    }
  }
}

// ─── 9b. Declared cross-references (knowledge / construct / boundary / template) ─

/**
 * Every id in a declared `related`-style field (knowledge `related` / `seeAlso`
 * / `supersededBy` / `actionHints.related*`, construct `related*` + facets that
 * declare `resolvesAs`, boundary `related*`, template `related`), read from THE
 * collector — this pass never walks a field itself. `buildLookupsV2` already
 * warmed the registries, so the collector's sync half is enough.
 *
 * A dangling id is a warning (it shrinks a result, it does not misroute —
 * `--strict` fails on it); a dangling `supersededBy`, a supersession cycle and
 * a facet naming an unknown kind are errors. An id that could not be looked up
 * is `xref-unverified` (info) AND an unexamined unit in the coverage record,
 * so the doctor cannot settle to a pass over it.
 */
function checkDeclaredCrossReferences(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): {
  summary: NonNullable<ISelfConfigDoctorReportV2['crossReferences']>;
  coverage: IVerdictCoverage[];
  report: IDeclaredXrefReport;
} {
  const report = collectDeclaredXrefs(inspection);
  for (const row of report.rows) {
    if (row.status === DeclaredXrefStatus.Ok) continue;
    const firstAccepted = row.accepts === 'any' ? undefined : row.accepts[0];
    const wrongKindAs = row.status === DeclaredXrefStatus.WrongKind ? row.resolvedAs[0] : undefined;
    pushFinding(findings, {
      severity: severityV2(row.severity),
      code:
        row.status === DeclaredXrefStatus.Dangling
          ? 'xref-dangling'
          : row.status === DeclaredXrefStatus.WrongKind
            ? 'xref-wrong-kind'
            : 'xref-unverified',
      sourceKind: selfKindOf(row.sourceKind),
      sourceId: row.sourceId,
      targetKind: selfKindOf(wrongKindAs ?? firstAccepted),
      targetId: row.targetId,
      relation: row.relation,
      file: row.file,
      message: row.message,
      suggestedFix:
        row.status === DeclaredXrefStatus.Unverified
          ? 'Run `shrk self-config doctor` from the CLI (it warms every registry), or fix the empty registry the id resolves against.'
          : row.didYouMean.length > 0
            ? `Did you mean "${row.didYouMean[0]}"? Correct the id, register the target, or remove it from \`${row.field}\`.`
            : `Register the target, or remove the id from \`${row.field}\`.`,
      nextCommand: `shrk self-config resolve ${row.targetId}`,
      confidence: 'high',
    });
  }
  for (const issue of report.issues) {
    const superseded = issue.code === 'xref-superseded-cycle' || issue.code === 'xref-superseded-chain';
    // A supersession issue names the successor (a knowledge id). A declaration
    // issue (`xref-unknown-kind`, `xref-malformed`) is about the FIELD: the
    // facet value there may well resolve — its declared KIND is what is wrong.
    // It used to read `related unknown:<value>` (round 12, 12.4).
    const target: ISearchTuningTarget = superseded
      ? { targetKind: 'knowledge', targetId: issue.targetId ?? issue.field, relation: 'supersedes' }
      : {
          targetKind: 'schema',
          targetId: issue.facetId !== undefined ? `${issue.field}[${issue.facetId}]` : issue.field,
          relation: 'validates',
        };
    pushFinding(findings, {
      severity: severityV2(issue.severity),
      code: issue.code,
      sourceKind: selfKindOf(issue.sourceKind),
      sourceId: issue.sourceId,
      targetKind: target.targetKind,
      targetId: target.targetId,
      relation: target.relation,
      file: issue.file,
      message: issue.message,
      confidence: 'high',
    });
  }
  // Like every probe family: a workspace that declares no cross-reference ids
  // contributes no record (it is not "nothing examined" for the whole doctor).
  const coverage =
    report.counts.ids > 0 || report.examined.unreadSources.length > 0
      ? [{ ...declaredXrefCoverage(report), subject: 'declared cross-references' }]
      : [];
  return {
    summary: { examined: report.examined, counts: report.counts, summary: declaredXrefSummaryLine(report) },
    coverage,
    report,
  };
}

/** THE declared-xref rows that could not be looked up, as unresolvable references (one per row). */
function xrefUnresolvableReferences(
  inspection: ISharkcraftInspection,
  report: IDeclaredXrefReport,
): IUnresolvableReference[] {
  return report.rows
    .filter((r) => r.status === DeclaredXrefStatus.Unverified)
    .map((r) => {
      const kind = r.accepts === 'any' ? ('any' as const) : r.accepts[0];
      const declarable = kind === undefined || kind === 'any' || isReferenceKindDeclarable(kind);
      return {
        // The collector records the file project-relative when possible.
        ...(r.file ? { file: nodePath.resolve(inspection.projectRoot, r.file) } : {}),
        ...(r.packageName ? { packageName: r.packageName } : {}),
        sourceKind: r.sourceKind,
        sourceId: r.sourceId,
        field: r.field,
        kind: kind ?? 'any',
        id: r.targetId,
        reason: declarable ? UnresolvableReason.RegistryEmpty : UnresolvableReason.UndeclarableKind,
      };
    });
}

/**
 * THE unresolvable-reference scan over the reference families' probes and the
 * declared-xref report: what was probed (`expected` — the reference families'
 * units plus the xref ids), what could be checked, and each that could not.
 * The doctor carries it; `collectUnresolvableReferences` returns it.
 */
function referenceScanOf(
  inspection: ISharkcraftInspection,
  probes: readonly (IIdProbe | undefined)[],
  xrefs: IDeclaredXrefReport,
): IUnresolvableReferenceScan {
  const present = probes.filter((p): p is IIdProbe => p !== undefined);
  const references = [...present.flatMap((p) => p.unverifiedRefs), ...xrefUnresolvableReferences(inspection, xrefs)];
  const expected = present.reduce((n, p) => n + p.probed, 0) + xrefs.counts.ids;
  return { expected, examined: expected - references.length, references };
}

// ─── 10. Pack contribution conflicts (every kind) ─────────────────────────

/**
 * EVERY pack contribution conflict (duplicate id, shadowed, invalid,
 * missing-loader, stale signature). This used to surface only stale
 * signatures, so a duplicate-id or shadowed conflict was visible over MCP (v1)
 * and invisible to `shrk self-config doctor` (v2). Stale signatures keep their
 * v2 code `pack-signature-stale`; the v1 projection maps it back to
 * `pack-conflict:stale-signature`.
 */
async function checkPackConflicts(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): Promise<IPackContributionsInventory | null> {
  try {
    // The ASYNC inventory (loaders consulted); the stale-signature conflict it
    // carries is read from the one pack-asset freshness authority.
    const inv = await buildPackContributionsInventoryAsync(inspection);
    checkContributionRejections(findings, inv.rejections);
    for (const c of inv.conflicts) {
      const stale = c.kind === 'stale-signature';
      pushFinding(findings, {
        severity: stale ? SelfConfigSeverityV2.Warning : severityV2(c.severity),
        code: stale ? 'pack-signature-stale' : `pack-conflict:${c.kind}`,
        sourceKind: 'pack',
        sourceId: c.id,
        targetKind: stale ? 'schema' : 'pack',
        targetId: stale ? 'sharkcraft.pack-manifest/v1' : String(c.contributionKind),
        relation: 'validates',
        message: c.message,
        ...(c.nextCommand ? { nextCommand: c.nextCommand } : {}),
        confidence: 'high',
      });
    }
    return inv;
  } catch {
    // An inventory that cannot be built is `shrk packs doctor`'s to report.
    return null;
  }
}

/**
 * THE rejection family (round 12, 12.1): every declared contribution entry a
 * loader refused — from THE rejection channel the inventory carries — is an
 * ERROR, one finding per failing field (`<kind>-invalid`, or
 * `<kind>-duplicate-id`), local and pack alike: an entry that never takes
 * effect is a defect, and it used to reach no surface but its kind's doctor
 * (conventions, helpers) or none at all (knowledge, templates, playbooks, …).
 * The routing / registration hint families no longer report their own
 * `invalid-hint` / `duplicate-id` issues, so each rejection has one reporter.
 */
function checkContributionRejections(
  findings: ISelfConfigFindingV2[],
  rejections: IPackContributionsInventory['rejections'],
): void {
  for (const r of rejections) {
    const f = rejectionFindingOf(r.kind, r.cause);
    const where = r.index >= 0 ? `${r.exportName ?? ''}[${r.index}]` : (r.exportName ?? 'default');
    const who = r.entryId !== undefined ? `"${r.entryId}"` : `at ${where}`;
    for (const reason of r.reasons) {
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Error,
        code: f.code,
        sourceKind: f.kind,
        sourceId: r.entryId ?? `${r.file}:${where}`,
        targetKind: 'schema',
        targetId: validatorField(reason),
        relation: 'validates',
        file: r.file,
        message: `${f.kind} ${who} in ${r.file} (${where}) was rejected by its loader — ${reason}. It does not take effect.`,
        nextCommand: r.packageName ? `shrk packs contributions --pack ${r.packageName}` : f.doctor,
        confidence: 'high',
      });
    }
  }
}

/**
 * A reference that resolves nowhere may name an entry that WAS declared — and
 * refused by its loader. Its `*-missing` finding then says so instead of
 * offering a did-you-mean (round 12, 12.1): the id is not a typo.
 */
function annotateRejectedTargets(
  findings: ISelfConfigFindingV2[],
  rejections: IPackContributionsInventory['rejections'],
): void {
  const byId = new Map<string, IPackContributionsInventory['rejections'][number]>();
  for (const r of rejections) if (r.entryId !== undefined && !byId.has(r.entryId)) byId.set(r.entryId, r);
  if (byId.size === 0) return;
  findings.forEach((f, i) => {
    if (!isUnresolvedReferenceFinding(f)) return;
    const r = byId.get(f.targetId);
    if (!r) return;
    const rejectedAs = rejectionFindingOf(r.kind, r.cause).kind;
    if (f.targetKind !== rejectedAs && f.targetKind !== selfKindOf(undefined)) return;
    findings[i] = {
      ...f,
      suggestedFix: `'${f.targetId}' is declared in ${r.file} but was rejected: ${r.reasons.join('; ')}`,
    };
  });
}

// ─── 11. Command strings → the injected command resolver ─────────────────

interface ICommandSite {
  sourceKind: SelfConfigKind;
  sourceId: string;
  field: string;
  command: string;
  severity: SelfConfigSeverityV2;
  relation: SelfConfigRelation;
  file?: string | undefined;
  /**
   * A command REFERENCE (a knowledge `command` reference, an agent test's
   * `expectedCommands`) rather than free shell text: resolved through
   * `resolveShrkCommandReference`, so a bare `frobnicate` reads as the dead
   * shrk verb it names — exactly as knowledge-stale and the test runner read
   * the same string.
   */
  assumeShrk?: boolean;
}

type CommandProbeCounts = ISelfConfigDoctorReportV2['probes']['command'];

function actionHintCommand(c: unknown): string | undefined {
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && typeof (c as { command?: unknown }).command === 'string') {
    return (c as { command: string }).command;
  }
  return undefined;
}

/**
 * Every command string an asset prescribes, with where it came from. A broken
 * source degrades to "no commands from it" — that asset's own loader reports
 * the load failure.
 */
async function collectCommandSites(inspection: ISharkcraftInspection): Promise<ICommandSite[]> {
  const sites: ICommandSite[] = [];
  const add = (
    sourceKind: SelfConfigKind,
    sourceId: string,
    field: string,
    commands: readonly unknown[] | undefined,
    severity: SelfConfigSeverityV2,
    relation: SelfConfigRelation,
    file?: string,
    assumeShrk = false,
  ): void => {
    for (const raw of commands ?? []) {
      const command = actionHintCommand(raw)?.trim();
      if (command) {
        sites.push({
          sourceKind,
          sourceId,
          field,
          command,
          severity,
          relation,
          file,
          ...(assumeShrk ? { assumeShrk: true } : {}),
        });
      }
    }
  };
  const W = SelfConfigSeverityV2.Warning;
  try {
    const { loadAgentContractTests } = await import('./test-runner.ts');
    // An agent test's expectation is load-bearing: a dead expected command fails
    // the test forever, so it is an error here too.
    for (const t of await loadAgentContractTests(inspection)) {
      add('agent-test', t.id, 'expectedCommands', t.expectedCommands, SelfConfigSeverityV2.Error, 'expects', undefined, true);
    }
  } catch {
    // agent-test loader failure is reported by `shrk test agent`
  }
  try {
    for (const e of await listTaskRoutingHints(inspection)) {
      add('routing-hint', e.hint.id, 'recommends.commands', e.hint.recommends?.commands, W, 'routes-to', e.sourceFile);
    }
  } catch {
    // reported by the routing-hint loader
  }
  try {
    for (const e of await listRegistrationHints(inspection)) {
      add('registration-hint', e.hint.id, 'validationCommands', e.hint.validationCommands, W, 'validates', e.sourceFile);
    }
  } catch {
    // reported by the registration-hint loader
  }
  for (const p of inspection.pipelineRegistry?.list?.() ?? []) {
    for (const step of p.steps ?? []) {
      add('pipeline', p.id, `steps.${step.id}.cliCommands`, step.cliCommands, W, 'references');
    }
  }
  for (const p of listPlaybooks(inspection)) {
    // The loader refuses a playbook without an array `steps` (12.1d: an
    // accepted one crashed the whole doctor here); guard anyway.
    (Array.isArray(p.steps) ? p.steps : []).forEach((step, i) => {
      add('playbook', p.id, `steps[${i}].commands`, step?.commands, W, 'references');
    });
  }
  for (const c of listConstructs(inspection)) {
    add('construct', c.id, 'commands', c.commands, W, 'references');
  }
  for (const p of inspection.presetRegistry?.list?.() ?? []) {
    add('preset', p.id, 'recommendedNextCommands', p.recommendedNextCommands, W, 'references');
  }
  for (const k of inspection.knowledgeEntries) {
    const origin = k.source?.origin ?? undefined;
    add('knowledge', k.id, 'actionHints.commands', k.actionHints?.commands, W, 'references', origin);
    const refCommands = (k.references ?? [])
      .filter((r) => r.kind === 'command')
      .map((r) => r.id ?? r.command)
      .filter((c): c is string => typeof c === 'string' && c.length > 0);
    add('knowledge', k.id, 'references', refCommands, W, 'references', origin, true);
  }
  try {
    for (const d of await loadTsDecisions(inspection)) {
      add('decision', d.id, 'relatedCommands', d.relatedCommands, W, 'related', d.sourceFile);
    }
  } catch {
    // reported by the decisions loader
  }
  return sites;
}

/**
 * The command-strings pass: every command an asset prescribes, resolved
 * through THE injected command resolver, deduped per (asset, command).
 *
 * Without a resolver (outside the CLI) nothing is checked, and the pass says
 * so ONCE (`command-probe-unverified`, info) — never a finding per command,
 * and never an error. The old probes checked against a set initialised empty,
 * so every command in every hint was "missing", correct ones included.
 */
async function checkCommandStrings(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): Promise<CommandProbeCounts> {
  const seen = new Set<string>();
  const sites = (await collectCommandSites(inspection)).filter((s) => {
    // The reading is part of the key: one asset may cite `doctor` both as free
    // shell text and as a command reference, and the two resolve differently.
    const key = `${s.sourceKind}:${s.sourceId}|${s.assumeShrk === true ? 'ref' : 'sh'}|${s.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const counts = { probed: sites.length, exists: 0, prefixOnly: 0, notShrk: 0, unknown: 0, unverified: 0 };
  if (sites.length === 0) return counts;
  if (!hasCommandResolver(inspection)) {
    counts.unverified = sites.length;
    pushFinding(findings, {
      severity: SelfConfigSeverityV2.Info,
      code: 'command-probe-unverified',
      // The doctor's own probe summary — it has a kind (it borrowed `unknown`).
      sourceKind: 'self-config',
      sourceId: 'command-probes',
      targetKind: 'command',
      targetId: `${sites.length} command string(s)`,
      relation: 'references',
      message: `${sites.length} command string(s) prescribed by assets were NOT checked: ${COMMAND_INDEX_NOT_INJECTED}.`,
      suggestedFix: 'Run `shrk self-config doctor` from the CLI, which injects the live command index.',
      confidence: 'high',
    });
    return counts;
  }
  for (const site of sites) {
    const resolution = site.assumeShrk
      ? resolveShrkCommandReference(inspection, site.command)
      : resolveCommandReference(inspection, site.command);
    switch (resolution.status) {
      case CommandResolutionStatus.Ok:
        counts.exists += 1;
        break;
      case CommandResolutionStatus.PrefixOnly:
        counts.prefixOnly += 1;
        break;
      case CommandResolutionStatus.NotShrk:
        counts.notShrk += 1;
        break;
      case CommandResolutionStatus.Unverified:
        counts.unverified += 1;
        break;
      default: {
        counts.unknown += 1;
        const closest = resolution.closest ?? [];
        pushFinding(findings, {
          severity: site.severity,
          code: 'unknown-command',
          sourceKind: site.sourceKind,
          sourceId: site.sourceId,
          targetKind: 'command',
          targetId: site.command,
          relation: site.relation,
          file: site.file,
          message: `${site.sourceKind} "${site.sourceId}" ${site.field} prescribes \`${site.command}\`, which does not resolve (${resolution.status}${resolution.reason ? ` — ${resolution.reason}` : ''}).`,
          suggestedFix:
            closest.length > 0
              ? `Did you mean \`${closest[0]}\`? Update or remove the command.`
              : 'Update or remove the command.',
          nextCommand: 'shrk surface list',
          confidence: 'high',
        });
      }
    }
  }
  return counts;
}

// ─── Public entry ─────────────────────────────────────────────────────────

export async function buildSelfConfigDoctorReportV2(
  inspection: ISharkcraftInspection,
): Promise<ISelfConfigDoctorReportV2> {
  const findings: ISelfConfigFindingV2[] = [];
  const lookups = await buildLookupsV2(inspection);

  checkKnowledgeFileRefs(inspection, findings);
  const tuning = await checkSearchTuning(inspection, findings);
  checkSearchTuningLoadIssues(inspection, findings);
  await checkAgentTests(inspection, lookups, findings);
  const templateFamily = checkTemplateMetadata(inspection, findings);
  const routing = await checkRoutingHints(inspection, findings);
  checkPipelines(inspection, lookups, findings);
  const playbookFamily = await checkPlaybooks(inspection, lookups, findings);
  const registration = await checkRegistrationHints(inspection, findings);
  const conventionFamily = await checkConventionApplicability(inspection, findings);
  const scaffolds = await checkScaffoldPatterns(inspection, findings);
  checkDecisions(inspection, lookups, findings);
  const xrefs = checkDeclaredCrossReferences(inspection, findings);
  const inventory = await checkPackConflicts(inspection, findings);
  const commandProbes = await checkCommandStrings(inspection, findings);
  if (inventory) annotateRejectedTargets(findings, inventory.rejections);
  const referenceScan = referenceScanOf(
    inspection,
    [templateFamily.refProbe, routing.refProbe, registration.refProbe, conventionFamily.refProbe, tuning.refProbe],
    xrefs.report,
  );
  const selectorUnits = [
    ...(tuning.liveness ?? []),
    ...(routing.liveness ?? []),
    ...(registration.liveness ?? []),
    ...(scaffolds.liveness ?? []),
  ]
    .flatMap((s) => s.units)
    .filter((u) => u.state !== UnitLivenessState.Live);

  const coverage: IVerdictCoverage[] = [
    ...commandProbeCoverage(commandProbes),
    ...tuning.coverage,
    ...routing.coverage,
    ...playbookFamily.coverage,
    ...registration.coverage,
    ...conventionFamily.coverage,
    ...templateFamily.coverage,
    ...scaffolds.coverage,
    ...xrefs.coverage,
  ];
  const deadUnits = [
    ...tuning.deadUnits,
    ...routing.deadUnits,
    ...registration.deadUnits,
    ...scaffolds.deadUnits,
  ];
  const totals = computeTotalsV2(findings);
  // One derivation: core's `coverageShortfall`, the rule the CLI settles with.
  const unverified = coverage.some((c) => coverageShortfall(c) !== undefined);
  const verdict: ISelfConfigDoctorReportV2['verdict'] =
    totals.error > 0 ? 'errors' : unverified ? 'unverified' : totals.warning > 0 ? 'warnings' : 'ok';
  const nextCommands: string[] = [];
  if (totals.error > 0) {
    nextCommands.push(
      'Fix the errored ids first — agent-test expectations and template requirements are load-bearing.',
      'shrk packs conflicts',
    );
  } else if (unverified) {
    nextCommands.push(
      `Some units were NOT verified (see coverage): a dead selector / boost is a ${DEAD_SELECTOR_CAUSES} — fix it, or mark a planned target expectEmpty; and run from the CLI, which injects the command index.`,
    );
  } else if (totals.warning > 0) {
    nextCommands.push(
      'Review warnings — most resolve by registering the missing id or removing the stale link.',
    );
  } else {
    nextCommands.push('shrk self-config doctor --schema v2 --json | jq .verdict');
  }

  return {
    schema: SELF_CONFIG_DOCTOR_V2_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: inspection.projectRoot,
    findings,
    totals,
    verdict,
    nextCommands,
    coverage,
    deadUnits,
    selectorUnits,
    unresolvableReferences: referenceScan.references,
    probes: {
      command: commandProbes,
      'search-tuning-target': tuning.probes,
      'routing-hint-target': routing.probes,
    },
    crossReferences: xrefs.summary,
  };
}

/**
 * Every declared reference that could not be resolved because its kind's
 * registry is empty here, or can never be filled (round 12, ONE-CHANGE) —
 * running EXACTLY the doctor's reference probes (template metadata, routing
 * `recommends`, registration-hint and convention id fields, declared
 * cross-references) over a warmed inspection, without the rest of the doctor.
 * `buildSelfConfigDoctorReportV2` carries the same list, so the doctor and
 * `shrk packs contributions` cannot disagree.
 */
export async function collectUnresolvableReferences(
  inspection: ISharkcraftInspection,
): Promise<IUnresolvableReferenceScan> {
  await warmReferenceRegistries(inspection);
  const scratch: ISelfConfigFindingV2[] = [];
  const templateFamily = checkTemplateMetadata(inspection, scratch);
  const routing = await checkRoutingHints(inspection, scratch);
  const registration = await probeRegistrationHintIds(inspection, scratch);
  const conventionFamily = await checkConventionApplicability(inspection, scratch);
  const xrefs = checkDeclaredCrossReferences(inspection, scratch);
  // THE key probes the tuning lint judges (round 13) — the same function, so
  // `packs contributions` and `search tuning doctor` answer from one resolution.
  const { entries: tunings } = await loadSearchTuning(inspection);
  const tuning = tuningReferenceProbe(inspection, searchTuningKeyProbes(inspection, tunings));
  return referenceScanOf(
    inspection,
    [templateFamily.refProbe, routing.refProbe, registration.refProbe, conventionFamily.refProbe, tuning],
    xrefs.report,
  );
}

/**
 * The command-string probes' coverage: every prescribed command string must
 * have been resolved. Only present when assets prescribe any — a repo with no
 * command strings is not "nothing examined" for the whole doctor.
 *
 * `not-shrk` strings (git, tsc, a script with no package.json to read) are a
 * DELIBERATE narrowing — not this engine's to judge — so they leave `expected`
 * rather than counting as examined. A set that is ALL not-shrk narrows to
 * nothing and carries no record, exactly like a set with no strings at all.
 * `prefix-only` strings stay in scope (the verb was proven); the clean line
 * names how many tails went unproven.
 */
function commandProbeCoverage(c: CommandProbeCounts): IVerdictCoverage[] {
  const expected = c.probed - c.notShrk;
  if (expected <= 0) return [];
  return [
    {
      unit: 'command strings',
      expected,
      examined: expected - c.unverified,
      // `reason` names why a GAP exists. Only the no-resolver path returns
      // Unverified, so `unverified > 0` means exactly "index not injected";
      // a fully examined run carries no reason (a verified row labelled
      // NOT VERIFIED misled JSON readers).
      ...(c.unverified > 0 ? { reason: COMMAND_INDEX_NOT_INJECTED } : {}),
    },
  ];
}

/** One-line summary of the command-string probes, shared by the renderers. */
function commandProbeLine(report: ISelfConfigDoctorReportV2): string {
  const c = report.probes.command;
  return `probed ${c.probed} · unknown ${c.unknown} · prefix-only ${c.prefixOnly} · not-shrk ${c.notShrk} · unverified ${c.unverified}`;
}

/**
 * The tuning-key probes on ONE line — so a 100% failure rate reads as a probe
 * fault, not as N independent content errors.
 */
function tuningProbeLine(report: ISelfConfigDoctorReportV2): string {
  const t = report.probes['search-tuning-target'];
  return `probed ${t.probed} · resolved ${t.resolved} · missing ${t.missing} · unprefixed ${t.unprefixed} · unknown-kind ${t.unknownKind} · unverified ${t.unverified}`;
}

function routingProbeLine(report: ISelfConfigDoctorReportV2): string {
  const r = report.probes['routing-hint-target'];
  return `probed ${r.probed} · resolved ${r.resolved} · missing ${r.missing} · unverified ${r.unverified}`;
}

/** `<subject>: <formatCoverage>` per record — what each family examined. */
function coverageLines(report: ISelfConfigDoctorReportV2): string[] {
  return report.coverage.map((c) => `${c.subject ? `${c.subject}: ` : ''}${formatCoverage(c)}`);
}

function computeTotalsV2(
  findings: readonly ISelfConfigFindingV2[],
): ISelfConfigDoctorReportV2['totals'] {
  const byRelation: Record<string, number> = {};
  const bySourceKind: Record<string, number> = {};
  const byTargetKind: Record<string, number> = {};
  let error = 0;
  let warning = 0;
  let info = 0;
  for (const f of findings) {
    byRelation[f.relation] = (byRelation[f.relation] ?? 0) + 1;
    bySourceKind[f.sourceKind] = (bySourceKind[f.sourceKind] ?? 0) + 1;
    byTargetKind[f.targetKind] = (byTargetKind[f.targetKind] ?? 0) + 1;
    if (f.severity === SelfConfigSeverityV2.Error) error += 1;
    else if (f.severity === SelfConfigSeverityV2.Warning) warning += 1;
    else info += 1;
  }
  return { error, warning, info, byRelation, bySourceKind, byTargetKind };
}

export function renderSelfConfigDoctorV2Text(report: ISelfConfigDoctorReportV2): string {
  const lines: string[] = [];
  lines.push('=== Self-config doctor (v2) ===');
  lines.push(`  schema        ${report.schema}`);
  lines.push(`  generatedAt   ${report.generatedAt}`);
  lines.push(`  verdict       ${report.verdict.toUpperCase()}`);
  lines.push(`  errors        ${report.totals.error}`);
  lines.push(`  warnings      ${report.totals.warning}`);
  lines.push(`  info          ${report.totals.info}`);
  lines.push(`  commands      ${commandProbeLine(report)}`);
  lines.push(`  tuning keys   ${tuningProbeLine(report)}`);
  lines.push(`  routing ids   ${routingProbeLine(report)}`);
  if (report.crossReferences) lines.push(`  xrefs         ${report.crossReferences.summary}`);
  for (const c of coverageLines(report)) lines.push(`  coverage      ${c}`);
  lines.push('');
  if (report.findings.length === 0) {
    // No ✓ here: whether this is a pass is the settled verdict's call (a dead
    // or unverified unit is not a finding, and still is not a pass).
    lines.push('  No findings.');
    return lines.join('\n') + '\n';
  }
  for (const f of report.findings.slice(0, 200)) {
    lines.push(
      `  ${f.severity.padEnd(7)} [${f.code}] ${f.sourceKind}:${f.sourceId} ${f.relation} ${f.targetKind}:${f.targetId}${f.occurrences && f.occurrences > 1 ? ` (×${f.occurrences})` : ''}`,
    );
    lines.push(`           ${f.message}`);
    if (f.suggestedFix) lines.push(`           fix: ${f.suggestedFix}`);
    if (f.nextCommand) lines.push(`           next: ${f.nextCommand}`);
  }
  if (report.findings.length > 200) {
    lines.push(`  … (${report.findings.length - 200} more)`);
  }
  if (report.nextCommands.length > 0) {
    lines.push('');
    lines.push('Next:');
    for (const c of report.nextCommands) lines.push(`  • ${c}`);
  }
  return lines.join('\n') + '\n';
}

export function renderSelfConfigDoctorV2Markdown(
  report: ISelfConfigDoctorReportV2,
): string {
  const lines: string[] = ['# Self-config doctor (v2)', ''];
  lines.push(`- schema: ${report.schema}`);
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: **${report.verdict.toUpperCase()}**`);
  lines.push(`- errors: ${report.totals.error}`);
  lines.push(`- warnings: ${report.totals.warning}`);
  lines.push(`- info: ${report.totals.info}`);
  lines.push(`- commands: ${commandProbeLine(report)}`);
  lines.push(`- tuning keys: ${tuningProbeLine(report)}`);
  lines.push(`- routing ids: ${routingProbeLine(report)}`);
  if (report.crossReferences) lines.push(`- xrefs: ${report.crossReferences.summary}`);
  for (const c of coverageLines(report)) lines.push(`- coverage: ${c}`);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('No findings.');
    return lines.join('\n') + '\n';
  }
  lines.push('| Severity | Source | Relation | Target | Message | Next |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const f of report.findings) {
    lines.push(
      `| ${f.severity} | \`${f.sourceKind}:${f.sourceId}\` | \`${f.relation}\` | \`${f.targetKind}:${f.targetId}\` | ${f.message} | ${f.nextCommand ?? ''} |`,
    );
  }
  return lines.join('\n') + '\n';
}
