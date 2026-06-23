import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AssetKind,
  AssetProvenanceOperation,
  AssetProvenanceSource,
  buildRuleScaffold,
  diagnoseRuleQuality,
  inspectSharkcraft,
  recordProvenance,
  renderRuleQualityText,
  RuleScaffoldKind,
} from '@shrkcrft/inspector';
import { formatRuleCompact, formatRuleFull, formatRulesForAi } from '@shrkcrft/rules';
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
import {
  knowledgeAddCommand,
  knowledgeRemoveCommand,
  knowledgeUpdateCommand,
} from './knowledge-author.command.ts';

export const rulesListCommand: ICommandHandler = {
  name: 'list',
  description: 'List all rules.',
  usage: 'shrk rules list [--top N] [--brief] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    let rules = inspection.ruleService.list();
    // --top N: deterministic, token-bounded slice (id-sorted so it's stable).
    const top = flagNumber(args, 'top');
    if (top !== undefined && top > 0) {
      rules = [...rules].sort((a, b) => a.id.localeCompare(b.id)).slice(0, top);
    }
    if (flagBool(args, 'json')) {
      // --brief: project to the high-signal fields (drop content/examples).
      const payload = flagBool(args, 'brief')
        ? rules.map((r) => ({
            id: r.id,
            type: r.type,
            priority: r.priority,
            title: r.title,
            scope: r.scope,
            tags: r.tags,
            appliesWhen: r.appliesWhen,
          }))
        : rules;
      process.stdout.write(asJson(payload) + '\n');
      return 0;
    }
    process.stdout.write(header(`Rules (${rules.length})`));
    for (const r of rules) process.stdout.write(formatRuleCompact(r) + '\n');
    return 0;
  },
};

