import { hasActionHints } from '@shrkcrft/knowledge';
import { resolvePreset, resolvePresetReferences } from '@shrkcrft/presets';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { inspectionReferenceLookup } from './reference-lookup.ts';

export interface ICoverageCategory {
  id: string;
  title: string;
  total: number;
  covered: number;
  /** 0..100 percentage. */
  score: number;
  /** Detail lines for items missing coverage. */
  missing: string[];
}

export interface ICoverageReport {
  categories: ICoverageCategory[];
  /** Overall average score (0..100). */
  overall: number;
  /** Free-form suggestions. */
  suggestions: string[];
}

function pct(covered: number, total: number): number {
  if (total === 0) return 100;
  return Math.round((covered / total) * 100);
}

/**
 * Deterministic coverage report. Different from AI-readiness — focuses on
 * **relationships**: do entries link to each other in a way that lets an
 * agent traverse the project intelligence?
 */
export function buildCoverageReport(inspection: ISharkcraftInspection): ICoverageReport {
  const suggestions: string[] = [];
  const categories: ICoverageCategory[] = [];

  // 1. Templates with description ≥ 5 chars.
  {
    const total = inspection.templates.length;
    const missing: string[] = [];
    let covered = 0;
    for (const t of inspection.templates) {
      if (typeof t.description === 'string' && t.description.trim().length >= 5) {
        covered += 1;
      } else {
        missing.push(`${t.id} — description missing or too short`);
      }
    }
    categories.push({
      id: 'template-descriptions',
      title: 'Templates have a meaningful description',
      total,
      covered,
      score: pct(covered, total),
      missing,
    });
  }

  // 2. Templates with related rules / paths.
  {
    const total = inspection.templates.length;
    const missing: string[] = [];
    let covered = 0;
    for (const t of inspection.templates) {
      const related = (t as { related?: readonly string[] }).related ?? [];
      if (related.length > 0) covered += 1;
      else missing.push(`${t.id} — no related rules/paths declared`);
    }
    categories.push({
      id: 'template-related',
      title: 'Templates declare related rules/paths',
      total,
      covered,
      score: pct(covered, total),
      missing,
    });
  }

  // 3. Critical/high knowledge entries with action hints.
  {
    const eligible = inspection.knowledgeEntries.filter((e) => {
      const p = String(e.priority);
      return p === 'critical' || p === 'high';
    });
    const total = eligible.length;
    const missing: string[] = [];
    let covered = 0;
    for (const e of eligible) {
      if (hasActionHints(e)) covered += 1;
      else missing.push(`${e.id} — no actionHints`);
    }
    categories.push({
      id: 'hint-coverage',
      title: 'Critical/high entries carry actionHints',
      total,
      covered,
      score: pct(covered, total),
      missing,
    });
  }

  // 4. Pipelines whose steps reference existing templates/rules/paths.
  {
    const total = inspection.pipelines.length;
    const missing: string[] = [];
    let covered = 0;
    for (const p of inspection.pipelines) {
      const refs: string[] = [];
      for (const step of p.steps ?? []) {
        for (const ref of step.references ?? []) refs.push(ref);
      }
      if (refs.length === 0) {
        missing.push(`${p.id} — no step references`);
        continue;
      }
      const allResolve = refs.every(
        (id) =>
          inspection.templates.some((t) => t.id === id) ||
          inspection.knowledgeEntries.some((e) => e.id === id),
      );
      if (allResolve) covered += 1;
      else missing.push(`${p.id} — some step references unknown ids`);
    }
    categories.push({
      id: 'pipeline-step-refs',
      title: 'Pipelines reference resolvable templates/rules',
      total,
      covered,
      score: pct(covered, total),
      missing,
    });
  }

  // 5. Presets — references resolve.
  {
    const refLookup = inspectionReferenceLookup(inspection);
    const presets = inspection.presetRegistry.list();
    const total = presets.length;
    const missing: string[] = [];
    let covered = 0;
    for (const p of presets) {
      const resolved = resolvePreset(inspection.presetRegistry, p.id);
      const refs = resolvePresetReferences(resolved, refLookup);
      if (refs.totalMissing === 0 && resolved.issues.length === 0) {
        covered += 1;
      } else {
        missing.push(
          `${p.id} — ${resolved.issues.length} composition issues, ${refs.totalMissing} missing refs`,
        );
      }
    }
    categories.push({
      id: 'preset-references',
      title: 'Presets compose + reference assets that resolve',
      total,
      covered,
      score: pct(covered, total),
      missing,
    });
  }

  // 6. Boundary rules — suggested fix present.
  {
    const rules = inspection.boundaryRegistry.list();
    const total = rules.length;
    const missing: string[] = [];
    let covered = 0;
    for (const r of rules) {
      if (typeof r.suggestedFix === 'string' && r.suggestedFix.trim().length > 0) covered += 1;
      else missing.push(`${r.id} — no suggestedFix`);
    }
    categories.push({
      id: 'boundary-fixes',
      title: 'Boundary rules ship a suggestedFix',
      total,
      covered,
      score: pct(covered, total),
      missing,
    });
  }

  // 7. Packs — at least one doc.
  {
    const packs = inspection.packs.discoveredPacks.filter((p) => p.valid);
    const total = packs.length;
    const missing: string[] = [];
    let covered = 0;
    for (const p of packs) {
      const docs = p.manifest?.contributions.docsFiles ?? [];
      if (docs.length > 0) covered += 1;
      else missing.push(`${p.packageName} — no docsFiles`);
    }
    categories.push({
      id: 'pack-docs',
      title: 'Packs ship at least one doc',
      total,
      covered,
      score: pct(covered, total),
      missing,
    });
  }

  // `overall` measures how well the USER has grounded THIS repo, so two kinds
  // of category must not inflate it:
  //   1. Empty categories (total === 0) — they vacuously score 100 (see `pct`),
  //      so a repo that just hasn't configured boundaries/packs would read as
  //      perfectly grounded and tell the agent to skip adding rules.
  //   2. `preset-references` — it scores the BUILT-IN preset registry's
  //      validity (≈72/72 always), not the user's configuration, so on an
  //      otherwise-empty repo it alone would peg the overall at 100.
  // Both stay as displayed categories; they're just out of the average.
  // 0 when nothing user-authored is configured (honest: no coverage to report).
  const scored = categories.filter((c) => c.total > 0 && c.id !== 'preset-references');
  const overall =
    scored.length > 0
      ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length)
      : 0;
  if (overall < 60) suggestions.push('Pair every critical rule with action hints + verification commands.');
  if (overall < 80) suggestions.push('Make templates declare related rules/paths (`template.related`).');

  return { categories, overall, suggestions };
}
