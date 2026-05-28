import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AssetKind,
  AssetProvenanceOperation,
  AssetProvenanceSource,
  buildTemplateAuthoringPreview,
  buildTemplateDriftReport,
  inspectSharkcraft,
  recordProvenance,
  TemplateAuthoringOperation,
  TemplateDriftStatus,
  type ITemplateAuthoringInput,
  type ITemplateUpdateOps,
} from '@shrkcrft/inspector';
import {
  detectAuthoringSource,
  multiFlagValues,
  writeAuthoringDrafts,
} from '../authoring/authoring-kit.ts';
import { applyTemplateUpdate } from '../asset-preview/apply-template-update.ts';
import type { ITemplateUpdateApplyInput } from '../asset-preview/apply-template-update.ts';
import { previewTemplate } from '@shrkcrft/templates';
import type { ITemplateDefinition as ITemplateDefinitionImport } from '@shrkcrft/templates';
import { buildNameVariables } from '@shrkcrft/generator';
import {
  flagBool,
  flagList,
  flagString,
  flagVars,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { maybeRunInWatchMode } from '../output/watch-loop.ts';
import { renderFailureHints, templateDriftHints } from '../output/failure-hints.ts';
import {
  enrichWithLlmRecommendations,
  renderRecommendationsMarkdown,
  type IRecommendationEnvelope,
} from '@shrkcrft/ai';

export const templatesVarsCommand: ICommandHandler = {
  name: 'vars',
  description: 'Show the variables a template accepts (required/optional/defaults/examples).',
  usage: 'shrk [--cwd <dir>] templates vars <templateId> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk templates vars <templateId>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const template = inspection.templateRegistry.get(id);
    if (!template) {
      process.stderr.write(`No template with id "${id}".\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          id: template.id,
          name: template.name,
          description: template.description,
          variables: template.variables.map((v) => ({
            name: v.name,
            required: v.required ?? false,
            description: v.description ?? '',
            default: v.default,
            choices: v.choices ?? [],
            examples: v.examples ?? [],
            pattern: v.pattern ? v.pattern.source : undefined,
          })),
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Template variables: ${template.id}`));
    process.stdout.write(kv('name', template.name) + '\n');
    process.stdout.write(kv('description', template.description) + '\n\n');
    if (template.variables.length === 0) {
      process.stdout.write('(no variables)\n');
      return 0;
    }
    for (const v of template.variables) {
      const tag = v.required ? '*required' : ' optional';
      process.stdout.write(`  ${tag}  ${v.name}\n`);
      if (v.description) process.stdout.write(`             ${v.description}\n`);
      if (v.default) process.stdout.write(`             default: ${v.default}\n`);
      if (v.choices?.length) {
        process.stdout.write(`             choices: ${v.choices.join(', ')}\n`);
      }
      if (v.examples?.length) {
        process.stdout.write(`             examples: ${v.examples.join(', ')}\n`);
      }
      if (v.pattern) process.stdout.write(`             pattern: ${v.pattern.source}\n`);
    }
    const exampleVars = template.variables
      .map((v) => `--var ${v.name}=${v.examples?.[0] ?? v.default ?? '<value>'}`)
      .join(' ');
    process.stdout.write(`\nExample:\n  $ shrk gen ${template.id} <name> ${exampleVars} --dry-run\n`);
    return 0;
  },
};

export const templatesListCommand: ICommandHandler = {
  name: 'list',
  description: 'List available templates.',
  usage: 'shrk templates list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const list = inspection.templateRegistry.list();
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(list.map((t) => ({ id: t.id, name: t.name, description: t.description, tags: t.tags }))) + '\n');
      return 0;
    }
    process.stdout.write(header(`Templates (${list.length})`));
    for (const t of list) {
      process.stdout.write(`  ${t.id.padEnd(28)} — ${t.name}\n`);
      process.stdout.write(`      ${t.description}\n`);
      if (t.tags.length) process.stdout.write(`      tags: ${t.tags.join(', ')}\n`);
    }
    return 0;
  },
};

