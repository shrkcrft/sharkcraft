/**
 * Pack-aware project-config resolution.
 *
 * The "cross-file invariant as DATA" planes — `wiringRules`, `registries`,
 * `registrationGraph`, `policyRules`, `baselines`, `generatedArtifacts`,
 * `reusePrimitives` — can be authored inline in a repo's
 * `sharkcraft.config.ts`. They can ALSO be SHIPPED by a framework pack (e.g. a
 * NestJS pack contributing "every @Injectable must be registered in a module"
 * as a wiring rule) via the new `wiringRuleFiles` / `registryFiles` /
 * `policyRuleFiles` / `reusePrimitiveFiles` manifest slots.
 *
 * The merge CANNOT live in `loadProjectConfig`: config sits at layer 3 and packs
 * at layer 6, so config cannot import the pack discovery. The inspector (layer
 * 10, above packs) is the lowest layer that can see both, so the merge seam
 * lives here.
 *
 * Precedence is LOCAL-WINS: a repo's own declaration always beats a pack's, and
 * a pack element whose key collides with a local (or an earlier pack) one is
 * dropped with a diagnostic. Pack elements are validated with the SAME exported
 * zod schemas the config loader uses, so a malformed pack element is skipped
 * (with a diagnostic) rather than crashing config resolution.
 *
 * Round 12 (12.1): every pack element the merge refuses — schema-invalid, a
 * vetoed shell command, a key collision, an unresolvable `$use` — is also a
 * structured rejection in {@link IResolvedProjectConfig.planeOutcomes}, and
 * every adopted one an accepted entry, so THE contribution rejection channel
 * reports gate-plane contributions like every other kind.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  ERROR_CODES,
  importModuleViaLoader,
  ok,
  RejectionCause,
  resolvePlaneExtractors,
  unitProblemsOf,
  validateResolvedPlaneSources,
  type AppError,
  type IBaselineRule,
  type IDocReferenceRule,
  type IGeneratedArtifactRule,
  type IPolicyRule,
  type IRegistrationIdiom,
  type IRegistryDeclaration,
  type IReusePrimitive,
  type IWiringRule,
  type Result,
} from '@shrkcrft/core';
import {
  BaselineRuleSchema,
  DocReferenceRuleSchema,
  GeneratedArtifactRuleSchema,
  loadProjectConfig,
  normalizePlaneRule,
  PolicyRuleSchema,
  RegistrationIdiomSchema,
  RegistryDeclarationSchema,
  ReusePrimitiveSchema,
  WiringRuleSchema,
  type GatePlane,
  type LoadedConfig,
} from '@shrkcrft/config';
import { discoverPacks, type IDiscoveredPack } from '@shrkcrft/packs';
import { ContributionKind } from './contribution-kind.ts';
import type { IContributionAcceptedEntry } from './i-contribution-accepted-entry.ts';
import type { IContributionEntryRejection } from './i-contribution-entry-rejection.ts';

/**
 * The gate plane a `mergePlane` label merges (round 13), so the seam
 * normalises a pack element's markable lists through the ONE per-plane
 * normaliser the loader uses (`normalizePlaneRule`). `reusePrimitive` is not a
 * gate plane and has no markable list.
 */
function gatePlaneOfLabel(planeLabel: string): GatePlane | undefined {
  const planes: Readonly<Record<string, GatePlane>> = {
    wiringRule: 'wiring',
    registry: 'registry',
    registrationIdiom: 'registration',
    policyRule: 'policy',
    baseline: 'baseline',
    generatedArtifact: 'generated',
    docReference: 'doc-reference',
  };
  return planes[planeLabel];
}

/**
 * THE "is there no SharkCraft config at all?" answer for a failed
 * {@link resolveProjectConfig}: the loader found no `sharkcraft/` folder. A
 * config that EXISTS but failed to load is a different answer — an error.
 * `finish` (the plane gates are "not applicable") and the quality report's
 * plane row (no row) both read this, so the two cannot disagree about one
 * repo (round 11 review R12-REG-2).
 */
export function isProjectConfigAbsent(error: Pick<AppError, 'code'>): boolean {
  return error.code === ERROR_CODES.SHARKCRAFT_FOLDER_NOT_FOUND;
}

/**
 * A {@link LoadedConfig} whose data planes have had pack contributions
 * merged in (local-wins), plus the human-readable notes from that merge.
 */
