import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import {
  AiMessageRole,
  buildPromptMessages,
  EnhancementPipeline,
  EnhancementStageKind,
  OllamaProvider,
  buildDefaultEnhancementStages,
  buildFastEnhancementStages,
  selectAiProvider,
  type IAiMessage,
  type IEnhancementStageResult,
} from '@shrkcrft/ai';
import { buildContext } from '@shrkcrft/context';
import { EdgeKind, GraphQueryApi, GraphStore, NodeKind, type INode } from '@shrkcrft/graph';
import {
  buildProjectOverview,
  buildTaskPacket,
  inspectSharkcraft,
  renderOverviewText,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagList,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import {
  DeclarationKind,
  PLAN_CACHE_SCHEMA,
  PlanCache,
  SemanticIndex,
  TaskType,
  buildFocusedContext,
  classifyTask,
  encodeEmbedding,
  getDefaultSourceRoots,
  listIndexableFiles,
  parseTaskTypeOverride,
  renderFocusedContextForPrompt,
  type IFocusedContext,
  type IPlanCacheHit,
  type ISemanticFreshnessReport,
  type ISemanticHit,
  type ITaskClassification,
} from '@shrkcrft/embeddings';
import {
  SmartContextDetailedPlanSchema,
  SmartContextExpansionRequestSchema,
} from '../schemas/json-schemas.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { printError } from '../output/print-error.ts';
import {
  buildTemplateAudit,
  type ITemplateAuditReport,
} from '../audit/templates-audit.ts';
import { enrichAuditWithLlm } from '../audit/templates-audit-llm.ts';
import {
  buildFixPlan,
  type ITemplateFixPlan,
} from '../audit/templates-fix-plan.ts';
import { enrichFixPlanWithLlm } from '../audit/templates-fix-plan-llm.ts';
import { buildAiBlock, renderAiBlockMarkdown } from '@shrkcrft/ai';
import {
  buildKnowledgeAudit,
  type IKnowledgeAuditReport,
} from '../audit/knowledge-audit.ts';
import { enrichKnowledgeAuditWithLlm } from '../audit/knowledge-audit-llm.ts';
import {
  buildKnowledgeFixPlan,
  type IKnowledgeFixPlan,
} from '../audit/knowledge-fix-plan.ts';
import { enrichKnowledgeFixPlanWithLlm } from '../audit/knowledge-fix-plan-llm.ts';
import {
  buildPipelineAudit,
  buildPipelineFixPlan,
  type IPipelineAuditReport,
  type IPipelineFixPlan,
} from '../audit/pipeline-audit.ts';
import { enrichPipelineAuditWithLlm } from '../audit/pipeline-audit-llm.ts';

const SMART_CONTEXT_DIR = nodePath.join('.sharkcraft', 'smart-context');

/**
 * Gemini-backed context enrichment.
 *
 * Sits next to `shrk ask` as an explicit, opt-in AI surface — the
 * deterministic engine (`shrk context`, `shrk brief`, MCP tools) stays
 * AI-free. See docs/smart-context.md and the
 * `.claude/skills/shrk-smart-context/` skill for the agent workflow.
 *
 * Verbs:
 *   - `smart-context "<task>"`               — single brief (default).
 *   - `smart-context "<task>" --plan`        — single structured plan.
 *   - `smart-context "<task>" --ai-plan`     — two-stage AI-assisted plan.
 *   - `smart-context "<task>" --save`        — persist under .sharkcraft/smart-context/.
 *   - `smart-context plan-ahead "t1" "t2"`   — batch-save plans for an upcoming queue.
 *   - `smart-context list`                   — list saved entries.
 *   - `smart-context show <slug>`            — print a saved entry.
 */
export const smartContextCommand: ICommandHandler = {
  name: 'smart-context',
  description:
    'Build deterministic context and ask an AI provider to synthesise an enriched brief (default), structured plan (--plan), or two-stage development plan (--ai-plan).',
  usage:
    'shrk smart-context "<task>" [--plus] [--budget <seconds>] [--plan] [--ai-plan] [--save] [--provider auto|ollama|llamacpp] [--enhance|--no-enhance] [--enhance-passes N] [--instructions <path>] [--no-instructions] [--model <id>] [--max-tokens N] [--stage1-max-tokens N] [--seed-tokens N] [--expansion-tokens N] [--expansion-limit N] [--log-prompt] [--save-conversation[=<path>]] [--dry-run] [--debug] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const task = args.positional.join(' ').trim();
    if (!task) {
      process.stderr.write('Usage: shrk smart-context "<task>" [--plan] [--ai-plan] [--save]\n');
      return 2;
    }
    // Isolate the LLM / native-runtime work in a child process. On macOS the
    // node-llama-cpp (ggml/Metal) and ONNX static destructors abort during
    // `exit()` — surfacing a GGML backtrace + `libc++abi … mutex lock failed`
    // (and a shell `abort`) AFTER a perfectly good result. There is no JS hook
    // in this Node build to skip libc++ finalizers, so instead the child
    // self-contains that noise (fd 2 → log on exit) and hands its real exit
    // code back through a sentinel file; the parent never loads a native
    // runtime, so it exits cleanly with the correct code. Dry-run does no
    // native work, so it stays in-process. Gated on SHRK_CLI so a unit test
    // calling `run()` in-process never spawns a subprocess.
    if (
      process.env.SHRK_CLI === '1' &&
      process.env.SHRK_SMART_CONTEXT_WORKER !== '1' &&
      !flagBool(args, 'dry-run')
    ) {
      return runSmartContextInChild();
    }
    const cwd = resolveCwd(args);
    const opts = readCommonOptions(args);
    const inspection = await inspectSharkcraft({ cwd });
    const seed = await buildSmartContextSeed({ cwd, task, inspection, options: opts });

    // --focused / --tiny-only: route through the BGE-built bundle. Skips
    // the verbose seed-dump path entirely (no CLAUDE.md body, no knowledge
    // dump). The bundle is dense, task-specific, and ~2 KB instead of ~10 KB.
    if (opts.focused) {
      const focusedExit = await runFocusedMode({ cwd, task, seed, options: opts });
      if (focusedExit !== null) return focusedExit;
    }

    if (opts.aiPlan) {
      if (opts.dryRun) {
        writeAiPlanDryRun(seed, seed.graphGrounding, opts);
        return 0;
      }
      const aiPlan = await buildAiPlanEnvelope({ cwd, inspection, seed, options: opts });
      if (!aiPlan.ok) {
        printError(aiPlan.error);
        return 1;
      }
      if (opts.save) {
        const saved = saveEnvelope(cwd, aiPlan.value);
        writeSavedNotice(saved, opts.json, aiPlan.value);
        return 0;
      }
      writeEnvelope(aiPlan.value, opts.json, opts.debug);
      return 0;
    }

    const messages = buildMessages(seed, opts.mode);
    logPromptToStderr(opts.mode, messages, opts);
    if (opts.dryRun) {
      writeDryRun(messages, opts.mode, displayProviderName(opts.provider));
      return 0;
    }

    const selection = selectAiProvider(opts.provider);
    if (!selection.provider) {
      process.stderr.write(providerMissingMessage(selection.requested) + '\n');
      return 1;
    }
    if (opts.model) selection.provider.configure({ model: opts.model });
    if (!opts.json) {
      process.stdout.write(`(provider: ${selection.provider.id})\n`);
    }
    // Brief mode with the multi-pass enhancement pipeline. When an
    // LLM is ready and enhancement is on, run `draft → critique →
    // refine → polish` over the deterministic seed instead of a
    // single LLM shot. Falls back to single-shot when --no-enhance
    // is passed or when SHRK_ENHANCE=off.
    if (opts.mode === 'brief' && opts.enhance) {
      const enhanced = await runEnhancementPipeline({
        provider: selection.provider,
        messages,
        seed,
        options: opts,
      });
      if (!enhanced.ok) {
        printError(enhanced.error);
        return 1;
      }
      if (opts.saveConversation) {
        const path = writeConversationFile({
          cwd,
          task,
          mode: opts.mode,
          options: opts,
          providerId: selection.provider.id,
          model: enhanced.value.ai.model,
          turns: enhanced.value.turns,
        });
        if (!opts.json) {
          process.stderr.write(`[smart-context] conversation saved → ${path}\n`);
        }
      }
      const enh = enhanced.value.enhancement;
      if (!opts.json && !enh.deterministicFallback) {
        if (enh.budgetExhausted) {
          process.stderr.write(
            `[smart-context] budget reached before all ${enh.plannedPasses} passes finished — output is the best so far. Try a smaller --model or raise --budget.\n`,
          );
        }
        if (!enh.plus) {
          process.stderr.write(
            `[smart-context] fast ${enh.plannedPasses}-pass enhancement. Pass --plus for the full draft→critique→refine→polish (denser, slower).\n`,
          );
        }
      }
      const envelope = buildEnvelope({
        task,
        seed,
        ai: enhanced.value.ai,
        mode: opts.mode,
        content: enhanced.value.content,
        enhancement: enhanced.value.enhancement,
      });
      if (opts.save) {
        const saved = saveEnvelope(cwd, envelope);
        writeSavedNotice(saved, opts.json, envelope);
        return 0;
      }
      writeEnvelope(envelope, opts.json, opts.debug);
      return 0;
    }

    const aiResult = await callProvider({
      provider: selection.provider,
      messages,
      maxTokens: opts.maxTokens,
      model: opts.model,
    });
    if (!aiResult.ok) {
      printError(aiResult.error);
      return 1;
    }

    if (opts.saveConversation) {
      const path = writeConversationFile({
        cwd,
        task,
        mode: opts.mode,
        options: opts,
        providerId: aiResult.value.providerId,
        model: aiResult.value.model,
        turns: [
          {
            stage: 'single',
            request: { messages: messages.map((m) => ({ role: m.role, content: m.content })) },
            response: {
              content: aiResult.value.content,
              model: aiResult.value.model,
              finishReason: aiResult.value.finishReason,
              usage: aiResult.value.usage,
            },
          },
        ],
      });
      if (!opts.json) {
        process.stderr.write(`[smart-context] conversation saved → ${path}\n`);
      }
    }

    const envelope = buildEnvelope({
      task,
      seed,
      ai: aiResult.value,
      mode: opts.mode,
    });

    if (opts.save) {
      const saved = saveEnvelope(cwd, envelope);
      writeSavedNotice(saved, opts.json, envelope);
      return 0;
    }
    writeEnvelope(envelope, opts.json, opts.debug);
    return 0;
  },
};

/** `shrk smart-context plan-ahead "task1" "task2" ...` — batch-saves plans. */
export const smartContextPlanAheadCommand: ICommandHandler = {
  name: 'plan-ahead',
  description:
    'Generate and save AI-backed plans for a queue of upcoming tasks. Each task is saved under .sharkcraft/smart-context/.',
  usage:
    'shrk smart-context plan-ahead "<task1>" "<task2>" ... [--brief] [--provider auto|ollama|llamacpp] [--instructions <path>] [--model <id>] [--max-tokens N] [--dry-run] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const tasks = args.positional.map((t) => t.trim()).filter((t) => t.length > 0);
    if (tasks.length === 0) {
      process.stderr.write(
        'Usage: shrk smart-context plan-ahead "<task1>" "<task2>" ...\n',
      );
      return 2;
    }
    const cwd = resolveCwd(args);
    const opts = readCommonOptions(args);
    if (opts.aiPlan) {
      process.stderr.write('`shrk smart-context plan-ahead` does not support `--ai-plan` yet.\n');
      return 2;
    }
    const wantBrief = flagBool(args, 'brief');
    opts.mode = wantBrief ? 'brief' : 'plan';
    opts.save = true;

    const inspection = await inspectSharkcraft({ cwd });
    const results: IPlanAheadEntry[] = [];

    const selection = opts.dryRun ? null : selectAiProvider(opts.provider);
    if (!opts.dryRun && !selection?.provider) {
      process.stderr.write(providerMissingMessage(selection?.requested ?? 'gemini') + '\n');
      return 1;
    }
    if (selection?.provider && opts.model) selection.provider.configure({ model: opts.model });

    for (const task of tasks) {
      const seed = await buildSmartContextSeed({ cwd, task, inspection, options: opts });
      const messages = buildMessages(seed, opts.mode);

      if (opts.dryRun) {
        results.push({ task, status: 'dry-run', slug: slug(task) });
        if (!opts.json) {
          process.stdout.write(header(`Dry-run prompt for: ${task}`));
          for (const m of messages) process.stdout.write(`\n[${m.role}]\n${m.content}\n`);
        }
        continue;
      }

      const aiResult = await callProvider({
        provider: selection!.provider!,
        messages,
        maxTokens: opts.maxTokens,
        model: opts.model,
      });
      if (!aiResult.ok) {
        results.push({ task, status: 'error', error: aiResult.error.message, slug: slug(task) });
        if (!opts.json) {
          process.stderr.write(`  ✗ ${task}\n    ${aiResult.error.message}\n`);
        }
        continue;
      }
      const envelope = buildEnvelope({ task, seed, ai: aiResult.value, mode: opts.mode });
      const saved = saveEnvelope(cwd, envelope);
      results.push({
        task,
        status: 'saved',
        slug: saved.slug,
        files: { markdown: saved.mdPath, json: saved.jsonPath },
        usage: aiResult.value.usage ?? null,
      });
      if (!opts.json) {
        process.stdout.write(`  ✓ ${task}\n    → ${saved.mdPath}\n`);
      }
    }

    if (opts.json) {
      process.stdout.write(asJson({ tasks: results.length, results }) + '\n');
    } else {
      process.stdout.write(
        `\nplan-ahead: ${results.filter((r) => r.status === 'saved').length}/${results.length} saved\n`,
      );
    }
    return results.some((r) => r.status === 'error') ? 1 : 0;
  },
};

/** `shrk smart-context list` — list saved entries. */
export const smartContextListCommand: ICommandHandler = {
  name: 'list',
  description: 'List saved smart-context entries under .sharkcraft/smart-context/.',
  usage: 'shrk smart-context list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const entries = readSavedIndex(cwd);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ entries }) + '\n');
      return 0;
    }
    if (entries.length === 0) {
      process.stdout.write('No saved smart-context entries yet.\n');
      process.stdout.write('Try: shrk smart-context "<task>" --save\n');
      return 0;
    }
    process.stdout.write(header(`Saved smart-context (${entries.length})`));
    for (const e of entries) {
      process.stdout.write(
        `  ${e.slug.padEnd(40)}  [${e.mode}]  ${e.savedAt}\n    ${e.task}\n`,
      );
    }
    return 0;
  },
};