export const templatesGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show one template.',
  usage: 'shrk templates get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk templates get <id>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const template = inspection.templateRegistry.get(id);
    if (!template) {
      process.stderr.write(`No template with id "${id}".\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      const safe = {
        id: template.id,
        name: template.name,
        description: template.description,
        tags: template.tags,
        scope: template.scope,
        appliesWhen: template.appliesWhen,
        variables: template.variables,
        postGenerationNotes: template.postGenerationNotes ?? [],
        related: template.related ?? [],
      };
      process.stdout.write(asJson(safe) + '\n');
      return 0;
    }
    process.stdout.write(header(`Template: ${template.id}`));
    process.stdout.write(`Name: ${template.name}\n`);
    process.stdout.write(`Description: ${template.description}\n`);
    if (template.tags.length) process.stdout.write(`Tags: ${template.tags.join(', ')}\n`);
    if (template.scope.length) process.stdout.write(`Scope: ${template.scope.join(', ')}\n`);
    if (template.appliesWhen.length) process.stdout.write(`appliesWhen: ${template.appliesWhen.join(', ')}\n`);
    if (template.variables.length) {
      process.stdout.write(`Variables:\n`);
      for (const v of template.variables) {
        process.stdout.write(
          `  - ${v.name}${v.required ? ' (required)' : ''}${v.default ? ` = ${v.default}` : ''}${v.description ? ` — ${v.description}` : ''}\n`,
        );
      }
    }
    return 0;
  },
};

export const templatesSearchCommand: ICommandHandler = {
  name: 'search',
  description: 'Search templates.',
  usage: 'shrk templates search <query>',
  async run(args: ParsedArgs): Promise<number> {
    const query = args.positional.join(' ');
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const results = inspection.templateRegistry.search(query);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(results.map((t) => ({ id: t.id, name: t.name, description: t.description }))) + '\n');
      return 0;
    }
    process.stdout.write(header(`Templates (${results.length})`));
    for (const t of results) process.stdout.write(`  ${t.id.padEnd(28)} — ${t.name}\n`);
    return 0;
  },
};

export const templatesPreviewCommand: ICommandHandler = {
  name: 'preview',
  description: 'Render a template preview without writing files.',
  usage: 'shrk templates preview <id> [--var key=value ...] [<name>]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    const maybeName = args.positional[1];
    if (!id) {
      process.stderr.write('Usage: shrk templates preview <id> [--var key=value ...]\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const template = inspection.templateRegistry.get(id);
    if (!template) {
      process.stderr.write(`No template with id "${id}".\n`);
      return 1;
    }

    const nameVars = maybeName ? buildNameVariables(maybeName) : {};
    const values = { ...nameVars, ...flagVars(args) };
    const preview = previewTemplate(template, values);

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(preview) + '\n');
      return preview.validation.valid && preview.rendered ? 0 : 1;
    }

    if (!preview.validation.valid) {
      process.stderr.write('Variable validation failed:\n');
      for (const issue of preview.validation.issues) {
        process.stderr.write(`  - ${issue.variable}: ${issue.message}\n`);
      }
      return 1;
    }

    process.stdout.write(header(`Template preview: ${template.id}`));
    for (const f of preview.rendered!.files) {
      process.stdout.write(`\n--- ${f.targetPath} ---\n`);
      process.stdout.write(f.content);
      if (!f.content.endsWith('\n')) process.stdout.write('\n');
    }
    if (preview.rendered!.postGenerationNotes.length) {
      process.stdout.write('\nPost-generation notes:\n');
      for (const note of preview.rendered!.postGenerationNotes) {
        process.stdout.write(`  • ${note}\n`);
      }
    }
    return 0;
  },
};

export const templatesDriftCommand: ICommandHandler = {
  name: 'drift',
  description:
    'Verify every registered template against the workspace. Severity controls and `--watch [--once] [--debounce N]` supported. `--llm-recommendations` layers a local-LLM-derived list of concrete next-steps on top of the deterministic findings (no-op when no provider reachable). Read-only.',
  usage:
    'shrk templates drift [--template <id>] [--pack <packId>] [--var key=value ...] [--min-severity error|warning|info] [--hide <code>[,<code>...]] [--strict] [--ci] [--format text|markdown|html|json] [--report] [--output <path>] [--json] [--llm-recommendations] [--provider auto|ollama|llamacpp] [--watch [--once] [--debounce N]]',
  async run(args: ParsedArgs): Promise<number> {
    const watchExit = await maybeRunInWatchMode(args, templatesDriftImpl);
    if (watchExit !== null) return watchExit;
    return templatesDriftImpl(args);
  },
};

async function templatesDriftImpl(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const report = buildTemplateDriftReport(inspection, {
      ...(flagString(args, 'template') ? { templateId: flagString(args, 'template')! } : {}),
      ...(flagString(args, 'pack') ? { packId: flagString(args, 'pack')! } : {}),
      sampleVars: flagVars(args),
    });

    // Severity + hide + strict + ci controls.
    const minSeverityRaw = (flagString(args, 'min-severity') ?? '').toLowerCase();
    const hideCodes = new Set(
      (flagString(args, 'hide') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const strict = flagBool(args, 'strict');
    const ci = flagBool(args, 'ci');
    const formatRaw = (flagString(args, 'format') ?? '').toLowerCase();
    const wantJson = flagBool(args, 'json') || formatRaw === 'json';
    const wantMarkdown = formatRaw === 'markdown' || formatRaw === 'md';
    const wantHtml = formatRaw === 'html';
    const wantReport = flagBool(args, 'report');
    const output = flagString(args, 'output');

    const severityRank: Record<string, number> = { info: 1, warning: 2, error: 3 };
    const minRank = severityRank[minSeverityRaw] ?? 1;

    // Filter / re-classify issues per template entry.
    const filteredEntries = report.entries.map((e) => {
      const issues = e.issues.filter((i) => {
        if (hideCodes.has(i.code)) return false;
        const rank = severityRank[i.severity] ?? 1;
        return rank >= minRank;
      });
      // Strict mode upgrades warnings → errors for the purpose of exit code.
      const effectiveIssues = strict
        ? issues.map((i) => (i.severity === 'warning' ? { ...i, severity: 'error' as const } : i))
        : issues;
      const status = effectiveIssues.some((i) => i.severity === 'error')
        ? TemplateDriftStatus.Fail
        : effectiveIssues.some((i) => i.severity === 'warning')
          ? TemplateDriftStatus.Warn
          : TemplateDriftStatus.Pass;
      return { ...e, issues: effectiveIssues, status };
    });
    let filteredPass = 0;
    let filteredWarn = 0;
    let filteredFail = 0;
    for (const e of filteredEntries) {
      if (e.status === TemplateDriftStatus.Pass) filteredPass++;
      else if (e.status === TemplateDriftStatus.Warn) filteredWarn++;
      else filteredFail++;
    }
    const wantLlmRecs = flagBool(args, 'llm-recommendations');
    const llmEnvelope: IRecommendationEnvelope | null = wantLlmRecs
      ? await enrichWithLlmRecommendations({
          surface: 'templates-drift',
          deterministicSummary: summariseDriftEntries(filteredEntries),
          providerKind: flagString(args, 'provider') ?? undefined,
          ask: 'For each FAIL or WARN entry, propose ONE concrete fix the maintainer can apply — name the specific field in `sharkcraft/templates.ts` (or a peer file) to edit. Skip PASS entries unless something is genuinely worth nudging.',
          maxTokens: 1024,
        })
      : null;

    const ciPayload = {
      ...report,
      entries: filteredEntries,
      pass: filteredPass,
      warn: filteredWarn,
      fail: filteredFail,
      ci: {
        ci,
        strict,
        minSeverity: minSeverityRaw || 'info',
        hideCodes: [...hideCodes],
      },
      ...(llmEnvelope ? { llmRecommendations: llmEnvelope } : {}),
    };

    const exitNonZero = ci
      ? filteredFail > 0 || (strict && filteredWarn > 0)
      : filteredFail > 0;

    if (wantReport || output) {
      const reportsDir = nodePath.join(cwd, '.sharkcraft', 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const outPath = output
        ? nodePath.isAbsolute(output)
          ? output
          : nodePath.resolve(cwd, output)
        : nodePath.join(reportsDir, `template-drift-${ts}.json`);
      writeFileSync(outPath, JSON.stringify(ciPayload, null, 2), 'utf8');
      if (!wantJson && !wantMarkdown && !wantHtml) {
        process.stdout.write(`Wrote report → ${outPath}\n`);
      }
    }

    if (wantJson) {
      process.stdout.write(asJson(ciPayload) + '\n');
      return exitNonZero ? 1 : 0;
    }
    if (wantMarkdown) {
      process.stdout.write(renderDriftMarkdown(ciPayload));
      return exitNonZero ? 1 : 0;
    }
    if (wantHtml) {
      process.stdout.write(renderDriftHtml(ciPayload));
      return exitNonZero ? 1 : 0;
    }
    process.stdout.write(header(`Template drift (${ciPayload.totalTemplates})`));
    process.stdout.write(`pass=${ciPayload.pass} warn=${ciPayload.warn} fail=${ciPayload.fail}\n\n`);
    for (const e of filteredEntries) {
      if (e.issues.length === 0 && e.status === TemplateDriftStatus.Pass) continue;
      const tag = e.status === TemplateDriftStatus.Pass ? 'PASS' : e.status === TemplateDriftStatus.Warn ? 'WARN' : 'FAIL';
      process.stdout.write(`  ${tag.padEnd(5)} ${e.templateId}${e.templateName ? ` — ${e.templateName}` : ''}\n`);
      for (const i of e.issues) {
        process.stdout.write(`         ${i.severity}: ${i.code} — ${i.message}\n`);
        if (i.suggestedFix) process.stdout.write(`         ↳ ${i.suggestedFix}\n`);
      }
    }
    if (exitNonZero) {
      process.stdout.write(renderFailureHints(templateDriftHints()));
    }
    if (llmEnvelope) {
      process.stdout.write('\n');
      process.stdout.write(renderRecommendationsMarkdown(llmEnvelope));
    }
    return exitNonZero ? 1 : 0;
}

function summariseDriftEntries(entries: ReadonlyArray<{
  templateId: string;
  templateName?: string;
  status: TemplateDriftStatus;
  issues: ReadonlyArray<{ severity: 'info' | 'warning' | 'error'; code: string; message: string; suggestedFix?: string }>;
}>): string {
  const lines: string[] = [];
  for (const e of entries) {
    const tag = e.status === TemplateDriftStatus.Pass ? 'PASS' : e.status === TemplateDriftStatus.Warn ? 'WARN' : 'FAIL';
    lines.push(`## [${tag}] ${e.templateId}${e.templateName ? ` — ${e.templateName}` : ''}`);
    if (e.issues.length === 0) {
      lines.push('(no issues)');
    } else {
      for (const i of e.issues) {
        lines.push(`- ${i.severity} \`${i.code}\` — ${i.message}${i.suggestedFix ? ` (suggested: ${i.suggestedFix})` : ''}`);
      }
    }
    lines.push('');
  }
  if (lines.length === 0) lines.push('(no templates in this drift report)');
  return lines.join('\n');
}

