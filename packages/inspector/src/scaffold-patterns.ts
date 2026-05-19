/**
 * Scaffold pattern registry + loader.
 *
 * Resolves scaffold patterns from packs (and the local config when supplied)
 * into a single in-memory list. Patterns are data; this module never executes
 * shell commands or evaluates pack code beyond a dynamic import.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { importModuleViaLoader } from '@shrkcrft/core';
import {
  isRecognizedScaffoldStrategy,
  type IScaffoldPattern,
} from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection, ISourceInfo } from './sharkcraft-inspector.ts';

export interface IScaffoldPatternWithSource {
  pattern: IScaffoldPattern;
  source: ISourceInfo;
}

export interface IScaffoldPatternsLoadResult {
  patterns: IScaffoldPatternWithSource[];
  warnings: string[];
}

export async function loadScaffoldPatternsFromFile(
  file: string,
): Promise<{ patterns: IScaffoldPattern[]; warnings: string[] }> {
  if (!existsSync(file)) return { patterns: [], warnings: [`scaffold pattern file missing: ${file}`] };
  try {
    const mod = await importModuleViaLoader<{
      default?: unknown;
    }>(file);
    const raw = mod.default ?? mod;
    if (!Array.isArray(raw)) {
      return {
        patterns: [],
        warnings: [`scaffold pattern file did not default-export an array: ${file}`],
      };
    }
    const out: IScaffoldPattern[] = [];
    const warnings: string[] = [];
    for (const candidate of raw) {
      if (!candidate || typeof candidate !== 'object') {
        warnings.push(`scaffold pattern entry is not an object in ${file}`);
        continue;
      }
      const p = candidate as Partial<IScaffoldPattern>;
      if (!p.id || typeof p.id !== 'string') {
        warnings.push(`scaffold pattern missing id in ${file}`);
        continue;
      }
      if (!p.templateId || typeof p.templateId !== 'string') {
        warnings.push(`scaffold pattern "${p.id}" missing templateId in ${file}`);
        continue;
      }
      if (!Array.isArray(p.matchPaths) || p.matchPaths.length === 0) {
        warnings.push(`scaffold pattern "${p.id}" must declare matchPaths in ${file}`);
        continue;
      }
      out.push(p as IScaffoldPattern);
    }
    return { patterns: out, warnings };
  } catch (e) {
    return {
      patterns: [],
      warnings: [`failed to import scaffold pattern file ${file}: ${(e as Error).message}`],
    };
  }
}

/**
 * Walk the inspection's discovered packs and load every `scaffoldPatternFiles`
 * entry. Returns the patterns + source map.
 */
export async function loadScaffoldPatternsFromInspection(
  inspection: ISharkcraftInspection,
): Promise<IScaffoldPatternsLoadResult> {
  const seen = new Map<string, IScaffoldPatternWithSource>();
  const warnings: string[] = [];
  // Also load a local sharkcraft/scaffold-patterns.ts when present.
  if (inspection.sharkcraftDir) {
    const local = nodePath.join(inspection.sharkcraftDir, 'scaffold-patterns.ts');
    if (existsSync(local)) {
      const r = await loadScaffoldPatternsFromFile(local);
      warnings.push(...r.warnings);
      for (const p of r.patterns) {
        if (seen.has(p.id)) {
          warnings.push(`scaffold pattern "${p.id}" duplicated — local version skipped`);
          continue;
        }
        seen.set(p.id, {
          pattern: p,
          source: { type: 'local', file: local },
        });
      }
    }
  }
  for (const pack of inspection.packs.validPacks) {
    const c = pack.manifest!.contributions as { scaffoldPatternFiles?: readonly string[] };
    for (const rel of c.scaffoldPatternFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      const r = await loadScaffoldPatternsFromFile(full);
      warnings.push(...r.warnings);
      for (const p of r.patterns) {
        if (seen.has(p.id)) {
          warnings.push(`scaffold pattern "${p.id}" duplicated — pack version skipped`);
          continue;
        }
        seen.set(p.id, {
          pattern: p,
          source: {
            type: 'pack',
            packageName: pack.packageName,
            packageVersion: pack.packageVersion,
            file: full,
          },
        });
        if (pack.resolvedCounts) {
          (pack.resolvedCounts as { scaffoldPatterns?: number }).scaffoldPatterns =
            (pack.resolvedCounts.scaffoldPatterns ?? 0) + 1;
        }
      }
    }
  }
  return { patterns: [...seen.values()], warnings };
}

// ─── Matching + doctor ────────────────────────────────────────────────────────