export const rulesGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show full content of one rule.',
  usage: 'shrk rules get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk rules get <id>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const rule = inspection.ruleService.get(id);
    if (!rule) {
      process.stderr.write(`No rule with id "${id}".\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(rule) + '\n');
      return 0;
    }
    process.stdout.write(formatRuleFull(rule) + '\n');
    return 0;
  },
};

export const rulesRelevantCommand: ICommandHandler = {
  name: 'relevant',
  description: 'Return rules relevant to a task.',
  usage: 'shrk rules relevant --task "<task>" [--scope x,y] [--limit 10] [--ai] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const task = flagString(args, 'task');
    if (!task) {
      process.stderr.write('Missing --task\n');
      return 2;
    }
    const scope = flagList(args, 'scope');
    const tags = flagList(args, 'tag');
    const appliesWhen = flagList(args, 'appliesWhen');
    const limit = flagNumber(args, 'limit') ?? 10;

    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const rules = inspection.ruleService.getRelevant(task, {
      scope: scope.length ? scope : undefined,
      tags: tags.length ? tags : undefined,
      appliesWhen: appliesWhen.length ? appliesWhen : undefined,
      limit,
    });

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(rules) + '\n');
      return 0;
    }
    if (flagBool(args, 'ai')) {
      process.stdout.write(formatRulesForAi(rules) + '\n');
      return 0;
    }
    process.stdout.write(header(`Relevant rules for: ${task}`));
    for (const r of rules) process.stdout.write(formatRuleCompact(r) + '\n');
    return 0;
  },
};

function parseRuleScaffoldKind(value: string | undefined): RuleScaffoldKind {
  switch ((value ?? '').toLowerCase()) {
    case 'safety':
      return RuleScaffoldKind.Safety;
    case 'architecture':
      return RuleScaffoldKind.Architecture;
    case 'style':
      return RuleScaffoldKind.Style;
    case 'governance':
      return RuleScaffoldKind.Governance;
    case 'migration':
      return RuleScaffoldKind.Migration;
    case 'testing':
      return RuleScaffoldKind.Testing;
    case 'advisory':
      return RuleScaffoldKind.Advisory;
    default:
      return RuleScaffoldKind.Architecture;
  }
}

export const rulesScaffoldCommand: ICommandHandler = {
  name: 'scaffold',
  description:
    'Scaffold a new rule. Preview-only by default — writes nothing. Pass --write-preview to materialise the scaffold under .sharkcraft/fixes/.',
  usage:
    'shrk rules scaffold --id <id> [--kind architecture|safety|style|governance|migration|testing|advisory] [--title <t>] [--rationale <text>] [--owner <name>] [--good <code>] [--bad <code>] [--verification "<cmd>"] [--forbidden "<text>"] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk rules scaffold --id <id> [--kind <k>] [--write-preview]\n');
      return 2;
    }
    const kind = parseRuleScaffoldKind(flagString(args, 'kind'));
    const verification = flagList(args, 'verification');
    const forbidden = flagList(args, 'forbidden');
    const result = buildRuleScaffold({
      id,
      kind,
      title: flagString(args, 'title') ?? undefined,
      rationale: flagString(args, 'rationale') ?? undefined,
      owner: flagString(args, 'owner') ?? undefined,
      goodExample: flagString(args, 'good') ?? undefined,
      badExample: flagString(args, 'bad') ?? undefined,
      verificationCommands: verification.length > 0 ? verification : undefined,
      forbiddenActions: forbidden.length > 0 ? forbidden : undefined,
    });

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
      // Continue to write-preview side effect even in json mode for parity.
    } else {
      process.stdout.write(header(`Rule scaffold preview: ${id}`));
      process.stdout.write(`  kind:       ${result.kind}\n`);
      process.stdout.write(`  generated:  ${result.generatedAt}\n`);
      process.stdout.write(`  files:\n`);
      process.stdout.write(`    ${result.tsScaffold.path}\n`);
      process.stdout.write(`    ${result.jsonManifest.path}\n`);
      process.stdout.write(`    ${result.explainer.path}\n`);
      if (result.warnings.length > 0) {
        process.stdout.write('\n  warnings:\n');
        for (const w of result.warnings) process.stdout.write(`    • ${w}\n`);
      }
      process.stdout.write('\n--- TypeScript scaffold ---\n');
      process.stdout.write(result.tsScaffold.body);
      process.stdout.write('\n--- Next commands ---\n');
      for (const c of result.nextCommands) process.stdout.write(`  $ ${c}\n`);
      if (!flagBool(args, 'write-preview')) {
        process.stdout.write('\n  (preview only — pass --write-preview to materialise under .sharkcraft/fixes/)\n');
      }
    }

    if (flagBool(args, 'write-preview')) {
      const cwd = resolveCwd(args);
      const dir = nodePath.join(cwd, '.sharkcraft', 'fixes');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      for (const file of [result.tsScaffold, result.jsonManifest, result.explainer]) {
        const abs = nodePath.join(cwd, file.path);
        writeFileSync(abs, file.body, 'utf8');
      }
      process.stdout.write(`\nWrote 3 files under ${nodePath.join(cwd, '.sharkcraft', 'fixes')}\n`);
      // Record provenance for the scaffold.
      try {
        const isAgent = Boolean(process.env['SHARKCRAFT_AGENT']) ||
          Boolean(process.env['CLAUDE_CODE_SESSION']);
        recordProvenance({
          projectRoot: cwd,
          entry: {
            operation: AssetProvenanceOperation.Add,
            assetKind: AssetKind.Rule,
            assetId: id,
            source: isAgent ? AssetProvenanceSource.Agent : AssetProvenanceSource.Cli,
            previewPath: result.tsScaffold.path,
            ...(flagString(args, 'reason') ? { reason: flagString(args, 'reason')! } : {}),
          },
        });
      } catch {
        // best-effort — failing to record provenance must not break the scaffold.
      }
    }
    return 0;
  },
};

/**
 * Clone ParsedArgs with a flag override. Used by the rules add/
 * remove wrappers to force `type='rule'` before delegating to the
 * knowledge authoring path.
 */
function withFlagOverride(args: ParsedArgs, key: string, value: string): ParsedArgs {
  const flags = new Map(args.flags);
  flags.set(key, value);
  return {
    positional: [...args.positional],
    flags,
    multiFlags: args.multiFlags,
    ...(args.globalCwd ? { globalCwd: args.globalCwd } : {}),
  };
}

/**
 * `shrk rules add`.
 *
 * Mirror of `shrk knowledge add` with `type='rule'` forced. Rules in
 * SharkCraft are knowledge entries with `type='rule'`, so we reuse the
 * canonical `knowledge add` flow (preview, draft path, provenance) and
 * just enforce the type at the wrapper. Refuses if `--type` was passed
 * with a non-rule value.
 */
export const rulesAddCommand: ICommandHandler = {
  name: 'add',
  description:
    'Preview adding a new rule. Mirror of `knowledge add` with `type=rule` forced. Preview-only — pass --write-preview to materialise under .sharkcraft/authoring/.',
  usage:
    'shrk rules add --id <id> [--title <t>] [--priority critical|high|medium|low] [--summary <s>] [--content <text>] [--scope x,y] [--tag x,y] [--applies-when x,y] [--related a,b] [--reference kind:value[:required]] [--reason <text>] [--allow-overwrite] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = flagString(args, 'id') ?? args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk rules add --id <id> [...]\n');
      return 2;
    }
    const requestedType = flagString(args, 'type');
    if (requestedType && requestedType !== 'rule') {
      process.stderr.write(
        `Refused: \`shrk rules add\` forces type='rule'. Got --type ${requestedType}. Use \`shrk knowledge add\` for non-rule types.\n`,
      );
      return 2;
    }
    const next = withFlagOverride(args, 'type', 'rule');
    return knowledgeAddCommand.run(next);
  },
};