interface ITemplateDriftCiPayload {
  totalTemplates: number;
  pass: number;
  warn: number;
  fail: number;
  entries: readonly { templateId: string; templateName?: string; status: TemplateDriftStatus; issues: readonly { severity: 'info' | 'warning' | 'error'; code: string; message: string; suggestedFix?: string }[] }[];
  ci: { ci: boolean; strict: boolean; minSeverity: string; hideCodes: readonly string[] };
}

function renderDriftMarkdown(p: ITemplateDriftCiPayload): string {
  const out: string[] = [];
  out.push('# Template drift');
  out.push('');
  out.push(`- total: ${p.totalTemplates}`);
  out.push(`- pass=${p.pass}, warn=${p.warn}, fail=${p.fail}`);
  if (p.ci.minSeverity !== 'info' || p.ci.hideCodes.length > 0 || p.ci.strict) {
    out.push(`- filters: min-severity=${p.ci.minSeverity}, strict=${p.ci.strict}, hide=[${p.ci.hideCodes.join(', ')}]`);
  }
  out.push('');
  for (const e of p.entries) {
    if (e.issues.length === 0 && e.status === TemplateDriftStatus.Pass) continue;
    const tag = e.status === TemplateDriftStatus.Pass ? 'PASS' : e.status === TemplateDriftStatus.Warn ? 'WARN' : 'FAIL';
    out.push(`## ${tag} — \`${e.templateId}\`${e.templateName ? ` (${e.templateName})` : ''}`);
    for (const i of e.issues) {
      out.push(`- **${i.severity}** \`${i.code}\` — ${i.message}`);
      if (i.suggestedFix) out.push(`  - ↳ ${i.suggestedFix}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function renderDriftHtml(p: ITemplateDriftCiPayload): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const blocks: string[] = [];
  for (const e of p.entries) {
    if (e.issues.length === 0 && e.status === TemplateDriftStatus.Pass) continue;
    const items = e.issues
      .map((i) => `<li><b>${esc(i.severity)}</b> <code>${esc(i.code)}</code> — ${esc(i.message)}${i.suggestedFix ? `<br><small>↳ ${esc(i.suggestedFix)}</small>` : ''}</li>`)
      .join('');
    blocks.push(`<section><h2>${esc(e.status)} — <code>${esc(e.templateId)}</code></h2><ul>${items}</ul></section>`);
  }
  return `<!doctype html><meta charset="utf-8"><title>Template drift</title>
<style>body{font:14px/1.4 sans-serif;margin:1rem}h2{margin-top:1rem}code{background:#f6f8fa;padding:0 .25rem}</style>
<h1>Template drift</h1>
<p>total=${p.totalTemplates}, pass=${p.pass}, warn=${p.warn}, fail=${p.fail}</p>
${blocks.join('')}
`;
}

export const templatesVerifyPathsCommand: ICommandHandler = {
  name: 'verify-paths',
  description:
    'Verify template sample paths against registered path conventions. Subset of `templates drift`.',
  usage: 'shrk templates verify-paths [--template <id>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const report = buildTemplateDriftReport(inspection, {
      ...(flagString(args, 'template') ? { templateId: flagString(args, 'template')! } : {}),
    });
    const filtered = report.entries.filter((e) =>
      e.issues.some((i) => i.code === 'forbidden-legacy-path' || i.code === 'path-no-convention'),
    );
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ entries: filtered }) + '\n');
      return filtered.some((e) => e.issues.some((i) => i.severity === 'error')) ? 1 : 0;
    }
    process.stdout.write(header(`Template path verification (${filtered.length})`));
    if (filtered.length === 0) {
      process.stdout.write('  all templates align with path conventions.\n');
      return 0;
    }
    for (const e of filtered) {
      process.stdout.write(`  ${e.templateId}:\n`);
      for (const i of e.issues) {
        if (i.code !== 'forbidden-legacy-path' && i.code !== 'path-no-convention') continue;
        process.stdout.write(`    ${i.severity}: ${i.message}\n`);
      }
    }
    return 0;
  },
};

export const templatesSmokeCommand: ICommandHandler = {
  name: 'smoke',
  description: 'Render every template with a sample name and report errors. Same as `templates drift` for now.',
  usage: 'shrk templates smoke [--json]',
  async run(args: ParsedArgs): Promise<number> {
    return templatesDriftCommand.run(args) as Promise<number>;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Template authoring stack: scaffold / add / doctor.
//
// Preview-first; writes only under
// `.sharkcraft/authoring/templates/`. Provenance recorded on write-preview.
// SharkCraft is not a template IDE; this is a thin, deterministic scaffold +
// validation surface that pairs with `shrk apply --asset-preview`.
// ─────────────────────────────────────────────────────────────────────────────

interface ITemplateScaffoldInput {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly scope: readonly string[];
  readonly appliesWhen: readonly string[];
  readonly producedAnchors: readonly string[];
  readonly requiredAnchors: readonly string[];
  readonly requiredProfileIds: readonly string[];
  readonly requiredHelperIds: readonly string[];
  readonly registrationHintIds: readonly string[];
  readonly forbiddenPaths: readonly string[];
}

function slugifyId(s: string): string {
  return s.replace(/[^a-z0-9.-]/gi, '-').toLowerCase();
}

function buildTemplateScaffold(input: ITemplateScaffoldInput): { tsBody: string; explainer: string } {
  const ts = `// Template scaffold preview. TODO bodies only — fill in before
// running \`shrk apply --asset-preview\`.
//
// Id:    ${input.id}
// Title: ${input.title}
import type { ITemplateDefinition } from '@shrkcrft/templates';

export const template: ITemplateDefinition = {
  id: '${input.id}',
  title: '${input.title.replace(/'/g, "\\'")}',
  description: '${input.description.replace(/'/g, "\\'")}',
  tags: ${JSON.stringify(input.tags)},
  scope: ${JSON.stringify(input.scope)},
  appliesWhen: ${JSON.stringify(input.appliesWhen)},
  // Required metadata (fill in or remove if not applicable).
  producedAnchors: ${JSON.stringify(input.producedAnchors)},
  requiredAnchors: ${JSON.stringify(input.requiredAnchors)},
  requiredProfileIds: ${JSON.stringify(input.requiredProfileIds)},
  requiredHelperIds: ${JSON.stringify(input.requiredHelperIds)},
  registrationHintIds: ${JSON.stringify(input.registrationHintIds)},
  variables: [
    {
      name: 'name',
      required: true,
      description: 'TODO: describe the primary variable.',
    },
  ],
  // TODO: fill in. Forbidden path fragments to avoid: ${JSON.stringify(input.forbiddenPaths)}.
  files: (vars: Record<string, string>) => {
    const name = vars['name'] ?? 'placeholder';
    return [
      {
        // TODO: confirm canonical targetPath before \`shrk apply --write\`.
        targetPath: \`.sharkcraft/preview/${input.id}/\${name}.ts\`,
        content: '// TODO: template body for ${input.id}.\\n',
      },
    ];
  },
  postGenerationNotes: [
    'Confirm canonical targetPath before running shrk apply --write.',
  ],
};

export default template;
`;
  const explainer = `# Template scaffold: ${input.id}

Generated by \`shrk templates scaffold\`.

## Next

1. Edit the draft at \`.sharkcraft/authoring/templates/${slugifyId(input.id)}.draft.ts\` —
   fill in \`files\`, variables, and metadata.
2. Validate with:
   - \`shrk templates drift --min-severity warning\`
   - \`shrk self-config doctor\`
   - \`shrk packs signature-status\` (if this is a pack-contributed template)
3. When the draft looks right, copy it into the pack or local
   \`sharkcraft/templates.ts\` using:
   \`\`\`
   shrk apply --asset-preview .sharkcraft/authoring/templates/${slugifyId(input.id)}.draft.ts \\
     --target <path-to-templates.ts>
   \`\`\`

Forbidden path fragments (do not let \`files\` emit these): ${input.forbiddenPaths.join(', ') || '(none)'}.
`;
  return { tsBody: ts, explainer };
}

function validateTemplateId(id: string): string | null {
  if (!id || !/^[a-z][a-z0-9.-]*$/.test(id)) {
    return `Invalid id "${id}". Use lowercase letters, digits, dots and hyphens (e.g. app.my-template).`;
  }
  return null;
}

export const templatesScaffoldCommand: ICommandHandler = {
  name: 'scaffold',
  description:
    'Scaffold a new template. Preview-only by default; --write-preview materialises a TS draft under .sharkcraft/authoring/templates/. Pair with `shrk apply --asset-preview` to insert into the target file.',
  usage:
    'shrk templates scaffold --id <id> [--title <t>] [--description <d>] [--tag a,b] [--scope a,b] [--applies-when a,b] [--produced-anchor a,b] [--required-anchor a,b] [--required-profile a,b] [--required-helper a,b] [--registration-hint a,b] [--forbidden-path a,b] [--reason <text>] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk templates scaffold --id <id> [...] [--write-preview]\n');
      return 2;
    }
    const idError = validateTemplateId(id);
    if (idError) {
      process.stderr.write(`Refused: ${idError}\n`);
      return 1;
    }
    const input: ITemplateScaffoldInput = {
      id,
      title: flagString(args, 'title') ?? id,
      description: flagString(args, 'description') ?? 'TODO: describe what this template generates.',
      tags: flagList(args, 'tag'),
      scope: flagList(args, 'scope'),
      appliesWhen: flagList(args, 'applies-when'),
      producedAnchors: flagList(args, 'produced-anchor'),
      requiredAnchors: flagList(args, 'required-anchor'),
      requiredProfileIds: flagList(args, 'required-profile'),
      requiredHelperIds: flagList(args, 'required-helper'),
      registrationHintIds: flagList(args, 'registration-hint'),
      forbiddenPaths: flagList(args, 'forbidden-path'),
    };
    const { tsBody, explainer } = buildTemplateScaffold(input);
    const cwd = resolveCwd(args);
    const slug = slugifyId(id);
    const tsRel = nodePath.join('.sharkcraft', 'authoring', 'templates', `${slug}.draft.ts`);
    const mdRel = nodePath.join('.sharkcraft', 'authoring', 'templates', `${slug}.md`);
    const tsAbs = nodePath.join(cwd, tsRel);
    const mdAbs = nodePath.join(cwd, mdRel);

    const result = {
      schema: 'sharkcraft.template-scaffold/v1' as const,
      generatedAt: new Date().toISOString(),
      id,
      title: input.title,
      preview: { ts: tsRel, explainer: mdRel },
      nextCommands: [
        `shrk apply --asset-preview ${tsRel} --target <path-to-templates.ts>`,
        `shrk templates drift --min-severity warning`,
        `shrk self-config doctor`,
        `shrk packs signature-status`,
      ],
    };

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
    } else {
      process.stdout.write(header(`Template scaffold preview: ${id}`));
      process.stdout.write(`  title:      ${input.title}\n`);
      process.stdout.write(`  files:\n    ${tsRel}\n    ${mdRel}\n`);
      process.stdout.write('\n--- TypeScript draft ---\n');
      process.stdout.write(tsBody);
      process.stdout.write('\n--- Next ---\n');
      for (const c of result.nextCommands) process.stdout.write(`  $ ${c}\n`);
      if (!flagBool(args, 'write-preview')) {
        process.stdout.write('\n(preview only — pass --write-preview to materialise under .sharkcraft/authoring/templates/)\n');
      }
    }

    if (flagBool(args, 'write-preview')) {
      mkdirSync(nodePath.dirname(tsAbs), { recursive: true });
      writeFileSync(tsAbs, tsBody, 'utf8');
      writeFileSync(mdAbs, explainer, 'utf8');
      try {
        const isAgent = Boolean(process.env['SHARKCRAFT_AGENT']) ||
          Boolean(process.env['CLAUDE_CODE_SESSION']);
        recordProvenance({
          projectRoot: cwd,
          entry: {
            operation: AssetProvenanceOperation.Add,
            assetKind: AssetKind.Template,
            assetId: id,
            source: isAgent ? AssetProvenanceSource.Agent : AssetProvenanceSource.Cli,
            previewPath: tsRel,
            ...(flagString(args, 'reason') ? { reason: flagString(args, 'reason')! } : {}),
          },
        });
      } catch {
        // best-effort
      }
      if (!flagBool(args, 'json')) {
        process.stdout.write(`\nWrote 2 files under ${nodePath.join(cwd, '.sharkcraft', 'authoring', 'templates')}\n`);
      }
    }
    return 0;
  },
};

