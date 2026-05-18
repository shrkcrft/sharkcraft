/**
 * `shrk plan check <path>` — validate ANY external plan/spec file
 * against the live workspace. Read-only; never modifies the input
 * file.
 *
 * Two built-in extractors:
 *   - `sharkcraft.spec/v1`       (spec.md format)
 *   - `markdown-frontmatter-loose` (any YAML frontmatter; --field-map remaps)
 */

import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  getExtractorById,
  pickExtractor,
  type ExtractorFieldMap,
  type IExtractedPlan,
  type IPlanExtractor,
  type ISpecValidationIssue,
} from '@shrkcrft/generator';
import {
  inspectSharkcraft,
  loadNxProjects,
  mapFilesToProjects,
  validateExtractedPlan,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

export const PLAN_CHECK_SCHEMA = 'sharkcraft.plan-check/v1';

export interface IPlanCheckReport {
  readonly schema: typeof PLAN_CHECK_SCHEMA;
  readonly source: string;
  readonly extractorId: string;
  readonly verdict: 'pass' | 'warn' | 'fail';
  readonly errors: readonly ISpecValidationIssue[];
  readonly warnings: readonly ISpecValidationIssue[];
  readonly nx?: {
    readonly enabled: boolean;
    readonly affectedProjects?: readonly string[];
    readonly note?: string;
  };
}

export const planCheckCommand: ICommandHandler = {
  name: 'check',
  description:
    'Validate an external plan/spec file against the live workspace. Read-only — the input file is never modified. Supports two built-in extractors and an optional --field-map.',
  usage:
    'shrk plan check <path> [--extractor sharkcraft.spec/v1|markdown-frontmatter-loose] [--field-map <json>] [--json] [--strict]',
  async run(args: ParsedArgs): Promise<number> {
    const path = args.positional[0];
    if (!path) {
      process.stderr.write('Usage: shrk plan check <path> [--extractor <id>] [--field-map <json>]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const absPath = nodePath.isAbsolute(path) ? path : nodePath.resolve(cwd, path);
    if (!existsSync(absPath)) {
      process.stderr.write(`Plan file not found: ${absPath}\n`);
      return 1;
    }

    const extractor = pickExtractorFromFlag(args, absPath);
    if (!extractor) {
      process.stderr.write(
        `Refusing: no extractor accepts "${path}". Pass --extractor sharkcraft.spec/v1 | markdown-frontmatter-loose.\n`,
      );
      return 1;
    }

    const fieldMap = parseFieldMap(flagString(args, 'field-map'));
    if (fieldMap === 'invalid') {
      process.stderr.write('Refusing: --field-map must be valid JSON of shape {"externalKey":"canonicalKey",...}.\n');
      return 1;
    }

    const raw = readFileSync(absPath, 'utf8');
    const extracted = extractor.extract(raw, {
      source: nodePath.relative(cwd, absPath) || absPath,
      ...(fieldMap ? { fieldMap } : {}),
    });
    if (!extracted.ok) {
      process.stderr.write(`Extractor "${extractor.id}" refused: ${extracted.error.message}\n`);
      return 1;
    }

    const inspection = await inspectSharkcraft({ cwd });
    const validation = validateExtractedPlan(extracted.value, inspection);
    const verdict: 'pass' | 'warn' | 'fail' = validation.errors.length > 0
      ? 'fail'
      : validation.warnings.length > 0
        ? 'warn'
        : 'pass';

    const nxReport = buildNxReport(cwd, extracted.value);

    const report: IPlanCheckReport = {
      schema: PLAN_CHECK_SCHEMA,
      source: extracted.value.source,
      extractorId: extractor.id,
      verdict,
      errors: validation.errors,
      warnings: validation.warnings,
      ...(nxReport ? { nx: nxReport } : {}),
    };

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
    } else {
      renderHuman(report);
    }

    if (verdict === 'fail') return 1;
    if (verdict === 'warn' && flagBool(args, 'strict')) return 1;
    return 0;
  },
};

function pickExtractorFromFlag(args: ParsedArgs, absPath: string): IPlanExtractor | null {
  const explicit = flagString(args, 'extractor');
  if (explicit) return getExtractorById(explicit);
  return pickExtractor(absPath);
}

function parseFieldMap(raw: string | undefined): ExtractorFieldMap | null | 'invalid' {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid';
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string') return 'invalid';
      out[k] = v;
    }
    return out;
  } catch {
    return 'invalid';
  }
}

function buildNxReport(cwd: string, extracted: IExtractedPlan): IPlanCheckReport['nx'] | undefined {
  const graph = loadNxProjects(cwd);
  if (!graph) return undefined;
  const files = extracted.affectedFiles ?? [];
  if (files.length === 0) {
    return { enabled: true, note: 'no affectedFiles declared — skipping project mapping' };
  }
  const projects = mapFilesToProjects(files, graph);
  return {
    enabled: true,
    affectedProjects: projects,
    ...(projects.length > 1
      ? { note: `plan touches ${projects.length} projects: ${projects.join(', ')}` }
      : {}),
  };
}

function renderHuman(report: IPlanCheckReport): void {
  process.stdout.write(header(`Plan check: ${report.source}`));
  process.stdout.write(`  extractor: ${report.extractorId}\n`);
  process.stdout.write(`  verdict:   ${report.verdict.toUpperCase()}\n`);
  process.stdout.write(`  errors:    ${report.errors.length}\n`);
  process.stdout.write(`  warnings:  ${report.warnings.length}\n`);
  if (report.nx) {
    if (report.nx.affectedProjects) {
      process.stdout.write(`  nx projects: ${report.nx.affectedProjects.join(', ') || '(none)'}\n`);
    } else if (report.nx.note) {
      process.stdout.write(`  nx: ${report.nx.note}\n`);
    }
  }
  if (report.errors.length > 0) {
    process.stdout.write('\nErrors:\n');
    for (const e of report.errors) {
      process.stdout.write(`  [${e.code}] ${e.field}: ${e.message}\n`);
    }
  }
  if (report.warnings.length > 0) {
    process.stdout.write('\nWarnings:\n');
    for (const w of report.warnings) {
      process.stdout.write(`  [${w.code}] ${w.field}: ${w.message}\n`);
    }
  }
}
