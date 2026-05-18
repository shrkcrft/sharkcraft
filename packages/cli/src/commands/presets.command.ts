import * as nodePath from 'node:path';
import { inspectSharkcraft, inspectionReferenceLookup } from '@shrkcrft/inspector';
import {
  applyPresetPlan,
  previewResolvedPresetApplication,
  recommendPresets,
  resolvePreset,
  resolvePresetReferences,
  type IPreset,
  type IPresetApplyPlan,
  type IResolvedPreset,
  type IResolvedReferences,
} from '@shrkcrft/presets';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

function compact(p: IPreset): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    tags: p.tags ?? [],
    appliesTo: p.appliesTo ?? [],
    weight: p.weight ?? 5,
    counts: {
      knowledge: p.includes.knowledge?.length ?? 0,
      rules: p.includes.rules?.length ?? 0,
      paths: p.includes.paths?.length ?? 0,
      templates: p.includes.templates?.length ?? 0,
      pipelines: p.includes.pipelines?.length ?? 0,
      docs: countKv(p.includes.docs),
      tasks: countKv(p.includes.tasks),
    },
  };
}

function countKv(
  v: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined,
): number {
  if (!v) return 0;
  if (v instanceof Map) return v.size;
  return Object.keys(v).length;
}

export const presetsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List built-in and discovered presets.',
  usage: 'shrk [--cwd <dir>] presets list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const presets = inspection.presetRegistry.list();
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson(
          presets.map((p) => ({
            ...compact(p),
            source: inspection.presetSources.get(p.id) ?? null,
          })),
        ) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Presets (${presets.length})`));
    for (const p of presets) {
      const src = inspection.presetSources.get(p.id);
      const srcLabel =
        src?.type === 'pack' ? `[pack:${src.packageName}]` : '[builtin]';
      process.stdout.write(
        `  ${p.id.padEnd(22)} ${srcLabel.padEnd(28)} ${p.title}\n`,
      );
      if (p.tags?.length) {
        process.stdout.write(`      tags=[${p.tags.join(', ')}]\n`);
      }
    }
    return 0;
  },
};

export const presetsGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show full details for one preset.',
  usage: 'shrk presets get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk presets get <id>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const preset = inspection.presetRegistry.get(id);
    if (!preset) {
      process.stderr.write(`No preset with id "${id}".\n`);
      return 1;
    }
    const resolved = resolvePreset(inspection.presetRegistry, id);
    const references = resolvePresetReferences(resolved, inspectionReferenceLookup(inspection));
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          preset,
          composedFrom: resolved.composedFrom,
          includes: resolved.includes,
          recommendedNextCommands: resolved.recommendedNextCommands,
          postInstallNotes: resolved.postInstallNotes,
          safetyNotes: resolved.safetyNotes,
          references,
          issues: resolved.issues,
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Preset: ${preset.id}`));
    process.stdout.write(kv('title', preset.title) + '\n');
    process.stdout.write(kv('description', preset.description) + '\n');
    process.stdout.write(kv('tags', (preset.tags ?? []).join(', ')) + '\n');
    process.stdout.write(
      kv('appliesTo', (preset.appliesTo ?? []).join(', ')) + '\n',
    );
    if (resolved.composedFrom.length > 1) {
      process.stdout.write(kv('composed from', resolved.composedFrom.join(' → ')) + '\n');
    }
    process.stdout.write('\nIncludes (after composition):\n');
    process.stdout.write(`  knowledge    ${resolved.includes.knowledge?.length ?? 0}\n`);
    process.stdout.write(`  rules        ${resolved.includes.rules?.length ?? 0}\n`);
    process.stdout.write(`  paths        ${resolved.includes.paths?.length ?? 0}\n`);
    process.stdout.write(`  templates    ${resolved.includes.templates?.length ?? 0}\n`);
    process.stdout.write(`  pipelines    ${resolved.includes.pipelines?.length ?? 0}\n`);
    if (
      resolved.includes.knowledgeIds?.length ||
      resolved.includes.ruleIds?.length ||
      resolved.includes.pathConventionIds?.length ||
      resolved.includes.templateIds?.length ||
      resolved.includes.pipelineIds?.length
    ) {
      process.stdout.write('\nReferences (existing assets, not embedded):\n');
      describeReferences(references);
      if (references.totalMissing > 0) {
        process.stdout.write(
          `\n${references.totalMissing} referenced id(s) are missing. Install the relevant pack or add them locally.\n`,
        );
      }
    }
    if (resolved.recommendedNextCommands.length) {
      process.stdout.write('\nRecommended next commands:\n');
      for (const cmd of resolved.recommendedNextCommands) {
        process.stdout.write(`  $ ${cmd}\n`);
      }
    }
    if (resolved.postInstallNotes.length) {
      process.stdout.write('\nPost-install notes:\n');
      for (const n of resolved.postInstallNotes) {
        process.stdout.write(`  • ${n}\n`);
      }
    }
    if (resolved.issues.length) {
      process.stdout.write('\nIssues:\n');
      for (const i of resolved.issues) {
        process.stdout.write(`  ${i.severity.toUpperCase()} ${i.code}: ${i.message}\n`);
      }
    }
    return 0;
  },
};