/** `shrk smart-context show <slug>` — print a saved entry. */
export const smartContextShowCommand: ICommandHandler = {
  name: 'show',
  description: 'Print a saved smart-context entry by slug. Use `list` to see slugs.',
  usage: 'shrk smart-context show <slug> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const target = args.positional[0]?.trim();
    if (!target) {
      process.stderr.write('Usage: shrk smart-context show <slug>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const entries = readSavedIndex(cwd);
    const hit = entries.find((e) => e.slug === target);
    if (!hit) {
      process.stderr.write(`No saved entry "${target}". Try: shrk smart-context list\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      try {
        process.stdout.write(readFileSync(hit.jsonPath, 'utf8'));
      } catch (e) {
        process.stderr.write(`Failed to read ${hit.jsonPath}: ${(e as Error).message}\n`);
        return 1;
      }
      return 0;
    }
    try {
      process.stdout.write(readFileSync(hit.mdPath, 'utf8'));
    } catch (e) {
      process.stderr.write(`Failed to read ${hit.mdPath}: ${(e as Error).message}\n`);
      return 1;
    }
    return 0;
  },
};

/**
 * `shrk smart-context audit-templates` — local-LLM template audit.
 *
 * Orchestrates the existing deterministic template inspectors
 * (`templates lint` + `templates drift`), dedupes their overlap by
 * (category + message), and — when a local provider is reachable —
 * runs an LLM critique pass per template. Always report-only: no edits
 * to template sources, no plan emission. See
 * docs/smart-context-audit-templates.md for the report contract.
 */
export const smartContextAuditTemplatesCommand: ICommandHandler = {
  name: 'audit-templates',
  description:
    'Audit user templates with the deterministic inspectors and (when reachable) a local LLM critique pass. Report-only — no edits. `--fix-plan` adds a Claude-targetable fix plan derived from the report.',
  usage:
    'shrk smart-context audit-templates [--id <templateId>] [--no-enhance] [--provider auto|ollama|llamacpp] [--model <id>] [--save] [--json] [--fix-plan] [--only-plan]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');
    const save = flagBool(args, 'save');
    const noEnhance = flagBool(args, 'no-enhance');
    const templateId = flagString(args, 'id');
    const providerKind = flagString(args, 'provider');
    const model = flagString(args, 'model');
    const wantFixPlan = flagBool(args, 'fix-plan') || flagBool(args, 'only-plan');
    const onlyPlan = flagBool(args, 'only-plan');

    const inspection = await inspectSharkcraft({ cwd });
    let report = buildTemplateAudit(
      inspection,
      templateId ? { templateId } : {},
    );

    if (report.templates.length === 0) {
      if (json) {
        process.stdout.write(asJson(report) + '\n');
      } else {
        process.stdout.write(
          templateId
            ? `No user template with id "${templateId}".\n`
            : 'No user templates registered.\n',
        );
      }
      return templateId ? 1 : 0;
    }

    const selection = noEnhance ? null : selectAiProvider(providerKind);
    if (selection?.provider) {
      if (model) selection.provider.configure({ model });
      if (!json) {
        process.stderr.write(
          `[audit-templates] enriching with provider ${selection.provider.id}…\n`,
        );
      }
      report = await enrichAuditWithLlm(report, {
        provider: selection.provider,
        inspection,
        onPerTemplateError: (id, err) => {
          if (!json) {
            process.stderr.write(
              `[audit-templates] LLM pass failed for ${id}: ${err.message.slice(0, 120)} — keeping deterministic findings only.\n`,
            );
          }
        },
      });
    } else if (!noEnhance && !json) {
      process.stderr.write(
        '[audit-templates] no local LLM reachable — running deterministic-only audit. See `ai.hints` in the output for setup steps.\n',
      );
    }

    report = { ...report, ai: buildAiBlock({ selection, userOptedOut: noEnhance }) };

    let fixPlan = wantFixPlan ? buildFixPlan(report) : null;
    if (fixPlan && selection?.provider) {
      if (!json) {
        process.stderr.write('[audit-templates] sharpening fix plan with LLM suggestions…\n');
      }
      fixPlan = await enrichFixPlanWithLlm(fixPlan, {
        provider: selection.provider,
        inspection,
        onPerTemplateError: (id, err) => {
          if (!json) {
            process.stderr.write(
              `[audit-templates] LLM fix-plan pass failed for ${id}: ${err.message.slice(0, 120)} — keeping deterministic prompts.\n`,
            );
          }
        },
      });
    }

    if (save) {
      const saved = saveAuditReport(cwd, report, fixPlan);
      if (json) {
        process.stdout.write(asJson({ saved, report, ...(fixPlan ? { fixPlan } : {}) }) + '\n');
      } else {
        process.stdout.write(`Audit saved → ${saved.mdPath}\n`);
        process.stdout.write(`           → ${saved.jsonPath}\n`);
        if (saved.planMdPath && saved.planJsonPath) {
          process.stdout.write(`Plan  saved → ${saved.planMdPath}\n`);
          process.stdout.write(`           → ${saved.planJsonPath}\n`);
        }
      }
      return exitCodeForAudit(report);
    }

    if (json) {
      if (onlyPlan && fixPlan) {
        process.stdout.write(asJson(fixPlan) + '\n');
      } else if (fixPlan) {
        process.stdout.write(asJson({ report, fixPlan }) + '\n');
      } else {
        process.stdout.write(asJson(report) + '\n');
      }
      return exitCodeForAudit(report);
    }
    if (!onlyPlan) {
      process.stdout.write(renderAuditMarkdown(report));
    }
    if (fixPlan) {
      if (!onlyPlan) process.stdout.write('\n');
      process.stdout.write(renderFixPlanMarkdown(fixPlan));
    }
    return exitCodeForAudit(report);
  },
};

function exitCodeForAudit(report: ITemplateAuditReport): number {
  if (report.summary.broken > 0) return 1;
  return 0;
}

interface ISavedAuditFiles {
  slug: string;
  mdPath: string;
  jsonPath: string;
  planMdPath?: string;
  planJsonPath?: string;
}

function saveAuditReport(
  cwd: string,
  report: ITemplateAuditReport,
  fixPlan: ITemplateFixPlan | null,
): ISavedAuditFiles {
  const dir = nodePath.join(cwd, SMART_CONTEXT_DIR);
  mkdirSync(dir, { recursive: true });
  const slug = report.auditId;
  const mdPath = nodePath.join(dir, `${slug}.md`);
  const jsonPath = nodePath.join(dir, `${slug}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(mdPath, renderAuditMarkdown(report), 'utf8');
  if (!fixPlan) return { slug, mdPath, jsonPath };
  const planSlug = fixPlan.fixPlanId;
  const planMdPath = nodePath.join(dir, `${planSlug}.md`);
  const planJsonPath = nodePath.join(dir, `${planSlug}.json`);
  writeFileSync(planJsonPath, JSON.stringify(fixPlan, null, 2), 'utf8');
  writeFileSync(planMdPath, renderFixPlanMarkdown(fixPlan), 'utf8');
  return { slug, mdPath, jsonPath, planMdPath, planJsonPath };
}

function renderAuditMarkdown(report: ITemplateAuditReport): string {
  const out: string[] = [];
  out.push(`# Template audit — ${report.auditId}`);
  out.push('');
  out.push(`- generated: ${report.generatedAt}`);
  out.push(
    `- llm enriched: ${report.llmEnriched ? `yes (${report.llmProviderId ?? 'unknown'})` : 'no — deterministic only'}`,
  );
  out.push(
    `- summary: ok=${report.summary.ok}, minor=${report.summary.minor}, stale=${report.summary.stale}, broken=${report.summary.broken} (total ${report.summary.total})`,
  );
  if (report.skipped.length > 0) {
    out.push(`- skipped: ${report.skipped.length} (${report.skipped.map((s) => s.templateId).join(', ')})`);
  }
  out.push('');

  const order: Array<'broken' | 'stale' | 'minor' | 'ok'> = ['broken', 'stale', 'minor', 'ok'];
  for (const verdict of order) {
    const inGroup = report.templates.filter((t) => t.verdict === verdict);
    if (inGroup.length === 0) continue;
    out.push(`## ${verdict.toUpperCase()} (${inGroup.length})`);
    out.push('');
    for (const entry of inGroup) {
      out.push(`### \`${entry.templateId}\` — ${entry.templateName}`);
      out.push(`usage: ${entry.usage}`);
      if (entry.deterministicFindings.length === 0 && entry.llmFindings.length === 0) {
        out.push('No findings.');
        out.push('');
        continue;
      }
      if (entry.deterministicFindings.length > 0) {
        out.push('');
        out.push('Findings:');
        for (const f of entry.deterministicFindings) {
          out.push(
            `- **[deterministic]** ${f.severity} \`${f.category}\` — ${f.message} _(sources: ${f.sources.join(', ')})_`,
          );
          if (f.suggestion) out.push(`  - ↳ ${f.suggestion}`);
        }
      }
      if (entry.llmFindings.length > 0) {
        out.push('');
        out.push('LLM-flagged (advisory):');
        for (const f of entry.llmFindings) {
          out.push(
            `- **[llm]** ${f.severity} \`${f.category}\` (confidence ${f.confidence.toFixed(2)}) — ${f.message}`,
          );
        }
      }
      if (entry.suggestedActions.length > 0) {
        out.push('');
        out.push('Suggested actions:');
        for (const a of entry.suggestedActions) {
          out.push(`- \`${a.kind}\` ${a.target} — ${a.note}`);
        }
      }
      out.push('');
    }
  }
  if (report.ai) {
    out.push(renderAiBlockMarkdown(report.ai));
  }
  return out.join('\n') + '\n';
}

function renderFixPlanMarkdown(plan: ITemplateFixPlan): string {
  const out: string[] = [];
  out.push(`# Template fix plan — ${plan.fixPlanId}`);
  out.push('');
  out.push(`- generated: ${plan.generatedAt}`);
  out.push(`- derived from audit: ${plan.auditId}`);
  out.push(`- source files Claude will edit: ${plan.sourceFiles.join(', ')}`);
  out.push(
    `- summary: ${plan.summary.fixCount} fix(es) — high=${plan.summary.highConfidence}, medium=${plan.summary.mediumConfidence}, low=${plan.summary.lowConfidence}; skipped=${plan.summary.skipped}`,
  );
  out.push('');
  if (plan.fixes.length === 0) {
    out.push('No fix instructions emitted.');
    out.push('');
  } else {
    const order: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
    for (const confidence of order) {
      const inGroup = plan.fixes.filter((f) => f.confidence === confidence);
      if (inGroup.length === 0) continue;
      out.push(`## Confidence: ${confidence.toUpperCase()} (${inGroup.length})`);
      out.push('');
      for (const fix of inGroup) {
        out.push(
          `### \`${fix.templateId}\` — \`${fix.findingCategory}\` _(${fix.source}, ${fix.severity})_`,
        );
        out.push(`**Intent.** ${fix.intent}`);
        out.push('');
        out.push(`Original finding: ${fix.finding}`);
        out.push('');
        out.push('Agent prompt:');
        out.push('```');
        out.push(fix.agentPrompt);
        out.push('```');
        if (fix.llmSuggestion) {
          out.push('');
          out.push('LLM suggestion (advisory):');
          out.push('> ' + fix.llmSuggestion.split('\n').join('\n> '));
        }
        out.push('');
      }
    }
  }
  if (plan.skipped.length > 0) {
    out.push(`## Skipped (${plan.skipped.length})`);
    out.push('');
    for (const s of plan.skipped) {
      out.push(`- \`${s.templateId}\` / \`${s.findingCategory}\` — ${s.reason}`);
      out.push(`  - finding: ${s.finding}`);
    }
    out.push('');
  }
  return out.join('\n') + '\n';
}

/**
 * `shrk smart-context audit-knowledge` — local-LLM knowledge audit.
 *
 * Wraps `lintKnowledge` + `buildKnowledgeStaleReport` from `@shrkcrft/inspector`,
 * then layers LLM critique (when a provider is reachable) and emits a
 * Claude-targetable fix plan. Report-only — no writes to knowledge sources.
 * See docs/smart-context-audit-templates.md for the shared report contract.
 */
export const smartContextAuditKnowledgeCommand: ICommandHandler = {
  name: 'audit-knowledge',
  description:
    'Audit user knowledge entries with the deterministic inspectors (lint + stale-reference check) and (when reachable) a local LLM critique pass. Report-only — no edits.',
  usage:
    'shrk smart-context audit-knowledge [--id <entryId>] [--no-enhance] [--no-stale-check] [--provider auto|ollama|llamacpp] [--model <id>] [--save] [--json] [--fix-plan] [--only-plan]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');
    const save = flagBool(args, 'save');
    const noEnhance = flagBool(args, 'no-enhance');
    const noStaleCheck = flagBool(args, 'no-stale-check');
    const entryId = flagString(args, 'id');
    const providerKind = flagString(args, 'provider');
    const model = flagString(args, 'model');
    const wantFixPlan = flagBool(args, 'fix-plan') || flagBool(args, 'only-plan');
    const onlyPlan = flagBool(args, 'only-plan');

    const inspection = await inspectSharkcraft({ cwd });
    let report = buildKnowledgeAudit(inspection, {
      ...(entryId ? { entryId } : {}),
      ...(noStaleCheck ? { skipStaleCheck: true } : {}),
    });

    if (report.entries.length === 0) {
      if (json) {
        process.stdout.write(asJson(report) + '\n');
      } else {
        process.stdout.write(
          entryId
            ? `No user knowledge entry with id "${entryId}".\n`
            : 'No user knowledge entries registered.\n',
        );
      }
      return entryId ? 1 : 0;
    }

    const selection = noEnhance ? null : selectAiProvider(providerKind);
    if (selection?.provider) {
      if (model) selection.provider.configure({ model });
      if (!json) {
        process.stderr.write(
          `[audit-knowledge] enriching with provider ${selection.provider.id}…\n`,
        );
      }
      report = await enrichKnowledgeAuditWithLlm(report, {
        provider: selection.provider,
        inspection,
        onPerEntryError: (id, err) => {
          if (!json) {
            process.stderr.write(
              `[audit-knowledge] LLM pass failed for ${id}: ${err.message.slice(0, 120)} — keeping deterministic findings only.\n`,
            );
          }
        },
      });
    } else if (!noEnhance && !json) {
      process.stderr.write(
        '[audit-knowledge] no local LLM reachable — running deterministic-only audit. See `ai.hints` in the output for setup steps.\n',
      );
    }

    report = { ...report, ai: buildAiBlock({ selection, userOptedOut: noEnhance }) };

    let fixPlan = wantFixPlan ? buildKnowledgeFixPlan(report) : null;
    if (fixPlan && selection?.provider) {
      if (!json) {
        process.stderr.write('[audit-knowledge] sharpening fix plan with LLM suggestions…\n');
      }
      fixPlan = await enrichKnowledgeFixPlanWithLlm(fixPlan, {
        provider: selection.provider,
        inspection,
        onPerEntryError: (id, err) => {
          if (!json) {
            process.stderr.write(
              `[audit-knowledge] LLM fix-plan pass failed for ${id}: ${err.message.slice(0, 120)} — keeping deterministic prompts.\n`,
            );
          }
        },
      });
    }

    if (save) {
      const saved = saveKnowledgeAuditReport(cwd, report, fixPlan);
      if (json) {
        process.stdout.write(asJson({ saved, report, ...(fixPlan ? { fixPlan } : {}) }) + '\n');
      } else {
        process.stdout.write(`Audit saved → ${saved.mdPath}\n`);
        process.stdout.write(`           → ${saved.jsonPath}\n`);
        if (saved.planMdPath && saved.planJsonPath) {
          process.stdout.write(`Plan  saved → ${saved.planMdPath}\n`);
          process.stdout.write(`           → ${saved.planJsonPath}\n`);
        }
      }
      return exitCodeForKnowledgeAudit(report);
    }

    if (json) {
      if (onlyPlan && fixPlan) {
        process.stdout.write(asJson(fixPlan) + '\n');
      } else if (fixPlan) {
        process.stdout.write(asJson({ report, fixPlan }) + '\n');
      } else {
        process.stdout.write(asJson(report) + '\n');
      }
      return exitCodeForKnowledgeAudit(report);
    }
    if (!onlyPlan) {
      process.stdout.write(renderKnowledgeAuditMarkdown(report));
    }
    if (fixPlan) {
      if (!onlyPlan) process.stdout.write('\n');
      process.stdout.write(renderKnowledgeFixPlanMarkdown(fixPlan));
    }
    return exitCodeForKnowledgeAudit(report);
  },
};

function exitCodeForKnowledgeAudit(report: IKnowledgeAuditReport): number {
  if (report.summary.broken > 0) return 1;
  return 0;
}

interface ISavedKnowledgeAuditFiles {
  slug: string;
  mdPath: string;
  jsonPath: string;
  planMdPath?: string;
  planJsonPath?: string;
}

function saveKnowledgeAuditReport(
  cwd: string,
  report: IKnowledgeAuditReport,
  fixPlan: IKnowledgeFixPlan | null,
): ISavedKnowledgeAuditFiles {
  const dir = nodePath.join(cwd, SMART_CONTEXT_DIR);
  mkdirSync(dir, { recursive: true });
  const slug = `knowledge-${report.auditId}`;
  const mdPath = nodePath.join(dir, `${slug}.md`);
  const jsonPath = nodePath.join(dir, `${slug}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(mdPath, renderKnowledgeAuditMarkdown(report), 'utf8');
  if (!fixPlan) return { slug, mdPath, jsonPath };
  const planSlug = `knowledge-${fixPlan.fixPlanId}`;
  const planMdPath = nodePath.join(dir, `${planSlug}.md`);
  const planJsonPath = nodePath.join(dir, `${planSlug}.json`);
  writeFileSync(planJsonPath, JSON.stringify(fixPlan, null, 2), 'utf8');
  writeFileSync(planMdPath, renderKnowledgeFixPlanMarkdown(fixPlan), 'utf8');
  return { slug, mdPath, jsonPath, planMdPath, planJsonPath };
}

function renderKnowledgeAuditMarkdown(report: IKnowledgeAuditReport): string {
  const out: string[] = [];
  out.push(`# Knowledge audit — ${report.auditId}`);
  out.push('');
  out.push(`- generated: ${report.generatedAt}`);
  out.push(
    `- llm enriched: ${report.llmEnriched ? `yes (${report.llmProviderId ?? 'unknown'})` : 'no — deterministic only'}`,
  );
  out.push(
    `- summary: ok=${report.summary.ok}, minor=${report.summary.minor}, stale=${report.summary.stale}, broken=${report.summary.broken} (total ${report.summary.total})`,
  );
  if (report.skipped.length > 0) {
    out.push(`- skipped: ${report.skipped.length} (pack-contributed)`);
  }
  out.push('');

  const order: Array<'broken' | 'stale' | 'minor' | 'ok'> = ['broken', 'stale', 'minor', 'ok'];
  for (const verdict of order) {
    const inGroup = report.entries.filter((t) => t.verdict === verdict);
    if (inGroup.length === 0) continue;
    out.push(`## ${verdict.toUpperCase()} (${inGroup.length})`);
    out.push('');
    for (const entry of inGroup) {
      out.push(`### \`${entry.entryId}\` (${entry.entryType}) — ${entry.title}`);
      if (entry.deterministicFindings.length === 0 && entry.llmFindings.length === 0) {
        out.push('No findings.');
        out.push('');
        continue;
      }
      if (entry.deterministicFindings.length > 0) {
        out.push('');
        out.push('Findings:');
        for (const f of entry.deterministicFindings) {
          out.push(
            `- **[deterministic]** ${f.severity} \`${f.category}\` (${f.field}) — ${f.message} _(sources: ${f.sources.join(', ')})_`,
          );
          if (f.fixSuggestion) out.push(`  - ↳ ${f.fixSuggestion}`);
          if (f.stubSuggestion) out.push(`  - stub: ${f.stubSuggestion}`);
        }
      }
      if (entry.llmFindings.length > 0) {
        out.push('');
        out.push('LLM-flagged (advisory):');
        for (const f of entry.llmFindings) {
          out.push(
            `- **[llm]** ${f.severity} \`${f.category}\` (confidence ${f.confidence.toFixed(2)}) — ${f.message}`,
          );
        }
      }
      if (entry.suggestedActions.length > 0) {
        out.push('');
        out.push('Suggested actions:');
        for (const a of entry.suggestedActions) {
          out.push(`- \`${a.kind}\` ${a.target} — ${a.note}`);
        }
      }
      out.push('');
    }
  }
  if (report.ai) {
    out.push(renderAiBlockMarkdown(report.ai));
  }
  return out.join('\n') + '\n';
}

function renderKnowledgeFixPlanMarkdown(plan: IKnowledgeFixPlan): string {
  const out: string[] = [];
  out.push(`# Knowledge fix plan — ${plan.fixPlanId}`);
  out.push('');
  out.push(`- generated: ${plan.generatedAt}`);
  out.push(`- derived from audit: ${plan.auditId}`);
  out.push(`- source hint: ${plan.sourceHint}`);
  out.push(
    `- summary: ${plan.summary.fixCount} fix(es) — high=${plan.summary.highConfidence}, medium=${plan.summary.mediumConfidence}, low=${plan.summary.lowConfidence}; skipped=${plan.summary.skipped}`,
  );
  out.push('');
  if (plan.fixes.length === 0) {
    out.push('No fix instructions emitted.');
    out.push('');
  } else {
    const order: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
    for (const confidence of order) {
      const inGroup = plan.fixes.filter((f) => f.confidence === confidence);
      if (inGroup.length === 0) continue;
      out.push(`## Confidence: ${confidence.toUpperCase()} (${inGroup.length})`);
      out.push('');
      for (const fix of inGroup) {
        out.push(
          `### \`${fix.entryId}\` — \`${fix.findingCategory}\` _(${fix.source}, ${fix.severity})_`,
        );
        out.push(`**Intent.** ${fix.intent}`);
        out.push('');
        out.push(`Original finding: ${fix.finding}`);
        out.push('');
        out.push('Agent prompt:');
        out.push('```');
        out.push(fix.agentPrompt);
        out.push('```');
        if (fix.llmSuggestion) {
          out.push('');
          out.push('LLM suggestion (advisory):');
          out.push('> ' + fix.llmSuggestion.split('\n').join('\n> '));
        }
        out.push('');
      }
    }
  }
  if (plan.skipped.length > 0) {
    out.push(`## Skipped (${plan.skipped.length})`);
    out.push('');
    for (const s of plan.skipped) {
      out.push(`- \`${s.entryId}\` / \`${s.findingCategory}\` — ${s.reason}`);
      out.push(`  - finding: ${s.finding}`);
    }
    out.push('');
  }
  return out.join('\n') + '\n';
}

/**
 * `shrk smart-context audit-pipelines` — local-LLM pipeline audit.
 *
 * Wraps `lintPipelines` from `@shrkcrft/inspector`, optionally layers
 * LLM critique, and emits a Claude-targetable fix plan. Same report-only
 * contract as audit-templates / audit-knowledge.
 */
export const smartContextAuditPipelinesCommand: ICommandHandler = {
  name: 'audit-pipelines',
  description:
    'Audit registered pipelines with the deterministic inspector and (when reachable) a local LLM critique pass. Report-only — no edits.',
  usage:
    'shrk smart-context audit-pipelines [--id <pipelineId>] [--no-enhance] [--provider auto|ollama|llamacpp] [--model <id>] [--save] [--json] [--fix-plan] [--only-plan]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');
    const save = flagBool(args, 'save');
    const noEnhance = flagBool(args, 'no-enhance');
    const pipelineId = flagString(args, 'id');
    const providerKind = flagString(args, 'provider');
    const model = flagString(args, 'model');
    const wantFixPlan = flagBool(args, 'fix-plan') || flagBool(args, 'only-plan');
    const onlyPlan = flagBool(args, 'only-plan');

    const inspection = await inspectSharkcraft({ cwd });
    let report = buildPipelineAudit(inspection, pipelineId ? { pipelineId } : {});

    if (report.pipelines.length === 0) {
      if (json) {
        process.stdout.write(asJson(report) + '\n');
      } else {
        process.stdout.write(
          pipelineId
            ? `No pipeline with id "${pipelineId}".\n`
            : 'No pipelines registered.\n',
        );
      }
      return pipelineId ? 1 : 0;
    }

    const selection = noEnhance ? null : selectAiProvider(providerKind);
    if (selection?.provider) {
      if (model) selection.provider.configure({ model });
      if (!json) {
        process.stderr.write(
          `[audit-pipelines] enriching with provider ${selection.provider.id}…\n`,
        );
      }
      report = await enrichPipelineAuditWithLlm(report, {
        provider: selection.provider,
        inspection,
        onPerPipelineError: (id, err) => {
          if (!json) {
            process.stderr.write(
              `[audit-pipelines] LLM pass failed for ${id}: ${err.message.slice(0, 120)} — keeping deterministic findings only.\n`,
            );
          }
        },
      });
    } else if (!noEnhance && !json) {
      process.stderr.write(
        '[audit-pipelines] no local LLM reachable — running deterministic-only audit. See `ai.hints` in the output for setup steps.\n',
      );
    }

    report = { ...report, ai: buildAiBlock({ selection, userOptedOut: noEnhance }) };

    const fixPlan = wantFixPlan ? buildPipelineFixPlan(report) : null;

    if (save) {
      const saved = savePipelineAuditReport(cwd, report, fixPlan);
      if (json) {
        process.stdout.write(asJson({ saved, report, ...(fixPlan ? { fixPlan } : {}) }) + '\n');
      } else {
        process.stdout.write(`Audit saved → ${saved.mdPath}\n`);
        process.stdout.write(`           → ${saved.jsonPath}\n`);
        if (saved.planMdPath && saved.planJsonPath) {
          process.stdout.write(`Plan  saved → ${saved.planMdPath}\n`);
          process.stdout.write(`           → ${saved.planJsonPath}\n`);
        }
      }
      return exitCodeForPipelineAudit(report);
    }

    if (json) {
      if (onlyPlan && fixPlan) {
        process.stdout.write(asJson(fixPlan) + '\n');
      } else if (fixPlan) {
        process.stdout.write(asJson({ report, fixPlan }) + '\n');
      } else {
        process.stdout.write(asJson(report) + '\n');
      }
      return exitCodeForPipelineAudit(report);
    }
    if (!onlyPlan) {
      process.stdout.write(renderPipelineAuditMarkdown(report));
    }
    if (fixPlan) {
      if (!onlyPlan) process.stdout.write('\n');
      process.stdout.write(renderPipelineFixPlanMarkdown(fixPlan));
    }
    return exitCodeForPipelineAudit(report);
  },
};

function exitCodeForPipelineAudit(report: IPipelineAuditReport): number {
  if (report.summary.broken > 0) return 1;
  return 0;
}

interface ISavedPipelineAuditFiles {
  slug: string;
  mdPath: string;
  jsonPath: string;
  planMdPath?: string;
  planJsonPath?: string;
}

function savePipelineAuditReport(
  cwd: string,
  report: IPipelineAuditReport,
  fixPlan: IPipelineFixPlan | null,
): ISavedPipelineAuditFiles {
  const dir = nodePath.join(cwd, SMART_CONTEXT_DIR);
  mkdirSync(dir, { recursive: true });
  const slug = `pipelines-${report.auditId}`;
  const mdPath = nodePath.join(dir, `${slug}.md`);
  const jsonPath = nodePath.join(dir, `${slug}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(mdPath, renderPipelineAuditMarkdown(report), 'utf8');
  if (!fixPlan) return { slug, mdPath, jsonPath };
  const planSlug = `pipelines-${fixPlan.fixPlanId}`;
  const planMdPath = nodePath.join(dir, `${planSlug}.md`);
  const planJsonPath = nodePath.join(dir, `${planSlug}.json`);
  writeFileSync(planJsonPath, JSON.stringify(fixPlan, null, 2), 'utf8');
  writeFileSync(planMdPath, renderPipelineFixPlanMarkdown(fixPlan), 'utf8');
  return { slug, mdPath, jsonPath, planMdPath, planJsonPath };
}

function renderPipelineAuditMarkdown(report: IPipelineAuditReport): string {
  const out: string[] = [];
  out.push(`# Pipeline audit — ${report.auditId}`);
  out.push('');
  out.push(`- generated: ${report.generatedAt}`);
  out.push(
    `- llm enriched: ${report.llmEnriched ? `yes (${report.llmProviderId ?? 'unknown'})` : 'no — deterministic only'}`,
  );
  out.push(
    `- summary: ok=${report.summary.ok}, minor=${report.summary.minor}, stale=${report.summary.stale}, broken=${report.summary.broken} (total ${report.summary.total})`,
  );
  out.push('');
  const order: Array<'broken' | 'stale' | 'minor' | 'ok'> = ['broken', 'stale', 'minor', 'ok'];
  for (const verdict of order) {
    const inGroup = report.pipelines.filter((p) => p.verdict === verdict);
    if (inGroup.length === 0) continue;
    out.push(`## ${verdict.toUpperCase()} (${inGroup.length})`);
    out.push('');
    for (const entry of inGroup) {
      out.push(`### \`${entry.pipelineId}\``);
      if (entry.deterministicFindings.length === 0 && entry.llmFindings.length === 0) {
        out.push('No findings.');
        out.push('');
        continue;
      }
      if (entry.deterministicFindings.length > 0) {
        out.push('');
        out.push('Findings:');
        for (const f of entry.deterministicFindings) {
          out.push(
            `- **[deterministic]** ${f.severity} \`${f.category}\`${f.stepId ? ` (step "${f.stepId}")` : ''} — ${f.message} _(sources: ${f.sources.join(', ')})_`,
          );
        }
      }
      if (entry.llmFindings.length > 0) {
        out.push('');
        out.push('LLM-flagged (advisory):');
        for (const f of entry.llmFindings) {
          out.push(
            `- **[llm]** ${f.severity} \`${f.category}\` (confidence ${f.confidence.toFixed(2)}) — ${f.message}`,
          );
        }
      }
      out.push('');
    }
  }
  if (report.ai) {
    out.push(renderAiBlockMarkdown(report.ai));
  }
  return out.join('\n') + '\n';
}

function renderPipelineFixPlanMarkdown(plan: IPipelineFixPlan): string {
  const out: string[] = [];
  out.push(`# Pipeline fix plan — ${plan.fixPlanId}`);
  out.push('');
  out.push(`- generated: ${plan.generatedAt}`);
  out.push(`- derived from audit: ${plan.auditId}`);
  out.push(`- source hint: ${plan.sourceHint}`);
  out.push(
    `- summary: ${plan.summary.fixCount} fix(es) — high=${plan.summary.highConfidence}, medium=${plan.summary.mediumConfidence}, low=${plan.summary.lowConfidence}`,
  );
  out.push('');
  if (plan.fixes.length === 0) {
    out.push('No fix instructions emitted.');
    out.push('');
    return out.join('\n') + '\n';
  }
  const order: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
  for (const confidence of order) {
    const inGroup = plan.fixes.filter((f) => f.confidence === confidence);
    if (inGroup.length === 0) continue;
    out.push(`## Confidence: ${confidence.toUpperCase()} (${inGroup.length})`);
    out.push('');
    for (const fix of inGroup) {
      out.push(
        `### \`${fix.pipelineId}\` — \`${fix.findingCategory}\` _(${fix.source}, ${fix.severity})_`,
      );
      out.push(`**Intent.** ${fix.intent}`);
      out.push('');
      out.push(`Original finding: ${fix.finding}`);
      out.push('');
      out.push('Agent prompt:');
      out.push('```');
      out.push(fix.agentPrompt);
      out.push('```');
      out.push('');
    }
  }
  return out.join('\n') + '\n';
}

// Patterns matching ONNX worker-thread teardown noise that surfaces
// AFTER a successful embeddings-build. `pipeline.dispose()` returns
// cleanly but `onnxruntime-node`'s worker pool isn't actually joined;
// when the main thread exits, the workers briefly outlive it and hit a
// pthread mutex teardown race. The libc++abi message is the user-visible
// symptom. Filtered here so the child's exit doesn't pollute the user's
// terminal — exit code is preserved.
const EMBEDDINGS_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /^libc\+\+abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed/,
];

function isEmbeddingsCleanupNoise(line: string): boolean {
  return EMBEDDINGS_NOISE_PATTERNS.some((p) => p.test(line));
}

/**
 * Run `embeddings-build` in an isolated child process and filter
 * known cleanup noise from its stderr. See EMBEDDINGS_NOISE_PATTERNS
 * for the rationale.
 *
 * Implementation: re-exec the same CLI binary (`process.execPath` +
 * `process.argv.slice(1)`) with `SHRK_EMBEDDINGS_WORKER=1` in the env.
 * The child sees the env flag, skips this wrapper, and runs the
 * indexing inline. The parent pipes child stdout through unchanged
 * (so JSON output + result line flow as-is) and filters child stderr
 * line-by-line before forwarding.
 *
 * Trust model: the child's exit code is the source of truth. Even if
 * the child aborts during cleanup, `reallyExit(code)` in main.ts has
 * already set the kernel-visible exit code before the abort. We
 * surface that code verbatim.
 */
/**
 * Run a smart-context brief/plan in an isolated child and return its real exit
 * code. stdio is inherited so progress + result flow straight to the user's
 * terminal; the child redirects fd 2 to a log file before its native teardown
 * abort, so no backtrace reaches the console. The child writes its true exit
 * code to a sentinel file (read back here) because the SIGABRT during teardown
 * would otherwise clobber it with 134. The parent loads no native runtime, so
 * it exits cleanly — no `zsh: abort`, correct code.
 */
function runSmartContextInChild(): Promise<number> {
  return new Promise<number>((resolve) => {
    const exitFile = nodePath.join(
      os.tmpdir(),
      `shrk-sc-exit-${process.pid}-${Date.now()}.code`,
    );
    const child = spawn(process.execPath, process.argv.slice(1), {
      env: {
        ...process.env,
        SHRK_SMART_CONTEXT_WORKER: '1',
        SHRK_WORKER_EXITCODE_FILE: exitFile,
      },
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      process.stderr.write(`Failed to spawn smart-context worker: ${err.message}\n`);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      // Prefer the sentinel — the worker writes its true exit code before the
      // native teardown can abort the process.
      let real: number | null = null;
      try {
        if (existsSync(exitFile)) {
          const raw = readFileSync(exitFile, 'utf8').trim();
          if (raw.length > 0 && Number.isFinite(Number(raw))) real = Number(raw);
          try {
            unlinkSync(exitFile);
          } catch {
            // best-effort cleanup
          }
        }
      } catch {
        // fall through to the signal/code-based result below
      }
      if (real !== null) {
        resolve(real);
        return;
      }
      // No sentinel (worker crashed mid-run, not during teardown) → surface a
      // failure rather than masking it. SIGABRT with no sentinel ⇒ non-zero.
      if (typeof code === 'number') resolve(code);
      else resolve(signal ? 1 : 0);
    });
  });
}

function runEmbeddingsBuildInChild(): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, process.argv.slice(1), {
      env: { ...process.env, SHRK_EMBEDDINGS_WORKER: '1' },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    child.stdout.pipe(process.stdout);
    let stderrBuf = '';
    const flushLine = (line: string): void => {
      if (isEmbeddingsCleanupNoise(line)) return;
      process.stderr.write(line + '\n');
    };
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      let idx: number;
      while ((idx = stderrBuf.indexOf('\n')) !== -1) {
        flushLine(stderrBuf.slice(0, idx));
        stderrBuf = stderrBuf.slice(idx + 1);
      }
    });
    child.on('error', (err) => {
      process.stderr.write(`Failed to spawn embeddings worker: ${err.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => {
      if (stderrBuf.length > 0 && !isEmbeddingsCleanupNoise(stderrBuf)) {
        process.stderr.write(stderrBuf);
      }
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

/** `shrk smart-context embeddings build` — (re)build the semantic index. */
export const smartContextEmbeddingsBuildCommand: ICommandHandler = {
  name: 'embeddings-build',
  description:
    'Build or incrementally refresh the semantic index. Defaults to incremental updates when an index already exists; pass --rebuild for a full rebuild.',
  usage:
    'shrk smart-context embeddings-build [--model <hf-id>] [--root <dir>]... [--max-files N] [--rebuild] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    // Top-level: if we're the parent, re-exec ourselves in worker mode
    // and filter the resulting cleanup noise. The child path (env flag
    // set) runs the original code below inline.
    if (process.env.SHRK_EMBEDDINGS_WORKER !== '1') {
      return runEmbeddingsBuildInChild();
    }

    const cwd = resolveCwd(args);
    const model = flagString(args, 'model');
    const maxFiles = flagNumber(args, 'max-files') ?? 5000;
    const rebuild = flagBool(args, 'rebuild');
    const json = flagBool(args, 'json');
    const explicitRoots = flagList(args, 'root');

    const files = listIndexableFilesForCli(cwd, maxFiles, explicitRoots);
    if (files.length === 0) {
      const triedRoots = explicitRoots.length > 0 ? explicitRoots : getDefaultSourceRoots();
      const existing = triedRoots
        .filter((rel) => existsSync(nodePath.join(cwd, rel)))
        .map((rel) => `${rel}/`);
      const missing = triedRoots
        .filter((rel) => !existsSync(nodePath.join(cwd, rel)))
        .map((rel) => `${rel}/`);
      const lines: string[] = [];
      lines.push(`No indexable .ts/.tsx/.js/.jsx/.md files found under ${cwd}.`);
      if (existing.length > 0) {
        lines.push(`  • Roots present but empty: ${existing.join(', ')}`);
      }
      if (missing.length > 0) {
        lines.push(`  • Roots not found: ${missing.join(', ')}`);
      }
      lines.push(
        `  • Pass --root <dir> (repeatable) to point at your source folder, e.g. --root src --root app.`,
      );
      process.stderr.write(lines.join('\n') + '\n');
      return 1;
    }

    const entries = files.map((path) => ({
      path,
      summary: readLeadingDocComment(cwd, path),
      exports: extractExportedNames(cwd, path),
    }));

    const start = Date.now();
    const existing = rebuild ? null : await SemanticIndex.tryLoad(cwd, model ? { model } : {});

    try {
      if (existing) {
        if (!json) {
          process.stderr.write(
            `[smart-context] refreshing semantic index (${existing.fileCount} indexed, ${entries.length} on disk)…\n`,
          );
        }
        const report = await existing.refresh(entries, {
          onProgress: json
            ? undefined
            : (done, total, action) => {
                if (done === total || done % 25 === 0) {
                  process.stderr.write(`[smart-context] re-embedded ${done}/${total} (${action})\n`);
                }
              },
        });
        const elapsedMs = Date.now() - start;
        if (json) {
          process.stdout.write(
            asJson({
              mode: 'refresh',
              files: existing.fileCount,
              model: existing.modelName,
              elapsedMs,
              ...report,
            }) + '\n',
          );
        } else {
          process.stdout.write(
            `\nRefreshed in ${(elapsedMs / 1000).toFixed(1)}s — added ${report.added}, changed ${report.changed}, removed ${report.removed}, unchanged ${report.unchanged} (total ${report.totalAfter}, model ${existing.modelName}).\n`,
          );
        }
        return 0;
      }
      if (!json) {
        process.stderr.write(
          `[smart-context] ${rebuild ? 'rebuilding' : 'building'} embedding index for ${entries.length} files (model: ${model ?? 'Xenova/bge-base-en-v1.5'})…\n`,
        );
      }
      const index = await SemanticIndex.build(cwd, entries, {
        ...(model ? { model } : {}),
        onProgress: json
          ? undefined
          : (done, total) => {
              if (done === total || done % 50 === 0) {
                process.stderr.write(`[smart-context] embedded ${done}/${total}\n`);
              }
            },
      });
      const elapsedMs = Date.now() - start;
      if (json) {
        process.stdout.write(
          asJson({ mode: 'build', files: index.fileCount, model: index.modelName, elapsedMs }) + '\n',
        );
      } else {
        process.stdout.write(
          `\nIndexed ${index.fileCount} files in ${(elapsedMs / 1000).toFixed(1)}s (model ${index.modelName}).\n`,
        );
      }
      return 0;
    } catch (e) {
      process.stderr.write(`Failed to build semantic index: ${(e as Error).message}\n`);
      return 1;
    }
  },
};

function listIndexableFilesForCli(cwd: string, max: number, roots?: readonly string[]): string[] {
  return listIndexableFiles(cwd, max, roots && roots.length > 0 ? { roots } : {});
}

/** `shrk smart-context embeddings-status` — freshness report (no model load). */
export const smartContextEmbeddingsStatusCommand: ICommandHandler = {
  name: 'embeddings-status',
  description:
    'Report semantic index freshness — how many indexed files are stale, missing, or untracked. Does not load the embedding model.',
  usage: 'shrk smart-context embeddings-status [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');
    const current = listIndexableFilesForCli(cwd, 5000);
    const report = SemanticIndex.freshnessReport(cwd, current);
    if (json) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    if (!report.hasIndex) {
      process.stdout.write(
        `No semantic index yet (workspace has ${report.untracked} indexable files).\n`,
      );
      process.stdout.write('Run: shrk smart-context embeddings-build\n');
      return 0;
    }
    if (report.corrupt) {
      process.stderr.write('Semantic index meta is corrupt; run `shrk smart-context embeddings-build --rebuild`.\n');
      return 1;
    }
    const stalePct = report.indexed > 0 ? Math.round((report.stale * 100) / report.indexed) : 0;
    process.stdout.write(
      `Indexed: ${report.indexed} (model ${report.model})\n` +
        `  fresh:     ${report.fresh}\n` +
        `  stale:     ${report.stale} (${stalePct}%)\n` +
        `  missing:   ${report.missing} (in store but deleted on disk)\n` +
        `  untracked: ${report.untracked} (on disk but not indexed)\n`,
    );
    if (report.stale + report.missing + report.untracked > 0) {
      process.stdout.write('Refresh: shrk smart-context embeddings-build\n');
    }
    return 0;
  },
};

function extractExportedNames(cwd: string, path: string): string[] {
  const abs = nodePath.isAbsolute(path) ? path : nodePath.join(cwd, path);
  let body: string;
  try {
    body = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  const pattern =
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|const|let|var|class|interface|enum|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    if (out.length >= 16) break;
    if (m[1]) out.push(m[1]);
  }
  return out;
}

interface ISmartContextOptions {
  mode: 'brief' | 'plan';
  provider?: string;
  model?: string;
  maxTokens: number;
  stage1MaxTokens: number;
  seedTokens: number;
  expansionTokens: number;
  expansionLimit: number;
  dryRun: boolean;
  json: boolean;
  save: boolean;
  debug: boolean;
  aiPlan: boolean;
  instructionsPath?: string;
  noInstructions: boolean;
  logPrompt: boolean;
  saveConversation: boolean;
  saveConversationPath?: string;
  noRefreshIndex: boolean;
  noCache: boolean;
  cacheReplayThreshold: number;
  cacheReferenceThreshold: number;
  focused: boolean;
  tinyOnly: boolean;
  taskTypeOverride: TaskType | null;
  /** Architecture plans default to a polish pass; set to true to skip it. */
  noPolish: boolean;
  /**
   * When set, focused-mode semantic search is restricted to files
   * changed since this git ref (plus their direct neighbors via the
   * import graph). Powers "what should I look at given my recent
   * changes?" workflows for the Claude agent watching the repo.
   */
  sinceRef?: string;
  /** Stream tokens to stderr as they're decoded (llamacpp only). */
  stream: boolean;
  /**
   * Multi-pass enhancement pipeline (brief mode). When the LLM is
   * ready, the pipeline runs `draft → critique → refine → polish`
   * over the deterministic seed. Off in plan / ai-plan modes (those
   * have their own dedicated flow). `false` disables the pipeline
   * even when an LLM is ready (falls back to single-shot).
   */
  enhance: boolean;
  /** Cap pipeline depth (default 4 = all stages). */
  enhancePasses: number | null;
  /**
   * `--plus`: run the full multi-pass `draft → critique → refine → polish`
   * pipeline ("use the LLM more, several calls, denser output") with a larger
   * wall-clock budget. Default (off) runs the fast 2-pass `draft → polish`.
   */
  plus: boolean;
  /**
   * `--budget <seconds>` override for the enhancement wall-clock budget. When
   * unset, defaults to the fast / plus ceiling. Lets the user cap a slow model
   * tightly (e.g. `--budget 60`).
   */
  budgetMs?: number;
}

function readCommonOptions(args: ParsedArgs): ISmartContextOptions {
  const aiPlan = flagBool(args, 'ai-plan');
  const wantPlan = flagBool(args, 'plan') || aiPlan;
  const mode: 'brief' | 'plan' = wantPlan ? 'plan' : 'brief';
  const model = flagString(args, 'model');
  const provider = flagString(args, 'provider');
  const maxTokens = flagNumber(args, 'max-tokens') ?? (mode === 'plan' ? 6144 : 3072);
  return {
    mode,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    maxTokens,
    stage1MaxTokens: flagNumber(args, 'stage1-max-tokens') ?? Math.min(2048, maxTokens),
    seedTokens: flagNumber(args, 'seed-tokens') ?? 3500,
    expansionTokens: flagNumber(args, 'expansion-tokens') ?? 2200,
    expansionLimit: flagNumber(args, 'expansion-limit') ?? 12,
    dryRun: flagBool(args, 'dry-run'),
    json: flagBool(args, 'json'),
    save: flagBool(args, 'save'),
    debug: flagBool(args, 'debug'),
    aiPlan,
    ...(flagString(args, 'instructions') ? { instructionsPath: flagString(args, 'instructions') } : {}),
    noInstructions: flagBool(args, 'no-instructions'),
    noRefreshIndex: flagBool(args, 'no-refresh-index'),
    noCache: flagBool(args, 'no-cache'),
    cacheReplayThreshold: flagNumber(args, 'cache-replay-threshold') ?? 0.95,
    cacheReferenceThreshold: flagNumber(args, 'cache-reference-threshold') ?? 0.75,
    focused: flagBool(args, 'focused') || flagBool(args, 'tiny-only'),
    tinyOnly: flagBool(args, 'tiny-only'),
    taskTypeOverride: parseTaskTypeOverride(flagString(args, 'task-type')),
    noPolish: flagBool(args, 'no-polish'),
    ...(flagString(args, 'since') ? { sinceRef: flagString(args, 'since') } : {}),
    stream: flagBool(args, 'stream'),
    enhance: resolveEnhanceFlag(args),
    enhancePasses: flagNumber(args, 'enhance-passes') ?? readEnhancePassesEnv(),
    plus: flagBool(args, 'plus'),
    ...(flagNumber(args, 'budget') !== undefined
      ? { budgetMs: Math.max(1, flagNumber(args, 'budget')!) * 1000 }
      : {}),
    logPrompt: flagBool(args, 'log-prompt'),
    saveConversation:
      flagBool(args, 'save-conversation') || flagString(args, 'save-conversation') !== undefined,
    ...(flagString(args, 'save-conversation')
      ? { saveConversationPath: flagString(args, 'save-conversation') }
      : {}),
  };
}

interface IStage1FileBrief {
  path: string;
  summary: string | null;
  exports: string[];
  exportSignatures: string[];
  imports: string[];
  importedBy: string[];
}

interface IDocumentationHit {
  path: string;
  line: number;
  snippet: string;
  token: string;
}

interface ISmartContextSeed {
  task: string;
  overviewText: string;
  contextBody: string;
  packet: ReturnType<typeof buildTaskPacket>;
  repoInstructions: { path: string; body: string } | null;
  graphGrounding: IInitialGraphGrounding;
  stage1FileBriefs: IStage1FileBrief[];
  documentationHits: IDocumentationHit[];
  semanticCandidates: ISemanticHit[];
  semanticModel: string | null;
}

async function buildSmartContextSeed(input: {
  cwd: string;
  task: string;
  inspection: ISharkcraftInspection;
  options: ISmartContextOptions;
}): Promise<ISmartContextSeed> {
  const { cwd, task, inspection, options } = input;
  const overview = buildProjectOverview(inspection.workspace, inspection.config?.projectName);
  const overviewText = renderOverviewText(overview);
  const packet = buildTaskPacket(inspection, task, { maxTokens: options.seedTokens });
  const ctx = buildContext(inspection.knowledgeEntries, {
    task,
    maxTokens: options.seedTokens,
    projectOverview: overviewText,
  });
  const graphGrounding = buildInitialGraphGrounding(cwd, task);
  const semantic = await tryLoadSemanticHits(cwd, task, 10, options);
  return {
    task,
    overviewText,
    contextBody: ctx.body,
    packet,
    repoInstructions: resolveRepoInstructions(cwd, options),
    graphGrounding,
    stage1FileBriefs: buildStage1FileBriefs(cwd, graphGrounding.taskFileCandidates, 6),
    documentationHits: collectDocumentationHits(cwd, tokenizeTask(task), 10),
    semanticCandidates: semantic.hits,
    semanticModel: semantic.model,
  };
}

const AUTO_REFRESH_FILE_CAP = 30;

const FOCUSED_BRIEF_PREAMBLE = [
  "You are a development planner for a SharkCraft-instrumented repository.",
  'The supplied context contains ONLY the most task-relevant code blocks, rules, docs, and validation commands — picked by an embedding model that ranked them against the user task.',
  'STRICT GROUNDING: every file path, rule id, and command in your output MUST appear verbatim in the supplied context. Do not invent.',
  'Output a concise Markdown BRIEF (≤ 400 words):',
  '  1. Restate the task in one sentence.',
  '  2. Cite the most relevant rule ids verbatim, each with one line of how-it-applies.',
  '  3. List the most likely files to read, then the most likely files to edit (use the supplied paths verbatim).',
  '  4. List the commands to run.',
  '  5. Flag gotchas, risks, or forbidden actions if present.',
  'No preamble. No closing pleasantries. Just the brief.',
].join(' ');

const FOCUSED_PLAN_PREAMBLE = [
  "You are a development planner for a SharkCraft-instrumented repository.",
  'The supplied context contains ONLY the most task-relevant code blocks (interfaces, signatures), rules, docs, and validation commands — selected by an embedding model that ranked them against the user task.',
  'STRICT GROUNDING: every path / rule id / command in your output MUST appear verbatim in the supplied context. Do not invent any new files.',
  'Output a detailed PLAN as one fenced ```json block then a short Markdown summary.',
  'The JSON must conform to this schema (omit empty arrays):',
  '{',
  '  "summary": string,',
  '  "filesToRead":      [{ "path": string, "why": string }],',
  '  "likelyFilesToEdit":[{ "path": string, "why": string }],',
  '  "relatedRules":     [{ "id": string, "applyWhen": string }],',
  '  "firstCommands":    [{ "command": string, "why": string }],',
  '  "implementationSteps": [{ "step": string, "details": string }],',
  '  "risks": [string],',
  '  "openQuestions": [string]',
  '}',
].join(' ');

const FOCUSED_ARCHITECTURE_PREAMBLE = [
  "You are a senior architect for a SharkCraft-instrumented repository. The user task is abstract: design first, code never.",
  '',
  'This repository has a SPECIFIC shape — use it:',
  '- The CLI (`shrk`) is the only write path. Inputs: argv. Outputs: stdout / fs writes under `.sharkcraft/`.',
  '- The MCP server is READ-ONLY. The agent CALLS it; it never pushes.',
  '- The dashboard is a localhost HTTP read-only server (GET/HEAD only).',
  '- Persistent state lives under `.sharkcraft/` (gitignored).',
  '- A BGE embedding index already exists at `.sharkcraft/embeddings/`.',
  '- A plan cache already exists at `.sharkcraft/smart-context/cache/plans.jsonl`.',
  '',
  'INTEGRATION VOCABULARY — use exactly these surface values. DO NOT use HTTP verbs like GET/POST for CLI, MCP, or file-system surfaces (those do not speak HTTP):',
  '- `cli-command`       — a new `shrk <subcommand>` the user runs once.',
  '- `cli-watcher`       — a long-running `shrk watch <X>` that emits stdout JSONL when triggers fire.',
  '- `mcp-tool-call`     — a new read-only MCP tool the agent invokes (pull, not push).',
  '- `mcp-resource-read` — a new MCP resource the agent reads on demand (pull).',
  '- `file-read`         — agent reads a file the producer wrote.',
  '- `file-write`        — producer writes a file (under `.sharkcraft/`).',
  '- `stdout-stream`     — producer prints JSONL lines on stdout.',
  '- `background-watcher`— an `fs.watch` listener inside a CLI process.',
  '',
  'STRICT GROUNDING: every file path / rule id / command in your output MUST appear in the supplied context. Code blocks below are *patterns to study*, not files to edit.',
  '',
  'Output one ```json block conforming to the schema below, then a short Markdown summary.',
  '',
  '{',
  '  "summary": string,                                              // 1 sentence, design framing',
  '  "taskUnderstanding": string,',
  '  "designQuestions": [string],                                    // ≤ 7 SHRK-SPECIFIC questions; see required topics below',
  '  "candidateArchitectures": [{                                    // 2–4 *genuinely different* options',
  '     "name": string,',
  '     "shape": string,                                              // concrete 1-liner from the vocabulary above',
  '     "howItWorks": string,                                         // 1 paragraph',
  '     "differentiator": string,                                     // ONE sentence stating WHAT MAKES THIS DIFFERENT from the others',
  '     "uniquePros": [string],                                       // ≥ 1 pro that no other candidate could claim',
  '     "uniqueCons": [string],                                       // ≥ 1 con that no other candidate has',
  '     "recommendation": "recommended" | "possible-later" | "not-for-mvp"',
  '  }],',
  '  "recommendedMvp": {                                              // EXACTLY ONE candidate.recommendation must be "recommended"',
  '     "architectureName": string,                                   // must match a candidateArchitectures.name',
  '     "why": string,                                                // why it is the safest first spike',
  '     "explicitlyNotInScope": [string]                              // what we are NOT building yet',
  '  },',
  '  "firstSpike": {                                                  // small, concrete, runnable',
  '     "proposedCommand": string | null,                             // e.g. "shrk context-feed start --interval 5s"',
  '     "proposedFiles": [{ "path": string, "purpose": string }],     // e.g. ".sharkcraft/context-stream/<timestamp>.json"',
  '     "schemaOutline": string,                                      // minimal JSON sketch of any context packet shape',
  '     "successCriteria": [string]                                   // observable pass/fail bullets',
  '  },',
  '  "integrationPoints": [{                                          // where this WOULD touch existing code',
  '     "surface": "cli-command"|"cli-watcher"|"mcp-tool-call"|"mcp-resource-read"|"file-read"|"file-write"|"stdout-stream"|"background-watcher",',
  '     "name": string,                                                // e.g. "shrk context-feed start", "context-packet/next"',
  '     "why": string',
  '  }],',
  '  "concerns": {                                                     // pick the ones that apply to the design',
  '     "contextPacketSchema": string,                                 // shape of one packet',
  '     "updateTrigger": string,                                       // ONE of: file-change, time-tick, user-event, graph-drift, stdin-prompt',
  '     "deduplication": string,                                       // how repeated packets are coalesced or skipped',
  '     "contextBudget": string,                                       // token / byte cap per packet',
  '     "claudeHandoffMechanism": string,                              // exactly how the consuming agent receives a packet',
  '     "mcpVsFsVsCliResponsibility": string,                          // which surface OWNS which job; explicit split',
  '     "sessionPersistence": string                                   // what survives a CLI restart',
  '  },',
  '  "filesToInspect": [{ "path": string, "why": string }],            // EXISTING patterns to read; NOT files to edit',
  '  "relatedRules": [{ "id": string, "applyWhen": string }],',
  '  "nonGoals": [string],',
  '  "risks": [string],',
  '  "openQuestions": [string]                                          // ≤ 5; ONLY task-specific',
  '}',
  '',
  'DIFFERENTIATION RULE — failure to obey will make the output rejected:',
  '- Each candidate\'s `uniquePros` and `uniqueCons` MUST list at least one item that no other candidate has.',
  '- If two candidates would have the same pros/cons, DROP one and keep only options that materially differ.',
  '- Exactly ONE candidate has `recommendation: "recommended"` and is named in `recommendedMvp.architectureName`.',
  '',
  'REQUIRED designQuestions topics (skip those that genuinely do not apply, but the surviving ones MUST be specific not generic):',
  '- Context-packet schema (what is in one packet?)',
  '- Update trigger (when do we emit?)',
  '- Deduplication (when is a packet *not* worth emitting?)',
  '- Context budget per packet',
  '- Claude handoff mechanism (how does the agent ingest a packet?)',
  '- MCP vs file-system vs CLI responsibility (who owns what?)',
  '- Session persistence (what survives a CLI restart?)',
  '',
  'ANTI-PATTERNS — emit ANY of these and the output is considered defective:',
  '- "May require additional resources and infrastructure" (generic boilerplate)',
  '- "May introduce additional complexity" (generic boilerplate)',
  '- "May require additional security and privacy considerations" (generic boilerplate)',
  '- "Can be implemented as a separate tool or as a plugin" (every option can — useless differentiation)',
  '- HTTP verbs (`GET`, `POST`, `PUT`, `DELETE`) on `cli-*`, `mcp-*`, `file-*`, or `stdout-*` surfaces',
  '- Questions about "documentation and support level", "user interaction", "monitoring and logging" (enterprise boilerplate, not SHRK-specific)',
  '- Questions about "scalability" or "throughput" unless the task explicitly names a load target',
  '',
  'GOOD differentiator EXAMPLE: "Sidecar is a child process forked from `shrk watch`; lives with that process. MCP-tool-call alternative is a pull-only RPC the agent invokes when it wants a packet — no continuous process at all."',
  'BAD differentiator EXAMPLE: "Can be implemented as a separate tool" (every candidate can).',
].join('\n');

const FOCUSED_ARCHITECTURE_POLISH_PREAMBLE = [
  'You are a critic improving an architectural design brief for a SharkCraft repository.',
  'You are given (a) the original deterministic context, (b) the first-pass JSON brief.',
  'Return ONE improved JSON object using the same schema, then a one-paragraph Markdown summary. No preface.',
  '',
  'YOUR JOB — fix EACH of these defects if you see them:',
  '1. Generic / repeated content in candidateArchitectures pros/cons.',
  '   - Every `uniquePros` and `uniqueCons` must contain at least one item no other option has.',
  '   - Drop any candidate that, after deduplication, has no unique pro or no unique con.',
  '2. Wrong vocabulary in integrationPoints.surface.',
  '   - Replace any HTTP verb / generic surface ("CLI"/"MCP server") with the canonical kebab-case vocabulary: `cli-command`, `cli-watcher`, `mcp-tool-call`, `mcp-resource-read`, `file-read`, `file-write`, `stdout-stream`, `background-watcher`.',
  '   - Each integrationPoint must name an actual surface (e.g. `shrk context-feed`, `context-packet/next`), not just "GET".',
  '3. No recommendedMvp picked, or `recommendation` field missing.',
  '   - Exactly ONE candidate gets `recommendation: "recommended"`. Others split between `possible-later` and `not-for-mvp`.',
  '   - Populate `recommendedMvp.architectureName` to match. Fill `recommendedMvp.explicitlyNotInScope` with at least 2 items.',
  '4. firstSpike too vague.',
  '   - `proposedCommand`: an actual command line if any.',
  '   - `proposedFiles`: actual paths under .sharkcraft/.',
  '   - `schemaOutline`: a minimal JSON sketch (a few fields with types).',
  '   - `successCriteria`: observable bullets ("packet appears on stdout within 200ms of file save").',
  '5. designQuestions / openQuestions polluted with generic enterprise boilerplate.',
  '   - Remove any question about "documentation and support level", "user interaction", "monitoring and logging", broad "scalability".',
  '   - Keep only SHRK-specific questions tied to the user task.',
  '6. nonGoals empty.',
  '   - At least 2 explicit non-goals, e.g. "Editing provider send methods.", "Adding write paths to MCP.".',
  '',
  'PRESERVE: filesToInspect, relatedRules — only fix what is broken.',
  'STRICT GROUNDING still applies: every file path, rule id, and command name must already appear in the original context.',
].join('\n');

const FOCUSED_INVESTIGATION_PREAMBLE = [
  "You are an investigator. The user wants to *understand* something in a SharkCraft-instrumented repository, not change it yet.",
  'Read the supplied code blocks as evidence. Hypotheses are welcome; certainty must be earned.',
  'Output a Markdown report (no JSON required) with: (1) Restated question; (2) What the supplied context tells us; (3) Best current hypothesis with confidence; (4) Files to read next to confirm/refute; (5) Open questions.',
  'STRICT GROUNDING: every path you cite must appear in the context.',
  'DO NOT propose code changes — this is investigation only.',
].join(' ');

async function runFocusedMode(input: {
  cwd: string;
  task: string;
  seed: ISmartContextSeed;
  options: ISmartContextOptions;
}): Promise<number | null> {
  const index = await SemanticIndex.tryLoad(input.cwd);
  if (!index) {
    process.stderr.write(
      '[smart-context] --focused / --tiny-only requires a semantic index. Run `shrk smart-context embeddings-build` first.\n',
    );
    return 1;
  }

  const auto = classifyTask(input.task);
  const taskType: TaskType = input.options.taskTypeOverride ?? auto.type;
  const classification: ITaskClassification = input.options.taskTypeOverride
    ? { type: input.options.taskTypeOverride, confidence: 1, signals: ['override'], scores: {} }
    : auto;
  if (!input.options.json) {
    const topSignals = classification.signals.slice(0, 4).join(', ') || 'none';
    process.stderr.write(
      `[smart-context] task type: ${taskType} (confidence ${classification.confidence.toFixed(2)}, signals: ${topSignals})\n`,
    );
    if (taskType === TaskType.Architecture) {
      process.stderr.write(
        '[smart-context] routing through architecture/design prompt — files listed will be "to inspect", not "to edit".\n',
      );
    }
  }

  // --since: build a path allowlist of changed files + one-hop graph
  // neighbors so the focused bundle stays anchored to the diff.
  let pathAllowlist: string[] | undefined;
  if (input.options.sinceRef) {
    pathAllowlist = collectChangedPathsWithNeighbors(input.cwd, input.options.sinceRef);
    if (!input.options.json) {
      if (pathAllowlist.length === 0) {
        process.stderr.write(
          `[smart-context] --since ${input.options.sinceRef}: no changed files found (or git unavailable). Ignoring the allowlist.\n`,
        );
        pathAllowlist = undefined;
      } else {
        process.stderr.write(
          `[smart-context] --since ${input.options.sinceRef}: restricting to ${pathAllowlist.length} changed-or-neighbor file(s).\n`,
        );
      }
    } else if (pathAllowlist.length === 0) {
      pathAllowlist = undefined;
    }
  }

  if (!input.options.json) {
    process.stderr.write('[smart-context] building focused context (BGE multi-cycle re-ranking)…\n');
  }
  const focused = await buildFocusedContext({
    cwd: input.cwd,
    task: input.task,
    index,
    rules: input.seed.packet.relevantRules,
    verificationCommands: input.seed.packet.verificationCommands,
    docCandidatePool: input.seed.documentationHits.map((h) => ({
      path: h.path,
      line: h.line,
      snippet: h.snippet,
    })),
    ...(pathAllowlist ? { pathAllowlist } : {}),
  });
  if (!input.options.json) {
    process.stderr.write(
      `[smart-context] focused bundle: ${focused.files.length} files, ${focused.docHits.length} doc hits, ${focused.rules.length} rules (~${focused.approxTokens} tokens).\n`,
    );
  }

  if (input.options.tinyOnly) {
    const plan = renderTinyPlan(focused, taskType);
    const envelope = buildEnvelope({
      task: input.task,
      seed: input.seed,
      mode: input.options.mode,
      ai: {
        content: plan,
        model: index.modelName,
        finishReason: null,
        usage: null,
        providerId: 'tiny-bge',
      },
    });
    if (input.options.save) {
      const saved = saveEnvelope(input.cwd, envelope);
      writeSavedNotice(saved, input.options.json, envelope);
      return 0;
    }
    writeEnvelope(envelope, input.options.json, input.options.debug);
    return 0;
  }

  // --focused (without --tiny-only): single LLM call with the tight bundle.
  const messages = buildFocusedMessages(focused, input.options.mode, taskType);
  logPromptToStderr(`focused-${input.options.mode}-${taskType}`, messages, input.options);
  if (input.options.dryRun) {
    writeDryRun(messages, input.options.mode, displayProviderName(input.options.provider));
    return 0;
  }

  const selection = selectAiProvider(input.options.provider);
  if (!selection.provider) {
    process.stderr.write(providerMissingMessage(selection.requested) + '\n');
    return 1;
  }
  if (input.options.model) selection.provider.configure({ model: input.options.model });
  if (!input.options.json) {
    process.stdout.write(`(provider: ${selection.provider.id}, strategy: focused)\n`);
  }
  const aiResult = await callProvider({
    provider: selection.provider,
    messages,
    maxTokens: input.options.maxTokens,
    model: input.options.model,
    ...(input.options.stream && !input.options.json
      ? {
          onTokenStream: (chunk: string) => {
            process.stderr.write(chunk);
          },
        }
      : {}),
  });
  if (input.options.stream && !input.options.json) process.stderr.write('\n');
  if (!aiResult.ok) {
    printError(aiResult.error);
    return 1;
  }

  // Polish pass — only for architecture tasks in plan mode, default-on,
  // user can opt out with --no-polish. This is a critic call: it takes
  // the first response and the original context and improves on it.
  let finalAi = aiResult.value;
  let polishMessages: IAiMessage[] | null = null;
  const shouldPolish =
    taskType === TaskType.Architecture &&
    input.options.mode === 'plan' &&
    !input.options.noPolish;
  if (shouldPolish) {
    polishMessages = buildPolishMessages(focused, finalAi.content);
    logPromptToStderr(`focused-architecture-polish`, polishMessages, input.options);
    if (!input.options.json) {
      process.stderr.write('[smart-context] polish pass — critic refining the design brief…\n');
    }
    const polish = await callProvider({
      provider: selection.provider,
      messages: polishMessages,
      maxTokens: input.options.maxTokens,
      model: input.options.model,
    });
    if (polish.ok) {
      finalAi = polish.value;
    } else {
      // Polish failure is non-fatal — we still have the first-pass output.
      if (!input.options.json) {
        process.stderr.write(
          `[smart-context] polish pass failed (${polish.error.message.slice(0, 100)}); keeping first-pass plan.\n`,
        );
      }
    }
  }

  if (input.options.saveConversation) {
    const turns: ISmartContextConversationTurn[] = [
      {
        stage: 'single',
        request: { messages: messages.map((m) => ({ role: m.role, content: m.content })) },
        response: {
          content: aiResult.value.content,
          model: aiResult.value.model,
          finishReason: aiResult.value.finishReason,
          usage: aiResult.value.usage,
        },
      },
    ];
    if (polishMessages && finalAi !== aiResult.value) {
      turns.push({
        stage: 'stage2',
        request: { messages: polishMessages.map((m) => ({ role: m.role, content: m.content })) },
        response: {
          content: finalAi.content,
          model: finalAi.model,
          finishReason: finalAi.finishReason,
          usage: finalAi.usage,
        },
      });
    }
    const path = writeConversationFile({
      cwd: input.cwd,
      task: input.task,
      mode: input.options.mode,
      options: input.options,
      providerId: finalAi.providerId,
      model: finalAi.model,
      turns,
    });
    if (!input.options.json) {
      process.stderr.write(`[smart-context] conversation saved → ${path}\n`);
    }
  }
  // Parse the LLM JSON output and walk it for unverified paths. Non-fatal
  // if parsing fails — focused mode is permissive about shape. When we do
  // get a parsed plan, attach it to the envelope so `shrk spike` and
  // downstream tooling can act on it.
  let parsedPlan = tryParseFocusedJson(finalAi.content);
  let unverifiedPaths = parsedPlan ? collectUnverifiedPathsFromJson(input.cwd, parsedPlan) : [];
  let pathRetried = false;

  // Path-aware retry: if the parsed plan cites paths that don't exist,
  // one extra LLM call with the offending paths called out usually
  // fixes it. Capped at one retry to avoid spinning. Skipped under
  // --no-polish (the user opted out of extra LLM work).
  if (
    parsedPlan !== null &&
    unverifiedPaths.length > 0 &&
    !input.options.noPolish &&
    input.options.mode === 'plan'
  ) {
    if (!input.options.json) {
      process.stderr.write(
        `[smart-context] ⚠ ${unverifiedPaths.length} unverified path(s) — retrying once with explicit corrections…\n`,
      );
    }
    const fixupMessages = buildPathFixupMessages(focused, finalAi.content, unverifiedPaths);
    logPromptToStderr(`focused-${input.options.mode}-path-fixup`, fixupMessages, input.options);
    const fixup = await callProvider({
      provider: selection.provider,
      messages: fixupMessages,
      maxTokens: input.options.maxTokens,
      model: input.options.model,
    });
    if (fixup.ok) {
      const reparsed = tryParseFocusedJson(fixup.value.content);
      if (reparsed) {
        const reUnverified = collectUnverifiedPathsFromJson(input.cwd, reparsed);
        // Accept the retry only if it reduced unverified-path count.
        if (reUnverified.length < unverifiedPaths.length) {
          finalAi = fixup.value;
          parsedPlan = reparsed;
          unverifiedPaths = reUnverified;
          pathRetried = true;
          if (!input.options.json) {
            process.stderr.write(
              `[smart-context] path-aware retry succeeded — ${unverifiedPaths.length} unverified path(s) remaining.\n`,
            );
          }
        } else if (!input.options.json) {
          process.stderr.write(
            `[smart-context] path-aware retry did not improve (${reUnverified.length} unverified); keeping previous response.\n`,
          );
        }
      }
    } else if (!input.options.json) {
      process.stderr.write(
        `[smart-context] path-aware retry failed (${fixup.error.message.slice(0, 100)}); keeping previous response.\n`,
      );
    }
  }

  if (!input.options.json) {
    if (parsedPlan === null) {
      process.stderr.write(
        '[smart-context] focused response did not contain a parseable JSON block; saving as raw text.\n',
      );
    } else if (unverifiedPaths.length > 0) {
      process.stderr.write(
        `[smart-context] ⚠ ${unverifiedPaths.length} unverified path(s) remain (possible hallucination): ${unverifiedPaths
          .slice(0, 4)
          .map((u) => u.path)
          .join(', ')}${unverifiedPaths.length > 4 ? ', …' : ''}\n`,
      );
    }
  }

  const envelope = buildEnvelope({
    task: input.task,
    seed: input.seed,
    ai: finalAi,
    mode: input.options.mode,
    aiPlan: {
      strategy: shouldPolish && finalAi !== aiResult.value ? 'focused-polished' : 'focused',
      requestedProvider: input.options.provider ?? 'auto',
      taskType,
      ...(parsedPlan ? { focusedParsedPlan: parsedPlan } : {}),
      ...(unverifiedPaths.length > 0 ? { unverifiedPaths } : {}),
      ...(pathRetried ? { warnings: ['Path-aware retry was applied.'] } : {}),
    },
  });
  if (input.options.save) {
    const saved = saveEnvelope(input.cwd, envelope);
    writeSavedNotice(saved, input.options.json, envelope);
    return 0;
  }
  writeEnvelope(envelope, input.options.json, input.options.debug);
  return 0;
}

function buildPathFixupMessages(
  focused: IFocusedContext,
  firstPassContent: string,
  unverified: ReadonlyArray<{ path: string; where: string }>,
): IAiMessage[] {
  const context = renderFocusedContextForPrompt(focused);
  const list = unverified.map((u) => `  - "${u.path}" (at ${u.where})`).join('\n');
  const preamble = [
    'You are a critic fixing path hallucinations in a focused plan you previously produced.',
    'Your previous response cited file paths that DO NOT EXIST in the supplied context.',
    'Return ONE corrected JSON object using the same schema as the previous response — no preface, no markdown around the JSON.',
    '',
    'PATHS TO REPLACE (these were invented; remove them or substitute paths that appear verbatim in the context):',
    list,
    '',
    'RULES:',
    '- Every `path` field MUST appear verbatim in the supplied context (`# Most relevant code` headings, `imports:`, `imported by:`, or `Related docs`).',
    '- If you cannot find a real replacement, OMIT the offending entry rather than inventing another one.',
    '- Do not change other fields beyond what is necessary to remove the hallucinated paths.',
  ].join('\n');
  const systemContext = [
    context,
    '',
    '# Previous response (fix the paths in here)',
    '```',
    firstPassContent.trim(),
    '```',
  ].join('\n');
  return buildPromptMessages({
    systemPreamble: `${preamble}\n\nThe user's task is: ${focused.task}`,
    context: systemContext,
    task: focused.task,
  });
}

function buildPolishMessages(
  focused: IFocusedContext,
  firstPassContent: string,
): IAiMessage[] {
  const context = renderFocusedContextForPrompt(focused);
  // Bundle the first-pass output INTO the system context so the critic
  // sees both the deterministic context and the candidate brief in one
  // turn. The user message restates the task to keep small-model focus.
  const systemContext = [
    context,
    '',
    '# First-pass design brief (improve this)',
    '```json-or-markdown',
    firstPassContent.trim(),
    '```',
  ].join('\n');
  return buildPromptMessages({
    systemPreamble: `${FOCUSED_ARCHITECTURE_POLISH_PREAMBLE}\n\nThe user's task is: ${focused.task}`,
    context: systemContext,
    task: focused.task,
  });
}

function buildFocusedMessages(
  focused: IFocusedContext,
  mode: 'brief' | 'plan',
  taskType: TaskType,
): IAiMessage[] {
  const preamble = pickPreamble(mode, taskType);
  // The task lives in THREE places for small-model anchoring:
  //   1. Inside the preamble's opening clause.
  //   2. At the top of the system context (`# TASK` block).
  //   3. As the literal user message.
  const context = renderFocusedContextForPrompt(focused);
  return buildPromptMessages({
    systemPreamble: `${preamble}\n\nThe user's task is: ${focused.task}`,
    context,
    task: focused.task,
  });
}

function pickPreamble(mode: 'brief' | 'plan', taskType: TaskType): string {
  if (taskType === TaskType.Architecture) return FOCUSED_ARCHITECTURE_PREAMBLE;
  if (taskType === TaskType.Investigation) return FOCUSED_INVESTIGATION_PREAMBLE;
  return mode === 'plan' ? FOCUSED_PLAN_PREAMBLE : FOCUSED_BRIEF_PREAMBLE;
}

function renderTinyPlan(focused: IFocusedContext, taskType: TaskType): string {
  if (taskType === TaskType.Architecture) return renderTinyArchitecturePlan(focused);
  if (taskType === TaskType.Investigation) return renderTinyInvestigationPlan(focused);
  return renderTinyImplementationPlan(focused);
}

function renderTinyImplementationPlan(focused: IFocusedContext): string {
  const lines: string[] = [];
  lines.push(`# Tiny-AI Plan — ${focused.task}`);
  lines.push('');
  lines.push(`_Generated entirely from the BGE-ranked focused context (${focused.model})._`);
  lines.push(`_Approx ${focused.approxTokens} input tokens, 0 LLM tokens, 0 network calls._`);
  lines.push('');

  lines.push('## Task');
  lines.push(focused.task);
  lines.push('');

  if (focused.files.length > 0) {
    lines.push('## Files to read (semantic match → review in order)');
    for (const file of focused.files) {
      lines.push(
        `- \`${file.path}\` (file-sim ${file.fileSimilarity.toFixed(3)}) — ${
          file.blocks.length > 0
            ? `top: \`${file.blocks[0]!.name}\` ${describeKind(file.blocks[0]!.kind)}`
            : 'overview'
        }`,
      );
    }
    lines.push('');

    const editable = focused.files
      .filter((f) => isLikelyEditable(f.path))
      .slice(0, 5);
    if (editable.length > 0) {
      lines.push('## Likely files to modify (filtered: source files only)');
      for (const file of editable) {
        const why = file.blocks[0]?.name
          ? `exposes \`${file.blocks[0]!.name}\` which matches the task semantically (sim ${file.blocks[0]!.similarity.toFixed(3)})`
          : `semantic match`;
        lines.push(`- \`${file.path}\` — ${why}`);
      }
      lines.push('');
    }
  }

  if (focused.rules.length > 0) {
    lines.push('## Rules to respect (cite by id)');
    for (const r of focused.rules) {
      lines.push(`- \`${r.id}\` — ${r.title}`);
      if (r.summary) lines.push(`  ${r.summary}`);
    }
    lines.push('');
  }

  if (focused.docHits.length > 0) {
    lines.push('## Relevant prior writing');
    for (const h of focused.docHits) {
      lines.push(`- \`${h.path}\`:${h.line} — ${h.snippet}`);
    }
    lines.push('');
  }

  if (focused.verificationCommands.length > 0) {
    lines.push('## Validation commands (run after your change)');
    for (const c of focused.verificationCommands) lines.push(`- \`${c}\``);
    lines.push('');
  }

  lines.push('## Suggested approach');
  lines.push(
    `1. Read the candidate files in the order above; pay extra attention to the highlighted declarations.`,
  );
  lines.push(
    `2. Make the change in the "likely files to modify" list. Stay within the rules cited above.`,
  );
  lines.push(`3. Run the validation commands; iterate until clean.`);
  lines.push('');
  lines.push(
    '## Handoff',
  );
  lines.push(
    `This plan was assembled deterministically by SharkCraft's local embedding model — it tells you *where to look* and *what to respect*, but it does not invent implementation details. For a richer plan, re-run without \`--tiny-only\` to polish it with the configured generative provider.`,
  );
  lines.push('');
  return lines.join('\n');
}

function renderTinyArchitecturePlan(focused: IFocusedContext): string {
  const lines: string[] = [];
  lines.push(`# Tiny-AI Design Brief — ${focused.task}`);
  lines.push('');
  lines.push(`_Generated entirely from the BGE-ranked focused context (${focused.model})._`);
  lines.push(`_Approx ${focused.approxTokens} input tokens, 0 LLM tokens, 0 network calls._`);
  lines.push(
    '_Task classified as **architecture / workflow design** — this brief intentionally avoids prescribing file edits._',
  );
  lines.push('');

  lines.push('## Task (as stated)');
  lines.push(focused.task);
  lines.push('');

  lines.push('## ⚠ This task is abstract');
  lines.push(
    `It asks _what_ to build at the system level. Resolve the design questions below before opening files for edit. The local model is not equipped to invent a concrete plan deterministically; the items here are *patterns to study* and *questions to answer*, not files to modify.`,
  );
  lines.push('');

  lines.push('## Design questions to answer first');
  lines.push('- **Context budget** — how much information per update? token / size estimate?');
  lines.push('- **Update trigger** — what causes a new packet to be emitted? (file change, time, user event, graph drift)');
  lines.push('- **Transport** — MCP read-only tool, file-system packet, CLI stdout JSONL, stdin protocol, in-process subscriber?');
  lines.push('- **Persistence** — where does the agent-facing state live across restarts? `.sharkcraft/`? in-memory only?');
  lines.push('- **Handoff** — how does the consuming agent discover updates? polling vs push?');
  lines.push('- **Lifecycle** — who starts/stops the parallel process; what happens on crash?');
  lines.push('');

  lines.push('## Patterns worth studying in this repo (do not assume they should be edited)');
  if (focused.files.length === 0) {
    lines.push('- _No strong semantic matches found in the indexed code. Consider exploring `packages/mcp-server/`, `packages/cli/src/dashboard/`, and `packages/inspector/src/` manually._');
  } else {
    for (const file of focused.files.slice(0, 6)) {
      const top = file.blocks[0];
      lines.push(
        `- \`${file.path}\` (file-sim ${file.fileSimilarity.toFixed(3)})${
          top ? ` — see \`${top.name}\` ${describeKind(top.kind)}` : ''
        }`,
      );
    }
  }
  lines.push('');

  lines.push('## Candidate integration shapes (informational; not a recommendation)');
  lines.push(
    '- **Sidecar process** — long-running child that writes context packets to `.sharkcraft/context-stream/` on triggers; consumer tails the directory.',
  );
  lines.push(
    '- **Watch-mode CLI** — `shrk watch --emit-context` subcommand that emits JSONL on stdout each time files change.',
  );
  lines.push(
    '- **MCP context-packet tool** — a new read-only MCP tool the agent polls; the tool computes the next packet on demand.',
  );
  lines.push(
    '- **File-system packet** — periodic dump of a summary to `.sharkcraft/agent-feed.json`; agent diff-reads it.',
  );
  lines.push('Each shape implies different answers to the questions above.');
  lines.push('');

  if (focused.rules.length > 0) {
    lines.push('## Rules to respect when you do start');
    for (const r of focused.rules) {
      lines.push(`- \`${r.id}\` — ${r.title}`);
      if (r.summary) lines.push(`  ${r.summary}`);
    }
    lines.push('');
  }

  lines.push('## Non-goals (until proven otherwise)');
  lines.push('- Editing provider `send` methods or model adapters.');
  lines.push('- Adding write paths to MCP (read-only by contract).');
  lines.push('- Cross-package boundary changes; pick one host package first.');
  lines.push('');

  lines.push('## Recommended first spike (smallest experiment)');
  lines.push(
    `1. Pick ONE integration shape from above based on which design question scares you most.`,
  );
  lines.push(
    `2. Write a hello-world version that emits one fake packet per second to its chosen transport.`,
  );
  lines.push(
    `3. Wire one consumer (the agent, or a script standing in for it) to receive it. Measure latency + size.`,
  );
  lines.push(
    `4. Only AFTER that measurement, commit to a final design and write a real plan.`,
  );
  lines.push('');

  lines.push('## Handoff');
  lines.push(
    `This brief is intentionally light on file-edit suggestions. Re-run without \`--tiny-only\` once you've chosen a candidate shape — the LLM can then write a concrete plan grounded on your decision.`,
  );
  lines.push('');
  return lines.join('\n');
}