/**
 * `shrk templates add` is an alias of `templates scaffold`.
 */
export const templatesAddCommand: ICommandHandler = {
  ...templatesScaffoldCommand,
  name: 'add',
  description:
    'Alias of `templates scaffold` — preview-only TS draft for a new template.',
};

/**
 * `shrk templates doctor` aggregates the existing drift + lint
 * signals into one structured report. Read-only.
 *
 * Distinct from `templates lint` (which surfaces test-style findings)
 * and `templates drift` (which compares declared vs. rendered output)
 * by combining them with a clean/dirty verdict + per-template summary.
 */
export const templatesDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description:
    'Template-quality doctor — combines drift + lint signals into one clean/dirty verdict per template. Read-only.',
  usage: 'shrk templates doctor [--strict] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const drift = buildTemplateDriftReport(inspection);
    const totals = {
      total: drift.entries.length,
      pass: drift.entries.filter((e) => e.status === TemplateDriftStatus.Pass).length,
      warn: drift.entries.filter((e) => e.status === TemplateDriftStatus.Warn).length,
      fail: drift.entries.filter((e) => e.status === TemplateDriftStatus.Fail).length,
    };
    const strict = flagBool(args, 'strict');
    const exit = totals.fail > 0 || (strict && totals.warn > 0) ? 1 : 0;
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.templates-doctor/v1',
          generatedAt: new Date().toISOString(),
          totals,
          entries: drift.entries,
        }) + '\n',
      );
      return exit;
    }
    process.stdout.write(header('Templates doctor'));
    process.stdout.write(kv('totals', `${totals.pass} pass, ${totals.warn} warn, ${totals.fail} fail`) + '\n\n');
    for (const e of drift.entries) {
      const label = (e.templateName ?? e.templateId);
      process.stdout.write(`  ${e.status.toUpperCase().padEnd(8)} ${label}\n`);
      for (const issue of e.issues) {
        process.stdout.write(`           [${issue.severity}] ${issue.message}\n`);
      }
    }
    if (exit === 0) process.stdout.write('\nClean. ✓\n');
    else process.stdout.write('\nIssues found. Run `shrk templates drift --min-severity warning` for detail.\n');
    return exit;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Templates authoring parity: update / remove.