/**
 * `shrk rules remove <id>`.
 *
 * Mirror of `shrk knowledge remove` that first asserts the target id is
 * a rule (so an accidental `shrk rules remove some-knowledge-id` becomes
 * a hard refusal instead of silently removing a documentation entry).
 * Reference-checking is identical to `knowledge remove` — reverse
 * references refuse the preview unless `--force-preview` is set.
 */
export const rulesRemoveCommand: ICommandHandler = {
  name: 'remove',
  description:
    'Preview removal of a rule. Asserts type=rule then delegates to `knowledge remove` — same reference-check, same preview path, same provenance.',
  usage:
    'shrk rules remove <id> [--force-preview] [--reason <text>] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk rules remove <id> [--force-preview]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entry = inspection.knowledgeEntries.find((e) => e.id === id);
    if (!entry) {
      process.stderr.write(
        `Unknown id: ${id}. Use \`shrk rules list\` or \`shrk knowledge list\` to find one.\n`,
      );
      return 1;
    }
    if (entry.type !== 'rule') {
      process.stderr.write(
        `Entry "${id}" exists but type=${entry.type}, not "rule". Use \`shrk knowledge remove ${id}\` instead.\n`,
      );
      return 1;
    }
    return knowledgeRemoveCommand.run(args);
  },
};

/**
 * `shrk rules update <id>`.
 *
 * Rules in SharkCraft are stored as knowledge entries with `type='rule'`.
 * The dedicated `rules update` verb exists so the authoring surface for
 * rules feels first-class. It asserts the target id is a rule and then
 * delegates to the knowledge-update flow — same flags, same preview
 * location (`.sharkcraft/authoring/`), same provenance ledger.
 *
 * Provenance: written under `AssetKind.Knowledge` (the underlying data
 * model). The dedicated `rules scaffold` flow writes under
 * `AssetKind.Rule` for new rules; updates piggy-back on knowledge.
 */