function renderTinyInvestigationPlan(focused: IFocusedContext): string {
  const lines: string[] = [];
  lines.push(`# Tiny-AI Investigation Notes — ${focused.task}`);
  lines.push('');
  lines.push(
    `_Generated entirely from the BGE-ranked focused context (${focused.model}). 0 LLM tokens._`,
  );
  lines.push('_Task classified as **investigation** — this is a reading list, not a plan to modify code._');
  lines.push('');

  lines.push('## Question');
  lines.push(focused.task);
  lines.push('');

  if (focused.files.length > 0) {
    lines.push('## Files to read (ranked by semantic match)');
    for (const file of focused.files) {
      lines.push(
        `- \`${file.path}\` (sim ${file.fileSimilarity.toFixed(3)})${
          file.blocks[0] ? ` — start with \`${file.blocks[0].name}\`` : ''
        }`,
      );
    }
    lines.push('');
  }

  if (focused.docHits.length > 0) {
    lines.push('## Documentation pointers');
    for (const h of focused.docHits) {
      lines.push(`- \`${h.path}\`:${h.line} — ${h.snippet}`);
    }
    lines.push('');
  }

  lines.push('## Suggested approach');
  lines.push('1. Read the candidate files in order; form a hypothesis.');
  lines.push('2. Use `shrk graph why <a> <b>` to confirm structural relationships.');
  lines.push(
    '3. When confident, re-run smart-context with a concrete *change* task — that will route through the implementation prompt.',
  );
  lines.push('');
  return lines.join('\n');
}