//
// Mirrors `shrk knowledge update` / `shrk knowledge remove` shape. Drafts
// land under `.sharkcraft/authoring/templates/` only — never mutate source.
// Reference-checking for remove uses knowledge/pipelines/presets/packs
// already loaded by inspect.
// ─────────────────────────────────────────────────────────────────────────────

function buildTemplateUpdateOps(args: ParsedArgs): ITemplateUpdateOps {
  const addTags = multiFlagValues(args, 'add-tag');
  const removeTags = multiFlagValues(args, 'remove-tag');
  const addScope = multiFlagValues(args, 'add-scope');
  const removeScope = multiFlagValues(args, 'remove-scope');
  const addAppliesWhen = multiFlagValues(args, 'add-applies-when');
  const removeAppliesWhen = multiFlagValues(args, 'remove-applies-when');
  const addProfile = multiFlagValues(args, 'add-required-profile');
  const removeProfile = multiFlagValues(args, 'remove-required-profile');
  const addForbid = multiFlagValues(args, 'add-forbidden-path');
  const removeForbid = multiFlagValues(args, 'remove-forbidden-path');
  const addRelated = multiFlagValues(args, 'add-related');
  const removeRelated = multiFlagValues(args, 'remove-related');
  const name = flagString(args, 'name');
  const description = flagString(args, 'description');
  const postNote = flagString(args, 'add-post-note');
  return {
    ...(name !== undefined && name !== null ? { setName: name } : {}),
    ...(description !== undefined && description !== null ? { setDescription: description } : {}),
    ...(addTags.length ? { addTags } : {}),
    ...(removeTags.length ? { removeTags } : {}),
    ...(addScope.length ? { addScope } : {}),
    ...(removeScope.length ? { removeScope } : {}),
    ...(addAppliesWhen.length ? { addAppliesWhen } : {}),
    ...(removeAppliesWhen.length ? { removeAppliesWhen } : {}),
    ...(addProfile.length ? { addRequiredProfileIds: addProfile } : {}),
    ...(removeProfile.length ? { removeRequiredProfileIds: removeProfile } : {}),
    ...(addForbid.length ? { addForbiddenPathFragments: addForbid } : {}),
    ...(removeForbid.length ? { removeForbiddenPathFragments: removeForbid } : {}),
    ...(addRelated.length ? { addRelated } : {}),
    ...(removeRelated.length ? { removeRelated } : {}),
    ...(postNote ? { addPostGenerationNote: postNote } : {}),
  };
}

