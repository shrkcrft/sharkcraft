/**
 * Validate ONE contribution file at build time through the SAME loader — or
 * THE acceptance predicate the loader applies — that the engine runs at load
 * (round 12, 12.1c / 12.1f). `shrk packs test --load` used to check only that
 * each entry of 8 slots carried a string `id`, so a convention missing its
 * required `severity` passed the build and then vanished at load.
 *
 *   - knowledge / rules / paths / path conventions / docs, templates,
 *     pipelines, presets, boundary rules, scaffold patterns — the loader
 *     function itself (each returns its `rejected` entries);
 *   - the registry kinds (conventions, helpers, hints, playbooks, constructs,
 *     …) — THE export reading (`readContributionExport`) and THE per-kind
 *     predicate the registry loader calls (`<kind>RejectionReasons`), plus the
 *     loader's own duplicate-id refusal within the file;
 *   - the gate planes — THE merge seam's schema + shell veto
 *     (`packPlaneElementRejectionReasons`);
 *   - framework extractors — THE shared reading + shape predicate.
 *
 * What only a consuming repository can decide (a duplicate across files or
 * packs, a facet's target construct, a `$use` extractor reference) is judged
 * at load, not here.
 */
import { existsSync } from 'node:fs';
import { importModuleViaLoader, readContributionExport, RejectionCause, type IRejectedEntry } from '@shrkcrft/core';
import { MarkdownKnowledgeLoader, TypeScriptKnowledgeLoader } from '@shrkcrft/knowledge';
import { loadTemplatesFromFile } from '@shrkcrft/templates';
import { loadPipelinesFromFile } from '@shrkcrft/pipelines';
import { loadPresetsFromFile } from '@shrkcrft/presets';
import { loadBoundaryRulesFromFile } from '@shrkcrft/boundaries';
import { frameworkExtractorExports, frameworkExtractorRejectionReasons } from '@shrkcrft/plugin-api';
import { constructFacetRejectionReasons, constructRejectionReasons } from './construct-registry.ts';
import { contractTemplateRejectionReasons } from './contract-template-registry.ts';
import { conventionRejectionReasons } from './convention-registry.ts';
import { decisionRejectionReasons } from './decision-records.ts';
import { delegateRecipeRejectionReasons } from './delegate-pack-recipes.ts';
import { feedbackRuleRejectionReasons } from './feedback-ingestion.ts';
import type { IContributionFileValidation } from './i-contribution-file-validation.ts';
import { migrationProfileRejectionReasons } from './migration-profile-registry.ts';
import { packHelperRejectionReasons } from './pack-helper-registry.ts';
import { contributionKindForSlot } from './pack-contributions-inventory.ts';
import { playbookRejectionReasons } from './playbook-registry.ts';
import { policyCheckRejectionReasons } from './policy-registry.ts';
import { registrationHintRejectionReasons } from './registration-hint-registry.ts';
import { packPlaneElementRejectionReasons, planeElementKey } from './resolve-project-config.ts';
import { loadScaffoldPatternsFromFile } from './scaffold-patterns.ts';
import { searchTuningRejectionReasons } from './search-tuning-registry.ts';
import { routingHintRejectionReasons } from './task-routing-hint-registry.ts';
import { testDefinitionRejectionReasons } from './test-runner.ts';

/** How a registry slot's module is read, and THE predicate its loader applies. */
interface IRegistrySlotSpec {
  readonly namedKeys?: readonly string[];
  readonly singleObject?: boolean;
  readonly reasons: (raw: unknown) => readonly string[];
  /** The loader refuses a second entry reusing an id (within this file, the refusal is decidable here). */
  readonly dedupe?: boolean;
}

