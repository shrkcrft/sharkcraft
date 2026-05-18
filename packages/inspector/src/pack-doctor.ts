import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { hasActionHints, type IKnowledgeEntry } from '@shrkcrft/knowledge';
import { resolvePreset, resolvePresetReferences } from '@shrkcrft/presets';
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
    | 'preset-composition-cycle'
    | 'preset-composed-not-found'
    | 'preset-missing-ref'
    | 'preset-no-includes'
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
    if (options.requireSignatures) {
      const status = pack.signatureStatus;
      if (!status || status === 'missing-signature' || status === 'not-checked') {
        issues.push({
          severity: 'warning',
          packageName: pack.packageName,
          code: 'unsigned-pack',
          message: 'Pack has no signature; --require-signatures was set.',
          suggestion: 'Run `shrk packs sign <pack-dir>` and ship the signed manifest.',
        });
      }
    }
    if (pack.signatureStatus === 'invalid-signature') {
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