/**
 * Project the preview's `next` template definition onto the
 * `applyTemplateUpdate` field shape. The preview generator merges
 * add/remove ops into the current state, so the apply receives the final
 * desired values for each top-level array and for `metadata.*`. The apply
 * splicer uses `mode: 'set'` for arrays (i.e. wholesale replace with the
 * already-merged set), and for metadata it forwards both scalar and
 * array fields. Function resolvers (`files` etc.) are excluded — the
 * draft cannot represent them.
 */
function buildApplyFieldsFromNext(
  next: ITemplateDefinitionImport,
): ITemplateUpdateApplyInput['fields'] {
  type Fields = ITemplateUpdateApplyInput['fields'];
  type FieldsMutable = { -readonly [K in keyof Fields]: Fields[K] };
  const fields: FieldsMutable = {};
  if (next.name !== undefined) fields.name = next.name;
  if (next.description !== undefined) fields.description = next.description;
  if (next.tags !== undefined) fields.tags = { mode: 'set', values: [...next.tags] };
  if (next.scope !== undefined) fields.scope = { mode: 'set', values: [...next.scope] };
  if (next.appliesWhen !== undefined) {
    fields.appliesWhen = { mode: 'set', values: [...next.appliesWhen] };
  }
  if (next.related !== undefined) {
    fields.related = { mode: 'set', values: [...next.related] };
  }
  if (next.metadata) {
    const md = next.metadata as Record<string, unknown>;
    const metaOut: Record<string, unknown> = {};
    for (const k of ['priority', 'maturity', 'dryRunOnly', 'requiresApproval'] as const) {
      if (md[k] !== undefined) metaOut[k] = md[k];
    }
    for (const k of [
      'requiredAnchors',
      'requiredProfileIds',
      'forbiddenPathFragments',
      'requiredVerificationCommandIds',
    ] as const) {
      const v = md[k];
      if (Array.isArray(v)) {
        metaOut[k] = { mode: 'set', values: [...v] };
      }
    }
    if (Object.keys(metaOut).length > 0) {
      fields.metadata = metaOut as Fields['metadata'];
    }
  }
  return fields;
}

