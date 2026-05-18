/**
 * `shrk spec` surface.
 *
 *   - `spec create "<title>"` — ground a new spec under .sharkcraft/specs/.
 *   - `spec review <id>`      — structural + cross-registry validation.
 *   - `spec implement <id>`   — compose proposedTemplates into a signed plan.
 *   - `spec verify <id>`      — run trusted verification commands + checks.
 *   - `spec list`             — list every spec.
 *   - `spec show <id>`        — print spec contents.
 *   - `spec status <id>`      — read/transition status.
 *   - `spec lint <id>`        — fast structural-only lint.
 *
 * Preview-first everywhere. `--write` / `--apply` opt-in.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  appendSpecEvent,
  buildSavedPlan,
  buildSpecId,
  canonicalJson,
  deriveSpecJson,
  FileChangeType,
  generate,
  listSpecIds,
  loadSpec,
  OverwriteStrategy,
  persistSpecArtifacts,
  PLAN_SECRET_ENV,
  readSpecEvents,
  readSpecJson,
  renderSpecMd,
  savePlanToFile,
  signPlan,
  specDir,
  specJsonPath,
  specMdPath,
  specPlanPath,
  specVerificationPath,
  splitSpecMd,
  SPEC_SCHEMA_V1,
  SpecStatus,
  validateSpecStructural,
  verifyPlan,
  writeSpecJson,
  writeSpecMd,
  type IGenerationPlan,
  type ISavedPlan,
  type ISavedPlanExpectedChange,
  type ISpecJson,
  type ISpecProposedTemplate,
} from '@shrkcrft/generator';
import {
  AssetKind,
  AssetProvenanceOperation,
  AssetProvenanceSource,
  buildSpecList,
  buildSpecReview,
  buildTaskPacket,
  inspectSharkcraft,
  recordProvenance,
  SPEC_LIST_SCHEMA,
  type ISharkcraftInspection,
  type ISpecListReport,
  type ISpecReviewReport,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagList,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { collectChangedPaths } from '../diff/collect-changed-paths.ts';
import { asJson, header } from '../output/format-output.ts';
// Bonus DX item — `spec implement --apply` now dispatches into
// applyCommand instead of asking the user to run apply separately.
import { applyCommand } from './apply.command.ts';

const DEFAULT_RELATED_LIMIT = 5;

export const SPEC_IMPLEMENT_SCHEMA = 'sharkcraft.spec-implement/v1';
export const SPEC_VERIFICATION_SCHEMA = 'sharkcraft.spec-verification/v1';

interface ISpecCreatePreview {
  readonly schema: typeof SPEC_SCHEMA_V1;
  readonly preview: true;
  readonly id: string;
  readonly path: string;
  readonly md: string;
  readonly spec: ISpecJson;
  readonly written: boolean;
}

export const specCreateCommand: ICommandHandler = {
  name: 'create',
  description:
    "Scaffold a grounded spec under .sharkcraft/specs/<id>/. Preview-only by default; pass --write to land. The engine fills the grounding fields (relevantRules / Knowledge / Paths / Templates / VerificationCommands); the human or agent fills the intent / motivation / acceptance.",
  usage:
    'shrk spec create "<title>" [--slug <slug>] [--write] [--issue <url>] [--related-knowledge <id,..>] [--related-rule <id,..>] [--related-path <id,..>] [--template <id,..>] [--limit 5] [--force] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const title = args.positional[0];
    if (!title || title.trim().length === 0) {
      process.stderr.write('Usage: shrk spec create "<title>" [--write]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const slugOverride = flagString(args, 'slug');
    const existing = listSpecIds(cwd);
    const built = buildSpecId({
      title,
      ...(slugOverride !== undefined ? { slug: slugOverride } : {}),
      existingIds: existing,
    });
    const limit = parseLimit(flagString(args, 'limit')) ?? DEFAULT_RELATED_LIMIT;
    const force = flagBool(args, 'force');

    const cliRelatedKnowledge = flagList(args, 'related-knowledge');
    const cliRelatedRules = flagList(args, 'related-rule');
    const cliRelatedPaths = flagList(args, 'related-path');
    const cliTemplates = flagList(args, 'template');

    let relatedRules = cliRelatedRules;
    let relatedKnowledge = cliRelatedKnowledge;
    let relatedPaths = cliRelatedPaths;
    let proposedTemplates: ISpecProposedTemplate[] = [];

    if (relatedRules.length === 0 || relatedKnowledge.length === 0 || relatedPaths.length === 0 || cliTemplates.length === 0) {
      const packet = buildTaskPacket(inspection, title, { maxTokens: 1500 });
      if (relatedRules.length === 0) {
        relatedRules = packet.relevantRules.slice(0, limit).map((r) => r.id);
      }
      if (relatedKnowledge.length === 0) {
        // Pull top-N knowledge ids from the same packet ranker.
        relatedKnowledge = inspection.knowledgeEntries
          .slice(0, limit)
          .map((k) => k.id);
      }
      if (relatedPaths.length === 0) {
        relatedPaths = packet.relevantPaths.slice(0, limit).map((p) => p.id);
      }
      if (cliTemplates.length === 0) {
        proposedTemplates = packet.relevantTemplates.slice(0, 1).map((t) => ({
          templateId: t.id,
          variables: {},
        }));
      }
    }
    if (cliTemplates.length > 0) {
      proposedTemplates = cliTemplates.map((id) => ({ templateId: id, variables: {} }));
    }

    // Unknown id refusal (any explicit flag must resolve).
    const ruleIds = new Set(inspection.ruleService.list().map((r) => r.id));
    const pathIds = new Set(inspection.pathService.list().map((p) => p.id));
    const knowledgeIds = new Set(inspection.knowledgeEntries.map((k) => k.id));
    const templateIds = new Set(inspection.templates.map((t) => t.id));
    for (const id of cliRelatedRules) {
      if (!ruleIds.has(id)) return reject(`unknown rule id "${id}"`);
    }
    for (const id of cliRelatedKnowledge) {
      if (!knowledgeIds.has(id)) return reject(`unknown knowledge id "${id}"`);
    }
    for (const id of cliRelatedPaths) {
      if (!pathIds.has(id)) return reject(`unknown path id "${id}"`);
    }
    for (const id of cliTemplates) {
      if (!templateIds.has(id)) return reject(`unknown template id "${id}"`);
    }

    const verificationCommandIds = (inspection.config?.verificationCommands ?? [])
      .filter((c) => c.trusted !== false)
      .map((c) => c.id);

    const issue = flagString(args, 'issue') ?? null;
    const now = new Date().toISOString();
    const md = renderSpecMd({
      id: built.id,
      slug: built.slug,
      title,
      createdAt: now,
      updatedAt: now,
      issue,
      relevantRules: relatedRules,
      relevantKnowledge: relatedKnowledge,
      relevantPaths: relatedPaths,
      affectedPackages: [],
      proposedTemplates,
      verificationCommandIds,
    });
    const split = splitSpecMd(md);
    if (!split.ok) {
      process.stderr.write(`Internal error: scaffolded spec did not parse: ${split.error.message}\n`);
      return 1;
    }
    const derived = deriveSpecJson(split.value);
    if (!derived.ok) {
      process.stderr.write(`Internal error: scaffolded spec did not derive: ${derived.error.message}\n`);
      return 1;
    }

    const wantWrite = flagBool(args, 'write');
    const targetDir = specDir(cwd, built.id);
    if (wantWrite && existsSync(targetDir) && !force) {
      process.stderr.write(
        `Spec ${built.id} already exists at ${targetDir}. Re-run with --force to overwrite, or `+
          `pick a different slug.\n`,
      );
      return 1;
    }

    let written = false;
    if (wantWrite) {
      const res = persistSpecArtifacts({ projectRoot: cwd, id: built.id, md, json: derived.value });
      if (!res.ok) {
        process.stderr.write(`Failed to write spec: ${res.error.message}\n`);
        return 1;
      }
      written = true;
      appendSpecEvent(cwd, built.id, {
        operation: 'create',
        details: { title, slug: built.slug },
      });
      recordProvenance({
        projectRoot: cwd,
        entry: {
          operation: AssetProvenanceOperation.Add,
          assetKind: 'spec',
          assetId: built.id,
          source: AssetProvenanceSource.Cli,
          reason: 'shrk spec create',
          ...(issue !== null ? { extra: { issue } } : {}),
        },
      });
    }

    const result: ISpecCreatePreview = {
      schema: SPEC_SCHEMA_V1,
      preview: true,
      id: built.id,
      path: specMdPath(cwd, built.id),
      md,
      spec: derived.value,
      written,
    };

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
      return 0;
    }
    process.stdout.write(header(`Spec ${written ? 'created' : 'preview'}: ${built.id}`));
    process.stdout.write(`  path: ${result.path}\n`);
    process.stdout.write(`  written: ${written ? 'yes' : 'no (pass --write to land)'}\n`);
    process.stdout.write('\n--- spec.md ---\n');
    process.stdout.write(md);
    process.stdout.write('\n--- next ---\n');
    if (!written) {
      process.stdout.write(`  $ shrk spec create "${title}" --write\n`);
    } else {
      process.stdout.write(`  edit ${result.path}\n`);
      process.stdout.write(`  $ shrk spec review ${built.id}\n`);
    }
    return 0;
  },
};

function parseLimit(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function reject(message: string): number {
  process.stderr.write(`Refusing: ${message}\n`);
  return 1;
}

export const specReviewCommand: ICommandHandler = {
  name: 'review',
  description:
    'Read-only structural + cross-registry validation of a spec. Returns sharkcraft.spec-review/v1.',
  usage: 'shrk spec review <id|path> [--json] [--strict] [--write]',
  async run(args: ParsedArgs): Promise<number> {
    const ref = args.positional[0];
    if (!ref) {
      process.stderr.write('Usage: shrk spec review <id|path>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const resolved = resolveSpecRef(cwd, ref);
    if (!resolved) {
      process.stderr.write(`Spec not found: ${ref}\n`);
      return 1;
    }
    const inspection = await inspectSharkcraft({ cwd });
    const loaded = loadSpec(cwd, resolved.id);
    if (!loaded.ok) {
      process.stderr.write(`Failed to load spec ${resolved.id}: ${loaded.error.message}\n`);
      return 1;
    }
    const review = buildSpecReview({
      spec: loaded.value.spec,
      specPath: specMdPath(cwd, resolved.id),
      body: loaded.value.body,
      inspection,
    });

    appendSpecEvent(cwd, resolved.id, {
      operation: 'review',
      verdict: review.verdict,
      details: {
        errors: review.errors.length,
        warnings: review.warnings.length,
      },
    });

    if (flagBool(args, 'write')) {
      // Cache the latest spec.json view + maybe transition status.
      writeSpecJson(cwd, resolved.id, loaded.value.spec);
      if (
        (review.verdict === 'pass' || review.verdict === 'warn') &&
        loaded.value.spec.status === SpecStatus.Draft
      ) {
        const md = readFileSync(specMdPath(cwd, resolved.id), 'utf8');
        const updated = md
          .replace(/^status:\s*draft$/m, `status: ${SpecStatus.Review}`)
          .replace(/^updatedAt:\s*.+$/m, `updatedAt: ${new Date().toISOString()}`);
        writeSpecMd(cwd, resolved.id, updated);
      }
    }

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(review) + '\n');
    } else {
      renderReview(review);
    }

    const strict = flagBool(args, 'strict');
    if (review.verdict === 'fail') return 1;
    if (review.verdict === 'warn' && strict) return 1;
    return 0;
  },
};

function renderReview(review: ISpecReviewReport): void {
  process.stdout.write(header(`Spec review: ${review.specId}`));
  process.stdout.write(`  verdict: ${review.verdict.toUpperCase()}\n`);
  process.stdout.write(`  errors: ${review.errors.length}\n`);
  process.stdout.write(`  warnings: ${review.warnings.length}\n`);
  if (review.errors.length > 0) {
    process.stdout.write('\nErrors:\n');
    for (const e of review.errors) {
      process.stdout.write(`  [${e.code}] ${e.field}: ${e.message}\n`);
    }
  }
  if (review.warnings.length > 0) {
    process.stdout.write('\nWarnings:\n');
    for (const w of review.warnings) {
      process.stdout.write(`  [${w.code}] ${w.field}: ${w.message}\n`);
    }
  }
}

export const specLintCommand: ICommandHandler = {
  name: 'lint',
  description:
    'Fast structural-only lint of a spec. Same as `spec review` but skips cross-registry resolution. Read-only.',
  usage: 'shrk spec lint <id|path> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const ref = args.positional[0];
    if (!ref) {
      process.stderr.write('Usage: shrk spec lint <id|path>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const resolved = resolveSpecRef(cwd, ref);
    if (!resolved) {
      process.stderr.write(`Spec not found: ${ref}\n`);
      return 1;
    }
    const loaded = loadSpec(cwd, resolved.id);
    if (!loaded.ok) {
      process.stderr.write(`Failed to load spec ${resolved.id}: ${loaded.error.message}\n`);
      return 1;
    }
    const result = validateSpecStructural(loaded.value.spec, loaded.value.body);
    const verdict: 'pass' | 'warn' | 'fail' =
      result.errors.length > 0 ? 'fail' : result.warnings.length > 0 ? 'warn' : 'pass';
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ schema: 'sharkcraft.spec-lint/v1', id: resolved.id, verdict, ...result }) + '\n');
    } else {
      process.stdout.write(header(`Spec lint: ${resolved.id}`));
      process.stdout.write(`  verdict: ${verdict.toUpperCase()}\n`);
      for (const e of result.errors) process.stdout.write(`  ERR  ${e.field}: ${e.message}\n`);
      for (const w of result.warnings) process.stdout.write(`  WARN ${w.field}: ${w.message}\n`);
    }
    return verdict === 'fail' ? 1 : 0;
  },
};

export const specListCommand: ICommandHandler = {
  name: 'list',
  description: 'List every spec in .sharkcraft/specs/. Read-only.',
  usage: 'shrk spec list [--status <s>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const report: ISpecListReport = buildSpecList(cwd);
    const statusFilter = flagString(args, 'status');
    const filtered: ISpecListReport = statusFilter
      ? {
          ...report,
          entries: report.entries.filter((e) => e.status === statusFilter),
        }
      : report;
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(filtered) + '\n');
      return 0;
    }
    process.stdout.write(header(`Specs (${filtered.entries.length})`));
    for (const e of filtered.entries) {
      const flags = [e.hasPlan ? 'P' : '-', e.hasVerification ? 'V' : '-'].join('');
      process.stdout.write(
        `  ${e.id.padEnd(36)}  ${String(e.status).padEnd(13)} ${flags}  ${e.title}\n`,
      );
    }
    if (filtered.entries.length === 0) {
      process.stdout.write('\n(no specs yet — try `shrk spec create "<title>" --write`)\n');
    }
    return 0;
  },
};

export const specShowCommand: ICommandHandler = {
  name: 'show',
  description: 'Print a spec contents. Read-only.',
  usage: 'shrk spec show <id> [--include-body] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const ref = args.positional[0];
    if (!ref) {
      process.stderr.write('Usage: shrk spec show <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const resolved = resolveSpecRef(cwd, ref);
    if (!resolved) {
      process.stderr.write(`Spec not found: ${ref}\n`);
      return 1;
    }
    const loaded = loadSpec(cwd, resolved.id);
    if (!loaded.ok) {
      process.stderr.write(`Failed to load spec ${resolved.id}: ${loaded.error.message}\n`);
      return 1;
    }
    const includeBody = flagBool(args, 'include-body');
    if (flagBool(args, 'json')) {
      const payload = includeBody
        ? { ...loaded.value.spec, body: loaded.value.body }
        : loaded.value.spec;
      process.stdout.write(asJson(payload) + '\n');
      return 0;
    }
    process.stdout.write(header(`Spec: ${loaded.value.spec.id}`));
    process.stdout.write(`  title: ${loaded.value.spec.title}\n`);
    process.stdout.write(`  status: ${loaded.value.spec.status}\n`);
    process.stdout.write(`  created: ${loaded.value.spec.createdAt}\n`);
    process.stdout.write(`  updated: ${loaded.value.spec.updatedAt}\n`);
    process.stdout.write(`  intent: ${loaded.value.spec.intent.slice(0, 200)}\n`);
    process.stdout.write(`  acceptance: ${loaded.value.spec.acceptanceCriteria.length} criterion(s)\n`);
    if (includeBody) {
      process.stdout.write('\n--- body ---\n');
      process.stdout.write(loaded.value.body);
      process.stdout.write('\n');
    }
    return 0;
  },
};

export const specStatusCommand: ICommandHandler = {
  name: 'status',
  description:
    'Read the current spec status, or transition it. Manual transitions allowed only to `abandoned` (with --reason). Other transitions happen automatically via `spec review` / `spec implement` / `spec verify`.',
  usage:
    'shrk spec status <id> [--set <state>] [--reason <text>] [--write] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const ref = args.positional[0];
    if (!ref) {
      process.stderr.write('Usage: shrk spec status <id> [--set abandoned --reason <text> --write]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const resolved = resolveSpecRef(cwd, ref);
    if (!resolved) {
      process.stderr.write(`Spec not found: ${ref}\n`);
      return 1;
    }
    const loaded = loadSpec(cwd, resolved.id);
    if (!loaded.ok) {
      process.stderr.write(`Failed to load spec ${resolved.id}: ${loaded.error.message}\n`);
      return 1;
    }
    const set = flagString(args, 'set');
    if (!set) {
      const payload = { id: resolved.id, status: loaded.value.spec.status };
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(payload) + '\n');
      } else {
        process.stdout.write(`${resolved.id}: ${loaded.value.spec.status}\n`);
      }
      return 0;
    }
    if (set !== SpecStatus.Abandoned) {
      process.stderr.write(
        `Refusing: manual transitions are only allowed to "${SpecStatus.Abandoned}". `+
          `Other transitions happen via spec review / implement / verify.\n`,
      );
      return 1;
    }
    const reason = flagString(args, 'reason');
    if (!reason || reason.trim().length === 0) {
      process.stderr.write(
        'Refusing: spec status --set abandoned requires --reason "<text>".\n',
      );
      return 1;
    }
    const wantWrite = flagBool(args, 'write');
    if (!wantWrite) {
      process.stdout.write(
        `Preview: would transition ${resolved.id} → ${SpecStatus.Abandoned} (reason: ${reason}).\n` +
          `Re-run with --write to apply.\n`,
      );
      return 0;
    }
    const md = readFileSync(specMdPath(cwd, resolved.id), 'utf8');
    const updated = md
      .replace(/^status:\s*\S+$/m, `status: ${SpecStatus.Abandoned}`)
      .replace(/^updatedAt:\s*.+$/m, `updatedAt: ${new Date().toISOString()}`);
    writeSpecMd(cwd, resolved.id, updated);
    appendSpecEvent(cwd, resolved.id, {
      operation: 'status',
      verdict: SpecStatus.Abandoned,
      details: { reason },
    });
    process.stdout.write(`${resolved.id}: abandoned (reason: ${reason})\n`);
    return 0;
  },
};

interface IPerTemplatePlanSummary {
  templateId: string;
  totalFiles: number;
  hasConflicts: boolean;
  changes: ISavedPlanExpectedChange[];
}

export const specImplementCommand: ICommandHandler = {
  name: 'implement',
  description:
    'Compose the spec\'s proposedTemplates into a signed combined plan. Default dry-run; pass --write-plan to land plan.json under the spec dir; --apply to ship the change.',
  usage:
    'shrk spec implement <id> [--dry-run] [--write-plan] [--apply] [--allow-divergent] [--skip-review] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const ref = args.positional[0];
    if (!ref) {
      process.stderr.write('Usage: shrk spec implement <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const resolved = resolveSpecRef(cwd, ref);
    if (!resolved) {
      process.stderr.write(`Spec not found: ${ref}\n`);
      return 1;
    }
    const loaded = loadSpec(cwd, resolved.id);
    if (!loaded.ok) {
      process.stderr.write(`Failed to load spec ${resolved.id}: ${loaded.error.message}\n`);
      return 1;
    }
    const spec = loaded.value.spec;
    if (spec.status === SpecStatus.Abandoned) {
      process.stderr.write(`Refusing: spec ${spec.id} is abandoned.\n`);
      return 1;
    }
    if (spec.proposedTemplates.length === 0) {
      process.stderr.write(`Refusing: spec ${spec.id} has no proposedTemplates.\n`);
      return 1;
    }
    const reviewOk = flagBool(args, 'skip-review') || hasReviewEventOk(cwd, spec.id);
    if (!reviewOk) {
      process.stderr.write(
        `Refusing: spec has not been reviewed. Run \`shrk spec review ${spec.id}\` first, or pass --skip-review.\n`,
      );
      return 1;
    }

    const inspection = await inspectSharkcraft({ cwd });
    const perTemplate: IPerTemplatePlanSummary[] = [];
    const combinedChanges: ISavedPlanExpectedChange[] = [];
    const refusals: { templateId: string; reason: string }[] = [];

    const collectedFileChanges: ISavedPlanExpectedChange[] = [];
    for (const t of spec.proposedTemplates) {
      const template = inspection.templateRegistry.get(t.templateId);
      if (!template) {
        refusals.push({ templateId: t.templateId, reason: 'template not found in registry' });
        continue;
      }
      const result = generate(template, {
        templateId: t.templateId,
        variables: t.variables as Record<string, string>,
        projectRoot: cwd,
        overwriteStrategy: OverwriteStrategy.Never,
        write: false,
      });
      if (!result.ok) {
        refusals.push({ templateId: t.templateId, reason: result.error.message });
        continue;
      }
      const plan = result.value.plan;
      perTemplate.push({
        templateId: t.templateId,
        totalFiles: plan.totalFiles,
        hasConflicts: plan.hasConflicts,
        changes: plan.changes.map((c) => ({
          type: String(c.type),
          relativePath: c.relativePath,
          sizeBytes: c.sizeBytes,
          ...(c.operation !== undefined ? { operation: c.operation } : {}),
        })),
      });
      if (plan.hasConflicts) {
        refusals.push({ templateId: t.templateId, reason: 'plan has conflicts' });
        continue;
      }
      for (const ch of plan.changes) {
        const dup = combinedChanges.find(
          (e) =>
            e.relativePath === ch.relativePath &&
            e.type === String(ch.type) &&
            e.type === String(FileChangeType.Create),
        );
        if (dup) {
          refusals.push({
            templateId: t.templateId,
            reason: `combined-plan conflict on ${ch.relativePath} (also written by another template)`,
          });
          continue;
        }
        const entry: ISavedPlanExpectedChange = {
          type: String(ch.type),
          relativePath: ch.relativePath,
          sizeBytes: ch.sizeBytes,
          ...(ch.operation !== undefined ? { operation: ch.operation } : {}),
        };
        combinedChanges.push(entry);
        collectedFileChanges.push(entry);
      }
    }

    const syntheticPlan: IGenerationPlan = {
      templateId: `sharkcraft.spec/${spec.id}`,
      templateName: `spec ${spec.id}`,
      changes: collectedFileChanges.map((c) => ({
        type: c.type as FileChangeType,
        relativePath: c.relativePath,
        absolutePath: nodePath.join(cwd, c.relativePath),
        sizeBytes: c.sizeBytes,
        contents: '',
        reason: `spec=${spec.id}`,
        ...(c.operation !== undefined ? { operation: c.operation } : {}),
      })),
      totalFiles: collectedFileChanges.length,
      hasConflicts: false,
      warnings: [],
      postGenerationNotes: [],
    };
    const built = buildSavedPlan({
      templateId: `sharkcraft.spec/${spec.id}`,
      variables: flattenVariables(spec.proposedTemplates),
      projectRoot: cwd,
      plan: syntheticPlan,
      note: `spec=${spec.id}; frontmatter=${spec.frontmatterHash}`,
    });

    let signedPlan: ISavedPlan = built;
    let signatureStatus: 'signed' | 'unsigned' | 'missing-secret' = 'unsigned';
    if (process.env[PLAN_SECRET_ENV]) {
      const signed = signPlan(built);
      if (signed.ok) {
        signedPlan = signed.value;
        signatureStatus = 'signed';
      } else {
        signatureStatus = 'missing-secret';
      }
    } else {
      signatureStatus = 'missing-secret';
    }

    const wantWritePlan = flagBool(args, 'write-plan');
    const wantApply = flagBool(args, 'apply');
    let savedPlanPath: string | null = null;
    let applied = false;

    if (refusals.length > 0 && !flagBool(args, 'allow-divergent')) {
      const report = {
        schema: SPEC_IMPLEMENT_SCHEMA,
        specId: spec.id,
        frontmatterHash: spec.frontmatterHash,
        perTemplatePlans: perTemplate,
        combined: {
          savedPlanPath,
          totalFiles: combinedChanges.length,
          signatureStatus,
          applied,
        },
        refusals,
      };
      if (flagBool(args, 'json')) process.stdout.write(asJson(report) + '\n');
      else {
        process.stdout.write(header(`Spec implement REFUSED: ${spec.id}`));
        for (const r of refusals) {
          process.stdout.write(`  ${r.templateId}: ${r.reason}\n`);
        }
      }
      return 1;
    }

    if (wantWritePlan) {
      savedPlanPath = specPlanPath(cwd, spec.id);
      const writeRes = savePlanToFile(signedPlan, savedPlanPath);
      if (!writeRes.ok) {
        process.stderr.write(`Failed to write plan: ${writeRes.error.message}\n`);
        return 1;
      }
      // Update spec.md plan block + transition status.
      const md = readFileSync(specMdPath(cwd, spec.id), 'utf8');
      const planRefLines = [
        'plan:',
        `  planPath: ${nodePath.relative(specDir(cwd, spec.id), savedPlanPath)}`,
        `  planHash: ${shortHash(canonicalJson(signedPlan))}`,
        `  signedAt: ${signedPlan.signature?.signedAt ?? ''}`,
      ];
      const updated = upsertPlanBlock(md, planRefLines.join('\n'))
        .replace(/^status:\s*\S+$/m, `status: ${SpecStatus.Implementing}`)
        .replace(/^updatedAt:\s*.+$/m, `updatedAt: ${new Date().toISOString()}`);
      writeSpecMd(cwd, spec.id, updated);
      // Re-derive spec.json so it stays consistent.
      const reparsed = splitSpecMd(updated);
      if (reparsed.ok) {
        const rederived = deriveSpecJson(reparsed.value);
        if (rederived.ok) writeSpecJson(cwd, spec.id, rederived.value);
      }
      appendSpecEvent(cwd, spec.id, {
        operation: 'implement',
        verdict: 'plan-written',
        details: { planPath: savedPlanPath, signatureStatus },
      });
    }

    if (wantApply) {
      // Close the spec→apply loop. `spec implement --apply` dispatches
      // into applyCommand directly with the signed plan path. The
      // signed plan was written above if --write-plan was passed; if
      // not, we still have the in-memory signed plan in `signedPlan`
      // — write it to a transient location under the spec dir so apply
      // has a file to consume.
      if (!savedPlanPath) {
        // Materialize the plan if --apply was passed without --write-plan.
        savedPlanPath = specPlanPath(cwd, spec.id);
        const writeRes = savePlanToFile(signedPlan, savedPlanPath);
        if (!writeRes.ok) {
          process.stderr.write(`Failed to write plan for apply: ${writeRes.error.message}\n`);
          return 1;
        }
      }
      // Dispatch into applyCommand. Forward --allow-divergent and
      // --verify-signature (defaults to true since we signed the plan
      // when a SHARKCRAFT_PLAN_SECRET was available).
      const applyFlags = new Map<string, string | boolean>();
      if (flagBool(args, 'allow-divergent')) applyFlags.set('allow-divergent', true);
      if (signatureStatus === 'signed') applyFlags.set('verify-signature', true);
      if (flagBool(args, 'json')) applyFlags.set('json', true);
      const applyArgs = {
        positional: [savedPlanPath],
        flags: applyFlags,
        multiFlags: new Map<string, string[]>(),
        ...(args.globalCwd !== undefined ? { globalCwd: args.globalCwd } : {}),
      };
      const applyRc = await applyCommand.run(applyArgs);
      applied = applyRc === 0;
      appendSpecEvent(cwd, spec.id, {
        operation: 'apply',
        verdict: applied ? 'applied' : 'apply-failed',
        details: { planPath: nodePath.relative(cwd, savedPlanPath), rc: applyRc },
      });
      if (!applied) {
        process.stderr.write(
          `Apply returned non-zero (${applyRc}); inspect the apply output above for details.\n`,
        );
      }
    }

    const report = {
      schema: SPEC_IMPLEMENT_SCHEMA,
      specId: spec.id,
      frontmatterHash: spec.frontmatterHash,
      perTemplatePlans: perTemplate,
      combined: {
        savedPlanPath,
        totalFiles: combinedChanges.length,
        signatureStatus,
        applied,
      },
      refusals,
    };
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
    } else {
      process.stdout.write(header(`Spec implement: ${spec.id}`));
      process.stdout.write(`  per-template plans: ${perTemplate.length}\n`);
      for (const p of perTemplate) {
        process.stdout.write(`    ${p.templateId.padEnd(28)} files=${p.totalFiles}\n`);
      }
      process.stdout.write(`  combined files: ${combinedChanges.length}\n`);
      process.stdout.write(`  signature: ${signatureStatus}\n`);
      if (savedPlanPath) process.stdout.write(`  plan: ${savedPlanPath}\n`);
      if (refusals.length > 0) {
        process.stdout.write('\nRefusals:\n');
        for (const r of refusals) process.stdout.write(`  ${r.templateId}: ${r.reason}\n`);
      }
    }
    return 0;
  },
};

function hasReviewEventOk(projectRoot: string, id: string): boolean {
  const events = readSpecEvents(projectRoot, id);
  return events.some((e) => e.operation === 'review' && e.verdict !== 'fail');
}

function flattenVariables(
  templates: readonly ISpecProposedTemplate[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of templates) {
    for (const [k, v] of Object.entries(t.variables)) {
      out[`${t.templateId}.${k}`] = v;
    }
  }
  return out;
}

function upsertPlanBlock(md: string, planBlock: string): string {
  const lines = md.split('\n');
  // Find frontmatter range.
  if (lines[0] !== '---') return md;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return md;
  // Strip any existing `plan:` block (top-level, until next top-level key).
  const fm: string[] = [];
  let inPlan = false;
  for (let i = 1; i < close; i++) {
    const line = lines[i]!;
    if (line.startsWith('plan:')) {
      inPlan = true;
      continue;
    }
    if (inPlan) {
      // End of plan block iff next top-level key (non-whitespace start).
      if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t') {
        inPlan = false;
        fm.push(line);
      }
      continue;
    }
    fm.push(line);
  }
  return ['---', ...fm, planBlock, '---', ...lines.slice(close + 1)].join('\n');
}

function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const specVerifyCommand: ICommandHandler = {
  name: 'verify',
  description:
    'Run the spec\'s trusted verification commands, check acceptance-criteria coverage, run diff-aware boundary + drift checks. Returns sharkcraft.spec-verification/v1.',
  usage:
    'shrk spec verify <id> [--since <ref>] [--strict] [--skip-verification-commands] [--json] [--write]',
  async run(args: ParsedArgs): Promise<number> {
    const ref = args.positional[0];
    if (!ref) {
      process.stderr.write('Usage: shrk spec verify <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const resolved = resolveSpecRef(cwd, ref);
    if (!resolved) {
      process.stderr.write(`Spec not found: ${ref}\n`);
      return 1;
    }
    const loaded = loadSpec(cwd, resolved.id);
    if (!loaded.ok) {
      process.stderr.write(`Failed to load spec ${resolved.id}: ${loaded.error.message}\n`);
      return 1;
    }
    const spec = loaded.value.spec;
    if (
      spec.status !== SpecStatus.Implementing &&
      spec.status !== SpecStatus.Implemented &&
      spec.status !== SpecStatus.Verified
    ) {
      process.stderr.write(
        `Refusing: spec ${spec.id} is in status "${spec.status}". Implement first via \`shrk spec implement ${spec.id} --write-plan\`.\n`,
      );
      return 1;
    }
    const inspection = await inspectSharkcraft({ cwd });
    const trusted = new Map(
      (inspection.config?.verificationCommands ?? [])
        .filter((c) => c.trusted !== false)
        .map((c) => [c.id, c]),
    );
    const known = new Map((inspection.config?.verificationCommands ?? []).map((c) => [c.id, c]));

    const skipCommands = flagBool(args, 'skip-verification-commands');
    const commandResults: Array<{
      id: string;
      status: 'pass' | 'fail' | 'skipped' | 'unknown';
      exitCode?: number;
      durationMs?: number;
      stderrTail?: string;
    }> = [];
    let commandFailed = false;
    if (!skipCommands) {
      for (const v of spec.verificationCommands) {
        const cmd = trusted.get(v.id);
        if (!cmd) {
          if (!known.has(v.id)) {
            commandResults.push({ id: v.id, status: 'unknown' });
            commandFailed = true;
            continue;
          }
          commandResults.push({ id: v.id, status: 'skipped' });
          continue;
        }
        const start = Date.now();
        try {
          execSync(cmd.command, { cwd, stdio: 'pipe' });
          commandResults.push({
            id: v.id,
            status: 'pass',
            exitCode: 0,
            durationMs: Date.now() - start,
          });
        } catch (e) {
          const errAny = e as { status?: number; stderr?: Buffer | string };
          commandResults.push({
            id: v.id,
            status: 'fail',
            exitCode: errAny.status ?? 1,
            durationMs: Date.now() - start,
            stderrTail: typeof errAny.stderr === 'string'
              ? errAny.stderr.split('\n').slice(-5).join('\n')
              : errAny.stderr?.toString('utf8').split('\n').slice(-5).join('\n'),
          });
          commandFailed = true;
        }
      }
    }

    const sinceRef = flagString(args, 'since');
    const changed = collectChangedPaths({ cwd, ...(sinceRef ? { ref: sinceRef } : {}) });

    const declaredScope = new Set<string>([
      ...spec.affectedAreas.files,
      ...spec.affectedAreas.packages,
    ]);
    const scopeDrift: { path: string; reason: string }[] = [];
    if (changed.isAvailable) {
      for (const p of changed.changed) {
        const inScope = [...declaredScope].some(
          (s) => p === s || p.startsWith(s.endsWith('/') ? s : `${s}/`),
        );
        if (!inScope && declaredScope.size > 0) {
          scopeDrift.push({ path: p, reason: 'changed file outside affectedAreas' });
        }
      }
    }

    let planIntegrity: 'verified' | 'missing-signature' | 'invalid-signature' | 'no-plan';
    const planPath = specPlanPath(cwd, spec.id);
    if (!existsSync(planPath)) {
      planIntegrity = 'no-plan';
    } else {
      try {
        const planRaw = JSON.parse(readFileSync(planPath, 'utf8')) as ISavedPlan;
        const verify = verifyPlan(planRaw);
        if (verify.ok) planIntegrity = 'verified';
        else if (verify.status === 'missing-signature') planIntegrity = 'missing-signature';
        else if (verify.status === 'missing-secret') planIntegrity = 'missing-signature';
        else planIntegrity = 'invalid-signature';
      } catch {
        planIntegrity = 'invalid-signature';
      }
    }

    const acceptanceResults = spec.acceptanceCriteria.map((ac) => ({
      id: ac.id,
      status: ac.verifiedBy.includes('manual')
        ? ('manual' as const)
        : commandFailed
          ? ('fail' as const)
          : ('pass' as const),
      evidence: [],
    }));

    const verdict: 'pass' | 'warn' | 'fail' = commandFailed
      ? 'fail'
      : scopeDrift.length > 0 || planIntegrity === 'missing-signature'
        ? 'warn'
        : 'pass';

    const report = {
      schema: SPEC_VERIFICATION_SCHEMA,
      specId: spec.id,
      frontmatterHash: spec.frontmatterHash,
      ranAt: new Date().toISOString(),
      verdict,
      acceptanceCriteria: acceptanceResults,
      verificationCommands: commandResults,
      boundaries: { since: changed.ref, violations: [] as unknown[] },
      scopeDrift: { outsideScope: scopeDrift },
      planIntegrity: { status: planIntegrity },
    };

    if (flagBool(args, 'write') || flagBool(args, 'apply')) {
      writeFileSync(specVerificationPath(cwd, spec.id), JSON.stringify(report, null, 2) + '\n', 'utf8');
      if (verdict === 'pass' && spec.status !== SpecStatus.Verified) {
        const md = readFileSync(specMdPath(cwd, spec.id), 'utf8');
        const updated = md
          .replace(/^status:\s*\S+$/m, `status: ${SpecStatus.Verified}`)
          .replace(/^updatedAt:\s*.+$/m, `updatedAt: ${new Date().toISOString()}`);
        writeSpecMd(cwd, spec.id, updated);
      }
    }
    appendSpecEvent(cwd, spec.id, { operation: 'verify', verdict });

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
    } else {
      process.stdout.write(header(`Spec verify: ${spec.id}`));
      process.stdout.write(`  verdict: ${verdict.toUpperCase()}\n`);
      process.stdout.write(`  verification commands: ${commandResults.length} (${commandResults.filter((r) => r.status === 'pass').length} pass)\n`);
      for (const r of commandResults) {
        process.stdout.write(`    ${r.status.padEnd(7)} ${r.id}${r.durationMs ? ` (${r.durationMs}ms)` : ''}\n`);
      }
      process.stdout.write(`  scope drift: ${scopeDrift.length}\n`);
      process.stdout.write(`  plan integrity: ${planIntegrity}\n`);
    }

    if (verdict === 'fail') return 1;
    if (verdict === 'warn' && flagBool(args, 'strict')) return 1;
    return 0;
  },
};

export const specParentCommand: ICommandHandler = {
  name: 'spec',
  description:
    'Spec-driven development. Subcommand required: create | review | implement | verify | list | show | status | lint.',
  usage: 'shrk spec <create|review|implement|verify|list|show|status|lint> [...]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const handlerMap: Record<string, ICommandHandler> = {
      create: specCreateCommand,
      review: specReviewCommand,
      implement: specImplementCommand,
      verify: specVerifyCommand,
      list: specListCommand,
      show: specShowCommand,
      status: specStatusCommand,
      lint: specLintCommand,
    };
    if (!sub || !handlerMap[sub]) {
      process.stderr.write(
        'Usage: shrk spec <create|review|implement|verify|list|show|status|lint>\n',
      );
      return 2;
    }
    return await handlerMap[sub]!.run({
      ...args,
      positional: args.positional.slice(1),
    });
  },
};

interface IResolvedSpec {
  id: string;
}

function resolveSpecRef(projectRoot: string, ref: string): IResolvedSpec | null {
  // Direct id.
  if (existsSync(specMdPath(projectRoot, ref))) return { id: ref };
  // Path to a spec.md.
  if (ref.endsWith('spec.md') && existsSync(ref)) {
    const id = nodePath.basename(nodePath.dirname(ref));
    if (existsSync(specMdPath(projectRoot, id))) return { id };
  }
  return null;
}

// Re-export schema constant for surface visibility.
export { SPEC_LIST_SCHEMA };