export const rulesUpdateCommand: ICommandHandler = {
  name: 'update',
  description:
    'Preview an update to an existing rule. Thin wrapper over `knowledge update` (rules are knowledge entries with type="rule") — same flags, preview-first, provenance recorded.',
  usage:
    'shrk rules update <id> [--summary <s>] [--content <text>] [--priority critical|high|medium|low] [--add-related a,b] [--remove-related a,b] [--reference kind:value[:required]] [--remove-reference kind:value] [--mark-deprecated] [--unmark-deprecated] [--reason <text>] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk rules update <id> [...]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entry = inspection.knowledgeEntries.find((e) => e.id === id);
    if (!entry) {
      process.stderr.write(
        `Unknown id: ${id}. Use \`shrk rules list\` or \`shrk knowledge list\` to find one.\n`,
      );
      return 1;
    }
    if (entry.type !== 'rule') {
      process.stderr.write(
        `Entry "${id}" exists but type=${entry.type}, not "rule". Use \`shrk knowledge update ${id}\` instead.\n`,
      );
      return 1;
    }
    return knowledgeUpdateCommand.run(args);
  },
};

/**
 * `shrk rules lint` is the lint-style alias of `rules doctor`. It
 * defaults to strict (warnings + errors fail), supports `--fix-preview`
 * which materialises a smallest-change patch under
 * `.sharkcraft/fixes/rules-lint/<rule-id>.patch.md` per finding, and
 * never mutates source.
 */
export const rulesLintCommand: ICommandHandler = {
  name: 'lint',
  description:
    'Lint rules — alias of `rules doctor` with lint-style defaults. `--fix-preview` materialises smallest-change patches under .sharkcraft/fixes/rules-lint/ (preview only).',
  usage:
    'shrk rules lint [--id <ruleId>] [--advisory <ruleId,...>] [--fix-preview] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const rules = inspection.ruleService.list();
    const knownVerificationIds = new Set(
      (inspection.config?.verificationCommands ?? []).map((c) => c.id),
    );
    const advisoryFlag = flagList(args, 'advisory');
    const id = flagString(args, 'id');
    const report = diagnoseRuleQuality(
      rules,
      {
        ruleId: id ?? undefined,
        advisoryRuleIds: advisoryFlag.length > 0 ? advisoryFlag : undefined,
      },
      { knownVerificationIds },
    );

    const wantJson = flagBool(args, 'json');
    const wantFixPreview = flagBool(args, 'fix-preview');
    const wantWritePreview = flagBool(args, 'write-preview');

    // Build smallest-change preview suggestions per finding when --fix-preview.
    interface IPreviewSuggestion {
      ruleId: string;
      finding: string;
      suggestion: string;
    }
    const suggestions: IPreviewSuggestion[] = [];
    if (wantFixPreview) {
      for (const f of report.findings) {
        const ruleId = f.ruleId ?? 'unknown';
        const suggestion = buildSmallestRuleFix(f);
        if (suggestion) {
          suggestions.push({ ruleId, finding: f.code, suggestion });
        }
      }
    }

    if (wantJson) {
      process.stdout.write(asJson({ report, suggestions }) + '\n');
    } else {
      process.stdout.write(header('Rules lint'));
      process.stdout.write(renderRuleQualityText(report));
      if (wantFixPreview) {
        process.stdout.write('\n--- Fix-preview suggestions ---\n');
        if (suggestions.length === 0) {
          process.stdout.write('  (no automatable fixes — review findings manually)\n');
        } else {
          for (const s of suggestions) {
            process.stdout.write(`\n  ${s.ruleId} — ${s.finding}\n`);
            for (const line of s.suggestion.split('\n')) {
              process.stdout.write(`    ${line}\n`);
            }
          }
        }
        if (!wantWritePreview) {
          process.stdout.write(
            '\n  (preview only — pass --write-preview to materialise under .sharkcraft/fixes/rules-lint/)\n',
          );
        }
      }
    }

    if (wantFixPreview && wantWritePreview && suggestions.length > 0) {
      const dir = nodePath.join(cwd, '.sharkcraft', 'fixes', 'rules-lint');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      for (const s of suggestions) {
        const safeId = s.ruleId.replace(/[^a-z0-9._-]/gi, '_');
        const out = nodePath.join(dir, `${safeId}.${s.finding}.patch.md`);
        const body =
          `# Rules-lint fix preview\n\n` +
          `- rule:    ${s.ruleId}\n` +
          `- finding: ${s.finding}\n\n` +
          `${s.suggestion}\n`;
        writeFileSync(out, body, 'utf8');
      }
      process.stdout.write(
        `\nWrote ${suggestions.length} preview file(s) under ${nodePath.join(cwd, '.sharkcraft', 'fixes', 'rules-lint')}\n`,
      );
    }

    // Lint defaults to strict — warnings and errors both fail.
    return report.summary.errors + report.summary.warnings > 0 ? 1 : 0;
  },
};

