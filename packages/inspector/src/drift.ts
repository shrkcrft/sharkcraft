import { evaluateBoundaries, loadTsconfigPaths, scanImports } from '@shrkcrft/boundaries';
import { resolvePreset, resolvePresetReferences } from '@shrkcrft/presets';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { inspectionReferenceLookup } from './reference-lookup.ts';

export type DriftSeverity = 'error' | 'warning' | 'info';
export type DriftCategory =
  | 'boundary'
  | 'preset-reference'
  | 'preset-composition'
  | 'missing-pack-asset'
  | 'config-mismatch'
  | 'template-relationship'
  | 'pipeline-template-link';

export interface IDriftFinding {
  category: DriftCategory;
  severity: DriftSeverity;
  message: string;
  evidence?: Record<string, unknown>;
  suggestedFix?: string;
  related?: { kind: 'rule' | 'template' | 'path' | 'pipeline' | 'preset' | 'pack'; id: string }[];
}

export interface IDriftReport {
  findings: IDriftFinding[];
  counts: { error: number; warning: number; info: number };
}

export interface IBuildDriftOptions {
  /** When true, run the full boundary scan (slow on large repos). Default: true. */
  runBoundaries?: boolean;
}

/**
 * First-cut drift report. Combines:
 *  - Boundary violations (when boundary rules are present).
 *  - Preset reference resolution (missing pack assets).
 *  - Preset composition issues.
 *  - Pipeline → template references that don't resolve.
 *
 * Pure orchestration over existing services. Returns warnings by default;
 * elevates clear architecture problems to errors.
 */
export function buildDriftReport(
  inspection: ISharkcraftInspection,
  options: IBuildDriftOptions = {},
): IDriftReport {
  const findings: IDriftFinding[] = [];

  // 1. Boundary violations.
  if ((options.runBoundaries ?? true) && inspection.boundaryRegistry.size() > 0) {
    const scan = scanImports({ projectRoot: inspection.projectRoot });
    const tsconfigPaths = loadTsconfigPaths(inspection.projectRoot);
    const evalResult = evaluateBoundaries(scan, inspection.boundaryRegistry.list(), {
      ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
    });
    for (const v of evalResult.violations) {
      findings.push({
        category: 'boundary',
        severity: v.severity,
        message: v.message,
        evidence: {
          ruleId: v.ruleId,
          file: v.file,
          line: v.line,
          importSpecifier: v.importSpecifier,
        },
        suggestedFix: v.suggestedFix,
      });
    }
  }

  // 2. Preset reference resolution + composition issues.
  const refLookup = inspectionReferenceLookup(inspection);
  for (const preset of inspection.presetRegistry.list()) {
    const resolved = resolvePreset(inspection.presetRegistry, preset.id);
    for (const issue of resolved.issues) {
      findings.push({
        category: 'preset-composition',
        severity: 'error',
        message: `Preset "${preset.id}": ${issue.message}`,
        evidence: { presetId: preset.id, code: issue.code },
      });
    }
    const refs = resolvePresetReferences(resolved, refLookup);
    for (const missing of refs.missing) {
      findings.push({
        category: 'preset-reference',
        severity: 'warning',
        message: `Preset "${preset.id}" references missing ${missing.kind} id "${missing.id}".`,
        evidence: { presetId: preset.id, ...missing },
        suggestedFix:
          'Install the pack that provides this asset, or add the asset locally.',
      });
    }
  }

  // 3. Pipeline step references to templates that don't exist.
  for (const pipeline of inspection.pipelines) {
    for (const step of pipeline.steps ?? []) {
      for (const ref of step.references ?? []) {
        if (
          !inspection.templates.some((t) => t.id === ref) &&
          !inspection.knowledgeEntries.some((e) => e.id === ref)
        ) {
          findings.push({
            category: 'pipeline-template-link',
            severity: 'warning',
            message: `Pipeline "${pipeline.id}" step "${step.id}" references unknown id "${ref}".`,
            evidence: { pipelineId: pipeline.id, stepId: step.id, ref },
          });
        }
      }
    }
  }

  // 4. Templates that declare related ids that don't resolve (action hints).
  for (const entry of inspection.knowledgeEntries) {
    const ah = entry.actionHints;
    if (!ah) continue;
    for (const id of ah.relatedTemplates ?? []) {
      if (!inspection.templates.some((t) => t.id === id)) {
        findings.push({
          category: 'template-relationship',
          severity: 'info',
          message: `Entry "${entry.id}" hints relatedTemplate "${id}" but no template with that id is registered.`,
          evidence: { entryId: entry.id, templateId: id },
        });
      }
    }
    for (const id of ah.relatedPathConventions ?? []) {
      if (
        !inspection.knowledgeEntries.some(
          (e) => e.id === id && String(e.type) === 'path',
        )
      ) {
        findings.push({
          category: 'template-relationship',
          severity: 'info',
          message: `Entry "${entry.id}" hints relatedPathConvention "${id}" but no path convention with that id is registered.`,
          evidence: { entryId: entry.id, pathId: id },
        });
      }
    }
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return { findings, counts };
}
