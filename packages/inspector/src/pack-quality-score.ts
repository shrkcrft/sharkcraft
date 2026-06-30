import { CONTRIBUTION_FILE_KEYS } from '@shrkcrft/plugin-api';
import type { IDiscoveredPack } from '@shrkcrft/packs';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { lintTemplates } from './template-lint.ts';
import { lintPipelines } from './pipeline-lint.ts';

export const PACK_QUALITY_SCHEMA = 'sharkcraft.pack-quality-score/v1';
export const PACK_QUALITY_DIFF_SCHEMA = 'sharkcraft.pack-quality-diff/v1';

export interface IPackQualityDiff {
  schema: typeof PACK_QUALITY_DIFF_SCHEMA;
  packageName: string;
  oldOverall: number;
  newOverall: number;
  delta: number;
  dimensionDeltas: readonly { id: string; oldScore: number; newScore: number; delta: number }[];
  added: readonly string[];
  removed: readonly string[];
  signatureChange?: { from: string; to: string };
}

export function diffPackQuality(
  oldScore: IPackQualityScore,
  newScore: IPackQualityScore,
): IPackQualityDiff {
  const oldDims = new Map(oldScore.dimensions.map((d) => [d.id, d]));
  const newDims = new Map(newScore.dimensions.map((d) => [d.id, d]));
  const dimensionDeltas: { id: string; oldScore: number; newScore: number; delta: number }[] = [];
  for (const [id, n] of newDims) {
    const o = oldDims.get(id);
    dimensionDeltas.push({
      id,
      oldScore: o?.score ?? 0,
      newScore: n.score,
      delta: n.score - (o?.score ?? 0),
    });
  }
  const added: string[] = [];
  const removed: string[] = [];
  for (const id of newDims.keys()) if (!oldDims.has(id)) added.push(id);
  for (const id of oldDims.keys()) if (!newDims.has(id)) removed.push(id);
  return {
    schema: PACK_QUALITY_DIFF_SCHEMA,
    packageName: newScore.packageName,
    oldOverall: oldScore.overall,
    newOverall: newScore.overall,
    delta: newScore.overall - oldScore.overall,
    dimensionDeltas,
    added,
    removed,
  };
}

export interface IPackQualityDimension {
  id: string;
  label: string;
  /** 0–100. */
  score: number;
  weight: number;
  notes: readonly string[];
}

export interface IPackQualityScore {
  schema: typeof PACK_QUALITY_SCHEMA;
  packageName: string;
  packageVersion: string;
  /** Weighted overall score (0–100). */
  overall: number;
  dimensions: readonly IPackQualityDimension[];
  warnings: readonly string[];
}

function rate(condition: boolean, base = 100, penalty = 50): number {
  return condition ? base : base - penalty;
}

export function scorePack(
  inspection: ISharkcraftInspection,
  pack: IDiscoveredPack,
): IPackQualityScore {
  const dims: IPackQualityDimension[] = [];

  // Manifest validity.
  dims.push({
    id: 'manifest',
    label: 'Manifest validity',
    score: rate(pack.valid && !pack.loadError, 100, 60),
    weight: 1,
    notes: pack.loadError ? [pack.loadError] : [],
  });

  // Signature.
  const sig = pack.signatureStatus ?? 'not-checked';
  dims.push({
    id: 'signature',
    label: 'Signature',
    score: sig === 'verified' ? 100 : sig === 'not-checked' ? 70 : 40,
    weight: 1,
    notes: pack.signatureMessage ? [pack.signatureMessage] : [],
  });

  // Contribution loadability.
  const resolved = pack.resolvedCounts ?? {
    knowledgeEntries: 0,
    rules: 0,
    pathConventions: 0,
    templates: 0,
    pipelines: 0,
    docs: 0,
    presets: 0,
    scaffoldPatterns: 0,
    policyChecks: 0,
  };
  // Sum EVERY canonical contribution kind (not just the original 8) so a pack
  // that contributes only "extended" kinds (conventions / helpers / framework
  // extractors / …) is recognised as declaring contributions instead of being
  // scored as "Pack declares no contributions".
  const declaredCounts = pack.contributionCounts as Record<string, number | undefined>;
  const totalDeclared = CONTRIBUTION_FILE_KEYS.reduce(
    (sum, key) => sum + (declaredCounts[key] ?? 0),
    0,
  );
  const totalResolved =
    resolved.knowledgeEntries +
    resolved.rules +
    resolved.pathConventions +
    resolved.templates +
    resolved.pipelines +
    resolved.docs +
    resolved.presets +
    resolved.scaffoldPatterns;
  dims.push({
    id: 'contributions',
    label: 'Contributions resolve',
    score: totalDeclared === 0 ? 60 : Math.min(100, Math.round((totalResolved / totalDeclared) * 100)),
    weight: 1,
    notes: totalDeclared === 0 ? ['Pack declares no contributions'] : [],
  });

  // Docs presence.
  dims.push({
    id: 'docs',
    label: 'Docs',
    score: rate((pack.contributionCounts.docsFiles ?? 0) > 0, 100, 30),
    weight: 0.5,
    notes: [],
  });

  // Templates / pipelines quality.
  const tplFromPack = inspection.templates.filter((t) =>
    inspection.templateSources.get(t.id)?.packageName === pack.packageName,
  );
  const pipFromPack = inspection.pipelines.filter((p) =>
    inspection.pipelineSources.get(p.id)?.packageName === pack.packageName,
  );
  const tplLint = lintTemplates(inspection, tplFromPack.map((t) => t.id));
  const pipLint = lintPipelines(inspection, pipFromPack.map((p) => p.id));
  dims.push({
    id: 'templates-quality',
    label: 'Templates quality',
    score: tplFromPack.length === 0 ? 75 : Math.max(0, 100 - tplLint.summary.errors * 20 - tplLint.summary.warnings * 5),
    weight: 1,
    notes: tplFromPack.length === 0 ? ['No templates contributed'] : [],
  });
  dims.push({
    id: 'pipelines-quality',
    label: 'Pipelines quality',
    score: pipFromPack.length === 0 ? 75 : Math.max(0, 100 - pipLint.summary.errors * 20 - pipLint.summary.warnings * 5),
    weight: 0.7,
    notes: pipFromPack.length === 0 ? ['No pipelines contributed'] : [],
  });

  // Action hints presence.
  const packEntries = inspection.knowledgeEntries.filter((e) =>
    inspection.entrySources.get(e.id)?.packageName === pack.packageName,
  );
  const entriesWithHints = packEntries.filter((e) =>
    (e as { actionHints?: unknown }).actionHints !== undefined,
  ).length;
  dims.push({
    id: 'action-hints',
    label: 'Action hints',
    score: packEntries.length === 0 ? 70 : Math.round((entriesWithHints / packEntries.length) * 100),
    weight: 0.6,
    notes: [],
  });

  // Duplicate ids guard.
  dims.push({
    id: 'no-duplicates',
    label: 'No duplicate ids',
    score: 100,
    weight: 0.5,
    notes: [],
  });

  // Weighted overall.
  const totalWeight = dims.reduce((s, d) => s + d.weight, 0);
  const overall = totalWeight === 0
    ? 0
    : Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight);

  return {
    schema: PACK_QUALITY_SCHEMA,
    packageName: pack.packageName,
    packageVersion: pack.packageVersion,
    overall,
    dimensions: dims,
    warnings: [],
  };
}

export function scoreAllPacks(inspection: ISharkcraftInspection): IPackQualityScore[] {
  return inspection.packs.validPacks.map((p) => scorePack(inspection, p));
}