const REGISTRY_SLOTS: Readonly<Record<string, IRegistrySlotSpec>> = {
  conventionFiles: { namedKeys: ['conventions'], reasons: conventionRejectionReasons, dedupe: true },
  helperFiles: { namedKeys: ['helpers'], reasons: packHelperRejectionReasons, dedupe: true },
  taskRoutingHintFiles: { namedKeys: ['taskRoutingHints'], reasons: routingHintRejectionReasons, dedupe: true },
  registrationHintFiles: { namedKeys: ['registrationHints'], reasons: registrationHintRejectionReasons, dedupe: true },
  contractTemplateFiles: { namedKeys: ['contractTemplates'], reasons: contractTemplateRejectionReasons, dedupe: true },
  migrationProfileFiles: { namedKeys: ['migrationProfiles'], reasons: migrationProfileRejectionReasons, dedupe: true },
  playbookFiles: { namedKeys: ['playbooks'], reasons: playbookRejectionReasons },
  constructFiles: { namedKeys: ['constructs'], reasons: constructRejectionReasons },
  constructFacetFiles: { namedKeys: ['constructs'], reasons: constructFacetRejectionReasons },
  searchTuningFiles: { namedKeys: ['searchTuning'], reasons: searchTuningRejectionReasons },
  decisionFiles: { singleObject: false, reasons: decisionRejectionReasons, dedupe: true },
  policyCheckFiles: { namedKeys: ['policyChecks'], singleObject: false, reasons: policyCheckRejectionReasons },
  feedbackRuleFiles: { singleObject: false, reasons: feedbackRuleRejectionReasons, dedupe: true },
  contextTestFiles: { singleObject: false, reasons: testDefinitionRejectionReasons },
  agentTestFiles: { singleObject: false, reasons: testDefinitionRejectionReasons },
  delegateRecipeFiles: { namedKeys: ['delegateRecipes'], reasons: delegateRecipeRejectionReasons, dedupe: true },
};

const KNOWLEDGE_SLOTS: ReadonlySet<string> = new Set([
  'knowledgeFiles',
  'ruleFiles',
  'pathFiles',
  'pathConventionFiles',
  'docsFiles',
]);

const GATE_PLANE_SLOTS: ReadonlySet<string> = new Set([
  'wiringRuleFiles',
  'registryFiles',
  'registrationGraphFiles',
  'policyRuleFiles',
  'reusePrimitiveFiles',
  'baselineFiles',
  'generatedArtifactFiles',
  'docReferenceFiles',
]);

/** The import-failure line an inspection-time loader reports as a warning. */
function importError(warnings: readonly string[]): string | undefined {
  return warnings.find((w) => /^(failed to (?:import|load)|timed out)/i.test(w));
}