export const presetsExplainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'Explain why a preset exists and when to use it. Surfaces title, description, composition chain, the appliesTo profiles in natural language, the recommended next commands, and a short narrative pulled from the preset description.',
  usage: 'shrk presets explain <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk presets explain <id>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const preset = inspection.presetRegistry.get(id);
    if (!preset) {
      process.stderr.write(`No preset with id "${id}".\n`);
      return 1;
    }
    const resolved = resolvePreset(inspection.presetRegistry, id);
    const composedFrom = resolved.composedFrom.length > 1 ? resolved.composedFrom : [];
    const appliesNatural = (preset.appliesTo ?? []).map(humanizeProfile);
    const recs = recommendPresets(inspection.presetRegistry.list(), {
      profiles: inspection.workspace.profiles,
      limit: 5,
    });
    const recRank = recs.findIndex((r) => r.preset.id === preset.id);
    const recScore = recRank >= 0 ? recs[recRank]!.score : 0;
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          presetId: preset.id,
          title: preset.title,
          description: preset.description,
          tags: preset.tags ?? [],
          appliesTo: preset.appliesTo ?? [],
          appliesNatural,
          composedFrom,
          recommendedNextCommands: resolved.recommendedNextCommands,
          counts: {
            knowledge: resolved.includes.knowledge?.length ?? 0,
            rules: resolved.includes.rules?.length ?? 0,
            paths: resolved.includes.paths?.length ?? 0,
            templates: resolved.includes.templates?.length ?? 0,
            pipelines: resolved.includes.pipelines?.length ?? 0,
          },
          recommendationRank: recRank >= 0 ? recRank + 1 : null,
          recommendationScore: recScore,
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Preset explain: ${preset.id}`));
    process.stdout.write(`  ${preset.title}\n`);
    process.stdout.write(`  ${preset.description}\n\n`);
    if (preset.tags?.length) {
      process.stdout.write(`tags: ${preset.tags.join(', ')}\n`);
    }
    if (appliesNatural.length) {
      process.stdout.write('\nApplies when this repo:\n');
      for (const a of appliesNatural) process.stdout.write(`  • ${a}\n`);
    }
    if (composedFrom.length) {
      process.stdout.write('\nComposed from (lower layers applied first, this preset wins):\n');
      for (const c of composedFrom) process.stdout.write(`  → ${c}\n`);
    }
    process.stdout.write('\nWhat you get (after composition):\n');
    process.stdout.write(`  knowledge entries  ${resolved.includes.knowledge?.length ?? 0}\n`);
    process.stdout.write(`  rules              ${resolved.includes.rules?.length ?? 0}\n`);
    process.stdout.write(`  path conventions   ${resolved.includes.paths?.length ?? 0}\n`);
    process.stdout.write(`  templates          ${resolved.includes.templates?.length ?? 0}\n`);
    process.stdout.write(`  pipelines          ${resolved.includes.pipelines?.length ?? 0}\n`);
    if (resolved.recommendedNextCommands.length) {
      process.stdout.write('\nNext after applying:\n');
      for (const c of resolved.recommendedNextCommands) process.stdout.write(`  $ ${c}\n`);
    }
    if (recRank >= 0) {
      process.stdout.write(
        `\nFor this repo: rank ${recRank + 1} of ${recs.length} (score ${recScore}).\n`,
      );
    } else {
      process.stdout.write(
        '\nFor this repo: not currently recommended — pass `--preset ' + preset.id + '` to apply explicitly.\n',
      );
    }
    return 0;
  },
};

function humanizeProfile(profile: string): string {
  // Map WorkspaceProfile string values back to a short natural-language
  // clause. Keep the mapping local — adding new profiles to the engine
  // shouldn't break this command; unknown profiles fall through verbatim.
  const map: Record<string, string> = {
    'has-typescript': 'uses TypeScript',
    'has-bun': 'uses Bun',
    'has-nx': 'is an Nx workspace',
    'has-turborepo': 'is a Turborepo workspace',
    'has-package-workspaces': 'uses package workspaces (npm/pnpm/yarn)',
    'has-react': 'uses React',
    'has-next': 'uses Next.js',
    'has-angular': 'uses Angular',
    'has-vue': 'uses Vue',
    'has-nestjs': 'uses NestJS',
    'has-mcp-sdk': 'depends on the MCP SDK',
    'has-tests': 'has a test runner',
    'has-eslint': 'uses ESLint',
    'has-biome': 'uses Biome',
    'has-github-actions': 'has GitHub Actions',
    'is-library': 'is published as a library',
    'is-service': 'runs as a service',
    'is-monorepo': 'is a monorepo',
    'is-frontend': 'is a frontend',
    'is-backend': 'is a backend',
  };
  return map[profile] ?? profile;
}

export const presetsRecommendCommand: ICommandHandler = {
  name: 'recommend',
  description: 'Recommend presets based on the detected project profile.',
  usage: 'shrk [--cwd <dir>] presets recommend [--limit N] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const limitFlag = args.flags.get('limit');
    const limit = typeof limitFlag === 'string' ? Number(limitFlag) || 5 : 5;
    const recs = recommendPresets(inspection.presetRegistry.list(), {
      profiles: inspection.workspace.profiles,
      limit,
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          detectedProfiles: inspection.workspace.profiles,
          recommendations: recs.map((r) => ({
            preset: compact(r.preset),
            score: r.score,
            confidence: r.confidence,
            reasons: r.reasons,
          })),
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header('Preset recommendations'));
    process.stdout.write(
      kv('detected profiles', inspection.workspace.profiles.join(', ') || '(none)') + '\n\n',
    );
    if (recs.length === 0) {
      process.stdout.write('No matching presets — try `shrk presets list`.\n');
      return 0;
    }
    for (const r of recs) {
      process.stdout.write(
        `  ${r.preset.id.padEnd(22)} confidence=${r.confidence.padEnd(6)} score=${r.score}\n`,
      );
      for (const reason of r.reasons) {
        process.stdout.write(`      • ${reason}\n`);
      }
    }
    return 0;
  },
};

function describePlan(plan: IPresetApplyPlan, force: boolean, merge: boolean): string {
  const lines: string[] = [];
  lines.push(`Plan for ${plan.presetId} → ${plan.sharkcraftDir}`);
  if (force) lines.push('  mode: --force (will overwrite existing files)');
  else if (merge) lines.push('  mode: --merge (append to existing where supported)');
  else lines.push('  mode: default (skip existing files)');
  lines.push('');
  for (const e of plan.entries) {
    const tag =
      e.status === 'create'
        ? 'CREATE       '
        : e.status === 'overwrite-with-force'
          ? 'OVERWRITE    '
          : e.status === 'merge-additive'
            ? 'APPEND       '
            : 'SKIP-EXISTING';
    lines.push(`  ${tag} ${e.relPath}`);
  }
  if (plan.warnings.length) {
    lines.push('');
    for (const w of plan.warnings) lines.push(`  WARN  ${w}`);
  }
  return lines.join('\n');
}

export const presetsPreviewCommand: ICommandHandler = {
  name: 'preview',
  description: 'Preview the files a preset would write into the target sharkcraft/ folder.',
  usage:
    'shrk [--cwd <dir>] presets preview <id> [--force] [--merge] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk presets preview <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const preset = inspection.presetRegistry.get(id);
    if (!preset) {
      process.stderr.write(`No preset with id "${id}".\n`);
      return 1;
    }
    const force = flagBool(args, 'force');
    const merge = flagBool(args, 'merge');
    const resolved = resolvePreset(inspection.presetRegistry, id);
    const references = resolvePresetReferences(resolved, inspectionReferenceLookup(inspection));
    const plan = previewResolvedPresetApplication(resolved, { projectRoot: cwd, force, merge });
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          composedFrom: resolved.composedFrom,
          issues: resolved.issues,
          references,
          plan,
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Preset preview: ${id}`));
    if (resolved.composedFrom.length > 1) {
      process.stdout.write(kv('composed from', resolved.composedFrom.join(' → ')) + '\n');
    }
    if (resolved.issues.length) {
      for (const i of resolved.issues) {
        process.stdout.write(`  ${i.severity.toUpperCase()} ${i.code}: ${i.message}\n`);
      }
    }
    process.stdout.write(describePlan(plan, force, merge) + '\n');
    if (references.totalReferenced > 0) {
      process.stdout.write('\nReferenced assets (resolved against current inspection):\n');
      describeReferences(references);
    }
    process.stdout.write('\nRe-run with `shrk presets apply ' + id + ' --write` to write.\n');
    return 0;
  },
};