export interface IResolvedProjectConfig extends LoadedConfig {
  /**
   * Notes from the pack-plane merge — missing/invalid pack files, dropped
   * collisions, pack-discovery failures. Empty when there are no packs (or no
   * pack contributions to the four planes). Surfaced by the readers that
   * consume the merged planes (`shrk check wiring`, `registry`, `policy-lint`,
   * `reuse`, `gate`).
   */
  readonly planeDiagnostics: readonly string[];
  /**
   * The same merge, structured (round 12, 12.1): every pack element adopted
   * (`accepted`), every one refused (`rejected` — schema-invalid, a vetoed
   * shell command, a key collision, an unresolvable `$use`), and every pack
   * plane file that failed to import. Optional so hand-built values keep
   * type-checking.
   */
  readonly planeOutcomes?: {
    readonly accepted: readonly IContributionAcceptedEntry[];
    readonly rejected: readonly IContributionEntryRejection[];
    readonly loadFailures: readonly {
      readonly file: string;
      readonly kind: ContributionKind;
      readonly packageName: string;
      readonly message: string;
    }[];
  };
}

/** Minimal structural view of a zod schema's `safeParse` — avoids a zod dep here. */
interface IPlaneSchema {
  safeParse(value: unknown): {
    success: boolean;
    data?: unknown;
    error?: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> };
  };
}

/** One pack's contribution file for a single plane. */
interface IPackContribFile {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly rel: string;
}

/** Where the structured merge outcome is collected (one per `resolveProjectConfig` run). */
interface IPlaneSink {
  readonly accepted: IContributionAcceptedEntry[];
  readonly rejected: IContributionEntryRejection[];
  readonly loadFailures: { file: string; kind: ContributionKind; packageName: string; message: string }[];
  /** `<kind>:<key>` → the adopted pack element, so a later `$use` drop can move it to `rejected`. */
  readonly adopted: Map<string, { readonly entry: IContributionAcceptedEntry; readonly index: number }>;
}

/** A pack element's veto: the diagnostic line, and the `<field>: <message>` rejection reason. */
interface IPackVeto {
  readonly diagnostic: string;
  readonly reason: string;
}

/**
 * THE per-element validation of a gate-plane pack contribution: one
 * `<path>: <message>` per zod issue, `[]` when accepted. The merge below and
 * `packs test --load` (`validateContributionFile`) both call it with the SAME
 * exported schema the config loader validates a local element with.
 */
export function planeElementRejectionReasons(schema: IPlaneSchema, raw: unknown): readonly string[] {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return [];
  const issues = parsed.error?.issues ?? [];
  return issues.length > 0
    ? issues.map((iss) => `${iss.path.join('.') || '(entry)'}: ${iss.message}`)
    : ['(entry): invalid element'];
}

/**
 * Generic per-plane load + validate + merge. Seeds the merged map from the
 * LOCAL array (keyed by `keyOf`), then folds in pack elements only when their
 * key is free. Missing files, non-array default exports, schema-invalid
 * elements, and key collisions all become diagnostics and are skipped — never a
 * throw.
 */