function describeKind(kind: DeclarationKind): string {
  switch (kind) {
    case DeclarationKind.Interface:
      return 'interface';
    case DeclarationKind.Type:
      return 'type alias';
    case DeclarationKind.Enum:
      return 'enum';
    case DeclarationKind.Class:
      return 'class';
    case DeclarationKind.Function:
      return 'function';
    case DeclarationKind.Const:
      return 'export';
  }
}

function isLikelyEditable(path: string): boolean {
  if (!/\.(ts|tsx|js|jsx)$/.test(path)) return false;
  if (path.includes('__tests__/')) return false;
  if (/\.(test|spec)\.[jt]sx?$/.test(path)) return false;
  if (path.endsWith('.d.ts')) return false;
  return true;
}

/**
 * Toggle to disable auto-refresh and plan-cache during automated tests
 * (which often run against the real repo root and would trigger a model
 * download). Set `SHRK_DISABLE_AUTO_AI=1` to opt out from auto-AI side
 * effects without touching the rest of the flow.
 */
function isSemanticAutomationDisabled(): boolean {
  return (process.env.SHRK_DISABLE_AUTO_AI ?? '').trim().length > 0;
}

/**
 * Returns the list of repo-relative paths touched since `gitRef`,
 * expanded with one-hop graph neighbors (importers + importees) so
 * the focused bundle covers the diff *and* the places it likely
 * ripples through. Empty array on git failure or no-graph.
 */