function idOf(raw: unknown, field: 'id' | 'framework' = 'id'): string | undefined {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[field] : undefined;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Validate `file`, declared under manifest `slot`. */
export async function validateContributionFile(slot: string, file: string): Promise<IContributionFileValidation> {
  const kind = contributionKindForSlot(slot);
  const base = { slot, file, ...(kind ? { kind } : {}) };
  const done = (
    accepted: readonly string[],
    rejected: readonly IRejectedEntry[],
    loadError?: string,
  ): IContributionFileValidation => ({
    ...base,
    loaded: loadError === undefined,
    ...(loadError !== undefined ? { loadError } : {}),
    accepted: accepted.length,
    acceptedIds: accepted,
    rejected,
  });
  if (!existsSync(file)) return done([], [], 'the file does not exist');

  if (KNOWLEDGE_SLOTS.has(slot)) {
    const ts = new TypeScriptKnowledgeLoader();
    const md = new MarkdownKnowledgeLoader();
    const loader = ts.canLoad(file) ? ts : md.canLoad(file) ? md : null;
    if (!loader) return { ...done([], []), unvalidated: true };
    const r = await loader.load(file);
    return done(r.entries.map((e) => e.id), r.rejected ?? [], importError(r.warnings));
  }
  if (slot === 'templateFiles') {
    const r = await loadTemplatesFromFile(file);
    return done(r.templates.map((t) => t.id), r.rejected, importError(r.warnings));
  }
  if (slot === 'pipelineFiles') {
    const r = await loadPipelinesFromFile(file);
    return done(r.pipelines.map((p) => p.id), r.rejected, importError(r.warnings));
  }
  if (slot === 'presetFiles') {
    const r = await loadPresetsFromFile(file);
    return done(r.presets.map((p) => p.id), r.rejected, importError(r.warnings));
  }
  if (slot === 'boundaryFiles') {
    const r = await loadBoundaryRulesFromFile(file);
    const rejected: IRejectedEntry[] = r.invalid.map((inv) => ({
      file,
      index: inv.index,
      // The export the rule array came from — `(default[1])`, one wording with every kind.
      ...(inv.exportName !== undefined ? { exportName: inv.exportName } : {}),
      ...(inv.ruleId !== undefined ? { entryId: inv.ruleId } : {}),
      reasons: inv.issues.map((i) => `${i.field}: ${i.message}`),
      cause: RejectionCause.Invalid,
    }));
    return done(r.rules.map((x) => x.id), rejected, r.loadError);
  }
  if (slot === 'scaffoldPatternFiles') {
    const r = await loadScaffoldPatternsFromFile(file);
    return done(r.patterns.map((p) => p.id), r.rejected, importError(r.warnings));
  }

  let mod: unknown;
  try {
    mod = await importModuleViaLoader(file);
  } catch (e) {
    return done([], [], ((e as Error).message ?? String(e)).split('\n')[0]!.trim());
  }

  if (GATE_PLANE_SLOTS.has(slot)) {
    const arr = (mod as { default?: unknown }).default;
    if (!Array.isArray(arr)) return done([], [], 'default export is not an array');
    const accepted: string[] = [];
    const rejected: IRejectedEntry[] = [];
    arr.forEach((raw: unknown, index: number) => {
      const reasons = packPlaneElementRejectionReasons(slot, raw) ?? [];
      // THE element-id reading the merge seam names a refused element by.
      const id = planeElementKey(raw);
      if (reasons.length > 0) {
        rejected.push({
          file,
          index,
          exportName: 'default',
          ...(id !== undefined ? { entryId: id } : {}),
          reasons,
          cause: RejectionCause.Invalid,
        });
        return;
      }
      accepted.push(id ?? `default[${index}]`);
    });
    return done(accepted, rejected);
  }

  if (slot === 'frameworkExtractorFiles') {
    const accepted: string[] = [];
    const rejected: IRejectedEntry[] = [];
    const seen = new Set<string>();
    for (const c of frameworkExtractorExports(mod)) {
      const reasons = frameworkExtractorRejectionReasons(c.value);
      const name = idOf(c.value, 'framework');
      const at = { file, index: c.index, exportName: c.exportName, ...(name ? { entryId: name } : {}) };
      if (reasons.length > 0) {
        rejected.push({ ...at, reasons, cause: RejectionCause.Invalid });
      } else if (seen.has(name!)) {
        rejected.push({ ...at, reasons: [`framework: "${name}" is already registered in this file`], cause: RejectionCause.DuplicateId });
      } else {
        seen.add(name!);
        accepted.push(name!);
      }
    }
    return done(accepted, rejected);
  }

  const spec = REGISTRY_SLOTS[slot];
  if (!spec) return { ...done([], []), unvalidated: true };
  const exp = readContributionExport(mod, {
    ...(spec.namedKeys ? { namedKeys: spec.namedKeys } : {}),
    ...(spec.singleObject === false ? { singleObject: false } : {}),
  });
  const accepted: string[] = [];
  const rejected: IRejectedEntry[] = [];
  const seen = new Set<string>();
  exp.items.forEach((raw, i) => {
    const id = idOf(raw);
    const at = {
      file,
      index: exp.single ? -1 : i,
      ...(exp.exportName ? { exportName: exp.exportName } : {}),
      ...(id ? { entryId: id } : {}),
    };
    const reasons = spec.reasons(raw);
    if (reasons.length > 0) {
      rejected.push({ ...at, reasons, cause: RejectionCause.Invalid });
      return;
    }
    if (spec.dedupe && id && seen.has(id)) {
      rejected.push({ ...at, reasons: [`id: "${id}" is already declared in this file`], cause: RejectionCause.DuplicateId });
      return;
    }
    if (id) seen.add(id);
    accepted.push(id ?? `${exp.exportName ?? 'default'}[${i}]`);
  });
  return done(accepted, rejected);
}