async function mergePlane<T>(
  localArr: readonly T[],
  packContribs: readonly IPackContribFile[],
  schema: IPlaneSchema,
  keyOf: (item: T) => string,
  planeLabel: string,
  diagnostics: string[],
  /** Where the structured outcome is recorded — absent for a plane with no manifest slot. */
  outcome: { readonly kind: ContributionKind; readonly sink: IPlaneSink } | undefined,
  /**
   * Optional per-item veto applied to PACK elements only. Returns the
   * diagnostic to record when the element must not be adopted (used by the
   * shell-executing planes — see the call sites).
   */
  packGuard?: (item: T, packName: string) => IPackVeto | undefined,
): Promise<readonly T[]> {
  const merged = new Map<string, T>();
  const localKeys = new Set<string>();
  // A plane with no manifest slot records into a sink nobody reads.
  const kind = outcome?.kind ?? ContributionKind.PolicyRule;
  const sink: IPlaneSink = outcome?.sink ?? { accepted: [], rejected: [], loadFailures: [], adopted: new Map() };
  for (const item of localArr) {
    const key = keyOf(item);
    merged.set(key, item);
    localKeys.add(key);
  }

  for (const contrib of packContribs) {
    const full = nodePath.resolve(contrib.packageRoot, contrib.rel);
    if (!existsSync(full)) {
      diagnostics.push(`pack ${contrib.packageName}: missing ${planeLabel} file ${contrib.rel}`);
      continue;
    }
    let mod: { default?: unknown };
    try {
      mod = await importModuleViaLoader<{ default?: unknown }>(full);
    } catch (e) {
      const message = (e as Error).message;
      diagnostics.push(
        `pack ${contrib.packageName}: failed to load ${planeLabel} file ${contrib.rel} — ${message}`,
      );
      sink.loadFailures.push({
        file: full,
        kind,
        packageName: contrib.packageName,
        message: (message.split('\n')[0] ?? message).trim(),
      });
      continue;
    }
    const arr = mod.default;
    if (!Array.isArray(arr)) {
      diagnostics.push(
        `pack ${contrib.packageName}: ${planeLabel} file ${contrib.rel} default export is not an array — skipped`,
      );
      continue;
    }
    arr.forEach((raw: unknown, index: number) => {
      const reject = (reasons: readonly string[], cause: RejectionCause, entryId?: string): void => {
        const id = entryId ?? planeElementKey(raw);
        sink.rejected.push({
          file: full,
          index,
          exportName: 'default',
          ...(id !== undefined ? { entryId: id } : {}),
          reasons,
          cause,
          kind,
          packageName: contrib.packageName,
          via: 'config-plane',
        });
      };
      const reasons = planeElementRejectionReasons(schema, raw);
      if (reasons.length > 0) {
        diagnostics.push(
          `pack ${contrib.packageName}: invalid ${planeLabel} element in ${contrib.rel} — ${reasons.join('; ')} — skipped`,
        );
        reject(reasons, RejectionCause.Invalid);
        return;
      }
      const parsedItem = schema.safeParse(raw).data as T;
      // Round 13: normalise the element's markable lists the way the loader
      // normalises a local rule (`normalizePlaneRule`) — plain string lists
      // plus `expectEmptyUnits` — and STAMP every marker with the contributing
      // pack, so a pack marker that went live reads as INFO and never fails the
      // consumer. The schema above already refused a malformed marker (the
      // round-12 rejection channel); a failure here is refused the same way.
      const plane = gatePlaneOfLabel(planeLabel);
      const normalized = plane !== undefined ? normalizePlaneRule(plane, parsedItem, contrib.packageName) : undefined;
      if (normalized !== undefined && !normalized.ok) {
        const problems = unitProblemsOf(normalized.error);
        diagnostics.push(
          `pack ${contrib.packageName}: invalid ${planeLabel} element in ${contrib.rel} — ${problems.join('; ')} — skipped`,
        );
        reject(problems, RejectionCause.Invalid);
        return;
      }
      const item = normalized !== undefined ? normalized.value : parsedItem;
      const veto = packGuard?.(item, contrib.packageName);
      if (veto !== undefined) {
        diagnostics.push(veto.diagnostic);
        reject([veto.reason], RejectionCause.Invalid, keyOf(item));
        return;
      }
      const key = keyOf(item);
      if (merged.has(key)) {
        const local = localKeys.has(key);
        diagnostics.push(
          local
            ? `pack ${contrib.packageName}: ${planeLabel} "${key}" already provided by local config — skipped`
            : `pack ${contrib.packageName}: ${planeLabel} "${key}" already provided — skipped`,
        );
        reject(
          [`id: "${key}" is already provided by ${local ? 'the local config' : 'an earlier pack'} — local wins`],
          RejectionCause.DuplicateId,
          key,
        );
        return;
      }
      merged.set(key, item);
      const entry: IContributionAcceptedEntry = { kind, file: full, packageName: contrib.packageName, id: key };
      sink.accepted.push(entry);
      sink.adopted.set(`${kind}:${key}`, { entry, index });
    });
  }
  return [...merged.values()];
}

/**
 * THE id of a raw gate-plane element — its `id` / `name` / `symbol`, whichever
 * string it carries first — for a rejection record. The merge seam and `packs
 * test --load` (`validateContributionFile`) both name a refused element by it.
 */
export function planeElementKey(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  for (const k of ['id', 'name', 'symbol'] as const) if (typeof r[k] === 'string') return r[k] as string;
  return undefined;
}

