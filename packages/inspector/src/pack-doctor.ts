import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import type { IVerdictCoverage } from '@shrkcrft/core';
import { hasActionHints, type IActionHints, type IKnowledgeEntry } from '@shrkcrft/knowledge';
import {
  PackageManager,
  WorkspaceProfile,
  type IWorkspaceSummary,
} from '@shrkcrft/workspace';
import { PipelineStepType } from '@shrkcrft/pipelines';
import { resolvePreset, resolvePresetReferences } from '@shrkcrft/presets';
import { PACK_SECRET_ENV, verifyPackManifest } from '@shrkcrft/plugin-api';
import * as nodePath from 'node:path';
import { inspectionReferenceLookup } from './reference-lookup.ts';
import {
  buildDeclaredXrefReport,
  collectDeclaredXrefs,
  isBrokenXref,
} from './declared-cross-references.ts';
import { DeclaredXrefStatus } from './declared-xref-status.ts';
import type { IDeclaredXrefReport } from './i-declared-xref-report.ts';
import { runPackReleaseCheck, type IPackReleaseCheck } from './pack-release-check.ts';
import {
  collectContributionLoadFailures,
  collectContributionRejections,
  collectRegistryOutcomes,
  formatEntryRejection,
  type IContributionLoadFailure,
} from './contribution-load-failures.ts';
import { ContributionKind } from './contribution-kind.ts';
import type { IContributionEntryRejection } from './i-contribution-entry-rejection.ts';
import type { IRegistryOutcomes } from './i-registry-outcomes.ts';
import { describePackAssetFreshness, detectPackAssetFreshness } from './pack-asset-freshness.ts';
import { detectUnregisteredExports, type IUnregisteredExport } from './unregistered-exports.ts';
import { typecheckPackAssets } from './pack-typecheck.ts';
import type { ITypecheckFilesResult } from './typecheck-files.ts';

export interface IPackDoctorIssue {
  severity: 'error' | 'warning' | 'info';
  packageName: string;
  code:
    | 'invalid-manifest'
    | 'missing-contribution-file'
    | 'empty-resolved-contributions'
    | 'duplicate-id-local'
    | 'duplicate-id-pack-internal'
    | 'template-no-description'
    | 'pipeline-no-steps'
    | 'critical-rule-no-hints'
    | 'docs-file-missing'
    | 'unsigned-pack'
    | 'tampered-pack'
    | 'signature-unverifiable'
    | 'dev-signature-not-trusted'
    | 'preset-composition-cycle'
    | 'preset-composed-not-found'
    | 'preset-missing-ref'
    | 'preset-no-includes'
    | 'pack-verification-pm-mismatch'
    | 'release-manifest-issue'
    | 'release-contribution-issue'
    | 'release-signature-issue'
    | 'release-files-issue'
    | 'release-readiness-issue'
    | 'contribution-load-failed'
    /** Round 12 (12.1): entries a contribution file declares that its loader refused. */
    | 'contribution-entries-rejected'
    | 'partially-resolved-contributions'
    | 'compiled-artifacts-stale'
    | 'compiled-artifacts-unrecorded'
    | 'unregistered-export'
    | 'typecheck-error'
    | 'typecheck-not-run'
    /** A pack-contributed asset names a cross-reference id no registry has. */
    | 'pack-xref-dangling'
    /** …names an id that resolves only in a kind the field does not accept. */
    | 'pack-xref-wrong-kind'
    /** …names ids that could not be looked up (registry not warmed / empty). */
    | 'pack-xref-unverified'
    /** A declaration problem: unknown facet kind, supersession cycle / chain, malformed field. */
    | 'pack-xref-invalid';
  message: string;
  /** Free-form suggestion. */
  suggestion?: string;
  /** Optional copy-pasteable shell command for the human reviewer. */
  suggestedCommand?: string;
}