function describeReferences(refs: IResolvedReferences): void {
  for (const [label, group] of [
    ['knowledge', refs.knowledge],
    ['rules', refs.rules],
    ['paths', refs.paths],
    ['templates', refs.templates],
    ['pipelines', refs.pipelines],
  ] as const) {
    if (!group.resolved.length && !group.missing.length) continue;
    process.stdout.write(`  ${label}:\n`);
    for (const id of group.resolved) process.stdout.write(`    OK      ${id}\n`);
    for (const id of group.missing) process.stdout.write(`    MISSING ${id}\n`);
  }
}

export const presetsApplyCommand: ICommandHandler = {
  name: 'apply',
  description:
    'Apply a preset to the target repo. Dry-run by default; pass --write to persist. Never overwrites existing files unless --force; --merge appends to mergable files.',
  usage:
    'shrk [--cwd <dir>] presets apply <id> [--write] [--force] [--merge] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk presets apply <id> [--write]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const preset = inspection.presetRegistry.get(id);
    if (!preset) {
      process.stderr.write(`No preset with id "${id}".\n`);
      return 1;
    }
    const force = flagBool(args, 'force');
    const merge = flagBool(args, 'merge');
    const write = flagBool(args, 'write');
    const resolved = resolvePreset(inspection.presetRegistry, id);
    if (resolved.issues.some((i) => i.severity === 'error')) {
      process.stderr.write('Refusing to apply: composition errors:\n');
      for (const i of resolved.issues) {
        process.stderr.write(`  ${i.severity.toUpperCase()} ${i.code}: ${i.message}\n`);
      }
      return 1;
    }
    const plan = previewResolvedPresetApplication(resolved, { projectRoot: cwd, force, merge });

    if (flagBool(args, 'json')) {
      if (!write) {
        process.stdout.write(asJson({ mode: 'dry-run', plan }) + '\n');
        return 0;
      }
      const result = applyPresetPlan(plan);
      process.stdout.write(asJson({ mode: 'write', plan, result }) + '\n');
      return 0;
    }

    process.stdout.write(header(`Preset apply: ${id}`));
    process.stdout.write(describePlan(plan, force, merge) + '\n');

    if (!write) {
      process.stdout.write('\nDry-run — re-run with --write to persist.\n');
      return 0;
    }
    const result = applyPresetPlan(plan);
    process.stdout.write(`\nWrote ${result.written.length} file(s).\n`);
    for (const p of result.written) {
      process.stdout.write(`  + ${p}\n`);
    }
    if (result.skipped.length) {
      process.stdout.write('\nSkipped:\n');
      for (const p of result.skipped) {
        process.stdout.write(`  - ${p}\n`);
      }
    }
    if (preset.recommendedNextCommands?.length) {
      process.stdout.write('\nNext:\n');
      for (const cmd of preset.recommendedNextCommands) {
        process.stdout.write(`  $ ${cmd}\n`);
      }
    }
    return 0;
  },
};