function buildSmallestRuleFix(
  finding: { code: string; message: string; ruleId?: string | null },
): string | null {
  // Deterministic, opinionated smallest-change suggestions. We never invent
  // semantic content — the agent fills it in. The preview shows the shape.
  switch (finding.code) {
    case 'missing-owner':
      return `Add an \`owner\` to this rule:\n\n    owner: 'team-name@example.com'`;
    case 'missing-verification':
      return `Add at least one verificationCommand id from sharkcraft.config.ts:\n\n    actionHints: { verificationCommands: ['<id-from-config>'] }`;
    case 'missing-hints':
    case 'missing-action-hints':
      return `Add an \`actionHints\` block:\n\n    actionHints: {\n      commands: [{ command: 'shrk <cmd>' }],\n      verificationCommands: [],\n      forbiddenActions: [],\n    }`;
    case 'missing-commands-or-mcp':
      return `Add either \`actionHints.commands\` or \`actionHints.mcpTools\` so agents know which command to run.`;
    case 'missing-forbidden-actions':
      return `Add \`actionHints.forbiddenActions: ['<plain-language description>']\` so agents know what NOT to do.`;
    case 'missing-write-policy':
      return `Set \`actionHints.writePolicy\` to 'cli-only' | 'plan-first' | 'preview-only'.`;
    case 'missing-examples':
      return `Add a paired example to the rule's \`examples\` array:\n\n    examples: [\n      { kind: 'good', code: '<canonical correct sample>' },\n      { kind: 'bad',  code: '<typical mistake>' },\n    ]`;
    case 'vague-rule':
      return `Rewrite the rationale as a single, falsifiable sentence ("X must Y because Z").`;
    case 'advisory-not-marked':
      return `Either set \`advisory: true\` on the rule, or remove it from the \`--advisory\` list passed to \`rules lint\`.`;
    case 'advisory-has-unused-verification':
      return `Advisory rules don't enforce — drop \`actionHints.verificationCommands\`, or unmark advisory if the verification really should run.`;
    case 'verification-references-unknown-script':
      return `Either declare this command in \`sharkcraft.config.ts > verificationCommands[]\`, or change the rule to reference an existing one.`;
    default:
      return null;
  }
}

export const rulesDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description:
    'Rule quality doctor. Surfaces missing actionHints / verificationCommands / examples / owner, vague rules, advisory mismatch.',
  usage:
    'shrk rules doctor [--id <ruleId>] [--advisory <ruleId,...>] [--strict] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const rules = inspection.ruleService.list();
    const knownVerificationIds = new Set(
      (inspection.config?.verificationCommands ?? []).map((c) => c.id),
    );
    const advisoryFlag = flagList(args, 'advisory');
    const id = flagString(args, 'id');
    const report = diagnoseRuleQuality(
      rules,
      {
        ruleId: id ?? undefined,
        advisoryRuleIds: advisoryFlag.length > 0 ? advisoryFlag : undefined,
      },
      { knownVerificationIds },
    );
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
    } else {
      process.stdout.write(renderRuleQualityText(report));
    }
    if (flagBool(args, 'strict')) {
      return report.summary.errors + report.summary.warnings > 0 ? 1 : 0;
    }
    return report.summary.errors > 0 ? 1 : 0;
  },
};