/** Collect every pack contribution file for one manifest slot across valid packs. */
function gatherPackContribs(
  validPacks: readonly IDiscoveredPack[],
  slot:
    | 'wiringRuleFiles'
    | 'registryFiles'
    | 'registrationGraphFiles'
    | 'policyRuleFiles'
    | 'reusePrimitiveFiles'
    | 'baselineFiles'
    | 'generatedArtifactFiles'
    | 'docReferenceFiles',
): IPackContribFile[] {
  const out: IPackContribFile[] = [];
  for (const pack of validPacks) {
    // Mirror sharkcraft-inspector's pack-merge: read the slot off the
    // contributions bag with a narrow cast (the new slots are all string[]).
    const contributions = pack.manifest?.contributions as
      | Record<string, readonly string[] | undefined>
      | undefined;
    const files = contributions?.[slot];
    for (const rel of files ?? []) {
      out.push({ packageName: pack.packageName, packageRoot: pack.packageRoot, rel });
    }
  }
  return out;
}

/** The shell-command veto of a pack-contributed baseline: `compute.run` is never auto-run. */
function baselinePackVeto(item: IBaselineRule, packName: string): IPackVeto | undefined {
  return item.compute?.kind === 'command'
    ? {
        diagnostic: `pack ${packName}: baseline "${item.id}" declares a shell \`compute.run\` — pack-contributed commands are never auto-run — skipped`,
        reason: 'compute.run: a pack-contributed shell command is never auto-run',
      }
    : undefined;
}

/** The shell-command veto of a pack-contributed generated artifact: `regen` is never auto-run. */
function generatedPackVeto(item: IGeneratedArtifactRule, packName: string): IPackVeto | undefined {
  return item.regen !== undefined
    ? {
        diagnostic: `pack ${packName}: generatedArtifact "${item.id}" declares a \`regen\` command — pack-contributed commands are never auto-run — skipped`,
        reason: 'regen: a pack-contributed shell command is never auto-run',
      }
    : undefined;
}

/** Each gate-plane manifest slot → THE schema its elements validate against, and its pack veto. */
const PACK_PLANE_SLOTS: Readonly<
  Record<string, { readonly schema: IPlaneSchema; readonly veto?: (item: never, packName: string) => IPackVeto | undefined }>
> = {
  wiringRuleFiles: { schema: WiringRuleSchema as IPlaneSchema },
  registryFiles: { schema: RegistryDeclarationSchema as IPlaneSchema },
  registrationGraphFiles: { schema: RegistrationIdiomSchema as IPlaneSchema },
  policyRuleFiles: { schema: PolicyRuleSchema as IPlaneSchema },
  reusePrimitiveFiles: { schema: ReusePrimitiveSchema as IPlaneSchema },
  baselineFiles: { schema: BaselineRuleSchema as IPlaneSchema, veto: baselinePackVeto as (item: never, p: string) => IPackVeto | undefined },
  generatedArtifactFiles: {
    schema: GeneratedArtifactRuleSchema as IPlaneSchema,
    veto: generatedPackVeto as (item: never, p: string) => IPackVeto | undefined,
  },
  // Round 13 (P3): no shell, so no veto — only the plane's schema.
  docReferenceFiles: { schema: DocReferenceRuleSchema as IPlaneSchema },
};

/**
 * Why a PACK element of a gate-plane slot would be refused by the merge seam
 * — THE same schema + shell veto `resolveProjectConfig` applies — or
 * `undefined` for a slot that is not a gate plane. `packs test --load` reads
 * it (`validateContributionFile`). A `$use` reference is resolved against the
 * CONSUMING repo's extractors, so it cannot be judged from the pack alone.
 */
export function packPlaneElementRejectionReasons(slot: string, raw: unknown): readonly string[] | undefined {
  const spec = PACK_PLANE_SLOTS[slot];
  if (!spec) return undefined;
  const reasons = planeElementRejectionReasons(spec.schema, raw);
  if (reasons.length > 0) return reasons;
  const veto = spec.veto?.(spec.schema.safeParse(raw).data as never, '(pack)');
  return veto ? [veto.reason] : [];
}

/** The plane a `$use` resolution error path names (`wiringRules[<id>]…`) → its contribution kind. */
const EXTRACTOR_PLANE_KIND: Readonly<Record<string, ContributionKind>> = {
  wiringRules: ContributionKind.WiringRule,
  registries: ContributionKind.Registry,
  registrationGraph: ContributionKind.RegistrationIdiom,
  baselines: ContributionKind.Baseline,
};

