import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildAiReadinessReport,
  buildPackSignatureStatusReport,
  inspectSharkcraft,
  runDoctor,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

/**
 * IDE data surface. Aggregates per-file SharkCraft signals
 * (applicable rules, relevant knowledge, suggested commands) into a single
 * deterministic JSON shape so a VS Code / Cursor / Zed extension can ask
 * one question per file. Read-only. No telemetry.
 */

interface IIdeFileReport {
  schema: 'sharkcraft.ide.file/v1';
  generatedAt: string;
  cwd: string;
  file: {
    path: string;
    relativePath: string;
    exists: boolean;
    isDirectory: boolean;
  };
  applicableRules: ReadonlyArray<{
    id: string;
    title?: string;
    priority?: string;
    advisory?: boolean;
    appliesWhen?: readonly string[];
  }>;
  relevantKnowledge: ReadonlyArray<{
    id: string;
    title?: string;
    type?: string;
    priority?: string;
  }>;
  suggestedCommands: readonly string[];
  notes: readonly string[];
}

function relativise(cwd: string, file: string): string {
  const abs = nodePath.isAbsolute(file) ? file : nodePath.resolve(cwd, file);
  return nodePath.relative(cwd, abs);
}

export const ideFileCommand: ICommandHandler = {
  name: 'file',
  description:
    'Emit per-file SharkCraft signals as one JSON record (applicable rules + relevant knowledge + suggested commands). Read-only. Designed for IDE extensions.',
  usage: 'shrk ide file <path> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const target = args.positional[0];
    if (!target) {
      process.stderr.write('Usage: shrk ide file <path> [--json]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const abs = nodePath.isAbsolute(target) ? target : nodePath.resolve(cwd, target);
    const exists = existsSync(abs);
    const isDirectory = exists ? safeIsDir(abs) : false;

    let report: IIdeFileReport;
    try {
      const inspection = await inspectSharkcraft({ cwd });
      const rules = inspection.ruleService.list();
      const knowledge = inspection.knowledgeEntries;
      // We don't have a per-file query in the engine; the deterministic
      // approach is: surface rules whose `pathPatterns` or content
      // mention this file's path segments, then suggest the smallest set
      // of next commands.
      const relPath = relativise(cwd, abs);
      const fileTokens = relPath.split(/[\\/.]/).filter((t) => t.length >= 3);

      const applicableRules = rules
        .filter((r) =>
          fileTokens.some((tok) => {
            const hay = (r.content + ' ' + (r.title ?? '') + ' ' + (r.tags ?? []).join(' ')).toLowerCase();
            return hay.includes(tok.toLowerCase());
          }),
        )
        .slice(0, 25)
        .map((r) => ({
          id: r.id,
          title: r.title,
          priority: r.priority,
          advisory: Boolean((r as { advisory?: boolean }).advisory),
          appliesWhen: r.appliesWhen,
        }));

      const relevantKnowledge = knowledge
        .filter((k) =>
          fileTokens.some((tok) => {
            const hay = (k.content + ' ' + (k.title ?? '') + ' ' + (k.tags ?? []).join(' ')).toLowerCase();
            return hay.includes(tok.toLowerCase());
          }),
        )
        .slice(0, 25)
        .map((k) => ({ id: k.id, title: k.title, type: k.type, priority: k.priority }));

      const suggestedCommands: string[] = [];
      suggestedCommands.push(`shrk why "${relPath}"`);
      if (applicableRules.length > 0) {
        suggestedCommands.push(`shrk rules relevant --task "edit ${relPath}"`);
      }
      if (relevantKnowledge.length > 0) {
        suggestedCommands.push(`shrk knowledge search "${nodePath.basename(relPath)}"`);
      }
      suggestedCommands.push('shrk impact');
      suggestedCommands.push('shrk check boundaries --changed-only');

      const notes: string[] = [];
      if (!exists) notes.push('file does not exist on disk');
      if (isDirectory) notes.push('path is a directory; results are heuristic');

      report = {
        schema: 'sharkcraft.ide.file/v1',
        generatedAt: new Date().toISOString(),
        cwd,
        file: {
          path: abs,
          relativePath: relPath,
          exists,
          isDirectory,
        },
        applicableRules,
        relevantKnowledge,
        suggestedCommands,
        notes,
      };
    } catch (e) {
      // If sharkcraft/ is absent or broken, still produce a useful skeleton.
      const relPath = relativise(cwd, abs);
      report = {
        schema: 'sharkcraft.ide.file/v1',
        generatedAt: new Date().toISOString(),
        cwd,
        file: { path: abs, relativePath: relPath, exists, isDirectory },
        applicableRules: [],
        relevantKnowledge: [],
        suggestedCommands: [
          'shrk init --zero-config',
          'shrk doctor',
        ],
        notes: [
          `inspectSharkcraft failed: ${(e as Error).message}`,
          'run `shrk init --zero-config` to set up the workspace',
        ],
      };
    }

    if (flagBool(args, 'json') || !process.stdout.isTTY) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(header(`IDE file report: ${report.file.relativePath}`));
    process.stdout.write(`exists:    ${report.file.exists}\n`);
    process.stdout.write(`directory: ${report.file.isDirectory}\n\n`);
    process.stdout.write(`applicable rules (${report.applicableRules.length}):\n`);
    for (const r of report.applicableRules.slice(0, 10)) {
      process.stdout.write(`  • ${r.id}${r.priority ? ` [${r.priority}]` : ''} — ${r.title ?? ''}\n`);
    }
    process.stdout.write(`\nrelevant knowledge (${report.relevantKnowledge.length}):\n`);
    for (const k of report.relevantKnowledge.slice(0, 10)) {
      process.stdout.write(`  • ${k.id}${k.priority ? ` [${k.priority}]` : ''} — ${k.title ?? ''}\n`);
    }
    process.stdout.write(`\nsuggested commands:\n`);
    for (const c of report.suggestedCommands) process.stdout.write(`  $ ${c}\n`);
    if (report.notes.length > 0) {
      process.stdout.write('\nnotes:\n');
      for (const n of report.notes) process.stdout.write(`  • ${n}\n`);
    }
    process.stdout.write(`\n(pass --json for the machine surface — schema ${report.schema})\n`);
    return 0;
  },
};

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * IDE project report. Aggregates the workspace-wide signals an
 * extension needs after the user opens a folder: active packs, presets,
 * framework, configured checks, doctor summary, CI status, pack signature
 * status. Read-only.
 */
interface IIdeProjectReport {
  schema: 'sharkcraft.ide.project/v1';
  generatedAt: string;
  cwd: string;
  workspace: {
    framework: string | null;
    profiles: readonly string[];
    hasSharkcraftFolder: boolean;
  };
  activePacks: ReadonlyArray<{ name: string; version: string }>;
  activePresets: ReadonlyArray<{ id: string }>;
  configuredVerificationCommandIds: readonly string[];
  doctor: { passed: boolean; errors: number; warnings: number; info: number; ok: number };
  aiReadiness: { score: number; grade: string };
  signatureStatus: {
    total: number;
    present: number;
    stale: number;
    missing: number;
    dev: number;
  };
  suggestedCommands: readonly string[];
}

export const ideProjectCommand: ICommandHandler = {
  name: 'project',
  description:
    'Emit workspace-wide SharkCraft signals as one JSON record (active packs, presets, framework, doctor summary, CI status, signature status). Read-only.',
  usage: 'shrk ide project [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const doctor = runDoctor(inspection);
    const ai = buildAiReadinessReport(inspection);
    const sig = buildPackSignatureStatusReport(inspection);
    const cfg = inspection.config as {
      verificationCommands?: ReadonlyArray<{ id?: string }>;
    } | null;
    const verificationIds = (cfg?.verificationCommands ?? [])
      .map((v) => v.id)
      .filter((id): id is string => typeof id === 'string');

    // Active presets — every preset in the registry that recommends with
    // confidence ≥ 'medium' against the detected profiles.
    const activePresets = inspection.presetRegistry
      .list()
      .filter((p) => {
        const appliesTo = (p as unknown as { appliesTo?: readonly string[] }).appliesTo;
        if (!appliesTo) return false;
        return inspection.workspace.profiles.some((prof) => appliesTo.includes(prof));
      })
      .slice(0, 25)
      .map((p) => ({ id: p.id }));

    const report: IIdeProjectReport = {
      schema: 'sharkcraft.ide.project/v1',
      generatedAt: new Date().toISOString(),
      cwd,
      workspace: {
        framework: (inspection.workspace as unknown as { framework?: string | null }).framework ?? null,
        profiles: inspection.workspace.profiles,
        hasSharkcraftFolder: inspection.hasSharkcraftFolder,
      },
      activePacks: (inspection.packs.validPacks ?? []).map((p) => ({
        name: p.packageName,
        version: p.packageVersion,
      })),
      activePresets,
      configuredVerificationCommandIds: verificationIds,
      doctor: {
        passed: doctor.passed,
        errors: doctor.summary.errors,
        warnings: doctor.summary.warnings,
        info: doctor.summary.info,
        ok: doctor.summary.ok,
      },
      aiReadiness: { score: ai.score, grade: ai.grade },
      signatureStatus: {
        total: sig.summary.total,
        present: sig.summary.present,
        stale: sig.summary.stale,
        missing: sig.summary.missing,
        dev: sig.summary.dev,
      },
      suggestedCommands: [
        'shrk doctor',
        'shrk check boundaries --changed-only',
        'shrk packs signature-status',
        'shrk drift rules',
      ],
    };

    if (flagBool(args, 'json') || !process.stdout.isTTY) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(header(`IDE project report`));
    process.stdout.write(`framework:  ${report.workspace.framework ?? '(unknown)'}\n`);
    process.stdout.write(`profiles:   ${report.workspace.profiles.join(', ') || '(none)'}\n`);
    process.stdout.write(`packs:      ${report.activePacks.length}\n`);
    process.stdout.write(`presets:    ${report.activePresets.length}\n`);
    process.stdout.write(
      `doctor:     ${report.doctor.errors} err / ${report.doctor.warnings} warn / ${report.doctor.ok} ok\n`,
    );
    process.stdout.write(`ai-ready:   ${report.aiReadiness.score}/100 (${report.aiReadiness.grade})\n`);
    process.stdout.write(
      `signatures: ${report.signatureStatus.present} present / ${report.signatureStatus.stale} stale / ${report.signatureStatus.missing} missing / ${report.signatureStatus.dev} dev\n`,
    );
    process.stdout.write(`\n(pass --json for the machine surface — schema ${report.schema})\n`);
    return 0;
  },
};