function collectChangedPathsWithNeighbors(cwd: string, gitRef: string): string[] {
  // Use `node:child_process` spawnSync (works under both Bun and Node)
  // instead of `Bun.spawnSync` so the CLI runs cleanly on a pure-Node
  // runtime after `npm i -g @shrkcrft/cli`. The compat-node preflight
  // gate flags `Bun.*` direct usages as publish blockers.
  let changed: string[];
  try {
    const out = spawnSync('git', ['-C', cwd, 'diff', '--name-only', `${gitRef}...HEAD`], {
      encoding: 'utf8',
    });
    if (out.status !== 0) return [];
    changed = (out.stdout ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
  if (changed.length === 0) return [];

  // Also include uncommitted changes — agent feedback should reflect
  // the *current* working tree, not just committed deltas.
  try {
    const out = spawnSync('git', ['-C', cwd, 'diff', '--name-only', 'HEAD'], {
      encoding: 'utf8',
    });
    if (out.status === 0) {
      const uncommitted = (out.stdout ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const p of uncommitted) if (!changed.includes(p)) changed.push(p);
    }
  } catch {
    // ignore
  }

  const set = new Set<string>(changed);
  // One-hop graph expansion if the graph is fresh.
  try {
    const store = new GraphStore(cwd);
    if (store.exists()) {
      const api = GraphQueryApi.fromStore(cwd);
      for (const path of changed) {
        const file = api.findFile(path);
        if (!file) continue;
        for (const dep of api.importsFrom(file.id)) {
          if (dep.path) set.add(dep.path);
        }
        for (const importer of api.importersOf(file.id)) {
          if (importer.path) set.add(importer.path);
        }
      }
    }
  } catch {
    // graph optional — ok to skip
  }
  return [...set];
}

async function tryLoadSemanticHits(
  cwd: string,
  task: string,
  k: number,
  options: ISmartContextOptions,
): Promise<{ hits: ISemanticHit[]; model: string | null; index: SemanticIndex | null }> {
  if (isSemanticAutomationDisabled()) {
    return { hits: [], model: null, index: null };
  }
  try {
    const index = await SemanticIndex.tryLoad(cwd);
    if (!index) {
      maybePrintMissingIndexHint(options);
      return { hits: [], model: null, index: null };
    }
    if (!options.noRefreshIndex && !options.dryRun) {
      await maybeAutoRefresh(cwd, index, options);
    }
    const hits = await index.searchFiles(task, k);
    return { hits, model: index.modelName, index };
  } catch {
    return { hits: [], model: null, index: null };
  }
}

interface IPlanCacheLookup {
  replay: IPlanCacheHit | null;
  reference: IPlanCacheHit | null;
  embedding: Float32Array | null;
  index: SemanticIndex | null;
}

async function lookupPlanCache(
  cwd: string,
  task: string,
  options: ISmartContextOptions,
): Promise<IPlanCacheLookup> {
  try {
    const index = await SemanticIndex.tryLoad(cwd);
    if (!index) return { replay: null, reference: null, embedding: null, index: null };
    const embedding = await index.embed(task);
    const hits = PlanCache.findSimilar(cwd, embedding, {
      model: index.modelName,
      k: 1,
      minSimilarity: options.cacheReferenceThreshold,
    });
    if (hits.length === 0) return { replay: null, reference: null, embedding, index };
    const best = hits[0]!;
    if (best.similarity >= options.cacheReplayThreshold) {
      return { replay: best, reference: null, embedding, index };
    }
    return { replay: null, reference: best, embedding, index };
  } catch {
    return { replay: null, reference: null, embedding: null, index: null };
  }
}

async function maybeAutoRefresh(
  cwd: string,
  index: SemanticIndex,
  options: ISmartContextOptions,
): Promise<void> {
  const current = listIndexableFiles(cwd, 5000);
  const report = SemanticIndex.freshnessReport(cwd, current);
  const driftCount = report.stale + report.missing + report.untracked;
  if (driftCount === 0) return;
  if (driftCount > AUTO_REFRESH_FILE_CAP) {
    if (!options.json) {
      process.stderr.write(
        `[smart-context] semantic index drifted by ${driftCount} files — too many for auto-refresh. Run \`shrk smart-context embeddings-build\`.\n`,
      );
    }
    return;
  }
  const entries = current.map((path) => ({
    path,
    summary: readLeadingDocComment(cwd, path),
    exports: extractExportedNames(cwd, path),
  }));
  const refreshReport = await index.refresh(entries);
  if (!options.json && (refreshReport.added + refreshReport.changed + refreshReport.removed) > 0) {
    process.stderr.write(
      `[smart-context] auto-refreshed semantic index: +${refreshReport.added} ~${refreshReport.changed} -${refreshReport.removed} (unchanged ${refreshReport.unchanged}).\n`,
    );
  }
}

let missingIndexHintShown = false;

function maybePrintMissingIndexHint(options: ISmartContextOptions): void {
  if (options.json || options.dryRun) return;
  if (missingIndexHintShown) return;
  missingIndexHintShown = true;
  process.stderr.write(
    '[smart-context] no semantic index found — run `shrk smart-context embeddings-build` for richer grounding.\n',
  );
}

function collectDocumentationHits(
  cwd: string,
  tokens: readonly string[],
  limit: number,
): IDocumentationHit[] {
  if (tokens.length === 0) return [];
  const roots = [
    nodePath.join(cwd, 'CLAUDE.md'),
    nodePath.join(cwd, 'AGENTS.md'),
    nodePath.join(cwd, 'README.md'),
  ];
  const docDir = nodePath.join(cwd, 'docs');
  if (existsSync(docDir) && statSync(docDir).isDirectory()) {
    walkMarkdown(docDir, roots, 200);
  }
  const out: IDocumentationHit[] = [];
  const seen = new Set<string>();
  for (const file of roots) {
    if (out.length >= limit) break;
    if (!existsSync(file)) continue;
    let body: string;
    try {
      body = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < limit; i += 1) {
      const line = lines[i]!;
      if (line.length === 0) continue;
      const lower = line.toLowerCase();
      for (const token of tokens) {
        if (token.length < 4) continue;
        if (!lower.includes(token)) continue;
        const key = `${file}:${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          path: nodePath.relative(cwd, file) || file,
          line: i + 1,
          snippet: truncateLine(line, 200),
          token,
        });
        break;
      }
    }
  }
  return out;
}

function walkMarkdown(dir: string, out: string[], cap: number): void {
  if (out.length >= cap) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= cap) return;
    if (entry.startsWith('.')) continue;
    const abs = nodePath.join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkMarkdown(abs, out, cap);
    } else if (stat.isFile() && entry.toLowerCase().endsWith('.md')) {
      out.push(abs);
    }
  }
}

function buildStage1FileBriefs(
  cwd: string,
  candidates: ReadonlyArray<{ path: string }>,
  limit: number,
): IStage1FileBrief[] {
  if (candidates.length === 0) return [];
  const store = new GraphStore(cwd);
  if (!store.exists()) return [];
  const api = GraphQueryApi.fromStore(cwd);
  const out: IStage1FileBrief[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    const node = api.findFile(candidate.path);
    if (!node) continue;
    const exports = api.symbolsIn(node.id).slice(0, 6).map((s) => s.label);
    const imports = api
      .importsFrom(node.id)
      .slice(0, 5)
      .map((n) => n.path ?? '')
      .filter((p) => p.length > 0);
    const importedBy = api
      .importersOf(node.id)
      .slice(0, 5)
      .map((n) => n.path ?? '')
      .filter((p) => p.length > 0);
    out.push({
      path: candidate.path,
      summary: readLeadingDocComment(cwd, candidate.path),
      exports,
      exportSignatures: extractExportSignatures(cwd, candidate.path, exports, 4),
      imports,
      importedBy,
    });
  }
  return out;
}

function extractExportSignatures(
  cwd: string,
  path: string,
  names: readonly string[],
  limit: number,
): string[] {
  if (names.length === 0) return [];
  const abs = nodePath.isAbsolute(path) ? path : nodePath.join(cwd, path);
  let body: string;
  try {
    body = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (out.length >= limit) break;
    if (seen.has(name)) continue;
    // Match the declaration line that introduces `name` after an export.
    // Tolerates: export function foo, export const foo, export class foo,
    // export interface foo, export enum foo, export type foo, export abstract class foo,
    // export default function foo (rare), export async function foo.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      String.raw`^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|const|let|var|class|interface|enum|type)\s+` +
        escaped +
        String.raw`\b`,
    );
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (!pattern.test(line)) continue;
      const sig = truncateLine(line, 200);
      out.push(sig);
      seen.add(name);
      break;
    }
  }
  return out;
}

function readLeadingDocComment(cwd: string, path: string): string | null {
  const abs = nodePath.isAbsolute(path) ? path : nodePath.join(cwd, path);
  let body: string;
  try {
    body = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const withoutShebang = body.replace(/^#!.*\r?\n/, '');
  const trimmed = withoutShebang.replace(/^\s+/, '');
  const jsdoc = trimmed.match(/^\/\*\*([\s\S]*?)\*\//);
  if (jsdoc) {
    const cleaned = jsdoc[1]!
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*\s?/, '').trim())
      .filter((line) => line.length > 0 && !line.startsWith('@'))
      .join(' ')
      .trim();
    if (cleaned.length > 0) return truncateLine(cleaned, 240);
  }
  const lines = trimmed.split(/\r?\n/);
  const commentLines: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('//')) {
      commentLines.push(t.replace(/^\/\/\s?/, ''));
    } else if (t.length === 0) {
      if (commentLines.length > 0) break;
    } else {
      break;
    }
  }
  if (commentLines.length > 0) return truncateLine(commentLines.join(' '), 240);
  return null;
}

function resolveRepoInstructions(
  cwd: string,
  options: ISmartContextOptions,
): { path: string; body: string } | null {
  if (options.noInstructions) return null;
  const candidates: string[] = [];
  if (options.instructionsPath) {
    candidates.push(
      nodePath.isAbsolute(options.instructionsPath)
        ? options.instructionsPath
        : nodePath.resolve(cwd, options.instructionsPath),
    );
  } else {
    candidates.push(nodePath.join(cwd, 'CLAUDE.md'), nodePath.join(cwd, 'AGENTS.md'));
  }
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const body = readFileSync(p, 'utf8').trim();
      if (body.length === 0) continue;
      return { path: nodePath.relative(cwd, p) || p, body };
    } catch {
      /* skip */
    }
  }
  return null;
}

function buildMessages(seed: ISmartContextSeed, mode: 'brief' | 'plan'): IAiMessage[] {
  const systemPreamble = mode === 'plan' ? PLAN_SYSTEM_PREAMBLE : BRIEF_SYSTEM_PREAMBLE;
  return buildPromptMessages({
    systemPreamble,
    context: renderSeed(seed),
    task: seed.task,
  });
}

function renderSeed(seed: ISmartContextSeed): string {
  const lines: string[] = [];
  if (seed.repoInstructions) {
    lines.push(`# Repository instructions (${seed.repoInstructions.path})`);
    lines.push(seed.repoInstructions.body);
    lines.push('');
  }
  lines.push('# Task', seed.task, '');
  lines.push('# Project overview', seed.overviewText.trim(), '');

  if (seed.packet.relevantRules.length > 0) {
    lines.push('# Relevant rules (cite by id verbatim)');
    for (const r of seed.packet.relevantRules.slice(0, 8)) {
      lines.push(`- \`${r.id}\` — ${r.title}`);
      const summary = ruleSummaryText(r);
      if (summary) lines.push(`  summary: ${truncateLine(summary, 240)}`);
      const applies = ruleAppliesWhen(r);
      if (applies.length > 0) {
        lines.push(`  applies when: ${applies.slice(0, 4).join('; ')}`);
      }
      const tags = ruleTags(r);
      if (tags.length > 0) lines.push(`  tags: ${tags.slice(0, 5).join(', ')}`);
    }
    lines.push('');
  }

  if (seed.packet.relevantPaths.length > 0) {
    lines.push('# Path conventions');
    for (const p of seed.packet.relevantPaths.slice(0, 8)) {
      lines.push(`- \`${p.id}\` — ${p.title}`);
      const summary = ruleSummaryText(p);
      if (summary) lines.push(`  ${truncateLine(summary, 240)}`);
      const applies = ruleAppliesWhen(p);
      if (applies.length > 0) {
        lines.push(`  applies when: ${applies.slice(0, 3).join('; ')}`);
      }
    }
    lines.push('');
  }

  if (seed.packet.relevantTemplates.length > 0) {
    lines.push('# Relevant templates');
    for (const t of seed.packet.relevantTemplates.slice(0, 6)) {
      const name = (t as { name?: string }).name ?? t.id;
      const description = (t as { description?: string }).description;
      lines.push(`- \`${t.id}\` — ${name}`);
      if (description) lines.push(`  ${truncateLine(description, 200)}`);
    }
    lines.push('');
  }

  if (seed.packet.recommendedCliCommands.length > 0) {
    lines.push('# Recommended commands');
    for (const c of seed.packet.recommendedCliCommands.slice(0, 10)) lines.push(`- \`${c}\``);
    lines.push('');
  }

  if (seed.packet.verificationCommands.length > 0) {
    lines.push('# Verification commands (run after change)');
    for (const c of seed.packet.verificationCommands.slice(0, 8)) lines.push(`- \`${c}\``);
    lines.push('');
  }

  if (seed.packet.forbiddenActions.length > 0) {
    lines.push('# Forbidden actions (must NOT do)');
    for (const a of seed.packet.forbiddenActions.slice(0, 10)) lines.push(`- ${a}`);
    lines.push('');
  }

  if (seed.packet.recommendedPipelines.length > 0) {
    lines.push('# Recommended pipelines');
    for (const p of seed.packet.recommendedPipelines) {
      lines.push(`- ${p.pipelineId} — ${p.reason}`);
    }
    lines.push('');
  }

  if (seed.graphGrounding.available) {
    const files = seed.graphGrounding.taskFileCandidates;
    const symbols = seed.graphGrounding.taskSymbolCandidates;
    if (files.length > 0 || symbols.length > 0) {
      lines.push('# Candidate code (graph-ranked from task tokens)');
      if (files.length > 0) {
        lines.push('files:');
        for (const f of files.slice(0, 10)) lines.push(`- \`${f.path}\` (score ${f.score})`);
      }
      if (symbols.length > 0) {
        lines.push('symbols:');
        for (const s of symbols.slice(0, 8)) {
          lines.push(`- \`${s.symbol}\`${s.path ? ` in \`${s.path}\`` : ''}`);
        }
      }
      lines.push('');
    }
  }

  if (seed.semanticCandidates.length > 0) {
    lines.push(
      `# Semantically-related files (${seed.semanticModel ?? 'embedding model'}, cosine similarity)`,
    );
    for (const hit of seed.semanticCandidates.slice(0, 10)) {
      lines.push(`- \`${hit.path}\` (sim ${hit.score.toFixed(3)})`);
    }
    lines.push('');
  }

  lines.push('# Knowledge context (engine-ranked, token-budgeted)');
  lines.push(seed.contextBody.trim());
  return lines.join('\n');
}

function ruleSummaryText(entry: { summary?: string; content?: string }): string {
  if (entry.summary && entry.summary.trim().length > 0) return entry.summary.trim();
  if (entry.content && entry.content.trim().length > 0) {
    return entry.content.trim().split(/\n\n/, 1)[0]!.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function ruleAppliesWhen(entry: { appliesWhen?: readonly string[] }): string[] {
  return (entry.appliesWhen ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

function ruleTags(entry: { tags?: readonly string[] }): string[] {
  return (entry.tags ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

function truncateLine(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, max - 1).trimEnd() + '…';
}

interface IAiCallResult {
  content: string;
  model: string;
  finishReason: string | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  providerId: string;
}

interface IEnhancementRun {
  ai: IAiCallResult;
  content: string;
  enhancement: {
    enabled: true;
    stages: Array<{
      kind: string;
      model: string;
      degraded: boolean;
      errorMessage?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    }>;
    totalUsage: { inputTokens: number; outputTokens: number };
    deterministicFallback: boolean;
    budgetExhausted: boolean;
    /** Stage count that actually ran (fast=2, plus=4, or capped). */
    plannedPasses: number;
    plus: boolean;
  };
  turns: ISmartContextConversationTurn[];
}

/**
 * Run the multi-pass enhancement pipeline against the deterministic
 * brief seed. Each stage's transcript is captured so `--save-conversation`
 * dumps the full draft → critique → refine → polish chain.
 *
 * The deterministic seed comes from the existing `messages` array
 * (system = repo context, user = task). The pipeline reuses that
 * system body verbatim across stages so the model never loses
 * grounding; only the user turn changes per stage.
 */
/**
 * Wall-clock ceilings for the enhancement pipeline. These are anti-hang
 * guards, not target runtimes — the speed win comes from running fewer passes
 * by default and from picking a smaller `--model`. A slow model that overruns
 * degrades to the best output so far (or the deterministic seed). Override per
 * invocation with `--budget <seconds>`.
 */
const PER_STAGE_TIMEOUT_MS = 90_000;
const FAST_ENHANCE_BUDGET_MS = 150_000;
const PLUS_ENHANCE_BUDGET_MS = 360_000;

async function runEnhancementPipeline(input: {
  provider: ReturnType<typeof selectAiProvider>['provider'];
  messages: IAiMessage[];
  seed: ISmartContextSeed;
  options: ISmartContextOptions;
}): Promise<{ ok: true; value: IEnhancementRun } | { ok: false; error: Error & { message: string } }> {
  const provider = input.provider!;
  const systemMsg = input.messages.find((m) => m.role === AiMessageRole.System);
  const userMsg = input.messages.find((m) => m.role === AiMessageRole.User);
  const originalContext = systemMsg?.content ?? '';
  const taskBody = userMsg?.content ?? input.seed.task;

  // Default is the fast 2-pass draft→polish; `--plus` opts into the full
  // draft→critique→refine→polish for denser output. Both are wall-clock
  // bounded so a slow local model degrades gracefully instead of hanging.
  const plus = input.options.plus;
  const stages = plus ? buildDefaultEnhancementStages() : buildFastEnhancementStages();
  const budgetMs = input.options.budgetMs ?? (plus ? PLUS_ENHANCE_BUDGET_MS : FAST_ENHANCE_BUDGET_MS);
  const pipeline = new EnhancementPipeline(stages);
  const stageInputs: Array<{ kind: string; messages: IAiMessage[] }> = [];
  const stageResponses: Array<IEnhancementStageResult> = [];

  // Tee per-stage prompts/responses so we can rebuild the conversation
  // file. The pipeline doesn't expose stage inputs publicly, so we
  // wrap the provider and record what the caller sees.
  const recordingProvider = {
    id: provider.id,
    configure: (cfg: { model?: string }) => provider.configure(cfg),
    send: async (req: Parameters<typeof provider.send>[0]) => {
      stageInputs.push({
        kind: `pass-${stageInputs.length + 1}`,
        messages: [...req.messages],
      });
      return provider.send(req);
    },
  } as unknown as typeof provider;

  const piRun = await pipeline.run(
    { task: taskBody, originalContext },
    recordingProvider,
    {
      ...(input.options.enhancePasses ? { maxPasses: input.options.enhancePasses } : {}),
      maxTokensPerStage: input.options.maxTokens,
      budgetMs,
      perStageTimeoutMs: PER_STAGE_TIMEOUT_MS,
      ...(input.options.model ? { model: input.options.model } : {}),
      onStage: (e) => {
        if (!input.options.json) {
          const tag = e.ok ? 'ok' : 'degraded';
          process.stderr.write(
            `[smart-context] enhance ${e.pass}/${e.total} ${e.kind} → ${tag}\n`,
          );
        }
        // Mirror the pipeline-internal stage result into our local
        // capture so `--save-conversation` can dump the full record.
        // This is a no-op on the call itself; the pipeline owns its
        // own bookkeeping.
        stageResponses.push({
          kind: e.kind as EnhancementStageKind,
          content: '',
          model: input.options.model ?? provider.id,
          ...(e.ok ? {} : { degraded: true }),
        });
      },
    },
  );

  if (!piRun.ok) {
    return { ok: false, error: piRun.error as Error & { message: string } };
  }

  const final = piRun.value.finalOutput;
  // Use the last non-degraded, non-critique stage as the "primary" AI
  // response surfaced in the envelope — that's the actual brief.
  const primary = [...piRun.value.stages]
    .reverse()
    .find((s) => s.kind !== EnhancementStageKind.Critique && !s.degraded);
  const usage = primary?.usage ?? {};

  const ai: IAiCallResult = {
    content: final,
    model: primary?.model ?? input.options.model ?? '',
    finishReason: piRun.value.deterministicFallback ? 'deterministic-fallback' : 'stop',
    usage: usage.inputTokens || usage.outputTokens ? usage : null,
    providerId: provider.id,
  };

  // Stitch the captured per-stage prompts + responses into a transcript.
  const turns = piRun.value.stages.map((stageResult, idx) => {
    const captured = stageInputs[idx] ?? { kind: stageResult.kind, messages: [] };
    return {
      stage: stageResult.kind,
      request: {
        messages: captured.messages.map((m) => ({ role: m.role, content: m.content })),
      },
      response: {
        content: stageResult.content,
        model: stageResult.model,
        finishReason: stageResult.degraded ? 'degraded' : 'stop',
        usage: stageResult.usage ?? null,
      },
    };
  });

  return {
    ok: true,
    value: {
      ai,
      content: final,
      enhancement: {
        enabled: true,
        stages: piRun.value.stages.map((s) => ({
          kind: String(s.kind),
          model: s.model,
          degraded: Boolean(s.degraded),
          ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}),
          ...(s.usage ? { usage: s.usage } : {}),
        })),
        totalUsage: piRun.value.totalUsage,
        deterministicFallback: piRun.value.deterministicFallback,
        budgetExhausted: piRun.value.budgetExhausted,
        plannedPasses: stages.length,
        plus,
      },
      turns,
    },
  };
}

function resolveEnhanceFlag(args: ParsedArgs): boolean {
  if (flagBool(args, 'no-enhance')) return false;
  if (flagBool(args, 'enhance')) return true;
  const env = (process.env.SHRK_ENHANCE ?? '').trim().toLowerCase();
  if (env === 'off' || env === '0' || env === 'false' || env === 'no') return false;
  return true;
}

function readEnhancePassesEnv(): number | null {
  const raw = (process.env.SHRK_ENHANCE_PASSES ?? '').trim();
  if (raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

async function callProvider(input: {
  provider: { id: string; configure(config: { model?: string }): void; send: (request: {
    messages: readonly IAiMessage[];
    maxTokens?: number;
    model?: string;
    responseFormat?: { type: 'json_object' | 'json_schema'; schema?: Record<string, unknown>; schemaName?: string };
    onTokenStream?: (chunk: string) => void;
  }) => Promise<{ ok: boolean; value?: { content: string; model: string; finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number } }; error?: Error }> };
  messages: IAiMessage[];
  maxTokens: number;
  model?: string;
  responseFormat?: { type: 'json_object' | 'json_schema'; schema?: Record<string, unknown>; schemaName?: string };
  onTokenStream?: (chunk: string) => void;
}): Promise<{ ok: true; value: IAiCallResult } | { ok: false; error: Error & { message: string } }> {
  if (input.model) input.provider.configure({ model: input.model });
  const res = await input.provider.send({
    messages: input.messages,
    maxTokens: input.maxTokens,
    ...(input.model ? { model: input.model } : {}),
    ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
    ...(input.onTokenStream ? { onTokenStream: input.onTokenStream } : {}),
  });
  if (!res.ok || !res.value) return { ok: false, error: (res as { error: Error }).error as Error & { message: string } };
  return {
    ok: true,
    value: {
      content: res.value.content,
      model: res.value.model,
      finishReason: res.value.finishReason ?? null,
      usage: res.value.usage ?? null,
      providerId: input.provider.id,
    },
  };
}

interface ISmartContextEnvelope {
  task: string;
  mode: 'brief' | 'plan';
  savedAt: string;
  ai: {
    provider: string;
    model: string;
    finishReason: string | null;
    usage: { inputTokens?: number; outputTokens?: number } | null;
  };
  deterministic: {
    repoInstructionsPath: string | null;
    relevantRules: Array<{ id: string; title: string }>;
    relevantPaths: Array<{ id: string; title: string }>;
    relevantTemplates: Array<{ id: string; name: string }>;
    recommendedCommands: readonly string[];
  };
  content: string;
  aiPlan?: {
    strategy: 'deterministic-fallback' | 'two-stage' | 'cache-replay' | 'focused' | 'focused-polished';
    requestedProvider: string;
    fallbackReason?: string;
    warnings?: string[];
    initialGraphGrounding?: IInitialGraphGrounding;
    stage1Request?: IContextExpansionRequest;
    stage1Retried?: boolean;
    stage1Degraded?: boolean;
    collectedContext?: ICollectedExpansionContext;
    finalPlan?: IDetailedDevelopmentPlan;
    stage2Retried?: boolean;
    unverifiedPaths?: Array<{ path: string; where: string }>;
    rawResponses?: { stage1?: string; stage2?: string };
    promptLog?: { stage1?: IAiMessage[]; stage2?: IAiMessage[] };
    cacheReplay?: { sourceTask: string; sourceSavedAt: string; similarity: number };
    cacheReference?: { sourceTask: string; sourceSavedAt: string; similarity: number };
    /** Task type (architecture, bugfix, …) chosen by the classifier or overridden. */
    taskType?: string;
    /**
     * Parsed JSON block extracted from the LLM's focused-mode response.
     * Populated only when the model emitted a structurally-valid JSON
     * object; `shrk spike` reads this to scaffold the recommended MVP.
     */
    focusedParsedPlan?: Record<string, unknown>;
  };
  /**
   * Multi-pass enhancement pipeline telemetry. Present only when the
   * brief mode ran with `--enhance` (the default when an LLM is
   * reachable). Each entry records what the LLM produced for that
   * stage so a downstream agent (Claude) can audit the chain.
   */
  enhancement?: {
    enabled: true;
    stages: Array<{
      kind: string;
      model: string;
      degraded: boolean;
      errorMessage?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    }>;
    totalUsage: { inputTokens: number; outputTokens: number };
    deterministicFallback: boolean;
  };
}

function logPromptToStderr(
  label: string,
  messages: readonly IAiMessage[],
  options: ISmartContextOptions,
): void {
  if (!options.logPrompt) return;
  const dump = messages.map((m) => ({ role: m.role, content: m.content }));
  process.stderr.write(`[smart-context] prompt log (${label}):\n`);
  process.stderr.write(`${asJson(dump)}\n`);
}

interface ISmartContextConversationTurn {
  stage: 'single' | 'stage1' | 'stage2' | 'draft' | 'critique' | 'refine' | 'polish';
  request: { messages: ReadonlyArray<{ role: AiMessageRole | string; content: string }> };
  response: {
    content: string;
    model: string;
    finishReason: string | null;
    usage: { inputTokens?: number; outputTokens?: number } | null;
    retried?: boolean;
    parseFailed?: boolean;
  };
}

function writeConversationFile(input: {
  cwd: string;
  task: string;
  mode: 'brief' | 'plan';
  options: ISmartContextOptions;
  providerId: string;
  model: string;
  turns: ISmartContextConversationTurn[];
}): string {
  const dir = nodePath.join(input.cwd, SMART_CONTEXT_DIR);
  const explicit = input.options.saveConversationPath;
  const target = explicit
    ? nodePath.isAbsolute(explicit)
      ? explicit
      : nodePath.resolve(input.cwd, explicit)
    : nodePath.join(dir, `${slug(input.task)}-${input.mode}.conversation.json`);
  mkdirSync(nodePath.dirname(target), { recursive: true });
  const body = {
    task: input.task,
    mode: input.mode,
    savedAt: new Date().toISOString(),
    provider: input.providerId,
    model: input.model,
    turns: input.turns,
  };
  writeFileSync(target, asJson(body) + '\n', 'utf8');
  return target;
}

function buildEnvelope(input: {
  task: string;
  seed: ISmartContextSeed;
  ai: IAiCallResult;
  mode: 'brief' | 'plan';
  aiPlan?: ISmartContextEnvelope['aiPlan'];
  content?: string;
  enhancement?: ISmartContextEnvelope['enhancement'];
}): ISmartContextEnvelope {
  return {
    task: input.task,
    mode: input.mode,
    savedAt: new Date().toISOString(),
    ai: {
      provider: input.ai.providerId,
      model: input.ai.model,
      finishReason: input.ai.finishReason,
      usage: input.ai.usage,
    },
    deterministic: {
      repoInstructionsPath: input.seed.repoInstructions?.path ?? null,
      relevantRules: input.seed.packet.relevantRules.map((r) => ({ id: r.id, title: r.title })),
      relevantPaths: input.seed.packet.relevantPaths.map((p) => ({ id: p.id, title: p.title })),
      relevantTemplates: input.seed.packet.relevantTemplates.map((t) => ({
        id: t.id,
        name: (t as { name?: string }).name ?? t.id,
      })),
      recommendedCommands: input.seed.packet.recommendedCliCommands,
    },
    content: input.content ?? input.ai.content,
    ...(input.aiPlan ? { aiPlan: input.aiPlan } : {}),
    ...(input.enhancement ? { enhancement: input.enhancement } : {}),
  };
}

function writeEnvelope(envelope: ISmartContextEnvelope, json: boolean, debug: boolean): void {
  if (json) {
    process.stdout.write(asJson(envelope) + '\n');
    return;
  }
  if (debug && envelope.aiPlan) {
    writeAiPlanDebug(envelope);
  }
  if (envelope.aiPlan?.warnings && envelope.aiPlan.warnings.length > 0) {
    for (const w of envelope.aiPlan.warnings) {
      process.stderr.write(`[smart-context] warning: ${w}\n`);
    }
  }
  if (envelope.aiPlan?.unverifiedPaths && envelope.aiPlan.unverifiedPaths.length > 0) {
    process.stderr.write(
      `[smart-context] unverified paths (possible hallucination): ${envelope.aiPlan.unverifiedPaths
        .map((u) => u.path)
        .join(', ')}\n`,
    );
  }
  process.stdout.write(envelope.content);
  if (!envelope.content.endsWith('\n')) process.stdout.write('\n');
}

function writeDryRun(
  messages: readonly IAiMessage[],
  mode: 'brief' | 'plan',
  provider: string,
): void {
  process.stdout.write(header(`AI prompt (dry-run, provider: ${provider}, mode: ${mode})`));
  for (const m of messages) {
    process.stdout.write(`\n[${m.role}]\n${m.content}\n`);
  }
}

function displayProviderName(explicit: string | undefined): string {
  if (explicit) return explicit;
  const envProvider = (process.env.AI_PROVIDER ?? '').trim().toLowerCase();
  if (envProvider === 'ollama' || envProvider === 'llamacpp') {
    return envProvider;
  }
  return 'auto';
}

interface ISavedPaths {
  slug: string;
  dir: string;
  mdPath: string;
  jsonPath: string;
}

function saveEnvelope(cwd: string, envelope: ISmartContextEnvelope): ISavedPaths {
  const dir = nodePath.join(cwd, SMART_CONTEXT_DIR);
  mkdirSync(dir, { recursive: true });
  const base = `${slug(envelope.task)}-${envelope.mode}`;
  const mdPath = nodePath.join(dir, `${base}.md`);
  const jsonPath = nodePath.join(dir, `${base}.json`);
  writeFileSync(mdPath, renderSavedMarkdown(envelope), 'utf8');
  writeFileSync(jsonPath, asJson(envelope) + '\n', 'utf8');
  if (envelope.aiPlan?.rawResponses) {
    const rawPath = nodePath.join(dir, `${base}.raw.json`);
    writeFileSync(rawPath, asJson(envelope.aiPlan.rawResponses) + '\n', 'utf8');
  }
  if (envelope.aiPlan?.promptLog) {
    const promptPath = nodePath.join(dir, `${base}.prompt.json`);
    writeFileSync(promptPath, asJson(envelope.aiPlan.promptLog) + '\n', 'utf8');
  }
  if (envelope.aiPlan?.focusedParsedPlan) {
    // Structured plan in a stable shape — `shrk spike <slug>` reads this.
    const planPath = nodePath.join(dir, `${base}.plan.json`);
    writeFileSync(planPath, asJson(envelope.aiPlan.focusedParsedPlan) + '\n', 'utf8');
  }
  if (envelope.aiPlan?.finalPlan && !envelope.aiPlan.focusedParsedPlan) {
    // ai-plan (2-stage) also gets a .plan.json so spike works against it.
    const planPath = nodePath.join(dir, `${base}.plan.json`);
    writeFileSync(planPath, asJson(envelope.aiPlan.finalPlan) + '\n', 'utf8');
  }
  return { slug: base, dir, mdPath, jsonPath };
}

function writeSavedNotice(
  saved: ISavedPaths,
  json: boolean,
  envelope: ISmartContextEnvelope,
): void {
  if (json) {
    process.stdout.write(
      asJson({
        ...envelope,
        savedAs: { slug: saved.slug, markdown: saved.mdPath, json: saved.jsonPath },
      }) + '\n',
    );
    return;
  }
  process.stdout.write(header(`Saved: ${saved.slug}`));
  process.stdout.write(kv('markdown', saved.mdPath) + '\n');
  process.stdout.write(kv('json', saved.jsonPath) + '\n');
  process.stdout.write(`\nPreview with: shrk smart-context show ${saved.slug}\n`);
}

function renderSavedMarkdown(envelope: ISmartContextEnvelope): string {
  const lines: string[] = [];
  lines.push(`# ${envelope.mode === 'plan' ? 'Plan' : 'Brief'} — ${envelope.task}`);
  lines.push('');
  lines.push(`_Saved ${envelope.savedAt} · model ${envelope.ai.model} (${envelope.ai.provider})._`);
  if (envelope.deterministic.repoInstructionsPath) {
    lines.push(`_Repo instructions: \`${envelope.deterministic.repoInstructionsPath}\`._`);
  }
  if (envelope.aiPlan) {
    lines.push(`_AI planning strategy: \`${envelope.aiPlan.strategy}\`._`);
    if (envelope.aiPlan.stage1Retried || envelope.aiPlan.stage2Retried) {
      const retried = [
        envelope.aiPlan.stage1Retried ? 'stage 1' : null,
        envelope.aiPlan.stage2Retried ? 'stage 2' : null,
      ]
        .filter((s): s is string => s !== null)
        .join(', ');
      lines.push(`_Retried after bad JSON: ${retried}._`);
    }
    if (envelope.aiPlan.stage1Degraded) {
      lines.push(`_Stage 1 degraded to empty expansion after retry._`);
    }
    if (envelope.aiPlan.warnings && envelope.aiPlan.warnings.length > 0) {
      lines.push('');
      lines.push('> **Warnings:**');
      for (const w of envelope.aiPlan.warnings) lines.push(`> - ${w}`);
    }
    if (envelope.aiPlan.unverifiedPaths && envelope.aiPlan.unverifiedPaths.length > 0) {
      lines.push('');
      lines.push('> **Unverified paths (possible hallucination):**');
      for (const u of envelope.aiPlan.unverifiedPaths) {
        lines.push(`> - \`${u.path}\` (referenced in \`${u.where}\`)`);
      }
    }
  }
  lines.push('');
  lines.push(envelope.content.trim());
  lines.push('');
  return lines.join('\n');
}

interface ISavedIndexEntry {
  slug: string;
  task: string;
  mode: 'brief' | 'plan';
  savedAt: string;
  mdPath: string;
  jsonPath: string;
}

function readSavedIndex(cwd: string): ISavedIndexEntry[] {
  const dir = nodePath.join(cwd, SMART_CONTEXT_DIR);
  if (!existsSync(dir)) return [];
  const out: ISavedIndexEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const jsonPath = nodePath.join(dir, name);
    try {
      if (!statSync(jsonPath).isFile()) continue;
      const env = JSON.parse(readFileSync(jsonPath, 'utf8')) as ISmartContextEnvelope;
      const slugBase = name.replace(/\.json$/, '');
      const mdPath = nodePath.join(dir, `${slugBase}.md`);
      out.push({
        slug: slugBase,
        task: env.task,
        mode: env.mode,
        savedAt: env.savedAt,
        mdPath,
        jsonPath,
      });
    } catch {
      /* skip malformed */
    }
  }
  out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  return out;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-+|-+$)/g, '')
      .slice(0, 60) || 'task'
  );
}

interface IPlanAheadEntry {
  task: string;
  slug: string;
  status: 'saved' | 'dry-run' | 'error';
  files?: { markdown: string; json: string };
  usage?: { inputTokens?: number; outputTokens?: number } | null;
  error?: string;
}

interface IInitialGraphGrounding {
  available: boolean;
  state: 'fresh' | 'missing' | 'corrupt';
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  cycleCount?: number | null;
  unresolvedImportCount?: number | null;
  taskFileCandidates: Array<{ path: string; score: number }>;
  taskSymbolCandidates: Array<{ symbol: string; path: string | null }>;
}

function buildInitialGraphGrounding(cwd: string, task: string): IInitialGraphGrounding {
  const store = new GraphStore(cwd);
  if (!store.exists()) {
    return {
      available: false,
      state: 'missing',
      taskFileCandidates: [],
      taskSymbolCandidates: [],
    };
  }
  const verify = store.verifyDigest();
  const snap = store.loadSnapshot();
  const api = GraphQueryApi.fromStore(cwd);
  const tokens = tokenizeTask(task);
  return {
    available: true,
    state: verify.ok ? 'fresh' : 'corrupt',
    fileCount: snap.manifest.filesIndexed,
    nodeCount: sumValues(snap.manifest.nodesByKind),
    edgeCount: sumValues(snap.manifest.edgesByKind),
    cycleCount: snap.manifest.cycleCount ?? null,
    unresolvedImportCount: snap.manifest.unresolvedImportCount ?? null,
    taskFileCandidates: rankTaskFileCandidates(api, tokens, 10),
    taskSymbolCandidates: rankTaskSymbolCandidates(api, tokens, 8),
  };
}

function renderInitialGraphGrounding(grounding: IInitialGraphGrounding): string {
  const lines: string[] = [];
  lines.push('# Graph grounding');
  if (!grounding.available) {
    lines.push('- graph unavailable');
    return lines.join('\n');
  }
  lines.push(`- graph state: ${grounding.state}`);
  lines.push(`- files: ${grounding.fileCount ?? 0}`);
  lines.push(`- nodes: ${grounding.nodeCount ?? 0}`);
  lines.push(`- edges: ${grounding.edgeCount ?? 0}`);
  if (grounding.cycleCount !== null && grounding.cycleCount !== undefined) {
    lines.push(`- cycles: ${grounding.cycleCount}`);
  }
  if (grounding.unresolvedImportCount !== null && grounding.unresolvedImportCount !== undefined) {
    lines.push(`- unresolved imports: ${grounding.unresolvedImportCount}`);
  }
  if (grounding.taskFileCandidates.length > 0) {
    lines.push('', '## Candidate files from task tokens');
    for (const c of grounding.taskFileCandidates) lines.push(`- \`${c.path}\` (score ${c.score})`);
  }
  if (grounding.taskSymbolCandidates.length > 0) {
    lines.push('', '## Candidate symbols from task tokens');
    for (const c of grounding.taskSymbolCandidates) {
      lines.push(`- \`${c.symbol}\`${c.path ? ` in \`${c.path}\`` : ''}`);
    }
  }
  return lines.join('\n');
}

interface IContextExpansionHint {
  target: string;
  why: string;
}

interface IContextExpansionRuleHint {
  id: string;
  why: string;
}

interface IContextExpansionRequest {
  summary?: string;
  filesToRead: IContextExpansionHint[];
  similarPatterns: IContextExpansionHint[];
  publicApiFiles: IContextExpansionHint[];
  testsToInspect: IContextExpansionHint[];
  architectureRules: IContextExpansionRuleHint[];
  riskyAreas: string[];
  missingInformation: string[];
}

interface IResolvedFileContext {
  path: string;
  why: string;
  requestedTarget: string;
  packageName: string | null;
  imports: string[];
  importedBy: string[];
  symbols: string[];
  publicApiCandidates: string[];
  testCandidates: string[];
}

interface ICollectedRuleContext {
  id: string;
  title: string;
  why: string;
}

interface ICollectedExpansionContext {
  schema: 'sharkcraft.smart-context-collection/v1';
  selectedFiles: IResolvedFileContext[];
  similarPatternFiles: IResolvedFileContext[];
  publicApiFiles: IResolvedFileContext[];
  testFiles: IResolvedFileContext[];
  architectureRules: ICollectedRuleContext[];
  riskyAreas: string[];
  missingInformation: string[];
}

interface IDetailedDevelopmentPlan {
  summary: string;
  taskUnderstanding: string;
  likelyTechnicalApproach: string;
  existingPatternsToFollow: Array<{ path: string; why: string }>;
  filesToRead: Array<{ path: string; why: string }>;
  likelyFilesToModify: Array<{ path: string; why: string }>;
  filesToAvoid: Array<{ path: string; why: string }>;
  publicApiFiles: Array<{ path: string; why: string }>;
  testsToInspect: Array<{ path: string; why: string }>;
  architectureConstraints: string[];
  relatedRules: Array<{ id: string; title: string; applyWhen: string }>;
  relatedTemplates: Array<{ id: string; useFor: string }>;
  firstCommands: Array<{ command: string; why: string }>;
  implementationSteps: Array<{ step: string; details: string }>;
  risks: string[];
  unknowns: string[];
  validationCommands: string[];
  handoffSummary: string;
}

async function buildAiPlanEnvelope(input: {
  cwd: string;
  inspection: ISharkcraftInspection;
  seed: ISmartContextSeed;
  options: ISmartContextOptions;
}): Promise<{ ok: true; value: ISmartContextEnvelope } | { ok: false; error: Error & { message: string } }> {
  const grounding = input.seed.graphGrounding;

  // Cache lookup (read-only, no LLM call). Done before provider selection
  // so a cache hit short-circuits even when no provider is available.
  const cacheLookup = (input.options.noCache || isSemanticAutomationDisabled())
    ? { replay: null, reference: null, embedding: null, index: null as SemanticIndex | null }
    : await lookupPlanCache(input.cwd, input.seed.task, input.options);
  if (cacheLookup.replay) {
    const cached = cacheLookup.replay;
    const md = (cached.entry.planMarkdown as string | undefined) ?? '';
    if (!input.options.json) {
      process.stderr.write(
        `[smart-context] cache replay — similar past task "${truncateLine(cached.entry.task, 80)}" (sim ${cached.similarity.toFixed(3)})\n`,
      );
    }
    return {
      ok: true,
      value: buildEnvelope({
        task: input.seed.task,
        seed: input.seed,
        mode: 'plan',
        ai: {
          content: md,
          model: cached.entry.model,
          finishReason: null,
          usage: null,
          providerId: 'cache',
        },
        content: md.length > 0 ? md : `(replayed from cache, no markdown stored)`,
        aiPlan: {
          strategy: 'cache-replay',
          requestedProvider: input.options.provider ?? 'auto',
          initialGraphGrounding: grounding,
          finalPlan: cached.entry.plan as unknown as IDetailedDevelopmentPlan,
          cacheReplay: {
            sourceTask: cached.entry.task,
            sourceSavedAt: cached.entry.savedAt,
            similarity: cached.similarity,
          },
        },
      }),
    };
  }

  const selection = selectAiProvider(input.options.provider);
  if (!selection.provider) {
    const fallbackContent = renderDeterministicFallback(input.seed);
    return {
      ok: true,
      value: buildEnvelope({
        task: input.seed.task,
        seed: input.seed,
        mode: 'plan',
        ai: {
          content: fallbackContent,
          model: 'deterministic-fallback',
          finishReason: null,
          usage: null,
          providerId: 'deterministic',
        },
        content: fallbackContent,
        aiPlan: {
          strategy: 'deterministic-fallback',
          requestedProvider: selection.requested,
          fallbackReason: providerMissingMessage(selection.requested),
          initialGraphGrounding: grounding,
        },
      }),
    };
  }
  if (input.options.model) selection.provider.configure({ model: input.options.model });

  const warnings: string[] = [];
  if (selection.provider.id === 'ollama' && selection.provider instanceof OllamaProvider) {
    const preflight = await selection.provider.healthCheck(input.options.model);
    if (!preflight.ok) {
      return {
        ok: false,
        error: new Error(
          preflight.error.message +
            (preflight.error.suggestion ? `\n  hint: ${preflight.error.suggestion}` : ''),
        ),
      };
    }
    if (input.options.model && preflight.value.modelPresent === false) {
      return {
        ok: false,
        error: new Error(
          `Ollama at ${preflight.value.host} does not have model "${input.options.model}" pulled. ` +
            `Run \`ollama pull ${input.options.model}\` (available: ${preflight.value.models.join(', ') || 'none'}).`,
        ),
      };
    }
    progressMarker(`preflight ok — host=${preflight.value.host} models=${preflight.value.models.length}`, input.options);
  }

  progressMarker(`stage 1 calling ${selection.provider.id}${input.options.model ? `:${input.options.model}` : ''}…`, input.options);
  const stage1Messages = buildStage1Messages(input.seed, grounding, cacheLookup.reference);
  logPromptToStderr('stage1', stage1Messages, input.options);
  const stage1Outcome = await callProviderWithRetry({
    provider: selection.provider,
    messages: stage1Messages,
    maxTokens: input.options.stage1MaxTokens,
    model: input.options.model,
    responseFormat: {
      type: 'json_schema',
      schemaName: 'smart_context_expansion_request',
      schema: SmartContextExpansionRequestSchema as Record<string, unknown>,
    },
    parse: parseExpansionRequest,
    repromptInstruction: STAGE1_REPROMPT,
    stageLabel: 'stage 1',
    options: input.options,
  });

  let stage1Request: IContextExpansionRequest;
  let stage1Retried = false;
  let stage1Degraded = false;
  let stage1RawResponse: string | undefined;
  let stage1Call: IAiCallResult | null = null;
  if (stage1Outcome.kind === 'ok') {
    stage1Request = stage1Outcome.parsed;
    stage1Retried = stage1Outcome.retried;
    stage1RawResponse = stage1Outcome.lastRawResponse;
    stage1Call = stage1Outcome.call;
  } else if (stage1Outcome.kind === 'call-failed') {
    return { ok: false, error: stage1Outcome.error };
  } else {
    stage1Request = emptyExpansionRequest();
    stage1Retried = true;
    stage1Degraded = true;
    stage1RawResponse = stage1Outcome.lastRawResponse;
    stage1Call = stage1Outcome.call;
    warnings.push(
      `Stage 1 returned invalid JSON after retry; continuing with empty expansion (${stage1Outcome.parseError.message}).`,
    );
  }

  const collected = collectExpansionContext({
    cwd: input.cwd,
    inspection: input.inspection,
    request: stage1Request,
    options: input.options,
  });

  progressMarker(`stage 2 calling ${selection.provider.id}${input.options.model ? `:${input.options.model}` : ''}…`, input.options);
  const stage2Messages = buildStage2Messages(input.seed, grounding, collected, cacheLookup.reference);
  logPromptToStderr('stage2', stage2Messages, input.options);
  const stage2Outcome = await callProviderWithRetry({
    provider: selection.provider,
    messages: stage2Messages,
    maxTokens: input.options.maxTokens,
    model: input.options.model,
    responseFormat: {
      type: 'json_schema',
      schemaName: 'smart_context_detailed_plan',
      schema: SmartContextDetailedPlanSchema as Record<string, unknown>,
    },
    parse: parseDetailedPlan,
    repromptInstruction: STAGE2_REPROMPT,
    stageLabel: 'stage 2',
    options: input.options,
  });

  const conversationTurns: ISmartContextConversationTurn[] = [];
  if (stage1Call) {
    conversationTurns.push({
      stage: 'stage1',
      request: { messages: stage1Messages.map((m) => ({ role: m.role, content: m.content })) },
      response: {
        content: stage1RawResponse ?? stage1Call.content,
        model: stage1Call.model,
        finishReason: stage1Call.finishReason,
        usage: stage1Call.usage,
        retried: stage1Retried,
        ...(stage1Degraded ? { parseFailed: true } : {}),
      },
    });
  }
  const stage2CallForLog =
    stage2Outcome.kind === 'ok' || stage2Outcome.kind === 'parse-failed' ? stage2Outcome.call : null;
  const stage2RawForLog =
    stage2Outcome.kind === 'ok' || stage2Outcome.kind === 'parse-failed'
      ? stage2Outcome.lastRawResponse
      : undefined;
  if (stage2CallForLog) {
    conversationTurns.push({
      stage: 'stage2',
      request: { messages: stage2Messages.map((m) => ({ role: m.role, content: m.content })) },
      response: {
        content: stage2RawForLog ?? stage2CallForLog.content,
        model: stage2CallForLog.model,
        finishReason: stage2CallForLog.finishReason,
        usage: stage2CallForLog.usage,
        ...(stage2Outcome.kind === 'ok' ? { retried: stage2Outcome.retried } : { parseFailed: true }),
      },
    });
  }

  const persistConversation = (): void => {
    if (!input.options.saveConversation || conversationTurns.length === 0) return;
    const lastTurn = conversationTurns[conversationTurns.length - 1]!;
    const path = writeConversationFile({
      cwd: input.cwd,
      task: input.seed.task,
      mode: 'plan',
      options: input.options,
      providerId: stage2CallForLog?.providerId ?? stage1Call?.providerId ?? selection.provider!.id,
      model: lastTurn.response.model,
      turns: conversationTurns,
    });
    if (!input.options.json) {
      process.stderr.write(`[smart-context] conversation saved → ${path}\n`);
    }
  };

  if (stage2Outcome.kind === 'call-failed') {
    persistConversation();
    return { ok: false, error: stage2Outcome.error };
  }
  if (stage2Outcome.kind === 'parse-failed') {
    persistConversation();
    return { ok: false, error: stage2Outcome.parseError };
  }
  const stage2Plan = stage2Outcome.parsed;
  const stage2Retried = stage2Outcome.retried;
  const stage2Call = stage2Outcome.call;
  const stage2RawResponse = stage2Outcome.lastRawResponse;

  const unverifiedPaths = verifyPlanPaths(input.cwd, stage2Plan);

  persistConversation();

  // Persist this run to the plan cache so future similar tasks can replay
  // it. Only when the semantic index is available (we need an embedding
  // and a stable model id to key by).
  if (!input.options.noCache && cacheLookup.embedding && cacheLookup.index) {
    try {
      PlanCache.append(input.cwd, {
        schema: PLAN_CACHE_SCHEMA,
        task: input.seed.task,
        taskSlug: slug(input.seed.task),
        model: cacheLookup.index.modelName,
        embeddingDimensions: cacheLookup.index.dimensions,
        embeddingB64: encodeEmbedding(cacheLookup.embedding),
        plan: stage2Plan as unknown as Record<string, unknown> & {
          summary: string;
          taskUnderstanding: string;
          likelyTechnicalApproach: string;
          handoffSummary: string;
        },
        planMarkdown: renderDetailedPlan(stage2Plan),
        savedAt: new Date().toISOString(),
      });
    } catch {
      // Cache write failures are non-fatal — the plan is still returned.
    }
  }

  return {
    ok: true,
    value: buildEnvelope({
      task: input.seed.task,
      seed: input.seed,
      mode: 'plan',
      ai: stage2Call,
      content: renderDetailedPlan(stage2Plan),
      aiPlan: {
        strategy: 'two-stage',
        requestedProvider: selection.requested,
        initialGraphGrounding: grounding,
        stage1Request,
        stage1Retried,
        stage1Degraded,
        collectedContext: collected,
        finalPlan: stage2Plan,
        stage2Retried,
        ...(unverifiedPaths.length > 0 ? { unverifiedPaths } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(cacheLookup.reference
          ? {
              cacheReference: {
                sourceTask: cacheLookup.reference.entry.task,
                sourceSavedAt: cacheLookup.reference.entry.savedAt,
                similarity: cacheLookup.reference.similarity,
              },
            }
          : {}),
        ...(stage1RawResponse !== undefined || stage2RawResponse !== undefined
          ? {
              rawResponses: {
                ...(stage1RawResponse !== undefined ? { stage1: stage1RawResponse } : {}),
                ...(stage2RawResponse !== undefined ? { stage2: stage2RawResponse } : {}),
              },
            }
          : {}),
        ...(input.options.logPrompt
          ? { promptLog: { stage1: stage1Messages, stage2: stage2Messages } }
          : {}),
      },
    }),
  };
}

function emptyExpansionRequest(): IContextExpansionRequest {
  return {
    filesToRead: [],
    similarPatterns: [],
    publicApiFiles: [],
    testsToInspect: [],
    architectureRules: [],
    riskyAreas: [],
    missingInformation: [],
  };
}

type ProviderForCall = Parameters<typeof callProvider>[0]['provider'];

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error & { message: string } };

type StageOutcome<T> =
  | { kind: 'ok'; parsed: T; call: IAiCallResult; retried: boolean; lastRawResponse: string }
  | { kind: 'call-failed'; error: Error & { message: string } }
  | {
      kind: 'parse-failed';
      parseError: Error & { message: string };
      call: IAiCallResult;
      lastRawResponse: string;
    };

const STAGE1_REPROMPT =
  'Your previous response was not parseable JSON. Reply with ONLY a single JSON object that conforms to the expansion-request schema. No prose, no markdown fence, no commentary.';
const STAGE2_REPROMPT =
  'Your previous response was not parseable JSON. Reply with ONLY a single JSON object that conforms to the detailed-plan schema. No prose, no markdown fence, no commentary.';

async function callProviderWithRetry<T>(input: {
  provider: ProviderForCall;
  messages: IAiMessage[];
  maxTokens: number;
  model?: string;
  responseFormat?: { type: 'json_object' | 'json_schema'; schema?: Record<string, unknown>; schemaName?: string };
  parse: (raw: string) => ParseResult<T>;
  repromptInstruction: string;
  stageLabel: string;
  options: ISmartContextOptions;
}): Promise<StageOutcome<T>> {
  const first = await callProvider({
    provider: input.provider,
    messages: input.messages,
    maxTokens: input.maxTokens,
    ...(input.model ? { model: input.model } : {}),
    ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
  });
  if (!first.ok) return { kind: 'call-failed', error: first.error };
  const firstParsed = input.parse(first.value.content);
  if (firstParsed.ok) {
    return {
      kind: 'ok',
      parsed: firstParsed.value,
      call: first.value,
      retried: false,
      lastRawResponse: first.value.content,
    };
  }

  progressMarker(
    `${input.stageLabel} parse failed (${firstParsed.error.message.slice(0, 80)}); retrying once…`,
    input.options,
  );
  const retryMessages: IAiMessage[] = [
    ...input.messages,
    { role: AiMessageRole.Assistant, content: first.value.content },
    { role: AiMessageRole.User, content: input.repromptInstruction },
  ];
  const second = await callProvider({
    provider: input.provider,
    messages: retryMessages,
    maxTokens: input.maxTokens,
    ...(input.model ? { model: input.model } : {}),
    ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
  });
  if (!second.ok) {
    return {
      kind: 'parse-failed',
      parseError: firstParsed.error,
      call: first.value,
      lastRawResponse: first.value.content,
    };
  }
  const secondParsed = input.parse(second.value.content);
  if (secondParsed.ok) {
    return {
      kind: 'ok',
      parsed: secondParsed.value,
      call: second.value,
      retried: true,
      lastRawResponse: second.value.content,
    };
  }
  return {
    kind: 'parse-failed',
    parseError: secondParsed.error,
    call: second.value,
    lastRawResponse: second.value.content,
  };
}

function progressMarker(message: string, options: ISmartContextOptions): void {
  if (options.json) return;
  process.stderr.write(`[smart-context] ${message}\n`);
}

function verifyPlanPaths(
  cwd: string,
  plan: IDetailedDevelopmentPlan,
): Array<{ path: string; where: string }> {
  const checks: Array<[string, ReadonlyArray<{ path: string }>]> = [
    ['existingPatternsToFollow', plan.existingPatternsToFollow],
    ['filesToRead', plan.filesToRead],
    ['likelyFilesToModify', plan.likelyFilesToModify],
    ['filesToAvoid', plan.filesToAvoid],
    ['publicApiFiles', plan.publicApiFiles],
    ['testsToInspect', plan.testsToInspect],
  ];
  const seen = new Set<string>();
  const out: Array<{ path: string; where: string }> = [];
  for (const [where, items] of checks) {
    for (const item of items) {
      const key = `${where}:${item.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!pathExistsInWorkspace(cwd, item.path)) {
        out.push({ path: item.path, where });
      }
    }
  }
  return out;
}

function pathExistsInWorkspace(cwd: string, candidate: string): boolean {
  if (candidate.length === 0) return false;
  const normalised = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
  const abs = nodePath.isAbsolute(normalised) ? normalised : nodePath.join(cwd, normalised);
  try {
    return existsSync(abs);
  } catch {
    return false;
  }
}

/**
 * Walk an arbitrary parsed-JSON tree looking for `path: string` leaves.
 * Used by focused-mode (and now ai-plan) to flag hallucinated paths
 * the LLM invented. The walker is intentionally lenient:
 *
 *   - any object key called `path` with a string value is treated as a
 *     filesystem reference if it looks like one (contains `/` or ends
 *     in a known extension).
 *   - `firstSpike.proposedFiles[].path` is captured via the same rule
 *     because each item is `{ path, purpose }`.
 *
 * Returns the locations of every path that DOES NOT exist on disk, so
 * the caller can surface them as `unverifiedPaths` on the envelope.
 */
function collectUnverifiedPathsFromJson(
  cwd: string,
  root: unknown,
): Array<{ path: string; where: string }> {
  const misses: Array<{ path: string; where: string }> = [];
  const seen = new Set<string>();
  walk(root, '$');
  return misses;

  function walk(value: unknown, where: string): void {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) walk(value[i], `${where}[${i}]`);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const rec = value as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      const child = rec[key];
      if (key === 'path' && typeof child === 'string') {
        const candidate = child.trim();
        if (looksLikeFilesystemRef(candidate)) {
          const id = `${where}.${key}:${candidate}`;
          if (!seen.has(id)) {
            seen.add(id);
            if (!pathExistsInWorkspace(cwd, candidate)) {
              misses.push({ path: candidate, where });
            }
          }
        }
        continue;
      }
      walk(child, `${where}.${key}`);
    }
  }
}

function looksLikeFilesystemRef(candidate: string): boolean {
  if (candidate.length === 0) return false;
  // Skip obvious schema placeholders like ".sharkcraft/context-stream/<timestamp>.json".
  if (/[<>{}]/.test(candidate)) return false;
  if (candidate.includes('/')) return true;
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|css|html)$/.test(candidate);
}

/**
 * Try to extract + parse a JSON object from a focused-mode LLM
 * response. The model is asked to emit one ```json fenced block; if
 * it complies we parse it. Otherwise we fall back to the existing
 * balanced-brace heuristics that ai-plan already uses.
 *
 * Returns the parsed object on success, `null` on any failure. Never
 * throws — focused mode tolerates missing structure.
 */
function tryParseFocusedJson(content: string): Record<string, unknown> | null {
  const parsed = extractJsonObject(content);
  if (!parsed.ok) return null;
  if (parsed.value === null || typeof parsed.value !== 'object') return null;
  if (Array.isArray(parsed.value)) return null;
  return parsed.value as Record<string, unknown>;
}

function buildStage1Messages(
  seed: ISmartContextSeed,
  grounding: IInitialGraphGrounding,
  cacheReference: IPlanCacheHit | null = null,
): IAiMessage[] {
  const briefs = renderStage1FileBriefs(seed.stage1FileBriefs);
  const docHits = renderDocumentationHits(seed.documentationHits);
  const reference = renderCacheReference(cacheReference);
  return buildPromptMessages({
    systemPreamble: STAGE1_SYSTEM_PREAMBLE,
    context: [
      renderSeed(seed),
      '',
      renderInitialGraphGrounding(grounding),
      ...(briefs ? ['', briefs] : []),
      ...(docHits ? ['', docHits] : []),
      ...(reference ? ['', reference] : []),
      '',
      'Use only paths, rule ids, commands, and symbols that appear in the supplied context.',
      `Expansion schema: ${JSON.stringify(SmartContextExpansionRequestSchema)}`,
    ].join('\n'),
    task: seed.task,
  });
}

function renderCacheReference(hit: IPlanCacheHit | null): string {
  if (!hit) return '';
  const lines: string[] = [];
  const plan = hit.entry.plan as Record<string, unknown>;
  const summary = typeof plan.summary === 'string' ? plan.summary : '';
  const approach = typeof plan.likelyTechnicalApproach === 'string' ? plan.likelyTechnicalApproach : '';
  const handoff = typeof plan.handoffSummary === 'string' ? plan.handoffSummary : '';
  lines.push(
    `# Prior similar plan (cosine ${hit.similarity.toFixed(3)} — for reference only, do not copy verbatim)`,
  );
  lines.push(`- prior task: ${truncateLine(hit.entry.task, 200)}`);
  lines.push(`- saved: ${hit.entry.savedAt}`);
  if (summary) lines.push(`- summary: ${truncateLine(summary, 240)}`);
  if (approach) lines.push(`- approach: ${truncateLine(approach, 240)}`);
  if (handoff) lines.push(`- handoff: ${truncateLine(handoff, 240)}`);
  const editable = (plan.likelyFilesToModify as Array<{ path: string }> | undefined) ?? [];
  if (editable.length > 0) {
    lines.push(`- prior files to modify: ${editable.slice(0, 6).map((e) => '`' + e.path + '`').join(', ')}`);
  }
  return lines.join('\n');
}

function renderDocumentationHits(hits: readonly IDocumentationHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = [];
  lines.push('# Documentation hits (keyword-grep on docs/, CLAUDE.md, AGENTS.md, READMEs)');
  for (const h of hits) {
    lines.push(`- \`${h.path}\`:${h.line} (matched \`${h.token}\`) — ${h.snippet}`);
  }
  return lines.join('\n');
}

function renderStage1FileBriefs(briefs: readonly IStage1FileBrief[]): string {
  if (briefs.length === 0) return '';
  const lines: string[] = [];
  lines.push('# Candidate file briefs (task-ranked — primary source for stage-1 targets)');
  for (const b of briefs) {
    lines.push(`## \`${b.path}\``);
    if (b.summary) lines.push(`  summary: ${b.summary}`);
    if (b.exports.length > 0) lines.push(`  exports: ${b.exports.join(', ')}`);
    if (b.exportSignatures.length > 0) {
      lines.push('  signatures:');
      for (const sig of b.exportSignatures) lines.push(`    ${sig}`);
    }
    if (b.imports.length > 0) lines.push(`  imports: ${b.imports.join(', ')}`);
    if (b.importedBy.length > 0) lines.push(`  imported by: ${b.importedBy.join(', ')}`);
  }
  return lines.join('\n');
}

function buildStage2Messages(
  seed: ISmartContextSeed,
  grounding: IInitialGraphGrounding,
  collected: ICollectedExpansionContext,
  cacheReference: IPlanCacheHit | null = null,
): IAiMessage[] {
  const reference = renderCacheReference(cacheReference);
  return buildPromptMessages({
    systemPreamble: STAGE2_SYSTEM_PREAMBLE,
    context: [
      renderSeed(seed),
      '',
      renderInitialGraphGrounding(grounding),
      '',
      '# Additional collected context',
      renderCollectedContext(collected),
      ...(reference ? ['', reference] : []),
      '',
      `Detailed plan schema: ${JSON.stringify(SmartContextDetailedPlanSchema)}`,
    ].join('\n'),
    task: seed.task,
  });
}

function renderDeterministicFallback(seed: ISmartContextSeed): string {
  const lines: string[] = [];
  lines.push('AI provider unavailable; returning deterministic smart-context only.');
  lines.push('');
  lines.push(renderSeed(seed));
  if (seed.packet.verificationCommands.length > 0) {
    lines.push('', '# Verification commands');
    for (const command of seed.packet.verificationCommands) lines.push(`- \`${command}\``);
  }
  return lines.join('\n');
}

function parseExpansionRequest(
  raw: string,
): { ok: true; value: IContextExpansionRequest } | { ok: false; error: Error & { message: string } } {
  const parsed = extractJsonObject(raw);
  if (!parsed.ok) return parsed;
  const validated = validateExpansionRequest(parsed.value);
  if (!validated.ok) return validated;
  return { ok: true, value: validated.value };
}

function parseDetailedPlan(
  raw: string,
): { ok: true; value: IDetailedDevelopmentPlan } | { ok: false; error: Error & { message: string } } {
  const parsed = extractJsonObject(raw);
  if (!parsed.ok) return parsed;
  const validated = validateDetailedPlan(parsed.value);
  if (!validated.ok) return validated;
  return { ok: true, value: validated.value };
}

function extractJsonObject(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: Error & { message: string } } {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const direct = tryParseJson(candidate);
  if (direct.ok) return direct;
  const balanced = extractBalancedJsonObject(candidate);
  if (balanced) {
    const parsedBalanced = tryParseJson(balanced);
    if (parsedBalanced.ok) return parsedBalanced;
    const repaired = repairIncompleteJson(balanced);
    if (repaired) {
      const parsedRepaired = tryParseJson(repaired);
      if (parsedRepaired.ok) return parsedRepaired;
    }
  }
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = candidate.slice(firstBrace, lastBrace + 1);
    const parsedSlice = tryParseJson(sliced);
    if (parsedSlice.ok) return parsedSlice;
    const repaired = repairIncompleteJson(sliced);
    if (repaired) return tryParseJson(repaired);
  }
  const repairedCandidate = repairIncompleteJson(candidate);
  if (repairedCandidate) {
    const parsedRepairedCandidate = tryParseJson(repairedCandidate);
    if (parsedRepairedCandidate.ok) return parsedRepairedCandidate;
  }
  return {
    ok: false,
    error: new Error('AI response did not contain a parseable JSON object.'),
  };
}

function extractBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const stack: string[] = ['}'];
  let inString = false;
  let escaping = false;
  for (let i = start + 1; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      const expected = stack.pop();
      if (expected !== ch) return null;
      if (stack.length === 0) return raw.slice(start, i + 1);
    }
  }
  return raw.slice(start);
}

function repairIncompleteJson(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const candidate = raw.slice(start).trim();
  const stack: string[] = [];
  let inString = false;
  let escaping = false;
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i]!;
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length === 0) return null;
      const expected = stack.pop();
      if (expected !== ch) return null;
    }
  }
  if (inString) return null;
  if (stack.length === 0) return candidate;
  return candidate + stack.reverse().join('');
}