/**
 * Load the project config, then merge pack-contributed `wiringRules` /
 * `registries` / `policyRules` / `reusePrimitives` over the local config
 * (local-wins). Returns the loader error untouched on failure, so callers keep
 * the same "invalid config vs. valid-with-no-rules" distinction they had with
 * {@link loadProjectConfig}. A pack-discovery failure degrades to a diagnostic
 * — it never fails config resolution.
 */
export async function resolveProjectConfig(
  cwd: string,
): Promise<Result<IResolvedProjectConfig, AppError>> {
  const loaded = await loadProjectConfig(cwd);
  if (!loaded.ok) return loaded;

  const diagnostics: string[] = [];
  const sink: IPlaneSink = { accepted: [], rejected: [], loadFailures: [], adopted: new Map() };
  const base = loaded.value;

  let validPacks: readonly IDiscoveredPack[] = [];
  try {
    const packs = await discoverPacks({ projectRoot: base.projectRoot });
    validPacks = packs.validPacks;
  } catch (e) {
    diagnostics.push(`pack discovery failed — pack-contributed planes skipped: ${(e as Error).message}`);
  }

  const wiringRules = await mergePlane<IWiringRule>(
    base.config.wiringRules ?? [],
    gatherPackContribs(validPacks, 'wiringRuleFiles'),
    WiringRuleSchema as IPlaneSchema,
    (r) => r.id,
    'wiringRule',
    diagnostics,
    { kind: ContributionKind.WiringRule, sink },
  );
  const registries = await mergePlane<IRegistryDeclaration>(
    base.config.registries ?? [],
    gatherPackContribs(validPacks, 'registryFiles'),
    RegistryDeclarationSchema as IPlaneSchema,
    (r) => r.name,
    'registry',
    diagnostics,
    { kind: ContributionKind.Registry, sink },
  );
  const registrationGraph = await mergePlane<IRegistrationIdiom>(
    base.config.registrationGraph ?? [],
    gatherPackContribs(validPacks, 'registrationGraphFiles'),
    RegistrationIdiomSchema as IPlaneSchema,
    (r) => r.name,
    'registrationIdiom',
    diagnostics,
    { kind: ContributionKind.RegistrationIdiom, sink },
  );
  const policyRules = await mergePlane<IPolicyRule>(
    base.config.policyRules ?? [],
    gatherPackContribs(validPacks, 'policyRuleFiles'),
    PolicyRuleSchema as IPlaneSchema,
    (r) => r.id,
    'policyRule',
    diagnostics,
    { kind: ContributionKind.PolicyRule, sink },
  );
  // The two SHELL-EXECUTING planes. A pack ships code the repo did not write;
  // letting it also ship a command that `shrk baseline check` would then RUN is
  // the same hazard the "pack-contributed verification commands are NOT
  // auto-run" contract already forbids. So the merge keeps the safe subset —
  // extractor computes and header-only generated rules — and drops the rest
  // with a diagnostic. The guarantee is structural: no downstream caller has to
  // remember to re-check provenance.
  const baselines = await mergePlane<IBaselineRule>(
    base.config.baselines ?? [],
    gatherPackContribs(validPacks, 'baselineFiles'),
    BaselineRuleSchema as IPlaneSchema,
    (r) => r.id,
    'baseline',
    diagnostics,
    { kind: ContributionKind.Baseline, sink },
    baselinePackVeto,
  );
  const generatedArtifacts = await mergePlane<IGeneratedArtifactRule>(
    base.config.generatedArtifacts ?? [],
    gatherPackContribs(validPacks, 'generatedArtifactFiles'),
    GeneratedArtifactRuleSchema as IPlaneSchema,
    (r) => r.id,
    'generatedArtifact',
    diagnostics,
    { kind: ContributionKind.GeneratedArtifact, sink },
    generatedPackVeto,
  );
  // No shell, no writes — a pack may contribute a prose-reference rule freely,
  // unlike the two shell-executing planes above. Round 13 (P3):
  // `docReferenceFiles` is a DECLARED manifest slot, so its outcome joins the
  // round-12 channel — a refused element is a structured rejection (`packs
  // contributions`, `packs list`, the gates ERRORED row), never only a
  // diagnostic string, and an adopted one is an accepted entry.
  const docReferences = await mergePlane<IDocReferenceRule>(
    base.config.docReferences ?? [],
    gatherPackContribs(validPacks, 'docReferenceFiles'),
    DocReferenceRuleSchema as IPlaneSchema,
    (r) => r.id,
    'docReference',
    diagnostics,
    { kind: ContributionKind.DocReference, sink },
  );
  const reusePrimitives = await mergePlane<IReusePrimitive>(
    base.config.reusePrimitives ?? [],
    gatherPackContribs(validPacks, 'reusePrimitiveFiles'),
    ReusePrimitiveSchema as IPlaneSchema,
    (r) => r.symbol,
    'reusePrimitive',
    diagnostics,
    { kind: ContributionKind.ReusePrimitive, sink },
  );

  // Pack-contributed elements have NOT been through the loader's `$use`
  // resolution (that ran on the local config only), so resolve the merged
  // planes here. A pack rule referencing an extractor this repo does not
  // declare is DROPPED with a diagnostic — never kept half-resolved, which
  // would read as "a source with no files" and match nothing, i.e. a silent
  // pass. Local rules are already resolved, so every error found here belongs
  // to a pack element by construction.
  const resolvedPlanes = resolvePlaneExtractors(
    { wiringRules, registries, registrationGraph, baselines },
    base.config.extractors,
  );
  const dropped = new Set<string>();
  /** Drop the pack element a source `path` belongs to; the adopted entry becomes a rejection. */
  const dropPackElement = (path: string, diagnostic: string, reason: string): void => {
    const prefix = path.slice(0, path.indexOf(']') + 1);
    diagnostics.push(diagnostic);
    if (dropped.has(prefix)) return;
    dropped.add(prefix);
    // The adopted pack element becomes a rejection — it never takes effect.
    const m = /^(\w+)\[(.*)\]$/.exec(prefix);
    const kind = m ? EXTRACTOR_PLANE_KIND[m[1]!] : undefined;
    const adopted = kind !== undefined ? sink.adopted.get(`${kind}:${m![2]!}`) : undefined;
    if (!adopted) return;
    const at = sink.accepted.indexOf(adopted.entry);
    if (at >= 0) sink.accepted.splice(at, 1);
    sink.rejected.push({
      file: adopted.entry.file,
      index: adopted.index,
      exportName: 'default',
      entryId: adopted.entry.id,
      reasons: [reason],
      cause: RejectionCause.Invalid,
      kind: adopted.entry.kind,
      ...(adopted.entry.packageName ? { packageName: adopted.entry.packageName } : {}),
      via: 'config-plane',
    });
  };
  const fieldOf = (path: string): string => path.slice(path.indexOf(']') + 1).replace(/^\./, '');
  for (const e of resolvedPlanes.errors) {
    dropPackElement(e.path, `${e.path}: ${e.message} — rule skipped`, `${fieldOf(e.path) || '$use'}: ${e.message}`);
  }
  // Then THE post-resolution check the loader runs on a local rule (core's
  // `validateResolvedPlaneSources`): a `$use` source is judged on its MERGED
  // shape. Without it a pack rule overriding an extractor with a negation-only
  // `files` was adopted — `packs contributions` said accepted, `check wiring`
  // said misconfigured (round 12 review, R12-X3). Local rules passed the
  // loader's identical check, so a problem here is a pack element's.
  for (const p of validateResolvedPlaneSources(resolvedPlanes)) {
    if (dropped.has(p.path.slice(0, p.path.indexOf(']') + 1))) continue;
    dropPackElement(p.path, `${p.path} ${p.message} — rule skipped`, `${fieldOf(p.path)} ${p.message}`);
  }
  const keep = <T>(items: readonly T[], plane: string, keyOf: (i: T) => string): readonly T[] =>
    dropped.size === 0 ? items : items.filter((i) => !dropped.has(`${plane}[${keyOf(i)}]`));

  return ok({
    ...base,
    config: {
      ...base.config,
      wiringRules: keep(resolvedPlanes.wiringRules ?? wiringRules, 'wiringRules', (r) => r.id),
      registries: keep(resolvedPlanes.registries ?? registries, 'registries', (r) => r.name),
      registrationGraph: keep(
        resolvedPlanes.registrationGraph ?? registrationGraph,
        'registrationGraph',
        (r) => r.name,
      ),
      policyRules,
      baselines: keep(resolvedPlanes.baselines ?? baselines, 'baselines', (r) => r.id),
      generatedArtifacts,
      docReferences,
      reusePrimitives,
    },
    planeDiagnostics: diagnostics,
    planeOutcomes: { accepted: sink.accepted, rejected: sink.rejected, loadFailures: sink.loadFailures },
  });
}