function recordTemplateAuthoringProvenance(
  cwd: string,
  id: string,
  op: 'update' | 'remove',
  previewPath: string,
  reason?: string,
): void {
  const src = detectAuthoringSource();
  recordProvenance({
    projectRoot: cwd,
    entry: {
      operation: AssetProvenanceOperation.Preview,
      assetKind: AssetKind.Template,
      assetId: id,
      source: src.source,
      ...(src.author ? { author: src.author } : {}),
      ...(src.sessionId ? { sessionId: src.sessionId } : {}),
      ...(reason ? { reason } : {}),
      previewPath,
      extra: { authoringOp: op },
    },
  });
}

export const templatesUpdateCommand: ICommandHandler = {
  name: 'update',
  description:
    'Preview an update to an existing template, or apply it in place with --apply. Mirror of `knowledge update` for preview; --write-preview materialises a draft under .sharkcraft/authoring/templates/. --apply splices the patch into the source template literal directly (preview-first, refuses pack-contributed templates and function-resolver replacement).',
  usage:
    'shrk templates update <id> [--name <n>] [--description <d>] [--add-tag a,b] [--remove-tag a,b] [--add-scope a,b] [--remove-scope a,b] [--add-applies-when a,b] [--remove-applies-when a,b] [--add-required-profile a,b] [--remove-required-profile a,b] [--add-forbidden-path a,b] [--remove-forbidden-path a,b] [--add-related a,b] [--remove-related a,b] [--add-post-note <text>] [--reason <text>] [--write-preview | --apply [--allow-divergent]] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk templates update <id> [...]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const input: ITemplateAuthoringInput = {
      operation: TemplateAuthoringOperation.Update,
      id,
      ...(flagString(args, 'reason') ? { reason: flagString(args, 'reason')! } : {}),
      updateOps: buildTemplateUpdateOps(args),
    };
    const result = buildTemplateAuthoringPreview(input, {
      templates: inspection.templateRegistry.list(),
      knowledgeEntries: inspection.knowledgeEntries,
    });
    // `--apply` path. Splices the projected metadata fields into
    // the source template literal in place. Refuses pack-contributed
    // templates (their source lives in the pack package).
    if (flagBool(args, 'apply')) {
      if (!result.ok) {
        if (flagBool(args, 'json')) process.stdout.write(asJson(result) + '\n');
        else {
          process.stdout.write(header(`Template update --apply refused: ${id}`));
          process.stdout.write(`  refusal: ${result.refusal}\n`);
        }
        return 1;
      }
      const src = inspection.templateSources.get(id);
      if (!src || src.type === 'pack') {
        process.stderr.write(
          `Refused: template "${id}" is pack-contributed. Edit the pack source and re-sign instead.\n`,
        );
        return 1;
      }
      // Locate the local source file for this template.
      const cfg = inspection.config;
      const sharkDir = inspection.sharkcraftDir;
      let sourceFile: string | null = null;
      const candidates: string[] = [];
      if (cfg && sharkDir) {
        for (const f of (cfg.templateFiles ?? []) as readonly string[]) {
          candidates.push(nodePath.join(sharkDir, f));
        }
      }
      for (const candidate of candidates) {
        try {
          const body = (await import('node:fs')).readFileSync(candidate, 'utf8');
          if (new RegExp(`id\\s*:\\s*['"]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(body)) {
            sourceFile = candidate;
            break;
          }
        } catch {
          continue;
        }
      }
      if (!sourceFile) {
        process.stderr.write(
          `Refused: could not locate local source file for template "${id}". Configured templateFiles: ${candidates.map((c) => nodePath.relative(cwd, c)).join(', ') || '(none)'}.\n`,
        );
        return 1;
      }
      const next = result.next!;
      const fieldsForApply = buildApplyFieldsFromNext(next);
      const apply = applyTemplateUpdate({
        cwd,
        targetPath: nodePath.relative(cwd, sourceFile),
        templateId: id,
        fields: fieldsForApply,
        write: false,
      });
      if (!apply.ok) {
        process.stderr.write(`Refused: ${apply.refusal}\n`);
        return 1;
      }
      const written = applyTemplateUpdate({
        cwd,
        targetPath: nodePath.relative(cwd, sourceFile),
        templateId: id,
        fields: fieldsForApply,
        write: true,
      });
      try {
        recordTemplateAuthoringProvenance(
          cwd,
          id,
          'update',
          nodePath.relative(cwd, sourceFile),
          input.reason,
        );
      } catch {
        // best-effort
      }
      if (flagBool(args, 'json')) {
        process.stdout.write(
          asJson({
            mode: 'applied',
            templateId: id,
            sourceFile: nodePath.relative(cwd, sourceFile),
            fieldChanges: written.fieldChanges,
            wrote: written.wrote,
          }) + '\n',
        );
      } else {
        process.stdout.write(header(`Template update --apply: ${id}`));
        process.stdout.write(`  source: ${nodePath.relative(cwd, sourceFile)}\n`);
        process.stdout.write(`  fields applied (${written.fieldChanges.length}):\n`);
        for (const f of written.fieldChanges) {
          process.stdout.write(`    • ${f.field} (${f.mode})\n`);
        }
        process.stdout.write(
          '\nRe-run `shrk templates drift --min-severity warning` to confirm the update lands cleanly.\n',
        );
      }
      return 0;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
    } else {
      process.stdout.write(header(`Template update preview: ${id}`));
      process.stdout.write(`  ok:        ${result.ok}\n`);
      if (!result.ok) process.stdout.write(`  refusal:   ${result.refusal}\n`);
      process.stdout.write(`  files:\n    ${result.tsDraft.path}\n    ${result.explainer.path}\n`);
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
        process.stdout.write('\n  (preview only — pass --write-preview to materialise under .sharkcraft/authoring/templates/)\n');
      }
    }
    if (flagBool(args, 'write-preview') && result.ok) {
      writeAuthoringDrafts(cwd, [result.tsDraft, result.explainer]);
      recordTemplateAuthoringProvenance(
        cwd,
        id,
        'update',
        result.tsDraft.path,
        input.reason,
      );
    }
    return result.ok ? 0 : 1;
  },
};

export const templatesRemoveCommand: ICommandHandler = {
  name: 'remove',
  description:
    'Preview removal of a template. Refuses if anything references it; pass --force-preview to override. Preview-only.',
  usage:
    'shrk templates remove <id> [--force-preview] [--reason <text>] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk templates remove <id> [--force-preview]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    // Build pack-template-id map so the reference-check flags pack ownership.
    const packTemplateIds = new Map<string, string>();
    for (const p of inspection.packs.validPacks ?? []) {
      const tmpls = (p.manifest?.contributions as { templateFiles?: readonly string[] } | undefined)?.templateFiles ?? [];
      for (const t of tmpls) {
        // Best-effort — we don't know the template id from the file name alone.
        // Use the file path as a marker so the reverse-ref note still surfaces.
        packTemplateIds.set(t, p.packageName);
      }
    }
    const input: ITemplateAuthoringInput = {
      operation: TemplateAuthoringOperation.Remove,
      id,
      forcePreview: flagBool(args, 'force-preview'),
      ...(flagString(args, 'reason') ? { reason: flagString(args, 'reason')! } : {}),
    };
    const result = buildTemplateAuthoringPreview(input, {
      templates: inspection.templateRegistry.list(),
      knowledgeEntries: inspection.knowledgeEntries,
      pipelines: inspection.pipelineRegistry.list(),
      presets: inspection.presetRegistry.list(),
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
    } else {
      process.stdout.write(header(`Template remove preview: ${id}`));
      process.stdout.write(`  ok:        ${result.ok}\n`);
      if (!result.ok) process.stdout.write(`  refusal:   ${result.refusal}\n`);
      if (result.reverseReferences && result.reverseReferences.length > 0) {
        process.stdout.write(`\n  reverse references (${result.reverseReferences.length}):\n`);
        for (const r of result.reverseReferences) {
          process.stdout.write(`    - ${r.fromKind} ${r.fromId} (${r.field})${r.note ? ` — ${r.note}` : ''}\n`);
        }
      }
      process.stdout.write('\n--- Next commands ---\n');
      for (const c of result.nextCommands) process.stdout.write(`  $ ${c}\n`);
      if (!flagBool(args, 'write-preview')) {
        process.stdout.write('\n  (preview only — pass --write-preview to materialise under .sharkcraft/authoring/templates/)\n');
      }
    }
    if (flagBool(args, 'write-preview') && result.ok) {
      writeAuthoringDrafts(cwd, [result.tsDraft, result.explainer]);
      recordTemplateAuthoringProvenance(
        cwd,
        id,
        'remove',
        result.explainer.path,
        input.reason,
      );
    }
    return result.ok ? 0 : 1;
  },
};
// Silence unused-import warnings if the surface ever rolls back.
void AssetProvenanceSource;