function tryParseJson(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: Error & { message: string } } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: new Error(`AI JSON parse failed: ${(e as Error).message}`) };
  }
}

function validateExpansionRequest(
  value: unknown,
): { ok: true; value: IContextExpansionRequest } | { ok: false; error: Error & { message: string } } {
  if (!isRecord(value)) return { ok: false, error: new Error('Expansion request must be a JSON object.') };
  const filesToRead = validateTargetArray(value.filesToRead, 'filesToRead');
  const similarPatterns = validateTargetArray(value.similarPatterns, 'similarPatterns');
  const publicApiFiles = validateTargetArray(value.publicApiFiles, 'publicApiFiles');
  const testsToInspect = validateTargetArray(value.testsToInspect, 'testsToInspect');
  if (!filesToRead.ok) return filesToRead;
  if (!similarPatterns.ok) return similarPatterns;
  if (!publicApiFiles.ok) return publicApiFiles;
  if (!testsToInspect.ok) return testsToInspect;
  const architectureRules = validateRuleHintArray(value.architectureRules);
  if (!architectureRules.ok) return architectureRules;
  const riskyAreas = validateStringArray(value.riskyAreas, 'riskyAreas');
  const missingInformation = validateStringArray(value.missingInformation, 'missingInformation');
  if (!riskyAreas.ok) return riskyAreas;
  if (!missingInformation.ok) return missingInformation;
  return {
    ok: true,
    value: {
      ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
      filesToRead: filesToRead.value,
      similarPatterns: similarPatterns.value,
      publicApiFiles: publicApiFiles.value,
      testsToInspect: testsToInspect.value,
      architectureRules: architectureRules.value,
      riskyAreas: riskyAreas.value,
      missingInformation: missingInformation.value,
    },
  };
}

