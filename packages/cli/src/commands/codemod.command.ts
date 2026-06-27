/**
 * `shrk codemod` (codemod-assist, NOT a codemod engine).
 *
 * Inventory + plan + checklist for a rule. Never rewrites source. The
 * preview surface mirrors `shrk fix preview` — write only under
 * `.sharkcraft/fixes/`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  affectedFromCheckReport,
  buildCodemodAssistReport,
  inspectSharkcraft,
  parseCustomCheckReportFromFile,
  renderCodemodAssistMarkdown,
} from '@shrkcrft/inspector';
import { formatRuleCompact } from '@shrkcrft/rules';
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

async function loadRule(args: ParsedArgs) {
  const ruleId = flagString(args, 'rule');
  if (!ruleId) {
    process.stderr.write('Missing --rule <ruleId>. Run `shrk codemod list` to see available rule ids.\n');
    return null;
  }
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const rule = inspection.ruleService.get(ruleId);
  if (!rule) {
    process.stderr.write(`No rule with id "${ruleId}". Run \`shrk codemod list\` to see available rule ids.\n`);
    return null;
  }
  return { rule, cwd };
}

/** `shrk codemod list` — enumerate the rule ids codemod-assist accepts. */
async function listRules(args: ParsedArgs): Promise<number> {
  const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
  let rules = inspection.ruleService.list();
  const top = flagNumber(args, 'top');
  if (top !== undefined && top > 0) {
    rules = [...rules].sort((a, b) => a.id.localeCompare(b.id)).slice(0, top);
  }
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson(rules.map((r) => ({ id: r.id, type: r.type, priority: r.priority, title: r.title }))) + '\n',
    );
    return 0;
  }
  process.stdout.write(header(`Codemod rules (${rules.length})`));
  for (const r of rules) process.stdout.write(formatRuleCompact(r) + '\n');
  return 0;
}

async function gatherAffected(args: ParsedArgs): Promise<readonly { path: string; note?: string }[]> {
  const fromReport = flagString(args, 'from-report');
  const out: { path: string; note?: string }[] = [];
  if (fromReport) {
    const parsed = parseCustomCheckReportFromFile(fromReport);
    if (parsed.ok) {
      for (const f of affectedFromCheckReport(parsed.report)) out.push({ path: f.path, note: f.note });
    } else {
      process.stderr.write(`Warning: --from-report parse failed: ${parsed.reason}\n`);
    }
  }
  for (const t of flagList(args, 'targets')) {
    out.push({ path: t });
  }
  return out;
}

function writeAssistOutputs(
  cwd: string,
  ruleId: string,
  markdown: string,
  scriptTemplate: { path: string; body: string },
): readonly string[] {
  const dir = nodePath.join(cwd, '.sharkcraft', 'fixes');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const safe = ruleId.replace(/[^a-zA-Z0-9]+/g, '-');
  const mdPath = nodePath.join(dir, `codemod-${safe}.md`);
  const scriptAbs = nodePath.join(cwd, scriptTemplate.path);
  writeFileSync(mdPath, markdown, 'utf8');
  writeFileSync(scriptAbs, scriptTemplate.body, 'utf8');
  return [mdPath, scriptAbs];
}

export const codemodCommand: ICommandHandler = {
  name: 'codemod',
  description:
    'Codemod-assist (NOT a codemod engine). Inventory + risk grouping + checklist + project-script template. Never rewrites source.',
  usage:
    'shrk codemod <list|inventory|plan|checklist> --rule <ruleId> [--from-report <path>] [--targets a,b,c] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0] ?? 'plan';
    if (!['list', 'inventory', 'plan', 'checklist'].includes(sub)) {
      process.stderr.write('Usage: shrk codemod <list|inventory|plan|checklist> --rule <ruleId>\n');
      return 2;
    }
    const inner: ParsedArgs = { ...args, positional: args.positional.slice(1) };
    // `list` enumerates rule ids and needs no --rule.
    if (sub === 'list') return listRules(inner);
    const loaded = await loadRule(inner);
    if (!loaded) return 1;
    const { rule, cwd } = loaded;
    const affectedFiles = await gatherAffected(inner);
    const report = buildCodemodAssistReport({
      rule,
      affectedFiles,
    });

    let exitCode = 0;
    if (sub === 'inventory') {
      // Just affected files — no checklist body.
      if (flagBool(inner, 'json')) {
        process.stdout.write(asJson({ schema: report.schema, ruleId: report.ruleId, affectedFiles: report.affectedFiles, riskGroups: report.riskGroups }) + '\n');
      } else {
        process.stdout.write(header(`Codemod inventory: ${report.ruleId}`));
        if (report.affectedFiles.length === 0) {
          process.stdout.write('  (no affected files supplied — pass --from-report or --targets)\n');
        }
        for (const f of report.affectedFiles) {
          process.stdout.write(`  ${f.risk.padEnd(7)} ${f.path}${f.consumerCount !== undefined ? ` (consumers: ${f.consumerCount})` : ''}\n`);
        }
      }
    } else if (sub === 'checklist') {
      if (flagBool(inner, 'json')) {
        process.stdout.write(asJson({ schema: report.schema, ruleId: report.ruleId, checklist: report.checklist, validationCommands: report.validationCommands }) + '\n');
      } else {
        process.stdout.write(header(`Codemod checklist: ${report.ruleId}`));
        for (const c of report.checklist) {
          process.stdout.write(`  - [ ] (${c.risk}) ${c.description}\n`);
          if (c.suggestedCommand) process.stdout.write(`        $ ${c.suggestedCommand}\n`);
        }
        process.stdout.write('\nValidation:\n');
        for (const v of report.validationCommands) process.stdout.write(`  $ ${v}\n`);
      }
    } else {
      // plan — full report
      if (flagBool(inner, 'json')) {
        process.stdout.write(asJson(report) + '\n');
      } else {
        process.stdout.write(renderCodemodAssistMarkdown(report));
      }
    }

    if (flagBool(inner, 'write-preview')) {
      const md = renderCodemodAssistMarkdown(report);
      const written = writeAssistOutputs(cwd, report.ruleId, md, report.scriptTemplate);
      process.stdout.write(`\nWrote ${written.length} files:\n`);
      for (const w of written) process.stdout.write(`  ${w}\n`);
    } else if (sub === 'plan' && !flagBool(inner, 'json')) {
      process.stdout.write('\n  (preview only — pass --write-preview to materialise under .sharkcraft/fixes/)\n');
    }

    return exitCode;
  },
};