export const presetsDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description:
    'Check whether the current repo matches a preset baseline (missing files / entries / templates / pipelines).',
  usage: 'shrk [--cwd <dir>] presets doctor <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk presets doctor <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const preset = inspection.presetRegistry.get(id);
    if (!preset) {
      process.stderr.write(`No preset with id "${id}".\n`);
      return 1;
    }
    const resolved = resolvePreset(inspection.presetRegistry, id);
    const references = resolvePresetReferences(resolved, inspectionReferenceLookup(inspection));
    const plan = previewResolvedPresetApplication(resolved, { projectRoot: cwd });
    const missing = plan.entries
      .filter((e) => e.status === 'create')
      .map((e) => e.relPath);
    const present = plan.entries
      .filter((e) => e.status !== 'create')
      .map((e) => e.relPath);

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          presetId: preset.id,
          missing,
          present,
          references,
          issues: resolved.issues,
          conforms: missing.length === 0 && references.totalMissing === 0,
        }) + '\n',
      );
      return missing.length === 0 && references.totalMissing === 0 ? 0 : 1;
    }
    process.stdout.write(header(`Preset doctor: ${preset.id}`));
    process.stdout.write(kv('present files', String(present.length)) + '\n');
    process.stdout.write(kv('missing files', String(missing.length)) + '\n');
    if (references.totalReferenced > 0) {
      process.stdout.write(
        kv('referenced ids', `${references.totalReferenced - references.totalMissing}/${references.totalReferenced}`) + '\n',
      );
    }
    process.stdout.write('\n');
    for (const m of missing) process.stdout.write(`  MISSING file ${m}\n`);
    for (const m of references.missing) {
      process.stdout.write(`  MISSING ${m.kind.padEnd(8)} ${m.id}\n`);
    }
    for (const i of resolved.issues) {
      process.stdout.write(`  ${i.severity.toUpperCase().padEnd(8)} ${i.code}: ${i.message}\n`);
    }
    const conforms = missing.length === 0 && references.totalMissing === 0 && resolved.issues.length === 0;
    process.stdout.write(
      `\nVerdict: ${conforms ? 'matches ✓' : `not conforming — run \`shrk presets patch ${preset.id} --write\``}\n`,
    );
    return conforms ? 0 : 1;
  },
};

/**
 * `shrk presets diff <id>` — show what's missing compared to a preset. Dry-run
 * preview; never writes. `shrk presets patch <id> --write` writes only the
 * missing pieces (existing files untouched).
 */
function buildDiff(
  resolved: IResolvedPreset,
  references: IResolvedReferences,
  plan: IPresetApplyPlan,
): {
  missingFiles: string[];
  existingFiles: string[];
  conflictFiles: string[];
  missingKnowledgeIds: string[];
  missingRuleIds: string[];
  missingPathIds: string[];
  missingTemplateIds: string[];
  missingPipelineIds: string[];
  composedFrom: readonly string[];
} {
  return {
    missingFiles: plan.entries.filter((e) => e.status === 'create').map((e) => e.relPath),
    existingFiles: plan.entries.filter((e) => e.status === 'skip-existing').map((e) => e.relPath),
    conflictFiles: plan.entries.filter((e) => e.status === 'overwrite-with-force').map((e) => e.relPath),
    missingKnowledgeIds: [...references.knowledge.missing],
    missingRuleIds: [...references.rules.missing],
    missingPathIds: [...references.paths.missing],
    missingTemplateIds: [...references.templates.missing],
    missingPipelineIds: [...references.pipelines.missing],
    composedFrom: resolved.composedFrom,
  };
}

export const presetsDiffCommand: ICommandHandler = {
  name: 'diff',
  description:
    'Show what the current repo is missing compared to a preset. Always read-only — pair with `shrk presets patch` to write the missing pieces.',
  usage: 'shrk [--cwd <dir>] presets diff <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk presets diff <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    if (!inspection.presetRegistry.has(id)) {
      process.stderr.write(`No preset with id "${id}".\n`);
      return 1;
    }
    const resolved = resolvePreset(inspection.presetRegistry, id);
    const references = resolvePresetReferences(resolved, inspectionReferenceLookup(inspection));
    const plan = previewResolvedPresetApplication(resolved, { projectRoot: cwd });
    const diff = buildDiff(resolved, references, plan);

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ presetId: id, diff }) + '\n');
      return 0;
    }

    process.stdout.write(header(`Preset diff: ${id}`));
    if (diff.composedFrom.length > 1) {
      process.stdout.write(kv('composed from', diff.composedFrom.join(' → ')) + '\n');
    }
    process.stdout.write(
      kv(
        'summary',
        `missing files=${diff.missingFiles.length}, existing files=${diff.existingFiles.length}, missing refs=${
          diff.missingKnowledgeIds.length +
          diff.missingRuleIds.length +
          diff.missingPathIds.length +
          diff.missingTemplateIds.length +
          diff.missingPipelineIds.length
        }`,
      ) + '\n\n',
    );
    if (diff.missingFiles.length) {
      process.stdout.write('Missing files:\n');
      for (const p of diff.missingFiles) process.stdout.write(`  + ${p}\n`);
      process.stdout.write('\n');
    }
    if (diff.existingFiles.length) {
      process.stdout.write('Existing (preset would skip):\n');
      for (const p of diff.existingFiles) process.stdout.write(`  = ${p}\n`);
      process.stdout.write('\n');
    }
    const groups: [string, string[]][] = [
      ['missing knowledge ids', diff.missingKnowledgeIds],
      ['missing rule ids', diff.missingRuleIds],
      ['missing path ids', diff.missingPathIds],
      ['missing template ids', diff.missingTemplateIds],
      ['missing pipeline ids', diff.missingPipelineIds],
    ];
    for (const [label, ids] of groups) {
      if (!ids.length) continue;
      process.stdout.write(`${label}:\n`);
      for (const id2 of ids) process.stdout.write(`  - ${id2}\n`);
      process.stdout.write('\n');
    }
    const conforms =
      diff.missingFiles.length === 0 &&
      diff.missingKnowledgeIds.length === 0 &&
      diff.missingRuleIds.length === 0 &&
      diff.missingPathIds.length === 0 &&
      diff.missingTemplateIds.length === 0 &&
      diff.missingPipelineIds.length === 0;
    process.stdout.write(
      conforms
        ? 'Verdict: repo matches preset ✓\n'
        : `Verdict: run \`shrk presets patch ${id} --write\` to write the missing pieces.\n`,
    );
    return conforms ? 0 : 1;
  },
};