function validateDetailedPlan(
  value: unknown,
): { ok: true; value: IDetailedDevelopmentPlan } | { ok: false; error: Error & { message: string } } {
  if (!isRecord(value)) return { ok: false, error: new Error('Detailed plan must be a JSON object.') };
  const requiredStrings = ['summary', 'taskUnderstanding', 'likelyTechnicalApproach', 'handoffSummary'] as const;
  for (const key of requiredStrings) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) {
      return { ok: false, error: new Error(`Detailed plan field "${key}" must be a non-empty string.`) };
    }
  }
  const existingPatternsToFollow = validatePathWhyArray(value.existingPatternsToFollow, 'existingPatternsToFollow');
  const filesToRead = validatePathWhyArray(value.filesToRead, 'filesToRead');
  const likelyFilesToModify = validatePathWhyArray(value.likelyFilesToModify, 'likelyFilesToModify');
  const filesToAvoid = validatePathWhyArray(value.filesToAvoid, 'filesToAvoid');
  const publicApiFiles = validatePathWhyArray(value.publicApiFiles, 'publicApiFiles');
  const testsToInspect = validatePathWhyArray(value.testsToInspect, 'testsToInspect');
  const relatedRules = validateRelatedRules(value.relatedRules);
  const relatedTemplates = validateRelatedTemplates(value.relatedTemplates);
  const firstCommands = validateCommandWhyArray(value.firstCommands, 'firstCommands');
  const implementationSteps = validateStepArray(value.implementationSteps);
  const architectureConstraints = validateStringArray(value.architectureConstraints, 'architectureConstraints');
  const risks = validateStringArray(value.risks, 'risks');
  const unknowns = validateStringArray(value.unknowns, 'unknowns');
  const validationCommands = validateStringArray(value.validationCommands, 'validationCommands');
  if (!existingPatternsToFollow.ok) return existingPatternsToFollow;
  if (!filesToRead.ok) return filesToRead;
  if (!likelyFilesToModify.ok) return likelyFilesToModify;
  if (!filesToAvoid.ok) return filesToAvoid;
  if (!publicApiFiles.ok) return publicApiFiles;
  if (!testsToInspect.ok) return testsToInspect;
  if (!relatedRules.ok) return relatedRules;
  if (!relatedTemplates.ok) return relatedTemplates;
  if (!firstCommands.ok) return firstCommands;
  if (!implementationSteps.ok) return implementationSteps;
  if (!architectureConstraints.ok) return architectureConstraints;
  if (!risks.ok) return risks;
  if (!unknowns.ok) return unknowns;
  if (!validationCommands.ok) return validationCommands;
  return {
    ok: true,
    value: {
      summary: value.summary,
      taskUnderstanding: value.taskUnderstanding,
      likelyTechnicalApproach: value.likelyTechnicalApproach,
      existingPatternsToFollow: existingPatternsToFollow.value,
      filesToRead: filesToRead.value,
      likelyFilesToModify: likelyFilesToModify.value,
      filesToAvoid: filesToAvoid.value,
      publicApiFiles: publicApiFiles.value,
      testsToInspect: testsToInspect.value,
      architectureConstraints: architectureConstraints.value,
      relatedRules: relatedRules.value,
      relatedTemplates: relatedTemplates.value,
      firstCommands: firstCommands.value,
      implementationSteps: implementationSteps.value,
      risks: risks.value,
      unknowns: unknowns.value,
      validationCommands: validationCommands.value,
      handoffSummary: value.handoffSummary,
    },
  };
}

function validateTargetArray(
  value: unknown,
  field: string,
): { ok: true; value: IContextExpansionHint[] } | { ok: false; error: Error & { message: string } } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: new Error(`Expansion field "${field}" must be an array.`) };
  const out: IContextExpansionHint[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!isRecord(item) || typeof item.target !== 'string' || typeof item.why !== 'string') {
      return { ok: false, error: new Error(`Expansion field "${field}[${i}]" must contain { target, why }.`) };
    }
    out.push({ target: item.target.trim(), why: item.why.trim() });
  }
  return { ok: true, value: out.filter((item) => item.target.length > 0 && item.why.length > 0) };
}

function validateRuleHintArray(
  value: unknown,
): { ok: true; value: IContextExpansionRuleHint[] } | { ok: false; error: Error & { message: string } } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: new Error('Expansion field "architectureRules" must be an array.') };
  const out: IContextExpansionRuleHint[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.why !== 'string') {
      return { ok: false, error: new Error(`Expansion field "architectureRules[${i}]" must contain { id, why }.`) };
    }
    out.push({ id: item.id.trim(), why: item.why.trim() });
  }
  return { ok: true, value: out.filter((item) => item.id.length > 0 && item.why.length > 0) };
}

function validateStringArray(
  value: unknown,
  field: string,
): { ok: true; value: string[] } | { ok: false; error: Error & { message: string } } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: new Error(`Field "${field}" must be an array of strings.`) };
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (typeof value[i] !== 'string') return { ok: false, error: new Error(`Field "${field}[${i}]" must be a string.`) };
    const trimmed = value[i].trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return { ok: true, value: out };
}

function validatePathWhyArray(
  value: unknown,
  field: string,
): { ok: true; value: Array<{ path: string; why: string }> } | { ok: false; error: Error & { message: string } } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: new Error(`Field "${field}" must be an array.`) };
  const out: Array<{ path: string; why: string }> = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.why !== 'string') {
      return { ok: false, error: new Error(`Field "${field}[${i}]" must contain { path, why }.`) };
    }
    out.push({ path: item.path.trim(), why: item.why.trim() });
  }
  return { ok: true, value: out.filter((item) => item.path.length > 0 && item.why.length > 0) };
}

function validateCommandWhyArray(
  value: unknown,
  field: string,
): { ok: true; value: Array<{ command: string; why: string }> } | { ok: false; error: Error & { message: string } } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: new Error(`Field "${field}" must be an array.`) };
  const out: Array<{ command: string; why: string }> = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!isRecord(item) || typeof item.command !== 'string' || typeof item.why !== 'string') {
      return { ok: false, error: new Error(`Field "${field}[${i}]" must contain { command, why }.`) };
    }
    out.push({ command: item.command.trim(), why: item.why.trim() });
  }
  return { ok: true, value: out.filter((item) => item.command.length > 0 && item.why.length > 0) };
}

function validateStepArray(
  value: unknown,
): { ok: true; value: Array<{ step: string; details: string }> } | { ok: false; error: Error & { message: string } } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: new Error('Field "implementationSteps" must be an array.') };
  const out: Array<{ step: string; details: string }> = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!isRecord(item) || typeof item.step !== 'string' || typeof item.details !== 'string') {
      return { ok: false, error: new Error(`Field "implementationSteps[${i}]" must contain { step, details }.`) };
    }
    out.push({ step: item.step.trim(), details: item.details.trim() });
  }
  return { ok: true, value: out.filter((item) => item.step.length > 0 && item.details.length > 0) };
}

function validateRelatedRules(
  value: unknown,
): { ok: true; value: Array<{ id: string; title: string; applyWhen: string }> } | { ok: false; error: Error & { message: string } } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: new Error('Field "relatedRules" must be an array.') };
  const out: Array<{ id: string; title: string; applyWhen: string }> = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.applyWhen !== 'string'
    ) {
      return { ok: false, error: new Error(`Field "relatedRules[${i}]" must contain { id, title, applyWhen }.`) };
    }
    out.push({ id: item.id.trim(), title: item.title.trim(), applyWhen: item.applyWhen.trim() });
  }
  return { ok: true, value: out.filter((item) => item.id.length > 0 && item.title.length > 0 && item.applyWhen.length > 0) };
}

function validateRelatedTemplates(
  value: unknown,
): { ok: true; value: Array<{ id: string; useFor: string }> } | { ok: false; error: Error & { message: string } } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: new Error('Field "relatedTemplates" must be an array.') };
  const out: Array<{ id: string; useFor: string }> = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.useFor !== 'string') {
      return { ok: false, error: new Error(`Field "relatedTemplates[${i}]" must contain { id, useFor }.`) };
    }
    out.push({ id: item.id.trim(), useFor: item.useFor.trim() });
  }
  return { ok: true, value: out.filter((item) => item.id.length > 0 && item.useFor.length > 0) };
}

function collectExpansionContext(input: {
  cwd: string;
  inspection: ISharkcraftInspection;
  request: IContextExpansionRequest;
  options: ISmartContextOptions;
}): ICollectedExpansionContext {
  const graphApi = new GraphStore(input.cwd).exists() ? GraphQueryApi.fromStore(input.cwd) : null;
  const limitPerCategory = Math.max(2, Math.floor(input.options.expansionLimit / 4));
  const selectedFiles = resolveFileContexts(input.cwd, graphApi, input.request.filesToRead, limitPerCategory);
  const similarPatternFiles = resolveFileContexts(input.cwd, graphApi, input.request.similarPatterns, limitPerCategory);
  const publicApiFiles = uniqueFileContexts([
    ...resolveFileContexts(input.cwd, graphApi, input.request.publicApiFiles, limitPerCategory),
    ...resolveDerivedContexts(input.cwd, graphApi, selectedFiles, limitPerCategory, 'public'),
    ...resolveDerivedContexts(input.cwd, graphApi, similarPatternFiles, limitPerCategory, 'public'),
  ]).slice(0, limitPerCategory);
  const testFiles = uniqueFileContexts([
    ...resolveFileContexts(input.cwd, graphApi, input.request.testsToInspect, limitPerCategory),
    ...resolveDerivedContexts(input.cwd, graphApi, selectedFiles, limitPerCategory, 'test'),
    ...resolveDerivedContexts(input.cwd, graphApi, similarPatternFiles, limitPerCategory, 'test'),
  ]).slice(0, limitPerCategory);
  const architectureRules = input.request.architectureRules
    .map((hint) => {
      const rule = input.inspection.ruleService.get(hint.id);
      if (!rule) return null;
      return { id: rule.id, title: rule.title, why: hint.why };
    })
    .filter((rule): rule is ICollectedRuleContext => rule !== null);
  return {
    schema: 'sharkcraft.smart-context-collection/v1',
    selectedFiles,
    similarPatternFiles,
    publicApiFiles,
    testFiles,
    architectureRules,
    riskyAreas: input.request.riskyAreas.slice(0, input.options.expansionLimit),
    missingInformation: input.request.missingInformation.slice(0, input.options.expansionLimit),
  };
}

function resolveFileContexts(
  cwd: string,
  api: GraphQueryApi | null,
  hints: readonly IContextExpansionHint[],
  limit: number,
): IResolvedFileContext[] {
  const out: IResolvedFileContext[] = [];
  for (const hint of hints) {
    const resolved = resolvePathsForTarget(cwd, api, hint.target, limit);
    for (const path of resolved) {
      out.push(describeFileContext(cwd, api, path, hint.target, hint.why));
      if (out.length >= limit) return uniqueFileContexts(out).slice(0, limit);
    }
  }
  return uniqueFileContexts(out).slice(0, limit);
}

function resolveDerivedContexts(
  cwd: string,
  api: GraphQueryApi | null,
  bases: readonly IResolvedFileContext[],
  limit: number,
  mode: 'public' | 'test',
): IResolvedFileContext[] {
  const out: IResolvedFileContext[] = [];
  for (const base of bases) {
    const targets = mode === 'public' ? base.publicApiCandidates : base.testCandidates;
    for (const target of targets.slice(0, 3)) {
      out.push(describeFileContext(cwd, api, target, base.path, `${mode === 'public' ? 'public API' : 'test'} candidate for ${base.path}`));
      if (out.length >= limit) return uniqueFileContexts(out).slice(0, limit);
    }
  }
  return uniqueFileContexts(out).slice(0, limit);
}

