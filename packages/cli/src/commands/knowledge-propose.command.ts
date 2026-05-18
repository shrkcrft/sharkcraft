/**
 * `shrk knowledge propose`.
 *
 * AST-driven inference of stub knowledge entries for exported top-level
 * constructs that are not yet covered by an existing entry. Preview-first.
 * `--write` materialises draft files under `.sharkcraft/authoring/proposed/`
 * so the user can hand-edit them before pasting into the canonical
 * knowledge module.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AssetKind,
  AssetProvenanceOperation,
  KNOWLEDGE_PROPOSE_SCHEMA,
  proposeKnowledge,
  recordProvenance,
  renderKnowledgeProposeMarkdown,
  type IKnowledgeProposeReport,
  type IProposedKnowledgeEntry,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';
import { detectAuthoringSource } from '../authoring/authoring-kit.ts';

function renderProposalAsTs(p: IProposedKnowledgeEntry): string {
  const obj = {
    id: p.id,
    title: p.title,
    type: p.type,
    priority: p.priority,
    scope: p.scope,
    tags: p.tags,
    appliesWhen: p.appliesWhen,
    summary: p.summary,
    content: p.content,
    references: p.references,
  };
  const body = JSON.stringify(obj, null, 2);
  return `// Proposed by \`shrk knowledge propose\`.\n// Source: ${p.source.file}:${p.source.line} (${p.source.kind}).\n// Replace title/summary/content with the real *why*, then paste into your\n// knowledge module (e.g. \`sharkcraft/knowledge.ts\`).\nexport const proposed_${p.id.replace(/[^a-zA-Z0-9]/g, '_')} = ${body};\n`;
}

function writeDraftFiles(cwd: string, report: IKnowledgeProposeReport): string[] {
  if (report.proposals.length === 0) return [];
  const outDir = nodePath.join(cwd, '.sharkcraft', 'authoring', 'proposed');
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const p of report.proposals) {
    const safe = p.id.replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = nodePath.join(outDir, `${safe}.ts`);
    writeFileSync(file, renderProposalAsTs(p));
    written.push(file);
  }
  // Manifest: one JSON listing every proposal for replay.
  const manifestPath = nodePath.join(outDir, '_manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schema: KNOWLEDGE_PROPOSE_SCHEMA,
        generatedAt: new Date().toISOString(),
        proposals: report.proposals.map((p) => ({ id: p.id, file: p.source.file, line: p.source.line })),
      },
      null,
      2,
    ),
  );
  written.push(manifestPath);
  return written;
}

export const knowledgeProposeCommand: ICommandHandler = {
  name: 'propose',
  description:
    'Propose stub knowledge entries for exported top-level constructs that lack coverage. Preview-first; --write materialises drafts under .sharkcraft/authoring/proposed/.',
  usage:
    'shrk knowledge propose [--path <file>] [--symbol <name>] [--since <ref>|--all] [--json] [--write]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const path = flagString(args, 'path');
    const symbol = flagString(args, 'symbol');
    const sinceFlag = flagString(args, 'since');
    const all = flagBool(args, 'all');
    const since = path
      ? undefined
      : symbol
        ? undefined
        : all
          ? null
          : sinceFlag ?? undefined;
    const report = await proposeKnowledge({
      cwd,
      ...(path ? { path } : {}),
      ...(symbol ? { symbol } : {}),
      ...(since !== undefined ? { since } : {}),
    });

    if (flagBool(args, 'json')) {
      const payload = flagBool(args, 'write')
        ? { ...report, writtenFiles: writeDraftFiles(cwd, report) }
        : report;
      process.stdout.write(asJson(payload) + '\n');
      if (flagBool(args, 'write') && report.proposals.length > 0) {
        recordProvenance({
          projectRoot: cwd,
          entry: {
            operation: AssetProvenanceOperation.Preview,
            assetKind: AssetKind.Knowledge,
            assetId: 'knowledge-propose',
            source: detectAuthoringSource().source,
            extra: { authoringOp: 'propose', count: report.proposals.length },
          },
        });
      }
      return report.proposals.length === 0 ? 0 : 0;
    }

    process.stdout.write(renderKnowledgeProposeMarkdown(report));
    process.stdout.write('\n');

    if (flagBool(args, 'write')) {
      const written = writeDraftFiles(cwd, report);
      if (written.length === 0) {
        process.stdout.write('\nNo files written (no proposals).\n');
      } else {
        process.stdout.write(`\nWrote ${written.length} files under .sharkcraft/authoring/proposed/:\n`);
        for (const f of written) {
          process.stdout.write(`  • ${nodePath.relative(cwd, f)}\n`);
        }
        recordProvenance({
          projectRoot: cwd,
          entry: {
            operation: AssetProvenanceOperation.Preview,
            assetKind: AssetKind.Knowledge,
            assetId: 'knowledge-propose',
            source: detectAuthoringSource().source,
            extra: { authoringOp: 'propose', count: report.proposals.length },
          },
        });
      }
    } else if (report.proposals.length > 0) {
      process.stdout.write('\n(preview only — pass --write to materialise under .sharkcraft/authoring/proposed/)\n');
    }
    return 0;
  },
};