/**
 * `shrk presets patch <id>` — write only the missing pieces. Dry-run by default;
 * `--write` persists. Never overwrites existing files (use `presets apply --force`
 * for that).
 */
export const presetsPatchCommand: ICommandHandler = {
  name: 'patch',
  description:
    'Write only the missing files from a preset (never overwrites existing files). Dry-run by default; --write persists.',
  usage: 'shrk [--cwd <dir>] presets patch <id> [--write] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk presets patch <id> [--write]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    if (!inspection.presetRegistry.has(id)) {
      process.stderr.write(`No preset with id "${id}".\n`);
      return 1;
    }
    const write = flagBool(args, 'write');
    const resolved = resolvePreset(inspection.presetRegistry, id);
    const plan = previewResolvedPresetApplication(resolved, { projectRoot: cwd });
    // Filter to only create-status entries (true patch — never touches existing).
    const patchPlan: IPresetApplyPlan = {
      ...plan,
      entries: plan.entries.filter((e) => e.status === 'create'),
    };

    if (flagBool(args, 'json')) {
      if (!write) {
        process.stdout.write(asJson({ mode: 'dry-run', plan: patchPlan }) + '\n');
        return 0;
      }
      const result = applyPresetPlan(patchPlan);
      process.stdout.write(asJson({ mode: 'write', plan: patchPlan, result }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Preset patch: ${id}`));
    if (patchPlan.entries.length === 0) {
      process.stdout.write('Nothing to patch — repo already matches.\n');
      return 0;
    }
    for (const e of patchPlan.entries) process.stdout.write(`  + ${e.relPath}\n`);
    if (!write) {
      process.stdout.write('\nDry-run — re-run with --write to persist.\n');
      return 0;
    }
    const result = applyPresetPlan(patchPlan);
    process.stdout.write(`\nWrote ${result.written.length} file(s).\n`);
    return 0;
  },
};

// Re-export the suggested-cwd helper for tests that don't want to spin up the
// real CLI.
export function _presetSuggestedTargetRoot(cwd: string): string {
  return nodePath.resolve(cwd);
}