function describeFileContext(
  cwd: string,
  api: GraphQueryApi | null,
  path: string,
  requestedTarget: string,
  why: string,
): IResolvedFileContext {
  const rel = normalizePath(path);
  const packageName = packageNameForPath(rel);
  const imports: string[] = [];
  const importedBy: string[] = [];
  const symbols: string[] = [];
  if (api) {
    const file = api.findFile(rel);
    if (file) {
      for (const dep of api.importsFrom(file.id).slice(0, 6)) {
        if (dep.path) imports.push(dep.path);
      }
      for (const dep of api.importersOf(file.id).slice(0, 6)) {
        if (dep.path) importedBy.push(dep.path);
      }
      for (const symbol of api.symbolsIn(file.id).slice(0, 8)) {
        symbols.push(symbol.label);
      }
    }
  }
  return {
    path: rel,
    why,
    requestedTarget,
    packageName,
    imports,
    importedBy,
    symbols,
    publicApiCandidates: derivePublicApiCandidates(cwd, rel),
    testCandidates: deriveTestCandidates(cwd, rel, api),
  };
}

function resolvePathsForTarget(
  cwd: string,
  api: GraphQueryApi | null,
  target: string,
  limit: number,
): string[] {
  const normalized = normalizePath(target.trim());
  const abs = nodePath.isAbsolute(target) ? target : nodePath.join(cwd, normalized);
  if (existsSync(abs) && statSync(abs).isFile()) return [normalizePath(nodePath.relative(cwd, abs))];
  const out = new Set<string>();
  if (api) {
    const exact = api.findFile(normalized);
    if (exact?.path) out.add(exact.path);
    for (const hit of fuzzyGraphFileSearch(api, normalized, limit)) out.add(hit);
    if (out.size < limit) {
      for (const sym of api.findSymbol(target, { exact: false, limit })) {
        const owner = declaringFileOf(api, sym.id);
        if (owner?.path) out.add(owner.path);
        if (out.size >= limit) break;
      }
    }
  } else {
    for (const hit of fuzzyFsSearch(cwd, normalized, limit)) out.add(hit);
  }
  return [...out].slice(0, limit);
}

function fuzzyGraphFileSearch(api: GraphQueryApi, query: string, limit: number): string[] {
  const q = query.toLowerCase();
  const hits: Array<{ path: string; score: number }> = [];
  for (const node of api.allFiles()) {
    const path = node.path ?? '';
    const base = path.slice(path.lastIndexOf('/') + 1);
    let score = 0;
    if (path === query) score += 12;
    if (base === query) score += 10;
    if (base.toLowerCase() === q) score += 9;
    if (base.toLowerCase().includes(q)) score += 6;
    if (path.toLowerCase().includes(q)) score += 4;
    if (score > 0) hits.push({ path, score });
  }
  hits.sort((a, b) => (b.score === a.score ? a.path.localeCompare(b.path) : b.score - a.score));
  return hits.slice(0, limit).map((hit) => hit.path);
}

function fuzzyFsSearch(cwd: string, query: string, limit: number): string[] {
  const q = query.toLowerCase();
  const hits: Array<{ path: string; score: number }> = [];
  for (const path of walkFiles(cwd)) {
    const rel = normalizePath(nodePath.relative(cwd, path));
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    let score = 0;
    if (rel === query) score += 12;
    if (base.toLowerCase() === q) score += 9;
    if (base.toLowerCase().includes(q)) score += 6;
    if (rel.toLowerCase().includes(q)) score += 4;
    if (score > 0) hits.push({ path: rel, score });
  }
  hits.sort((a, b) => (b.score === a.score ? a.path.localeCompare(b.path) : b.score - a.score));
  return hits.slice(0, limit).map((hit) => hit.path);
}

function walkFiles(cwd: string): string[] {
  const roots = ['packages', 'docs', 'sharkcraft', 'examples', 'libs']
    .map((part) => nodePath.join(cwd, part))
    .filter((abs) => existsSync(abs));
  const out: string[] = [];
  for (const root of roots) {
    const stack = [root];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      let entries: string[] = [];
      try {
        entries = readdirSync(cur);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const abs = nodePath.join(cur, entry);
        let isFile = false;
        let isDir = false;
        try {
          const stat = statSync(abs);
          isFile = stat.isFile();
          isDir = stat.isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          if (entry === 'dist' || entry === 'node_modules' || entry.startsWith('.')) continue;
          stack.push(abs);
        } else if (isFile) {
          out.push(abs);
        }
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function derivePublicApiCandidates(cwd: string, path: string): string[] {
  const match = path.match(/^packages\/([^/]+)\//);
  if (!match) return [];
  const pkg = match[1]!;
  const candidates = [
    `packages/${pkg}/src/index.ts`,
    `packages/${pkg}/public-api.ts`,
    `packages/${pkg}/index.ts`,
  ];
  return candidates.filter((candidate) => candidate !== path && existsSync(nodePath.join(cwd, candidate)));
}

function deriveTestCandidates(cwd: string, path: string, api: GraphQueryApi | null): string[] {
  const ext = nodePath.extname(path);
  const base = path.slice(0, path.length - ext.length);
  const file = path.slice(path.lastIndexOf('/') + 1, path.length - ext.length);
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const candidates = [
    `${base}.test${ext}`,
    `${base}.spec${ext}`,
    `${dir}/__tests__/${file}.test${ext}`,
    `${dir}/__tests__/${file}.spec${ext}`,
  ];
  const out = new Set<string>();
  for (const candidate of candidates) {
    if (candidate !== path && existsSync(nodePath.join(cwd, candidate))) out.add(normalizePath(candidate));
  }
  if (api && out.size === 0) {
    for (const hit of fuzzyGraphFileSearch(api, `${file}.test`, 2)) out.add(hit);
    for (const hit of fuzzyGraphFileSearch(api, `${file}.spec`, 2)) out.add(hit);
  }
  return [...out].slice(0, 4);
}

function uniqueFileContexts(items: readonly IResolvedFileContext[]): IResolvedFileContext[] {
  const seen = new Set<string>();
  const out: IResolvedFileContext[] = [];
  for (const item of items) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
  }
  return out;
}

function renderCollectedContext(collected: ICollectedExpansionContext): string {
  const lines: string[] = [];
  renderResolvedSection(lines, 'Files to inspect', collected.selectedFiles);
  renderResolvedSection(lines, 'Similar patterns', collected.similarPatternFiles);
  renderResolvedSection(lines, 'Public API files', collected.publicApiFiles);
  renderResolvedSection(lines, 'Tests to inspect', collected.testFiles);
  if (collected.architectureRules.length > 0) {
    lines.push('', '## Architecture rules');
    for (const rule of collected.architectureRules) {
      lines.push(`- \`${rule.id}\` — ${rule.title} (${rule.why})`);
    }
  }
  if (collected.riskyAreas.length > 0) {
    lines.push('', '## Risky areas');
    for (const item of collected.riskyAreas) lines.push(`- ${item}`);
  }
  if (collected.missingInformation.length > 0) {
    lines.push('', '## Missing information');
    for (const item of collected.missingInformation) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

function renderResolvedSection(
  lines: string[],
  title: string,
  items: readonly IResolvedFileContext[],
): void {
  if (items.length === 0) return;
  lines.push('', `## ${title}`);
  for (const item of items) {
    lines.push(`- \`${item.path}\` — ${item.why}`);
    if (item.symbols.length > 0) lines.push(`  symbols: ${item.symbols.join(', ')}`);
    if (item.imports.length > 0) lines.push(`  imports: ${item.imports.join(', ')}`);
    if (item.importedBy.length > 0) lines.push(`  imported by: ${item.importedBy.join(', ')}`);
    if (item.publicApiCandidates.length > 0) lines.push(`  public API candidates: ${item.publicApiCandidates.join(', ')}`);
    if (item.testCandidates.length > 0) lines.push(`  test candidates: ${item.testCandidates.join(', ')}`);
  }
}

function renderDetailedPlan(plan: IDetailedDevelopmentPlan): string {
  const summaryLines: string[] = [];
  summaryLines.push(plan.summary);
  summaryLines.push('');
  summaryLines.push(`Task understanding: ${plan.taskUnderstanding}`);
  summaryLines.push(`Likely approach: ${plan.likelyTechnicalApproach}`);
  if (plan.likelyFilesToModify.length > 0) {
    summaryLines.push('Likely files to modify:');
    for (const item of plan.likelyFilesToModify.slice(0, 6)) summaryLines.push(`- \`${item.path}\` — ${item.why}`);
  }
  if (plan.filesToAvoid.length > 0) {
    summaryLines.push('Files to avoid:');
    for (const item of plan.filesToAvoid.slice(0, 4)) summaryLines.push(`- \`${item.path}\` — ${item.why}`);
  }
  if (plan.architectureConstraints.length > 0) {
    summaryLines.push('Architecture constraints:');
    for (const item of plan.architectureConstraints.slice(0, 6)) summaryLines.push(`- ${item}`);
  }
  if (plan.risks.length > 0) {
    summaryLines.push('Risks:');
    for (const item of plan.risks.slice(0, 6)) summaryLines.push(`- ${item}`);
  }
  if (plan.unknowns.length > 0) {
    summaryLines.push('Unknowns:');
    for (const item of plan.unknowns.slice(0, 6)) summaryLines.push(`- ${item}`);
  }
  if (plan.validationCommands.length > 0) {
    summaryLines.push('Validation commands:');
    for (const item of plan.validationCommands.slice(0, 6)) summaryLines.push(`- \`${item}\``);
  }
  summaryLines.push(`Handoff: ${plan.handoffSummary}`);
  return `\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n\n${summaryLines.join('\n')}\n`;
}

function writeAiPlanDebug(envelope: ISmartContextEnvelope): void {
  if (!envelope.aiPlan) return;
  process.stdout.write(header('AI Plan Debug'));
  process.stdout.write('\n');
  process.stdout.write('Initial smart-context result:\n');
  process.stdout.write(renderDeterministicEnvelope(envelope.deterministic));
  process.stdout.write('\n');
  if (envelope.aiPlan.stage1Request) {
    process.stdout.write('Stage 1 context expansion request:\n');
    process.stdout.write(asJson(envelope.aiPlan.stage1Request) + '\n\n');
  }
  if (envelope.aiPlan.collectedContext) {
    process.stdout.write('Additional files selected:\n');
    const selected = [
      ...envelope.aiPlan.collectedContext.selectedFiles.map((f) => f.path),
      ...envelope.aiPlan.collectedContext.similarPatternFiles.map((f) => f.path),
      ...envelope.aiPlan.collectedContext.publicApiFiles.map((f) => f.path),
      ...envelope.aiPlan.collectedContext.testFiles.map((f) => f.path),
    ];
    for (const path of dedupeStrings(selected)) process.stdout.write(`- ${path}\n`);
    process.stdout.write('\n');
  }
  if (envelope.aiPlan.finalPlan) {
    process.stdout.write('Final detailed plan:\n');
    process.stdout.write(asJson(envelope.aiPlan.finalPlan) + '\n\n');
  }
}

function renderDeterministicEnvelope(
  deterministic: ISmartContextEnvelope['deterministic'],
): string {
  const lines: string[] = [];
  if (deterministic.repoInstructionsPath) {
    lines.push(`- repo instructions: ${deterministic.repoInstructionsPath}`);
  }
  if (deterministic.relevantRules.length > 0) {
    lines.push(`- relevant rules: ${deterministic.relevantRules.map((r) => r.id).join(', ')}`);
  }
  if (deterministic.relevantPaths.length > 0) {
    lines.push(`- relevant paths: ${deterministic.relevantPaths.map((p) => p.id).join(', ')}`);
  }
  if (deterministic.recommendedCommands.length > 0) {
    lines.push(`- commands: ${deterministic.recommendedCommands.join(', ')}`);
  }
  return lines.join('\n') + '\n';
}

function writeAiPlanDryRun(
  seed: ISmartContextSeed,
  grounding: IInitialGraphGrounding,
  options: ISmartContextOptions,
): void {
  process.stdout.write(header('AI Plan Dry Run'));
  process.stdout.write('\n');
  process.stdout.write('Initial smart-context result:\n\n');
  process.stdout.write(renderSeed(seed) + '\n\n');
  process.stdout.write(renderInitialGraphGrounding(grounding) + '\n\n');
  const stage1Messages = buildStage1Messages(seed, grounding);
  process.stdout.write(header(`Stage 1 prompt (${displayProviderName(options.provider)})`));
  for (const m of stage1Messages) process.stdout.write(`\n[${m.role}]\n${m.content}\n`);
  const stage2Messages = buildPromptMessages({
    systemPreamble: STAGE2_SYSTEM_PREAMBLE,
    context: [
      renderSeed(seed),
      '',
      renderInitialGraphGrounding(grounding),
      '',
      '# Additional collected context',
      '(resolved after Stage 1 at runtime)',
      '',
      `Detailed plan schema: ${JSON.stringify(SmartContextDetailedPlanSchema)}`,
    ].join('\n'),
    task: seed.task,
  });
  process.stdout.write('\n');
  process.stdout.write(header(`Stage 2 prompt template (${displayProviderName(options.provider)})`));
  for (const m of stage2Messages) process.stdout.write(`\n[${m.role}]\n${m.content}\n`);
}

function providerMissingMessage(requested: string): string {
  if (requested === 'ollama') {
    return 'Ollama is not reachable. Start the daemon with `ollama serve`, set OLLAMA_HOST=http://<host>:<port> (or OLLAMA_HOST=<host> + OLLAMA_PORT=<port>) to point at a remote box, or use --dry-run to print the prompt instead.';
  }
  if (requested === 'llamacpp') {
    return 'llama.cpp is not configured. Set LLAMACPP_MODEL_PATH=/path/to/model.gguf in .env (recommended: qwen2.5-coder-3b Q4_K_M, ~2 GB), or use --dry-run to print the prompt instead.';
  }
  if (requested === 'auto') {
    return 'No local LLM is ready. SharkCraft is local-only — start Ollama (`ollama serve`) or set LLAMACPP_MODEL_PATH=/path/to/model.gguf in .env. Set AI_PROVIDER=ollama or AI_PROVIDER=llamacpp to pin a provider. Run with --dry-run to print the prompt instead.';
  }
  // Deprecated branches: hosted providers are no longer in the auto
  // chain and are not user-documented, but some legacy tests pin them
  // explicitly via `--provider <name>`. Keep the messages around so
  // those paths surface a clear error rather than a generic one.
  if (requested === 'claude') {
    return 'ANTHROPIC_API_KEY is not set. (Hosted providers are deprecated; SharkCraft uses only Ollama / llama.cpp.)';
  }
  return 'GEMINI_API_KEY is not set. (Hosted providers are deprecated; SharkCraft uses only Ollama / llama.cpp.)';
}

function tokenizeTask(task: string): string[] {
  // Generic English stop words only. Do NOT add SharkCraft vocabulary here
  // (smart, context, plan, task, mode, etc.) — those are exactly the tokens
  // a user types when asking about the smart-context surface itself, and
  // stripping them defeats the graph-candidate ranking for those tasks.
  const stop = new Set([
    'a', 'an', 'and', 'or', 'but', 'the', 'this', 'that', 'these', 'those',
    'with', 'from', 'into', 'onto', 'over', 'under', 'about', 'across',
    'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'do', 'does', 'did', 'doing', 'done',
    'have', 'has', 'had', 'having',
    'i', 'we', 'you', 'they', 'he', 'she', 'it',
    'my', 'our', 'your', 'their', 'his', 'her', 'its',
    'me', 'us', 'them', 'him',
    'on', 'in', 'at', 'by', 'for', 'to', 'of', 'as', 'so',
    'if', 'then', 'else', 'when', 'while', 'until', 'because',
    'will', 'would', 'should', 'could', 'might', 'must', 'can', 'cant', 'cannot',
    'not', 'no', 'yes', 'maybe', 'just', 'only', 'also', 'too', 'very',
    'what', 'who', 'whom', 'whose', 'where', 'which', 'why', 'how',
    'there', 'here', 'than',
    'need', 'want', 'make', 'made', 'use', 'used', 'using', 'try', 'tried',
    'more', 'less', 'much', 'many', 'some', 'any', 'all', 'each', 'every',
    'between', 'against',
  ]);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): boolean => {
    if (raw.length < 3) return false;
    if (stop.has(raw)) return false;
    if (seen.has(raw)) return false;
    seen.add(raw);
    out.push(raw);
    return out.length >= 24;
  };

  // 1. Split on non-alphanumerics. Keep each whole chunk (so "smart-context"
  //    after splitting becomes "smart" and "context", and the bigram pass
  //    below also re-joins them as "smartcontext").
  const chunks: string[] = [];
  for (const raw of task.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length === 0) continue;
    chunks.push(raw);
  }

  // 2. For each chunk, also split camelCase (e.g. "smartContext" → ["smart","context"]).
  const expanded: string[] = [];
  for (const chunk of chunks) {
    expanded.push(chunk);
    const camelParts = chunk.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    for (const part of camelParts) {
      if (part.toLowerCase() !== chunk) expanded.push(part.toLowerCase());
    }
  }

  // 3. Add each token. Also try a singular form by stripping trailing 's' / 'es'.
  for (const raw of expanded) {
    if (add(raw)) return out;
    if (raw.endsWith('ies') && raw.length > 4) {
      if (add(raw.slice(0, -3) + 'y')) return out;
    } else if (raw.endsWith('es') && raw.length > 4) {
      if (add(raw.slice(0, -2))) return out;
    } else if (raw.endsWith('s') && raw.length > 4 && !raw.endsWith('ss')) {
      if (add(raw.slice(0, -1))) return out;
    }
  }

  // 4. Compound-token detection: for adjacent meaningful chunks emit the
  //    joined form ("smart" + "context" → "smartcontext"). This helps when
  //    the keyword appears in a symbol or filename in concatenated form.
  for (let i = 0; i < chunks.length - 1; i += 1) {
    const a = chunks[i]!;
    const b = chunks[i + 1]!;
    if (a.length < 3 || b.length < 3) continue;
    if (stop.has(a) || stop.has(b)) continue;
    if (add(a + b)) return out;
  }

  return out;
}

function rankTaskFileCandidates(
  api: GraphQueryApi,
  tokens: readonly string[],
  limit: number,
): Array<{ path: string; score: number }> {
  const scores = new Map<string, number>();
  for (const node of api.allFiles()) {
    const path = node.path ?? '';
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let score = 0;
    for (const token of tokens) {
      if (base === token) score += 6;
      else if (base.includes(token)) score += 4;
      else if (lower.includes(token)) score += 2;
    }
    if (score > 0) scores.set(path, score);
  }
  return [...scores.entries()]
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .slice(0, limit)
    .map(([path, score]) => ({ path, score }));
}

function rankTaskSymbolCandidates(
  api: GraphQueryApi,
  tokens: readonly string[],
  limit: number,
): Array<{ symbol: string; path: string | null }> {
  const out: Array<{ symbol: string; path: string | null }> = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    for (const symbol of api.findSymbol(token, { exact: false, limit: 4 })) {
      if (seen.has(symbol.id)) continue;
      seen.add(symbol.id);
      const owner = declaringFileOf(api, symbol.id);
      out.push({ symbol: symbol.label, path: owner?.path ?? null });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function declaringFileOf(api: GraphQueryApi, symbolId: string): INode | undefined {
  const neighbours = api.neighbours(symbolId);
  if (!neighbours) return undefined;
  for (const incoming of neighbours.in) {
    if (incoming.edge.kind !== EdgeKind.DeclaresSymbol) continue;
    if ('resolved' in incoming.source) continue;
    if (incoming.source.kind === NodeKind.File) return incoming.source;
  }
  return undefined;
}

function packageNameForPath(path: string): string | null {
  const match = path.match(/^packages\/([^/]+)\//);
  return match?.[1] ?? null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function dedupeStrings(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function sumValues(input: Record<string, number> | undefined): number {
  if (!input) return 0;
  return Object.values(input).reduce((sum, value) => sum + value, 0);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BRIEF_SYSTEM_PREAMBLE = [
  'You are an AI engineer\'s research assistant for a SharkCraft-instrumented repository.',
  'You are given the deterministic context the SharkCraft engine produced for a task, plus the repository\'s own agent instructions (CLAUDE.md/AGENTS.md) when present.',
  'Treat the supplied context as authoritative ground truth.',
  'STRICT GROUNDING: every rule id, template id, file path, and command in your output MUST appear verbatim in the supplied context. If you cannot find evidence in context, omit the item rather than guessing.',
  'PREFER `Candidate code (graph-ranked from task tokens)` for files-to-read/edit suggestions, then `Relevant rules` / `Path conventions` / `Relevant templates`.',
  'RESPECT `Forbidden actions` — never suggest a step that violates one; mention the conflict if the user\'s request would.',
  'If the repository instructions and the engine context conflict, prefer the repository instructions and call out the conflict in a single line.',
  'Produce a concise Markdown BRIEF (≤ 400 words) that:',
  '  1. Restates the task in one sentence.',
  '  2. Highlights the most relevant rules (cite their IDs verbatim, with one line on `applies when`).',
  '  3. Lists the most likely files to read, then the most likely files to edit (use the candidate-code paths).',
  '  4. Calls out templates to use, recommended commands to run, and the verification commands to run after.',
  '  5. Flags gotchas, generated files, forbidden actions, or stability/memory warnings if present.',
  'No preamble, no closing pleasantries — just the brief.',
].join(' ');

const PLAN_SYSTEM_PREAMBLE = [
  'You are an AI engineer\'s research assistant for a SharkCraft-instrumented repository.',
  'You are given the deterministic context the SharkCraft engine produced for a task, plus the repository\'s own agent instructions (CLAUDE.md/AGENTS.md) when present.',
  'Treat the supplied context as authoritative ground truth — do not invent rule IDs, file paths, or commands that are not present.',
  'If the repository instructions and the engine context conflict, prefer the repository instructions and note the conflict in `openQuestions`.',
  'Produce a detailed implementation PLAN as a single fenced ```json block, then a short Markdown summary below it.',
  'The JSON must conform to this schema (omit fields with no content):',
  '{',
  '  "summary": string,',
  '  "filesToRead": [{ "path": string, "why": string }],',
  '  "filesToEdit": [{ "path": string, "why": string }],',
  '  "relatedRules": [{ "id": string, "title": string, "applyWhen": string }],',
  '  "relatedTemplates": [{ "id": string, "useFor": string }],',
  '  "firstCommands": [{ "command": string, "why": string }],',
  '  "implementationSteps": [{ "step": string, "details": string }],',
  '  "gotchas": [string],',
  '  "openQuestions": [string]',
  '}',
  'Use only rule IDs, template IDs, paths, and commands that appear in the supplied context.',
].join(' ');

const STAGE1_SYSTEM_PREAMBLE = [
  'You are stage 1 of a two-stage planning flow for a SharkCraft-instrumented repository.',
  'Your job is NOT to implement the task. Your job is to decide what additional deterministic context SharkCraft should collect before stage 2 writes a richer plan.',
  'Output: exactly one JSON object. No markdown fence. No prose before or after.',
  'PRIMARY SIGNALS, in order:',
  '  (a) `Candidate file briefs (task-ranked)` — top files with summary, exports + signatures, imports, importers. Use these for `filesToRead` / `similarPatterns` / `publicApiFiles` / `testsToInspect`. Reference signature lines or export names in `why` to prove you read them.',
  '  (b) `Documentation hits` — keyword-grepped lines from CLAUDE.md / AGENTS.md / docs. Use these to discover background and to anchor `architectureRules` / `riskyAreas` / `missingInformation` in real prose. When `Candidate file briefs` is sparse, the hits are your fallback evidence.',
  '  (c) `Path conventions` — use these when the briefs do not cover a needed area; cite the path-rule id in `why`.',
  'STRICT GROUNDING: every `target` MUST appear verbatim somewhere in the supplied context — in a brief, in a documentation hit, in `Candidate code` paths/symbols, in `Path conventions`, in `Relevant templates`, or in repo instructions. If you cannot find a path, do not list it.',
  'Every `architectureRules[].id` MUST be one of the `Relevant rules` ids verbatim — do not invent ids.',
  'Prefer breadth: surface 4–8 file targets, similar patterns, public API/export files, and tests, but stay bounded. Do not request reading the whole repository.',
  'Each entry must include a one-sentence `why` that references concrete evidence (a brief summary, an export signature line, a doc-hit line number, an import path).',
  'Empty arrays are allowed; prefer omitting noise over inventing entries.',
].join(' ');

const STAGE2_SYSTEM_PREAMBLE = [
  'You are stage 2 of a two-stage planning flow for a SharkCraft-instrumented repository.',
  'You are given the original task, the initial deterministic smart-context seed, and the additional context SharkCraft collected after stage 1.',
  'Output: exactly one JSON object. No markdown fence. No prose before or after.',
  'This is a development-oriented plan for Claude, not a final implementation. Do not pretend certainty or exact implementation details that the context does not justify; surface those as `unknowns`.',
  'STRICT GROUNDING: every `path` you list MUST appear in the supplied context (candidate code, additional collected context, path-conventions, or knowledge body). Every `relatedRules[].id` MUST match a real rule id from the context. Every command in `firstCommands` / `validationCommands` MUST come from the `Recommended commands` or `Verification commands` sections.',
  'RESPECT `Forbidden actions` — never recommend a step that violates one.',
  'Required JSON fields (omit array fields cleanly when empty): summary, taskUnderstanding, likelyTechnicalApproach, existingPatternsToFollow, filesToRead, likelyFilesToModify, filesToAvoid, publicApiFiles, testsToInspect, architectureConstraints, relatedRules, relatedTemplates, firstCommands, implementationSteps, risks, unknowns, validationCommands, handoffSummary.',
  '`handoffSummary` is a single paragraph (≤ 6 sentences) Claude can read to start work.',
].join(' ');