export interface IPackDoctorReport {
  passed: boolean;
  packsChecked: number;
  issues: IPackDoctorIssue[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  /** Optional release-check payload per pack (populated when --release was passed). */
  releaseChecks?: readonly IPackReleaseCheck[];
  /** Per-pack typecheck results when the opt-in `--typecheck` ran (callers derive coverage from them). */
  typecheckResults?: readonly { readonly packageName: string; readonly result: ITypecheckFilesResult }[];
  /**
   * Compiled contribution artifacts that HAVE a source, and how many of them a
   * build record (source-map `sourcesContent` or signed digests) let the
   * freshness authority compare. An `unrecorded` artifact was never examined,
   * so a verdict over it is NOT VERIFIED. Absent when no pack ships a compiled
   * artifact with a source. Derived from the same `detectPackAssetFreshness`
   * call that emits the compiled-artifacts-* issues.
   */
  compiledArtifactCoverage?: IVerdictCoverage;
}

export interface IPackDoctorOptions {
  /** When true, unsigned packs surface as `unsigned-pack` warnings. */
  requireSignatures?: boolean;
  /**
   * Opt in to trusting dev signatures. By default a dev-signed pack fails
   * `--require-signatures` with `dev-signature-not-trusted`; when true, dev
   * signatures are re-verified against the well-known dev secret and accepted
   * (a tampered dev signature still surfaces as `tampered-pack`).
   */
  allowDevSignatures?: boolean;
  /** When true, also run pack-release-check per pack and fold findings into issues. */
  release?: boolean;
  /** When true, release-check warnings escalate to errors. */
  strict?: boolean;
  /**
   * Load failures the async registry loaders reported (helpers, conventions,
   * routing hints, …) — {@link buildPackDoctorReportAsync} gathers them. The
   * inspection-time loader failures are always read from the inspection.
   */
  registryLoadFailures?: readonly IContributionLoadFailure[];
  /**
   * What EVERY registry loader reported in one run (`collectRegistryOutcomes`)
   * — {@link buildPackDoctorReportAsync} gathers it. Its rejections feed
   * `contribution-entries-rejected` (round 12, 12.1); without it only the
   * inspection-time loaders' rejections are seen.
   */
  registryOutcomes?: IRegistryOutcomes;
  /** Pack entries exported by a group module but never registered (see `detectUnregisteredExports`). */
  unregisteredExports?: readonly IUnregisteredExport[];
  /** Per-pack `typecheckPackAssets` results (the opt-in `--typecheck`). */
  typecheckResults?: readonly { readonly packageName: string; readonly result: ITypecheckFilesResult }[];
  /**
   * THE declared cross-reference report (`buildDeclaredXrefReport`, warmed) —
   * {@link buildPackDoctorReportAsync} gathers it. Without it the sync doctor
   * collects on the caller's warm state: a cold cache yields `unverified`
   * rows, never a false dangling id.
   */
  declaredXrefs?: IDeclaredXrefReport;
}

const GEN_KEYWORDS = ['generate', 'create', 'add', 'refactor', 'test', 'review'];
function appliesToGeneration(e: IKnowledgeEntry): boolean {
  for (const a of e.appliesWhen ?? []) {
    const lower = a.toLowerCase();
    if (GEN_KEYWORDS.some((k) => lower.includes(k))) return true;
  }
  return false;
}
function isCriticalOrHigh(e: IKnowledgeEntry): boolean {
  const p = String(e.priority);
  return p === 'critical' || p === 'high';
}

/**
 * The `@shrkcrft/plugin-api` authoring type an asset of each kind can be
 * annotated with (`satisfies I<Kind>[]`), so `--typecheck` fails a missing
 * required field at build time. A kind with no published type is absent.
 */
const ASSET_TYPE_BY_KIND: Readonly<Partial<Record<ContributionKind, string>>> = {
  [ContributionKind.Knowledge]: 'IKnowledgeEntry',
  [ContributionKind.Rule]: 'IKnowledgeEntry',
  [ContributionKind.Path]: 'IKnowledgeEntry',
  [ContributionKind.PathConvention]: 'IKnowledgeEntry',
  [ContributionKind.Template]: 'ITemplateDefinition',
  [ContributionKind.Convention]: 'IConvention',
  [ContributionKind.Helper]: 'IPackHelper',
  [ContributionKind.TaskRoutingHint]: 'ITaskRoutingHint',
  [ContributionKind.RegistrationHint]: 'IRegistrationHint',
  [ContributionKind.Playbook]: 'IPlaybookInput',
  [ContributionKind.Construct]: 'IConstructInput',
  [ContributionKind.ConstructFacet]: 'IConstructFacetInput',
  [ContributionKind.SearchTuning]: 'ISearchTuning',
  [ContributionKind.ScaffoldPattern]: 'IScaffoldPattern',
  [ContributionKind.Policy]: 'IPackPolicyCheck',
  [ContributionKind.DelegateRecipe]: 'IDelegateRecipe',
};

/**
 * THE build-time pointer printed next to a rejected entry (round 12, 12.1f):
 * the runtime validator caught it; an annotated asset makes `--typecheck`
 * catch it before the pack ships.
 */
export function rejectedEntryTypecheckHint(kind: ContributionKind, pack: string): string {
  const type = ASSET_TYPE_BY_KIND[kind];
  if (!type) {
    // No published authoring type for this kind: the runtime loader is the check.
    return `\`shrk packs test ${pack} --load\` runs this loader at build time and fails on the entry — run it before publishing.`;
  }
  return `Annotate the asset with a type-only import and \`satisfies ${type}[]\` (from @shrkcrft/plugin-api) — see docs/pack-authoring.md — then \`shrk packs test ${pack} --typecheck\` catches this at build time.`;
}

/** A leading package-manager / runner literal a pack verification command may
 *  bake in. Order longest-first is not required — these tokens are disjoint. */
const PM_LITERAL_MANAGERS: ReadonlyArray<readonly [string, PackageManager]> = [
  ['bun ', PackageManager.Bun],
  ['pnpm ', PackageManager.Pnpm],
  ['yarn ', PackageManager.Yarn],
  ['npm ', PackageManager.Npm],
];

/** The package manager a command hard-codes as its leading runner, or null when
 *  it uses none (e.g. `make test`, a `<pm-run> test` placeholder, `shrk ...`). */
function literalPackageManager(command: string): PackageManager | null {
  const c = command.trim();
  for (const [literal, manager] of PM_LITERAL_MANAGERS) {
    if (c.startsWith(literal)) return manager;
  }
  return null;
}

/** The project's detected package manager (concrete only). Returns Unknown when
 *  no lockfile / packageManager field / bun profile signal is present — in that
 *  case we cannot claim a mismatch, so the lint stays silent. */
function detectedProjectManager(ws: IWorkspaceSummary | undefined): PackageManager {
  const m = ws?.packageManager?.manager;
  if (m && m !== PackageManager.Unknown) return m;
  if (ws?.profiles?.includes(WorkspaceProfile.HasBun)) return PackageManager.Bun;
  return PackageManager.Unknown;
}

/** Push a warning when `command` bakes in a runner that disagrees with the
 *  project's detected toolchain. No-op when the command is templated, runner-
 *  agnostic, or already agrees with the detected manager. */
function pushPmMismatch(
  issues: IPackDoctorIssue[],
  packageName: string,
  origin: string,
  command: string,
  detected: PackageManager,
): void {
  if (detected === PackageManager.Unknown) return;
  const literal = literalPackageManager(command);
  if (!literal || literal === detected) return;
  issues.push({
    severity: 'warning',
    packageName,
    code: 'pack-verification-pm-mismatch',
    message: `Verification command in ${origin} hard-codes \`${literal}\` but this project uses \`${detected}\`: "${command}".`,
    suggestion:
      'Use the `<pm-run>`/`<pm>` placeholder (resolved to the detected package manager at consume time) instead of a hard-coded runner.',
  });
}

/**
 * Full structural + quality audit of every discovered pack. Returns a list of
 * issues (error / warning / info) plus an aggregated pass flag.
 *
 * "Errors" mean the pack should not be trusted: invalid manifest, tampered
 * signature, missing contribution files, fully empty contributions. Everything
 * else is a warning — useful for pack authors, not fatal.
 */
export function buildPackDoctorReport(
  inspection: ISharkcraftInspection,
  options: IPackDoctorOptions = {},
): IPackDoctorReport {
  const issues: IPackDoctorIssue[] = [];
  const localKnowledgeIds = new Set(
    inspection.knowledgeEntries
      .filter((e) => inspection.entrySources.get(e.id)?.type === 'local')
      .map((e) => e.id),
  );
  const detectedPm = detectedProjectManager(inspection.workspace);
  const loadFailures = collectContributionLoadFailures(
    inspection,
    options.registryLoadFailures ?? options.registryOutcomes?.loadFailures ?? [],
  );
  // THE rejection channel, and each file's accepted count (the loader's own):
  // `N of M entries rejected` is accepted + rejected = declared.
  const rejections = collectContributionRejections(inspection, options.registryOutcomes?.rejections ?? []);
  const acceptedByFile = new Map<string, number>();
  for (const a of options.registryOutcomes?.accepted ?? []) {
    acceptedByFile.set(a.file, (acceptedByFile.get(a.file) ?? 0) + 1);
  }
  for (const d of inspection.loaderDiagnostics ?? []) {
    if (d.status !== 'ok') continue;
    const abs = nodePath.resolve(d.filePath);
    acceptedByFile.set(abs, (acceptedByFile.get(abs) ?? 0) + d.count);
  }
  const rejectedFiles = new Set(rejections.map((r) => r.file));
  // Files the inspection-time loaders imported AND that produced ≥ 1 entry.
  // Compiled artifacts with a source, and those no build record covers.
  let compiledWithSource = 0;
  const unrecordedArtifacts: string[] = [];
  const producingFiles = new Set(
    (inspection.loaderDiagnostics ?? [])
      .filter((d) => d.status === 'ok' && d.count > 0)
      .map((d) => nodePath.resolve(d.filePath)),
  );

  for (const pack of inspection.packs.invalidPacks) {
    issues.push({
      severity: 'error',
      packageName: pack.packageName,
      code: 'invalid-manifest',
      message:
        pack.loadError ??
        `Manifest validation failed: ${pack.validationIssues.map((i) => i.field).join(', ')}`,
      suggestion: 'Verify the manifest exports a definePackManifest({...}) default export.',
    });
  }

  for (const pack of inspection.packs.discoveredPacks) {
    if (!pack.valid) continue; // already covered by invalid-manifest above
    const manifest = pack.manifest!;
    const resolved = pack.resolvedCounts;
    const declaredAny =
      manifest.contributions.knowledgeFiles?.length ||
      manifest.contributions.ruleFiles?.length ||
      manifest.contributions.pathFiles?.length ||
      manifest.contributions.templateFiles?.length ||
      manifest.contributions.pipelineFiles?.length ||
      manifest.contributions.docsFiles?.length;
    const resolvedAny =
      !!resolved &&
      (resolved.knowledgeEntries +
        resolved.rules +
        resolved.pathConventions +
        resolved.templates +
        resolved.pipelines +
        resolved.docs >
        0);
    if (declaredAny && !resolvedAny) {
      issues.push({
        severity: 'error',
        packageName: pack.packageName,
        code: 'empty-resolved-contributions',
        message:
          'Pack declared contribution files but nothing loaded — every file is missing, empty, failed to load, or duplicates local entries.',
        suggestion: 'Run `shrk packs get <pack>` and check the listed contribution files.',
      });
    }

    // A contribution file the module loader could not import: nothing in it
    // takes effect, whatever a regex scrape of it might list. One error per file.
    const packRootPrefix = nodePath.resolve(pack.packageRoot) + nodePath.sep;
    const packFailures = [...loadFailures.values()].filter(
      (f) => f.packageName === pack.packageName || f.file.startsWith(packRootPrefix),
    );
    for (const f of packFailures) {
      issues.push({
        severity: 'error',
        packageName: pack.packageName,
        code: 'contribution-load-failed',
        message: `${nodePath.relative(pack.packageRoot, f.file) || f.file} (${f.kind}) failed to load — ${f.message}. Nothing in it takes effect.`,
        suggestion: 'Fix the syntax / import error in that file; release-check reproduces the load.',
        suggestedCommand: `shrk packs release-check ${pack.packageRoot}`,
      });
    }

    // Entries a contribution file DECLARES that its loader REFUSED (round 12,
    // 12.1): one error per file. A file with 8 of 10 entries used to read as
    // healthy here — only a file producing ZERO entries was ever flagged.
    const packRejections = rejections.filter(
      (r) => r.packageName === pack.packageName || r.file.startsWith(packRootPrefix),
    );
    const byFile = new Map<string, IContributionEntryRejection[]>();
    for (const r of packRejections) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
    for (const [file, list] of byFile) {
      const declared = (acceptedByFile.get(file) ?? 0) + list.length;
      const kind = list[0]!.kind;
      issues.push({
        severity: 'error',
        packageName: pack.packageName,
        code: 'contribution-entries-rejected',
        message: `${nodePath.relative(pack.packageRoot, file) || file} (${kind}): ${list.length} of ${declared} ${
          declared === 1 ? 'entry' : 'entries'
        } rejected — ${list.map((r) => formatEntryRejection(r)).join('; ')}. A rejected entry does not take effect.`,
        suggestion: `Fix the field(s) the loader names. ${
          options.typecheckResults ? '' : rejectedEntryTypecheckHint(kind, nodePath.relative(inspection.projectRoot, pack.packageRoot) || pack.packageRoot)
        }`.trim(),
        suggestedCommand: `shrk packs contributions --pack ${pack.packageName}`,
      });
    }

    // Declared knowledge-family files that LOADED but produced no entry: the
    // pack prints `k=2` next to `entries=1` and that pair used to go unread.
    if (declaredAny && resolvedAny) {
      const familyRels = [
        ...(manifest.contributions.knowledgeFiles ?? []),
        ...(manifest.contributions.ruleFiles ?? []),
        ...(manifest.contributions.pathFiles ?? []),
        ...(manifest.contributions.pathConventionFiles ?? []),
        ...(manifest.contributions.templateFiles ?? []),
        ...(manifest.contributions.pipelineFiles ?? []),
        ...(manifest.contributions.docsFiles ?? []),
      ];
      const familyAbs = [...new Set(familyRels.map((rel) => nodePath.resolve(pack.packageRoot, rel)))];
      const silent = familyAbs.filter(
        (abs) =>
          !producingFiles.has(abs) &&
          !loadFailures.has(abs) &&
          // Every entry rejected: `contribution-entries-rejected` says why.
          !rejectedFiles.has(abs) &&
          !inspection.warnings.includes(
            `pack ${pack.packageName}: missing contribution file ${nodePath.relative(pack.packageRoot, abs)}`,
          ),
      );
      if (silent.length > 0) {
        issues.push({
          severity: 'warning',
          packageName: pack.packageName,
          code: 'partially-resolved-contributions',
          message: `${silent.length} of ${familyAbs.length} declared contribution file(s) loaded but produced no entries: ${silent
            .map((abs) => nodePath.relative(pack.packageRoot, abs))
            .join(', ')}.`,
          suggestion:
            'Each file must export entry-shaped values (an array default export, or named entries); check the export shape and the required fields.',
        });
      }
    }

    // Compiled contributions vs their source — THE freshness authority
    // (content, never mtime). A stale build means shrk serves the previous one.
    const freshness = detectPackAssetFreshness(pack);
    const saidBuild = describePackAssetFreshness(freshness).build;
    if (freshness.build.state === 'stale' && saidBuild) {
      issues.push({
        severity: options.strict || options.release ? 'error' : 'warning',
        packageName: pack.packageName,
        code: 'compiled-artifacts-stale',
        message: saidBuild,
        ...(freshness.build.rebuildCommand
          ? { suggestedCommand: `(cd ${pack.packageRoot} && ${freshness.build.rebuildCommand})` }
          : {}),
      });
    } else if (freshness.build.state === 'unrecorded' && saidBuild) {
      // Never compared (no build record): NOT VERIFIED by default — the
      // verdict settles it through `compiledArtifactCoverage` — and, like a
      // stale build, an error under --strict / --release.
      issues.push({
        severity: options.strict || options.release ? 'error' : 'warning',
        packageName: pack.packageName,
        code: 'compiled-artifacts-unrecorded',
        message: saidBuild,
      });
    }
    for (const a of freshness.build.artifacts) {
      if (a.source === null) continue; // no source → nothing to compare it to
      compiledWithSource += 1;
      if (a.state === 'unrecorded') unrecordedArtifacts.push(`${pack.packageName}:${a.artifact}`);
    }

    for (const u of options.unregisteredExports ?? []) {
      if (u.packageName !== pack.packageName) continue;
      issues.push({
        severity: 'error',
        packageName: pack.packageName,
        code: 'unregistered-export',
        message: `${u.group}${u.line > 0 ? `:${u.line}` : ''} ${u.message}`,
      });
    }

    for (const t of options.typecheckResults ?? []) {
      if (t.packageName !== pack.packageName) continue;
      if (!t.result.ran) {
        issues.push({
          severity: 'warning',
          packageName: pack.packageName,
          code: 'typecheck-not-run',
          message: `--typecheck examined 0 TS files (${t.result.note ?? 'nothing to check'}) — NOT verified.`,
        });
        continue;
      }
      for (const e of t.result.errors) {
        issues.push({
          severity: 'error',
          packageName: pack.packageName,
          code: 'typecheck-error',
          message: `${nodePath.relative(pack.packageRoot, e.file) || e.file}:${e.line}:${e.column} TS${e.code} ${e.message}`,
        });
      }
    }

    // Templates contributed by this pack — require a non-trivial description.
    for (const t of inspection.templates) {
      const src = inspection.templateSources.get(t.id);
      if (src?.type !== 'pack' || src.packageName !== pack.packageName) continue;
      const description = (t as { description?: unknown }).description;
      if (typeof description !== 'string' || description.trim().length < 5) {
        issues.push({
          severity: 'warning',
          packageName: pack.packageName,
          code: 'template-no-description',
          message: `Template "${t.id}" lacks a meaningful description.`,
          suggestion: 'Add a description so agents can pick the right generator for a task.',
        });
      }
    }

    // Pipelines contributed by this pack — require at least one step.
    for (const p of inspection.pipelines) {
      const src = inspection.pipelineSources.get(p.id);
      if (src?.type !== 'pack' || src.packageName !== pack.packageName) continue;
      if (!Array.isArray(p.steps) || p.steps.length === 0) {
        issues.push({
          severity: 'warning',
          packageName: pack.packageName,
          code: 'pipeline-no-steps',
          message: `Pipeline "${p.id}" has no steps.`,
        });
      }
    }

    // Critical/high workflow rules contributed by this pack should carry hints.
    for (const entry of inspection.knowledgeEntries) {
      const src = inspection.entrySources.get(entry.id);
      if (src?.type !== 'pack' || src.packageName !== pack.packageName) continue;
      if (!isCriticalOrHigh(entry)) continue;
      if (!appliesToGeneration(entry)) continue;
      if (String(entry.type) === 'path') continue;
      if (!hasActionHints(entry)) {
        issues.push({
          severity: 'warning',
          packageName: pack.packageName,
          code: 'critical-rule-no-hints',
          message: `Rule "${entry.id}" is high/critical and applies to generation but ships no actionHints.`,
        });
      }
    }

    // Verification commands that bake in a *foreign* package manager / runner.
    // A pack playbook that ships `bun test` contradicts an npm/pnpm/yarn target;
    // prefer the `<pm-run>`/`<pm>` placeholder. Warning, never a hard fail.
    for (const entry of inspection.knowledgeEntries) {
      const src = inspection.entrySources.get(entry.id);
      if (src?.type !== 'pack' || src.packageName !== pack.packageName) continue;
      const hints = (entry as { actionHints?: IActionHints }).actionHints;
      for (const cmd of hints?.verificationCommands ?? []) {
        pushPmMismatch(issues, pack.packageName, `knowledge "${entry.id}"`, cmd, detectedPm);
      }
    }
    for (const p of inspection.pipelines) {
      const src = inspection.pipelineSources.get(p.id);
      if (src?.type !== 'pack' || src.packageName !== pack.packageName) continue;
      for (const step of p.steps ?? []) {
        if (step.type !== PipelineStepType.Command) continue;
        for (const cmd of step.cliCommands ?? []) {
          pushPmMismatch(
            issues,
            pack.packageName,
            `pipeline "${p.id}" step "${step.id}"`,
            cmd,
            detectedPm,
          );
        }
      }
    }

    // Local-vs-pack duplicate ids.
    for (const entry of inspection.knowledgeEntries) {
      const src = inspection.entrySources.get(entry.id);
      if (src?.type !== 'pack' || src.packageName !== pack.packageName) continue;
      if (localKnowledgeIds.has(entry.id)) {
        issues.push({
          severity: 'info',
          packageName: pack.packageName,
          code: 'duplicate-id-local',
          message: `Pack entry "${entry.id}" duplicates a local id — local wins.`,
        });
      }
    }

    // Signature gating.
    //
    // The inspector verifies with dev signatures DISALLOWED, so a dev-signed
    // pack arrives here as `dev-signature`. With --allow-dev-signature we
    // re-run the HMAC against the well-known dev secret so a *tampered* dev
    // signature still surfaces as invalid rather than being blindly trusted.
    let sigStatus = pack.signatureStatus;
    if (sigStatus === 'dev-signature' && options.allowDevSignatures && pack.manifest) {
      const v = verifyPackManifest(pack.manifest, { allowDev: true });
      sigStatus = v.ok ? 'verified' : v.status;
    }
    if (options.requireSignatures) {
      if (!sigStatus || sigStatus === 'missing-signature' || sigStatus === 'not-checked') {
        issues.push({
          severity: 'warning',
          packageName: pack.packageName,
          code: 'unsigned-pack',
          message: 'Pack has no signature; --require-signatures was set.',
          suggestion: 'Run `shrk packs sign <pack-dir>` and ship the signed manifest.',
        });
      } else if (sigStatus === 'missing-secret') {
        // S3-2: required verification that COULD NOT RUN is a failure, not a
        // pass. A signed pack whose secret is unavailable is unverifiable —
        // never report it as OK.
        issues.push({
          severity: 'error',
          packageName: pack.packageName,
          code: 'signature-unverifiable',
          message:
            `Pack is signed but ${PACK_SECRET_ENV} is not set, so the signature could not be verified — required verification failed.`,
          suggestion: `Set ${PACK_SECRET_ENV} (or pass --secret) and re-run with --require-signatures.`,
          suggestedCommand: `${PACK_SECRET_ENV}=<secret> shrk packs doctor --require-signatures`,
        });
      } else if (sigStatus === 'dev-signature') {
        // S3-1: a dev signature is verified only against the public dev secret
        // and is NOT release-trusted; under --require-signatures it must fail.
        issues.push({
          severity: 'error',
          packageName: pack.packageName,
          code: 'dev-signature-not-trusted',
          message:
            'Pack carries a dev signature (not release-trusted) and --require-signatures was set.',
          suggestion:
            'Re-sign with the release secret (`shrk packs sign <pack-dir>`), or pass --allow-dev-signature to accept dev signatures for local-only flows.',
        });
      }
    }
    if (sigStatus === 'invalid-signature') {
      issues.push({
        severity: 'error',
        packageName: pack.packageName,
        code: 'tampered-pack',
        message: pack.signatureMessage ?? 'Pack signature does not match.',
        suggestion: 'Do not trust this pack — re-fetch from a known-good source.',
      });
    }

    // Docs files: surface inspector-side "missing contribution file" warnings.
    // Those already land in inspection.warnings; we re-surface them here so the
    // doctor view is self-contained.
    // Preset composition / references for presets contributed by this pack.
    const refLookup = inspectionReferenceLookup(inspection);
    for (const preset of inspection.presetRegistry.list()) {
      const src = inspection.presetSources.get(preset.id);
      if (src?.type !== 'pack' || src.packageName !== pack.packageName) continue;
      const resolved = resolvePreset(inspection.presetRegistry, preset.id);
      for (const i of resolved.issues) {
        issues.push({
          severity: 'error',
          packageName: pack.packageName,
          code:
            i.code === 'composition-cycle'
              ? 'preset-composition-cycle'
              : 'preset-composed-not-found',
          message: `Preset "${preset.id}": ${i.message}`,
        });
      }
      const refs = resolvePresetReferences(resolved, refLookup);
      for (const m of refs.missing) {
        issues.push({
          severity: 'warning',
          packageName: pack.packageName,
          code: 'preset-missing-ref',
          message: `Preset "${preset.id}" references missing ${m.kind} id "${m.id}".`,
          suggestion:
            'Install the pack that provides the referenced asset, or add it locally.',
        });
      }
      const includesAny =
        (resolved.includes.knowledge?.length ?? 0) +
          (resolved.includes.rules?.length ?? 0) +
          (resolved.includes.paths?.length ?? 0) +
          (resolved.includes.templates?.length ?? 0) +
          (resolved.includes.pipelines?.length ?? 0) +
          (resolved.includes.knowledgeIds?.length ?? 0) +
          (resolved.includes.ruleIds?.length ?? 0) +
          (resolved.includes.pathConventionIds?.length ?? 0) +
          (resolved.includes.templateIds?.length ?? 0) +
          (resolved.includes.pipelineIds?.length ?? 0) >
        0;
      if (!includesAny) {
        issues.push({
          severity: 'warning',
          packageName: pack.packageName,
          code: 'preset-no-includes',
          message: `Preset "${preset.id}" contributes no includes (no embedded entries and no reference ids).`,
        });
      }
    }

    const prefix = `pack ${pack.packageName}: missing contribution file `;
    for (const w of inspection.warnings) {
      if (!w.startsWith(prefix)) continue;
      const rel = w.slice(prefix.length);
      issues.push({
        severity: 'error',
        packageName: pack.packageName,
        code: 'missing-contribution-file',
        message: `Contribution file is missing on disk: ${rel}`,
        suggestion: 'Update the manifest paths or restore the file under the package root.',
      });
    }
  }

  // Declared cross-references on pack-contributed assets (round 11, 4.2): the
  // SAME rows the self-config doctor reports, scoped to the pack that owns the
  // source asset — never a second walker over the fields.
  const xrefs = options.declaredXrefs ?? collectDeclaredXrefs(inspection);
  const packNames = new Set(inspection.packs.discoveredPacks.map((p) => p.packageName));
  const unverifiedByPack = new Map<string, number>();
  for (const row of xrefs.rows) {
    if (!row.packageName || !packNames.has(row.packageName)) continue;
    if (row.status === DeclaredXrefStatus.Unverified) {
      unverifiedByPack.set(row.packageName, (unverifiedByPack.get(row.packageName) ?? 0) + 1);
      continue;
    }
    if (!isBrokenXref(row)) continue;
    issues.push({
      severity: row.severity === 'error' ? 'error' : 'warning',
      packageName: row.packageName,
      code: row.status === DeclaredXrefStatus.Dangling ? 'pack-xref-dangling' : 'pack-xref-wrong-kind',
      message: `${row.message}${row.file ? ` (${row.file})` : ''}`,
      suggestion:
        row.didYouMean.length > 0
          ? `Did you mean "${row.didYouMean[0]}"? Fix the id in the pack source, then re-sign the pack.`
          : 'Fix or remove the id in the pack source, then re-sign the pack.',
      suggestedCommand: `shrk self-config resolve ${row.targetId}`,
    });
  }
  for (const issue of xrefs.issues) {
    if (!issue.packageName || !packNames.has(issue.packageName)) continue;
    issues.push({
      severity: issue.severity,
      packageName: issue.packageName,
      code: 'pack-xref-invalid',
      message: `[${issue.code}] ${issue.message}${issue.file ? ` (${issue.file})` : ''}`,
    });
  }
  for (const [packageName, n] of unverifiedByPack) {
    issues.push({
      severity: 'info',
      packageName,
      code: 'pack-xref-unverified',
      message: `${n} declared cross-reference id(s) NOT VERIFIED — the registry they resolve against was not warmed, or is empty.`,
      suggestedCommand: 'shrk self-config xrefs --json',
    });
  }

  const summary = {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
  };
  return {
    passed: summary.errors === 0,
    packsChecked: inspection.packs.discoveredPacks.length,
    issues,
    summary,
    ...(options.typecheckResults ? { typecheckResults: options.typecheckResults } : {}),
    ...(compiledWithSource > 0
      ? {
          compiledArtifactCoverage: {
            unit: 'compiled artifacts',
            expected: compiledWithSource,
            examined: compiledWithSource - unrecordedArtifacts.length,
            reason: 'have no build record (source-map sourcesContent or signed content digests) to compare their source against',
            ...(unrecordedArtifacts.length > 0
              ? { unexamined: unrecordedArtifacts.slice(0, 20), unexaminedTotal: unrecordedArtifacts.length }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The pack doctor with every ASYNC input gathered first: the registry loaders'
 * load failures, unregistered group-module exports, and (opt-in) a typecheck
 * of each pack's TS assets. `packs doctor` and the MCP doctor tools share it,
 * so both report the same issues.
 */
export async function buildPackDoctorReportAsync(
  inspection: ISharkcraftInspection,
  options: IPackDoctorOptions & { readonly typecheck?: boolean } = {},
): Promise<IPackDoctorReport> {
  // ONE run of every registry loader: load failures, rejected and accepted entries.
  const [registryOutcomes, unregisteredExports] = await Promise.all([
    collectRegistryOutcomes(inspection),
    detectUnregisteredExports(inspection).then((all) => all.filter((u) => u.packageName !== undefined)),
  ]);
  const registryLoadFailures = registryOutcomes.loadFailures;
  const typecheckResults = options.typecheck
    ? inspection.packs.validPacks.map((p) => ({
        packageName: p.packageName,
        result: typecheckPackAssets({ packageRoot: p.packageRoot, manifestPath: p.manifestPath, manifest: p.manifest ?? null }),
      }))
    : undefined;
  return buildPackDoctorReport(inspection, {
    ...options,
    registryLoadFailures,
    registryOutcomes,
    unregisteredExports,
    declaredXrefs: options.declaredXrefs ?? (await buildDeclaredXrefReport(inspection)),
    ...(typecheckResults ? { typecheckResults } : {}),
  });
}

/** Map a single release-check finding code to one of the four IPackDoctorIssue
 *  release-* bucket codes. */
function releaseFindingBucket(
  code: string,
): IPackDoctorIssue['code'] {
  if (code.startsWith('manifest-')) return 'release-manifest-issue';
  if (code === 'no-manifest' || code === 'no-package-json') return 'release-manifest-issue';
  if (code === 'contribution-missing' || code === 'contribution-load-failed' || code === 'contribution-helper-missing')
    return 'release-contribution-issue';
  if (code === 'unsigned-manifest') return 'release-signature-issue';
  if (code === 'no-files-whitelist' || code === 'manifest-not-in-files') return 'release-files-issue';
  return 'release-readiness-issue';
}

/** Run pack-release-check for every valid discovered pack and return the
 *  results. Async because contribution loading uses dynamic imports. */
export async function runPackReleaseChecksForReport(
  inspection: ISharkcraftInspection,
): Promise<IPackReleaseCheck[]> {
  const results: IPackReleaseCheck[] = [];
  for (const pack of inspection.packs.discoveredPacks) {
    if (!pack.valid) continue;
    try {
      const check = await runPackReleaseCheck(pack.packageRoot);
      results.push(check);
    } catch (e) {
      // Swallow per-pack errors so the doctor report stays best-effort.
      void e;
    }
  }
  return results;
}

/** Fold a list of release-check results into a doctor report. Mutates and
 *  returns the same report for ergonomics. */
export function mergePackReleaseChecks(
  inspection: ISharkcraftInspection,
  report: IPackDoctorReport,
  releaseChecks: readonly IPackReleaseCheck[],
  options: { strict?: boolean } = {},
): IPackDoctorReport {
  // Build a path -> packageName index so we can map check paths back to packs.
  const pathToName = new Map<string, string>();
  for (const pack of inspection.packs.discoveredPacks) {
    if (pack.valid) pathToName.set(pack.packageRoot, pack.packageName);
  }
  for (const check of releaseChecks) {
    const packageName = pathToName.get(check.packPath) ?? check.packPath;
    for (const f of check.findings) {
      const code = releaseFindingBucket(f.code);
      const severity: 'error' | 'warning' | 'info' =
        f.severity === 'error'
          ? 'error'
          : f.severity === 'warning' && options.strict
            ? 'error'
            : f.severity === 'warning'
              ? 'warning'
              : 'info';
      report.issues.push({
        packageName,
        severity,
        code,
        message: `[release/${f.code}] ${f.message}`,
        ...(f.suggestedFix ? { suggestion: f.suggestedFix } : {}),
        ...(f.suggestedCommand ? { suggestedCommand: f.suggestedCommand } : {}),
      });
    }
  }
  report.summary = {
    errors: report.issues.filter((i) => i.severity === 'error').length,
    warnings: report.issues.filter((i) => i.severity === 'warning').length,
    info: report.issues.filter((i) => i.severity === 'info').length,
  };
  report.passed = report.summary.errors === 0;
  report.releaseChecks = releaseChecks;
  return report;
}