/**
 * IDE symbol report. Surfaces the knowledge anchors / rules that
 * reference a given symbol so an extension can answer "what does
 * SharkCraft know about this symbol?". Read-only.
 */
interface IIdeSymbolReport {
  schema: 'sharkcraft.ide.symbol/v1';
  generatedAt: string;
  cwd: string;
  symbol: string;
  references: ReadonlyArray<{
    sourceKind: 'knowledge' | 'rule';
    sourceId: string;
    sourceTitle?: string;
    matchedField: 'anchors' | 'references' | 'content' | 'title';
  }>;
  suggestedCommands: readonly string[];
  notes: readonly string[];
}

export const ideSymbolCommand: ICommandHandler = {
  name: 'symbol',
  description:
    'Emit per-symbol SharkCraft signals (knowledge anchors / rule references / suggested commands) as one JSON record. Read-only.',
  usage: 'shrk ide symbol <name> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const symbol = args.positional[0];
    if (!symbol) {
      process.stderr.write('Usage: shrk ide symbol <name> [--json]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    type Reference = IIdeSymbolReport['references'][number];
    const references: Reference[] = [];
    const symbolLower = symbol.toLowerCase();
    const matchInString = (s?: string): boolean =>
      typeof s === 'string' && s.toLowerCase().includes(symbolLower);

    for (const entry of inspection.knowledgeEntries) {
      const kind = entry.type === 'rule' ? 'rule' : 'knowledge';
      const anchors = (entry as unknown as {
        anchors?: ReadonlyArray<{ kind?: string; symbol?: string }>;
      }).anchors;
      if (anchors) {
        for (const a of anchors) {
          if (a.kind === 'symbol' && a.symbol === symbol) {
            references.push({
              sourceKind: kind,
              sourceId: entry.id,
              sourceTitle: entry.title,
              matchedField: 'anchors',
            });
            break;
          }
        }
      }
      const refs = (entry as unknown as {
        references?: ReadonlyArray<{ kind?: string; symbol?: string }>;
      }).references;
      if (refs) {
        for (const r of refs) {
          if (r.kind === 'symbol' && r.symbol === symbol) {
            references.push({
              sourceKind: kind,
              sourceId: entry.id,
              sourceTitle: entry.title,
              matchedField: 'references',
            });
            break;
          }
        }
      }
      if (matchInString(entry.title) && !references.some((x) => x.sourceId === entry.id)) {
        references.push({
          sourceKind: kind,
          sourceId: entry.id,
          sourceTitle: entry.title,
          matchedField: 'title',
        });
      } else if (
        matchInString(entry.content) &&
        !references.some((x) => x.sourceId === entry.id)
      ) {
        references.push({
          sourceKind: kind,
          sourceId: entry.id,
          sourceTitle: entry.title,
          matchedField: 'content',
        });
      }
    }

    const report: IIdeSymbolReport = {
      schema: 'sharkcraft.ide.symbol/v1',
      generatedAt: new Date().toISOString(),
      cwd,
      symbol,
      references: references.slice(0, 50),
      suggestedCommands: [
        `shrk impact --symbol ${symbol}`,
        `shrk trace --symbol ${symbol}`,
        `shrk knowledge search "${symbol}"`,
      ],
      notes:
        references.length === 0
          ? ['no anchors / rules reference this symbol']
          : [],
    };

    if (flagBool(args, 'json') || !process.stdout.isTTY) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(header(`IDE symbol report: ${symbol}`));
    process.stdout.write(`references (${report.references.length}):\n`);
    for (const r of report.references.slice(0, 10)) {
      process.stdout.write(`  • ${r.sourceKind}:${r.sourceId} (matched in ${r.matchedField})\n`);
    }
    process.stdout.write(`\nsuggested commands:\n`);
    for (const c of report.suggestedCommands) process.stdout.write(`  $ ${c}\n`);
    return 0;
  },
};

export const ideCommand: ICommandHandler = {
  name: 'ide',
  description:
    'IDE data surface — read-only JSON reports per file / project / symbol. Designed for IDE extensions to consume.',
  usage:
    'shrk ide file <path> [--json] | shrk ide project [--json] | shrk ide symbol <name> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const verb = args.positional[0];
    if (verb === 'file') {
      return ideFileCommand.run({
        ...args,
        positional: args.positional.slice(1),
      });
    }
    if (verb === 'project') {
      return ideProjectCommand.run({
        ...args,
        positional: args.positional.slice(1),
      });
    }
    if (verb === 'symbol') {
      return ideSymbolCommand.run({
        ...args,
        positional: args.positional.slice(1),
      });
    }
    process.stderr.write(
      'Usage: shrk ide <file|project|symbol> [...args] [--json]\n',
    );
    return 2;
  },
};