export interface IScaffoldPatternIssue {
  patternId: string;
  field: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export function doctorScaffoldPatterns(
  patterns: readonly IScaffoldPatternWithSource[],
  inspection: ISharkcraftInspection,
): readonly IScaffoldPatternIssue[] {
  const issues: IScaffoldPatternIssue[] = [];
  const knownTemplateIds = new Set(inspection.templateRegistry.list().map((t) => t.id));
  for (const { pattern: p } of patterns) {
    if (!p.title) {
      issues.push({ patternId: p.id, field: 'title', severity: 'warning', message: 'missing title' });
    }
    if (!p.description) {
      issues.push({
        patternId: p.id,
        field: 'description',
        severity: 'warning',
        message: 'missing description',
      });
    }
    if (!Array.isArray(p.appliesWhen) || p.appliesWhen.length === 0) {
      issues.push({
        patternId: p.id,
        field: 'appliesWhen',
        severity: 'warning',
        message: 'appliesWhen is empty — pattern will not be consulted by any lifecycle hook',
      });
    }
    if (p.confidence !== 'high' && p.confidence !== 'medium' && p.confidence !== 'low') {
      issues.push({
        patternId: p.id,
        field: 'confidence',
        severity: 'error',
        message: `confidence must be high|medium|low (got "${String(p.confidence)}")`,
      });
    }
    for (const m of p.matchPaths) {
      if (typeof m !== 'string' || m.length === 0) {
        issues.push({
          patternId: p.id,
          field: 'matchPaths',
          severity: 'error',
          message: `matchPaths entry must be a non-empty string`,
        });
      }
    }
    if (!knownTemplateIds.has(p.templateId)) {
      issues.push({
        patternId: p.id,
        field: 'templateId',
        severity: 'warning',
        message: `template "${p.templateId}" is not registered in this project`,
      });
    }
    for (const v of p.variables ?? []) {
      if (!isRecognizedScaffoldStrategy(String(v.from))) {
        issues.push({
          patternId: p.id,
          field: `variables.${v.name}.from`,
          severity: 'warning',
          message: `unrecognized extraction strategy "${String(v.from)}"`,
        });
      }
    }
  }
  return issues;
}

/**
 * Convert a glob-like pattern (only `*` and `**` are recognized) into a
 * RegExp. Kept tiny — we don't depend on `minimatch`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      // `**/` matches zero or more path segments. We also consume the slash so
      // that the segment-separator isn't required by the rest of the pattern.
      re += '(?:.*/)?';
      i += 2;
    } else if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+()[]{}|^$\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

export function matchScaffoldPattern(
  pattern: IScaffoldPattern,
  relativePath: string,
): boolean {
  const path = relativePath.split(nodePath.sep).join('/');
  for (const x of pattern.excludePaths ?? []) {
    if (globToRegExp(x).test(path)) return false;
  }
  for (const m of pattern.matchPaths) {
    if (globToRegExp(m).test(path)) return true;
  }
  return false;
}

// ─── Variable extraction ──────────────────────────────────────────────────────

export interface IExtractedVariables {
  values: Record<string, string>;
  warnings: string[];
}

export function extractVariablesForFile(
  pattern: IScaffoldPattern,
  filePath: string,
  inspection: ISharkcraftInspection,
): IExtractedVariables {
  const warnings: string[] = [];
  const values: Record<string, string> = {};
  const base = nodePath.basename(filePath).replace(/\.(tsx?|jsx?)$/i, '');
  const dirSegments = filePath.split(/[\\/]/).slice(0, -1);
  const dir = dirSegments[dirSegments.length - 1] ?? '';

  for (const v of pattern.variables) {
    const strat = String(v.from);
    let value = '';
    if (strat === 'filename.kebab') {
      value = base
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/_+/g, '-')
        .toLowerCase();
    } else if (strat === 'filename.pascal') {
      value = base
        .split(/[-_.]/)
        .filter(Boolean)
        .map((s) => s[0]!.toUpperCase() + s.slice(1))
        .join('');
    } else if (strat === 'className') {
      value = pascal(base);
    } else if (strat.startsWith('className.stripPrefix:')) {
      const prefix = strat.slice('className.stripPrefix:'.length);
      const pascalName = pascal(base);
      value = pascalName.startsWith(prefix) ? pascalName.slice(prefix.length) : pascalName;
    } else if (strat === 'functionName') {
      value = camel(base);
    } else if (strat === 'directoryName') {
      value = dir;
    } else if (strat === 'nearestPackageName') {
      value = inspection.workspace.packageName ?? '';
    } else {
      warnings.push(`unrecognized extraction strategy "${strat}" for variable "${v.name}"`);
    }
    if (value) values[v.name] = value;
  }
  return { values, warnings };
}

function pascal(s: string): string {
  return s
    .split(/[-_.]/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('');
}

function camel(s: string): string {
  const p = pascal(s);
  return p ? p[0]!.toLowerCase() + p.slice(1) : '';
}
