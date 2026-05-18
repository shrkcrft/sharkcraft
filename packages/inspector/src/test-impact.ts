import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const TEST_IMPACT_SCHEMA = 'sharkcraft.test-impact/v1';

export interface ITestImpactInput {
  task?: string;
  files?: readonly string[];
}

export interface ITestImpact {
  schema: typeof TEST_IMPACT_SCHEMA;
  task: string;
  inputFiles: readonly string[];
  likelyTestFiles: readonly string[];
  missingTestFiles: readonly string[];
  testCommands: readonly string[];
  /** Minimum commands to gain coverage for the inferred test files. */
  minimalCommands: readonly string[];
  /** Full workspace test commands. */
  fullCommands: readonly string[];
  verificationCommands: readonly string[];
  /** Per-workspace-package suggestions, when detectable. */
  packageCommands: readonly { packageName: string; commands: readonly string[] }[];
  riskAreas: readonly string[];
  confidence: number;
  explanation: string;
}

const TEST_PATTERNS: Array<(f: string) => string | null> = [
  (f) => /\.(spec|test)\.[jt]sx?$/.test(f) ? f : null,
  (f) => f.replace(/^src\//, 'tests/').replace(/\.(ts|tsx|js|jsx)$/, '.spec.$1'),
  (f) => f.replace(/^src\//, 'tests/').replace(/\.(ts|tsx|js|jsx)$/, '.test.$1'),
  (f) => f.replace(/\.([tj]s)$/, '.spec.$1'),
  (f) => f.replace(/\.([tj]s)$/, '.test.$1'),
  (f) => f.replace(/\.tsx$/, '.test.tsx'),
  (f) => f.replace(/\.tsx$/, '.spec.tsx'),
  (f) => {
    const parsed = nodePath.parse(f);
    if (!parsed.name) return null;
    return nodePath.join(parsed.dir, '__tests__', `${parsed.name}.test${parsed.ext}`);
  },
  (f) => {
    const parsed = nodePath.parse(f);
    if (!parsed.name) return null;
    return nodePath.join(parsed.dir, '__tests__', `${parsed.name}.spec${parsed.ext}`);
  },
];

function readPackageScripts(cwd: string): Record<string, string> {
  const pkg = nodePath.join(cwd, 'package.json');
  if (!existsSync(pkg)) return {};
  try {
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> })
      .scripts ?? {};
  } catch {
    return {};
  }
}

export function analyzeTestImpact(
  inspection: ISharkcraftInspection,
  input: ITestImpactInput,
): ITestImpact {
  const files = uniqueStrings(input.files ?? []);
  const task = input.task ?? files.join(' ');

  const likely = new Set<string>();
  const missing = new Set<string>();
  for (const f of files) {
    const candidates: string[] = [];
    for (const fn of TEST_PATTERNS) {
      const c = fn(f);
      if (c) candidates.push(c);
    }
    let any = false;
    for (const c of candidates) {
      if (existsSync(nodePath.join(inspection.projectRoot, c))) {
        likely.add(c);
        any = true;
      }
    }
    if (!any) {
      // Pick the most idiomatic candidate as the expected location.
      const expected = candidates[0] ?? f.replace(/\.(ts|tsx|js|jsx)$/, '.spec.$1');
      missing.add(expected);
    }
  }

  const scripts = readPackageScripts(inspection.projectRoot);
  const fullCommands: string[] = [];
  for (const k of ['test', 'test:unit', 'test:int', 'test:e2e']) {
    if (scripts[k]) fullCommands.push(`bun run ${k}`);
  }
  if (fullCommands.length === 0) fullCommands.push('bun test');

  // Minimal commands: target the specific test files we found on disk.
  const minimalCommands: string[] = [];
  if (likely.size > 0) {
    minimalCommands.push(`bun test ${[...likely].sort().join(' ')}`);
  } else if (files.length > 0) {
    // Nothing to target — fall back to the full suite.
    minimalCommands.push(...fullCommands);
  }

  const packageCommands = detectWorkspacePackageCommands(inspection.projectRoot, files);

  const testCommands = uniqueStrings([...minimalCommands, ...fullCommands]);

  const verificationCommands = uniqueStrings([
    ...testCommands,
    'bun x tsc -p tsconfig.base.json --noEmit',
    'shrk check boundaries',
  ]);

  const riskAreas: string[] = [];
  if (missing.size > 0) riskAreas.push('missing-tests');
  if (likely.size === 0 && files.length > 0) riskAreas.push('no-tests-found');

  const confidence = files.length === 0 ? 0 : Math.min(100, Math.round((likely.size / files.length) * 100));

  return {
    schema: TEST_IMPACT_SCHEMA,
    task,
    inputFiles: files,
    likelyTestFiles: [...likely].sort(),
    missingTestFiles: [...missing].sort(),
    testCommands,
    minimalCommands,
    fullCommands,
    packageCommands,
    verificationCommands,
    riskAreas,
    confidence,
    explanation: `${likely.size}/${files.length} input file(s) have an existing test on disk.`,
  };
}

function detectWorkspacePackageCommands(
  projectRoot: string,
  files: readonly string[],
): { packageName: string; commands: readonly string[] }[] {
  if (files.length === 0) return [];
  const pkgPath = nodePath.join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let workspaces: readonly string[] = [];
  try {
    const json = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      workspaces?: readonly string[] | { packages?: readonly string[] };
    };
    if (Array.isArray(json.workspaces)) workspaces = json.workspaces;
    else workspaces = (json.workspaces as { packages?: readonly string[] } | undefined)?.packages ?? [];
  } catch {
    return [];
  }
  // Identify touched packages by prefix.
  const touched = new Map<string, { packageName: string; commands: string[] }>();
  for (const pattern of workspaces) {
    const dir = pattern.replace(/\/\*?$/, '');
    for (const f of files) {
      if (!f.startsWith(dir + '/')) continue;
      // Find the immediate package dir.
      const rest = f.slice(dir.length + 1);
      const pkgDirName = rest.split('/')[0];
      if (!pkgDirName) continue;
      const pkgRoot = nodePath.join(projectRoot, dir, pkgDirName);
      const pkgFile = nodePath.join(pkgRoot, 'package.json');
      if (!existsSync(pkgFile)) continue;
      if (touched.has(pkgRoot)) continue;
      try {
        const pj = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
          name?: string;
          scripts?: Record<string, string>;
        };
        const name = pj.name ?? pkgDirName;
        const commands: string[] = [];
        if (pj.scripts?.['test']) commands.push(`bun --filter ${name} test`);
        if (pj.scripts?.['test:unit']) commands.push(`bun --filter ${name} run test:unit`);
        if (commands.length === 0) commands.push(`bun test ${pkgRoot}`);
        touched.set(pkgRoot, { packageName: name, commands });
      } catch {
        /* ignore */
      }
    }
  }
  return [...touched.values()];
}

export function suggestTestPathFor(file: string): string {
  // Most idiomatic suggestion for "where should this test live?".
  if (/\.tsx$/.test(file)) return file.replace(/\.tsx$/, '.test.tsx');
  if (file.startsWith('src/')) {
    return file.replace(/^src\//, 'tests/').replace(/\.([tj]s)$/, '.spec.$1');
  }
  return file.replace(/\.([tj]s)$/, '.spec.$1');
}

function uniqueStrings(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}
