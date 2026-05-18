/**
 * `shrk why <file>` — closes the dangling promise from
 * `ide.command.ts:112`. For any file path under the project root,
 * surface:
 *
 *   - inferred package / layer
 *   - path conventions whose canonical path matches
 *   - rules whose scope / tags / appliesWhen overlap with the file's
 *     path tokens (top-N by priority)
 *   - boundary rules whose `from` glob matches the file (these dictate
 *     what the file is allowed to import)
 *   - knowledge entries that reference the file or its basename
 *   - suggested next commands
 *
 * Read-only. Pure composition over the live inspection — no LLM,
 * no shell, no writes.
 *
 * Symbol queries (`shrk why <symbol>`) intentionally route to
 * `shrk knowledge search` instead of trying to ground a symbol
 * without an AST pass. Honest about scope.
 */

import {
  buildWhyReport,
  inspectSharkcraft,
  type IWhyReport,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

export const whyCommand: ICommandHandler = {
  name: 'why',
  description:
    'Explain the constraints that apply to a file: package / layer, path conventions, rules, boundary rules, and related knowledge. Read-only. Pure composition — no LLM, no shell.',
  usage: 'shrk why <file> [--limit 10] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const target = args.positional[0];
    if (!target) {
      process.stderr.write(
        'Usage: shrk why <file>\n' +
          '\nFor symbol queries, use:\n  $ shrk knowledge search "<symbol>"\n' +
          '  $ shrk search "<symbol>"\n',
      );
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const limit = flagNumber(args, 'limit') ?? 10;
    const report = buildWhyReport({
      inspection,
      projectRoot: cwd,
      target,
      limit,
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    renderHuman(report);
    return 0;
  },
};

function renderHuman(report: IWhyReport): void {
  process.stdout.write(header(`Why: ${report.target.relativePath}`));
  process.stdout.write(`  kind:       ${report.target.kind}\n`);
  if (report.inferredPackage) {
    process.stdout.write(`  package:    ${report.inferredPackage}\n`);
  }
  if (report.inferredLayer) {
    process.stdout.write(`  layer:      ${report.inferredLayer}\n`);
  }
  if (report.target.kind === 'missing') {
    process.stdout.write(
      `\n  (file not on disk — results below are based on the input path string only)\n`,
    );
  }

  if (report.pathConventions.length > 0) {
    process.stdout.write('\nPath conventions:\n');
    for (const p of report.pathConventions) {
      process.stdout.write(`  ${p.id.padEnd(35)} ${p.title}\n`);
      process.stdout.write(`    canonical: ${p.canonicalPath}\n`);
      if (p.source) process.stdout.write(`    source: ${p.source}\n`);
    }
  }

  if (report.rules.length > 0) {
    process.stdout.write('\nApplicable rules (top by priority):\n');
    for (const r of report.rules) {
      process.stdout.write(`  ${r.id.padEnd(40)} [${r.priority}] ${r.title}\n`);
      process.stdout.write(`    ${r.reason}\n`);
      if (r.source) process.stdout.write(`    source: ${r.source}\n`);
    }
  }

  if (report.boundaries.length > 0) {
    process.stdout.write('\nBoundary rules (constrain imports from this file):\n');
    for (const b of report.boundaries) {
      const sev = b.severity ? `[${b.severity}]` : '';
      process.stdout.write(`  ${b.id.padEnd(40)} ${sev} ${b.title}\n`);
      if (b.forbiddenImports && b.forbiddenImports.length > 0) {
        process.stdout.write(`    forbidden: ${b.forbiddenImports.slice(0, 5).join(', ')}\n`);
      }
      if (b.allowedImports && b.allowedImports.length > 0) {
        process.stdout.write(`    allowed:   ${b.allowedImports.slice(0, 5).join(', ')}\n`);
      }
      if (b.source) process.stdout.write(`    source: ${b.source}\n`);
    }
  }

  if (report.knowledge.length > 0) {
    process.stdout.write('\nRelated knowledge:\n');
    for (const k of report.knowledge) {
      process.stdout.write(`  ${k.id.padEnd(35)} (${k.type}) ${k.title}\n`);
      process.stdout.write(`    ${k.reason}\n`);
    }
  }

  if (report.suggestedNext.length > 0) {
    process.stdout.write('\nSuggested next:\n');
    for (const cmd of report.suggestedNext) {
      process.stdout.write(`  $ ${cmd}\n`);
    }
  }

  if (
    report.pathConventions.length === 0 &&
    report.rules.length === 0 &&
    report.boundaries.length === 0 &&
    report.knowledge.length === 0
  ) {
    process.stdout.write(
      '\n(no registry entries matched. The file may be outside the conventions ' +
        'or the workspace may not have rules / paths defined yet.)\n',
    );
  }
}
