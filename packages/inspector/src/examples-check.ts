/**
 * `shrk examples check` — verify the examples/ tree is sound.
 *
 * Read-only. Verifies:
 *  - examples/ exists
 *  - each example directory has a package.json
 *  - example commands referenced in known scripts are present in the catalog
 *    (best-effort)
 *  - no destructive commands in any included demo script
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

export const EXAMPLES_CHECK_SCHEMA = 'sharkcraft.examples-check/v1';

export interface IExamplesCheckFinding {
  code:
    | 'examples-dir-missing'
    | 'example-missing-package-json'
    | 'destructive-command-detected'
    | 'unknown-command-reference'
    | 'demo-script-unsafe';
  severity: 'info' | 'warning' | 'error';
  message: string;
  file?: string;
  suggestion?: string;
}

export interface IExamplesCheckReport {
  schema: typeof EXAMPLES_CHECK_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  examples: readonly { name: string; path: string; hasPackageJson: boolean }[];
  findings: readonly IExamplesCheckFinding[];
  ok: boolean;
}

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+-rf\b/,
  /\brm\s+-fr\b/,
  />\s*\/dev\/null\s*2>&1\s*&&\s*rm\b/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
];

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function listScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of safeReaddir(dir)) {
    const full = nodePath.join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) out.push(...listScriptFiles(full));
      else if (entry.endsWith('.sh') || entry.endsWith('.bash')) out.push(full);
    } catch {
      /* skip */
    }
  }
  return out;
}

export interface IBuildExamplesCheckOptions {
  knownCommands?: readonly string[];
}

export function buildExamplesCheck(
  projectRoot: string,
  options: IBuildExamplesCheckOptions = {},
): IExamplesCheckReport {
  const findings: IExamplesCheckFinding[] = [];
  const examplesDir = nodePath.join(projectRoot, 'examples');
  const examples: { name: string; path: string; hasPackageJson: boolean }[] = [];
  if (!existsSync(examplesDir)) {
    findings.push({
      code: 'examples-dir-missing',
      severity: 'warning',
      message: 'No examples/ directory found at the project root.',
      suggestion: 'Create at least one example so the demo flow has a target.',
    });
    return {
      schema: EXAMPLES_CHECK_SCHEMA,
      generatedAt: new Date().toISOString(),
      projectRoot,
      examples: [],
      findings,
      ok: false,
    };
  }
  for (const entry of safeReaddir(examplesDir)) {
    const full = nodePath.join(examplesDir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const pkg = nodePath.join(full, 'package.json');
    const hasPackageJson = existsSync(pkg);
    if (!hasPackageJson) {
      findings.push({
        code: 'example-missing-package-json',
        severity: 'warning',
        message: `examples/${entry}/ has no package.json.`,
        file: `examples/${entry}/package.json`,
        suggestion: 'Add a package.json so the example resolves as a workspace.',
      });
    }
    examples.push({
      name: entry,
      path: `examples/${entry}`,
      hasPackageJson,
    });
  }
  const scriptFiles = listScriptFiles(examplesDir);
  for (const file of scriptFiles) {
    let body = '';
    try {
      body = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const re of DESTRUCTIVE_PATTERNS) {
      if (re.test(body)) {
        findings.push({
          code: 'destructive-command-detected',
          severity: 'error',
          message: `Destructive command pattern in ${nodePath.relative(projectRoot, file)}`,
          file: nodePath.relative(projectRoot, file),
          suggestion: 'Remove or comment out destructive lines. SharkCraft demos must be safe to run.',
        });
        break;
      }
    }
    if (options.knownCommands && options.knownCommands.length > 0) {
      const re = /\bshrk\s+([\w-]+(?:\s+[\w-]+)?)/g;
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(body))) {
        const cmd = `shrk ${m[1]!.trim()}`;
        if (seen.has(cmd)) continue;
        seen.add(cmd);
        let known = false;
        for (const k of options.knownCommands) {
          if (k === cmd || k.startsWith(cmd) || cmd.startsWith(k)) {
            known = true;
            break;
          }
        }
        if (!known) {
          findings.push({
            code: 'unknown-command-reference',
            severity: 'info',
            message: `${nodePath.relative(projectRoot, file)} references "${cmd}" which is not in the command catalog.`,
            file: nodePath.relative(projectRoot, file),
          });
        }
      }
    }
  }
  const ok = findings.filter((f) => f.severity === 'error').length === 0;
  return {
    schema: EXAMPLES_CHECK_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    examples,
    findings,
    ok,
  };
}

export function renderExamplesCheckText(report: IExamplesCheckReport): string {
  const lines: string[] = [];
  lines.push('# Examples check');
  lines.push(`OK: ${report.ok ? 'yes' : 'no'}  · examples: ${report.examples.length}`);
  for (const e of report.examples) {
    lines.push(`  - ${e.name}  [${e.hasPackageJson ? 'pkg' : 'no pkg'}]`);
  }
  if (report.findings.length === 0) lines.push('No findings.');
  else {
    lines.push('Findings:');
    for (const f of report.findings) {
      lines.push(`  [${f.severity}] ${f.code}: ${f.message}`);
      if (f.suggestion) lines.push(`     → ${f.suggestion}`);
    }
  }
  return lines.join('\n') + '\n';
}
