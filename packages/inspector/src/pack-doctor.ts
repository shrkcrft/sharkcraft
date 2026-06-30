import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { hasActionHints, type IActionHints, type IKnowledgeEntry } from '@shrkcrft/knowledge';
import {
  PackageManager,
  WorkspaceProfile,
  type IWorkspaceSummary,
} from '@shrkcrft/workspace';
import { PipelineStepType } from '@shrkcrft/pipelines';
import { resolvePreset, resolvePresetReferences } from '@shrkcrft/presets';
import { PACK_SECRET_ENV, verifyPackManifest } from '@shrkcrft/plugin-api';
import { inspectionReferenceLookup } from './reference-lookup.ts';
import { runPackReleaseCheck, type IPackReleaseCheck } from './pack-release-check.ts';

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
    | 'release-readiness-issue';
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
          'Pack declared contribution files but nothing loaded — every file is missing, empty, or duplicates local entries.',
        suggestion: 'Run `shrk packs get <pack>` and check the listed contribution files.',
      });
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
  };
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
