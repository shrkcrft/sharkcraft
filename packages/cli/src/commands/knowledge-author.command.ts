/**
 * Knowledge authoring CLI surface.
 *
 *   - `shrk knowledge add` — preview a new knowledge entry.
 *   - `shrk knowledge update <id>` — preview an incremental change.
 *   - `shrk knowledge remove <id>` — preview a removal (refuses if
 *     reverse references exist unless --force-preview).
 *   - `shrk knowledge author preview` — alias that classifies the
 *     operation by which flags were passed.
 *   - `shrk knowledge lint [--fix-preview]` — classify findings.
 *
 * All commands default to preview-only. Files land under
 * `.sharkcraft/authoring/` (drafts) or `.sharkcraft/fixes/` (lint output).
 * No direct mutation of `sharkcraft/knowledge.ts` or pack source.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildKnowledgeAuthoringPreview,
  buildKnowledgeLintFixPreview,
  buildKnowledgeStaleReport,
  inspectSharkcraft,
  KnowledgeAuthoringOperation,
  KnowledgeLintCategory,
  lintKnowledge,
  recordProvenance,
  renderKnowledgeLintFixPreviewMarkdown,
  renderKnowledgeLintMarkdown,
  ReferenceCheckOutcome,
  AssetKind,
  AssetProvenanceOperation,
  type IKnowledgeAuthoringInput,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import {
  detectAuthoringSource,
  multiFlagValues as multiValues,
  parseReferenceSpec as parseReference,
  writeAuthoringDrafts,
} from '../authoring/authoring-kit.ts';

const detectSource = detectAuthoringSource;
const maybeWriteDraftFiles = writeAuthoringDrafts;

function commonAuthoringFlags(args: ParsedArgs, id: string): IKnowledgeAuthoringInput {
  const referencesSpecs = multiValues(args, 'reference');
  const references = referencesSpecs
    .map((spec) => parseReference(spec))
    .filter((r): r is NonNullable<ReturnType<typeof parseReference>> => r !== null);
  const related = multiValues(args, 'related');
  const tags = multiValues(args, 'tag');
  const scope = multiValues(args, 'scope');
  const appliesWhen = multiValues(args, 'applies-when');
  return {
    operation: KnowledgeAuthoringOperation.Add,
    id,
    ...(flagString(args, 'title') ? { title: flagString(args, 'title') ?? undefined } : {}),
    ...(flagString(args, 'type') ? { type: flagString(args, 'type') ?? undefined } : {}),
    ...(flagString(args, 'priority')
      ? { priority: flagString(args, 'priority') as 'critical' | 'high' | 'medium' | 'low' }
      : {}),
    ...(flagString(args, 'summary') ? { summary: flagString(args, 'summary') ?? undefined } : {}),
    ...(flagString(args, 'content') ? { content: flagString(args, 'content') ?? undefined } : {}),
    ...(flagString(args, 'reason') ? { reason: flagString(args, 'reason') ?? undefined } : {}),
    ...(related.length > 0 ? { related } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(scope.length > 0 ? { scope } : {}),
    ...(appliesWhen.length > 0 ? { appliesWhen } : {}),
    ...(references.length > 0 ? { references } : {}),
  };
}

export const knowledgeAddCommand: ICommandHandler = {
  name: 'add',
  description: 'Preview adding a new knowledge entry. Preview-only — never mutates source.',
  usage:
    'shrk knowledge add --id <id> [--title <t>] [--type <type>] [--priority critical|high|medium|low] [--summary <s>] [--content <text>] [--scope x,y] [--tag x,y] [--applies-when x,y] [--related a,b] [--reference kind:value[:required]] [--reason <text>] [--allow-overwrite] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = flagString(args, 'id') ?? args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk knowledge add --id <id> [...]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const input: IKnowledgeAuthoringInput = {
      ...commonAuthoringFlags(args, id),
      operation: KnowledgeAuthoringOperation.Add,
      ...(flagBool(args, 'allow-overwrite') ? { allowOverwrite: true } : {}),
    };
    const result = buildKnowledgeAuthoringPreview(input, {
      entries: inspection.knowledgeEntries,
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
    } else {
      process.stdout.write(header(`Knowledge add preview: ${id}`));
      process.stdout.write(`  ok:        ${result.ok}\n`);
      if (!result.ok) process.stdout.write(`  refusal:   ${result.refusal}\n`);
      process.stdout.write(`  files:\n`);
      process.stdout.write(`    ${result.tsDraft.path}\n`);
      process.stdout.write(`    ${result.jsonManifest.path}\n`);
      process.stdout.write(`    ${result.explainer.path}\n`);
      if (result.warnings.length > 0) {
        process.stdout.write('\n  warnings:\n');
        for (const w of result.warnings) process.stdout.write(`    • ${w}\n`);
      }
      process.stdout.write('\n--- TypeScript draft ---\n');
      process.stdout.write(result.tsDraft.body);
      process.stdout.write('\n--- Next commands ---\n');
      for (const c of result.nextCommands) process.stdout.write(`  $ ${c}\n`);
      if (!flagBool(args, 'write-preview')) {
        process.stdout.write('\n  (preview only — pass --write-preview to materialise under .sharkcraft/authoring/)\n');
      }
    }
    if (flagBool(args, 'write-preview') && result.ok) {
      maybeWriteDraftFiles(cwd, [result.tsDraft, result.jsonManifest, result.explainer]);
      const src = detectSource();
      recordProvenance({
        projectRoot: cwd,
        entry: {
          operation: AssetProvenanceOperation.Preview,
          assetKind: AssetKind.Knowledge,
          assetId: id,
          targetFile: input.target?.filePath,
          source: src.source,
          ...(src.author ? { author: src.author } : {}),
          ...(src.sessionId ? { sessionId: src.sessionId } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          previewPath: result.tsDraft.path,
          extra: { authoringOp: 'add' },
        },
      });
    }
    return result.ok ? 0 : 1;
  },
};

export const knowledgeUpdateCommand: ICommandHandler = {
  name: 'update',
  description:
    'Preview an update to an existing knowledge entry. Preview-only — never mutates source.',
  usage:
    'shrk knowledge update <id> [--summary <s>] [--content <text>] [--priority critical|high|medium|low] [--add-related a,b] [--remove-related a,b] [--reference kind:value[:required]] [--remove-reference kind:value] [--add-anchor <json>] [--remove-anchor-id <id>] [--mark-deprecated] [--unmark-deprecated] [--reason <text>] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk knowledge update <id> [...]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const refs = multiValues(args, 'reference')
      .map((s) => parseReference(s))
      .filter((r): r is NonNullable<ReturnType<typeof parseReference>> => r !== null);
    const removeRefs = multiValues(args, 'remove-reference')
      .map((s) => parseReference(s))
      .filter((r): r is NonNullable<ReturnType<typeof parseReference>> => r !== null);
    const addRelated = multiValues(args, 'add-related');
    const removeRelated = multiValues(args, 'remove-related');
    const removeAnchorIds = multiValues(args, 'remove-anchor-id');
    const input: IKnowledgeAuthoringInput = {
      operation: KnowledgeAuthoringOperation.Update,
      id,
      ...(flagString(args, 'reason') ? { reason: flagString(args, 'reason') ?? undefined } : {}),
      updateOps: {
        ...(flagString(args, 'summary') !== undefined && flagString(args, 'summary') !== null
          ? { setSummary: flagString(args, 'summary')! }
          : {}),
        ...(flagString(args, 'content') !== undefined && flagString(args, 'content') !== null
          ? { setContent: flagString(args, 'content')! }
          : {}),
        ...(flagString(args, 'priority')
          ? { setPriority: flagString(args, 'priority') as 'critical' | 'high' | 'medium' | 'low' }
          : {}),
        ...(refs.length > 0 ? { addReferences: refs } : {}),
        ...(removeRefs.length > 0
          ? {
              removeReferences: removeRefs.map((r) => ({
                kind: r.kind,
                ...(r.id ? { id: r.id } : {}),
                ...(r.path ? { path: r.path } : {}),
                ...(r.symbol ? { symbol: r.symbol } : {}),
              })),
            }
          : {}),
        ...(addRelated.length > 0 ? { addRelated } : {}),
        ...(removeRelated.length > 0 ? { removeRelated } : {}),
        ...(removeAnchorIds.length > 0 ? { removeAnchorIds } : {}),
        ...(flagBool(args, 'mark-deprecated') ? { markDeprecated: true } : {}),
        ...(flagBool(args, 'unmark-deprecated') ? { unmarkDeprecated: true } : {}),
      },
    };
    const result = buildKnowledgeAuthoringPreview(input, {
      entries: inspection.knowledgeEntries,
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
    } else {
      process.stdout.write(header(`Knowledge update preview: ${id}`));
      process.stdout.write(`  ok:        ${result.ok}\n`);
      if (!result.ok) process.stdout.write(`  refusal:   ${result.refusal}\n`);
      process.stdout.write(`  files:\n`);
      process.stdout.write(`    ${result.tsDraft.path}\n`);
      process.stdout.write(`    ${result.jsonManifest.path}\n`);
      process.stdout.write(`    ${result.explainer.path}\n`);
      if (result.patch) {
        process.stdout.write(`\n  patch changes: ${result.patch.changes.length}\n`);
        for (const c of result.patch.changes) {
          process.stdout.write(`    - ${c.op} ${c.field}\n`);
        }
      }
      if (result.warnings.length > 0) {
        process.stdout.write('\n  warnings:\n');
        for (const w of result.warnings) process.stdout.write(`    • ${w}\n`);
      }
      process.stdout.write('\n--- TypeScript draft (next) ---\n');
      process.stdout.write(result.tsDraft.body);
      process.stdout.write('\n--- Next commands ---\n');
      for (const c of result.nextCommands) process.stdout.write(`  $ ${c}\n`);
      if (!flagBool(args, 'write-preview')) {
        process.stdout.write('\n  (preview only — pass --write-preview to materialise under .sharkcraft/authoring/)\n');
      }
    }
    if (flagBool(args, 'write-preview') && result.ok) {
      maybeWriteDraftFiles(cwd, [result.tsDraft, result.jsonManifest, result.explainer]);
      const src = detectSource();
      recordProvenance({
        projectRoot: cwd,
        entry: {
          operation: AssetProvenanceOperation.Preview,
          assetKind: AssetKind.Knowledge,
          assetId: id,
          source: src.source,
          ...(src.author ? { author: src.author } : {}),
          ...(src.sessionId ? { sessionId: src.sessionId } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          previewPath: result.tsDraft.path,
          extra: { authoringOp: 'update' },
        },
      });
    }
    return result.ok ? 0 : 1;
  },
};

export const knowledgeRemoveCommand: ICommandHandler = {
  name: 'remove',
  description:
    'Preview removal of a knowledge entry. Refuses if reverse references exist, unless --force-preview is set. Preview-only.',
  usage:
    'shrk knowledge remove <id> [--force-preview] [--reason <text>] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk knowledge remove <id> [--force-preview]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const input: IKnowledgeAuthoringInput = {
      operation: KnowledgeAuthoringOperation.Remove,
      id,
      forcePreview: flagBool(args, 'force-preview'),
      ...(flagString(args, 'reason') ? { reason: flagString(args, 'reason') ?? undefined } : {}),
    };
    const result = buildKnowledgeAuthoringPreview(input, {
      entries: inspection.knowledgeEntries,
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
    } else {
      process.stdout.write(header(`Knowledge remove preview: ${id}`));
      process.stdout.write(`  ok:        ${result.ok}\n`);
      if (!result.ok) process.stdout.write(`  refusal:   ${result.refusal}\n`);
      if (result.reverseReferences && result.reverseReferences.length > 0) {
        process.stdout.write(`\n  reverse references (${result.reverseReferences.length}):\n`);
        for (const r of result.reverseReferences) {
          process.stdout.write(`    - ${r.fromEntryId} (${r.field})${r.note ? ` — ${r.note}` : ''}\n`);
        }
      }
      if (result.suggestedDeprecationInstead) {
        process.stdout.write(
          '\n  Suggested: prefer `shrk knowledge update ' +
            id +
            ' --mark-deprecated` over removal — see explainer.\n',
        );
      }
      process.stdout.write('\n--- Next commands ---\n');
      for (const c of result.nextCommands) process.stdout.write(`  $ ${c}\n`);
      if (!flagBool(args, 'write-preview')) {
        process.stdout.write('\n  (preview only — pass --write-preview to materialise under .sharkcraft/authoring/)\n');
      }
    }
    if (flagBool(args, 'write-preview') && result.ok) {
      maybeWriteDraftFiles(cwd, [result.tsDraft, result.jsonManifest, result.explainer]);
      const src = detectSource();
      recordProvenance({
        projectRoot: cwd,
        entry: {
          operation: AssetProvenanceOperation.Preview,
          assetKind: AssetKind.Knowledge,
          assetId: id,
          source: src.source,
          ...(src.author ? { author: src.author } : {}),
          ...(src.sessionId ? { sessionId: src.sessionId } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          previewPath: result.tsDraft.path,
          extra: { authoringOp: 'remove', forced: input.forcePreview },
        },
      });
    }
    return result.ok ? 0 : 1;
  },
};

export const knowledgeLintCommand: ICommandHandler = {
  name: 'lint',
  description:
    'Lint knowledge entries — classify findings as safe stub vs needs-human-wording vs stale-reference vs missing-provenance.',
  usage:
    'shrk knowledge lint [--id <entryId,...>] [--fix-preview] [--write-preview] [--no-advisory] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entryIds = flagList(args, 'id');
    const includeAdvisory = !flagBool(args, 'no-advisory');
    const stale = buildKnowledgeStaleReport(inspection);
    const staleIds = new Set<string>();
    for (const c of stale.referenceChecks) {
      if (c.outcome === ReferenceCheckOutcome.Stale || c.outcome === ReferenceCheckOutcome.Missing) {
        staleIds.add(c.entryId);
      }
    }
    const report = lintKnowledge(inspection.knowledgeEntries, {
      ...(entryIds.length > 0 ? { entryIds } : {}),
      includeAdvisory,
      staleReferenceEntryIds: [...staleIds],
    });
    const wantPreview = flagBool(args, 'fix-preview');
    const preview = wantPreview ? buildKnowledgeLintFixPreview(report) : null;

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(wantPreview ? { report, preview } : report) + '\n');
    } else {
      process.stdout.write(renderKnowledgeLintMarkdown(report));
      if (preview) {
        process.stdout.write('\n');
        process.stdout.write(renderKnowledgeLintFixPreviewMarkdown(preview));
      }
    }
    if (flagBool(args, 'write-preview') && preview) {
      const fixesDir = nodePath.join(cwd, '.sharkcraft', 'fixes');
      mkdirSync(fixesDir, { recursive: true });
      const summaryPath = nodePath.join(fixesDir, 'knowledge-lint.preview.md');
      const todosPath = nodePath.join(fixesDir, 'knowledge-lint.todos.json');
      const patchPath = nodePath.join(fixesDir, 'knowledge-lint.patch');
      writeFileSync(summaryPath, renderKnowledgeLintFixPreviewMarkdown(preview), 'utf8');
      writeFileSync(todosPath, JSON.stringify({ todos: preview.todos, acknowledgements: preview.acknowledgements }, null, 2) + '\n', 'utf8');
      writeFileSync(
        patchPath,
        `# Knowledge lint patch suggestions.\n# Safe mechanical stubs:\n` +
          preview.safeStubs.map((s) => `# ${s.entryId} → ${s.field}: ${s.suggestion}`).join('\n') +
          '\n',
        'utf8',
      );
      process.stdout.write(`\nWrote 3 files under ${nodePath.relative(cwd, fixesDir)}\n`);
    }
    // Exit codes: 0 if no warnings, 1 if any non-advisory warnings.
    const warning = report.findings.some(
      (f) => f.severity === 'warning' && !f.advisory,
    );
    void KnowledgeLintCategory;
    return warning ? 1 : 0;
  },
};

export const knowledgeAuthorPreviewCommand: ICommandHandler = {
  name: 'author',
  description:
    'Knowledge authoring preview entry-point. Dispatches to add/update/remove based on flags.',
  usage:
    'shrk knowledge author [preview] --id <id> [--operation add|update|remove] [common knowledge add/update/remove flags] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    // The first positional may be "preview" (the verb) — strip it.
    if (args.positional[0] === 'preview') args.positional.shift();
    const operation = (flagString(args, 'operation') ?? 'add') as 'add' | 'update' | 'remove';
    switch (operation) {
      case 'add':
        return knowledgeAddCommand.run(args);
      case 'update':
        return knowledgeUpdateCommand.run(args);
      case 'remove':
        return knowledgeRemoveCommand.run(args);
    }
  },
};
