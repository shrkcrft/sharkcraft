import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { WorkspaceProfile, type IWorkspaceSummary } from '@shrkcrft/workspace';

export interface IMonorepoPackage {
  /** Package root relative to project root, e.g. "apps/web", "packages/core". */
  path: string;
  /** Group the package belongs to (apps / packages / libs). */
  group: 'apps' | 'packages' | 'libs';
  /** Name from the package.json (when present). */
  name?: string;
  /** Detected scripts (test/build/lint/typecheck only). */
  scripts: Readonly<Record<string, string>>;
  /** Whether the package has its own tsconfig.json. */
  hasTsConfig: boolean;
}

export interface IMonorepoBoundaryCandidate {
  id: string;
  title: string;
  from: readonly string[];
  forbiddenImports: readonly string[];
  reason: string;
}

export interface IMonorepoVerificationHint {
  packagePath: string;
  /** Script id (e.g. test, lint). */
  script: string;
  /** Suggested command, e.g. "bun --cwd packages/core run test". */
  command: string;
}

export interface IMonorepoSummary {
  /** Project root (absolute). */
  rootPath: string;
  /** Manager-detected workspaces array from package.json (raw globs). */
  workspaces: readonly string[];
  /** All discovered apps. */
  apps: readonly IMonorepoPackage[];
  /** All discovered packages. */
  packages: readonly IMonorepoPackage[];
  /** All discovered libs. */
  libs: readonly IMonorepoPackage[];
  /** Recommended root-level verification commands (deduped). */
  rootVerificationCommands: readonly string[];
  /** Per-package verification hints. */
  perPackageVerificationHints: readonly IMonorepoVerificationHint[];
  /** Layer/group boundary candidates derived from the layout. */
  boundaryCandidates: readonly IMonorepoBoundaryCandidate[];
  /** Preset ids worth recommending for a monorepo root. */
  presetRecommendations: readonly string[];
  /** Short narrative summary lines. */
  notes: readonly string[];
}

const PACKAGE_LIMIT = 30;

const GROUPS: Array<{ key: 'apps' | 'packages' | 'libs'; dir: string }> = [
  { key: 'apps', dir: 'apps' },
  { key: 'packages', dir: 'packages' },
  { key: 'libs', dir: 'libs' },
];

const TRACKED_SCRIPTS = new Set([
  'test',
  'test:unit',
  'test:int',
  'lint',
  'build',
  'typecheck',
]);

export function buildMonorepoSummary(
  ws: IWorkspaceSummary,
  subDirs: ReadonlyMap<string, readonly string[]>,
): IMonorepoSummary | null {
  const isMonorepo =
    ws.profiles.includes(WorkspaceProfile.IsMonorepo) ||
    ws.profiles.includes(WorkspaceProfile.HasPackageWorkspaces) ||
    ws.profiles.includes(WorkspaceProfile.HasNx);
  if (!isMonorepo) return null;

  const workspaces =
    (ws.raw.packageJson as { workspaces?: unknown } | null)?.workspaces;
  const workspacesArr: string[] = Array.isArray(workspaces)
    ? workspaces.filter((w): w is string => typeof w === 'string')
    : [];

  const groups: Record<'apps' | 'packages' | 'libs', IMonorepoPackage[]> = {
    apps: [],
    packages: [],
    libs: [],
  };
  let scanned = 0;
  for (const g of GROUPS) {
    const children = subDirs.get(g.dir) ?? [];
    for (const child of children) {
      if (scanned >= PACKAGE_LIMIT) break;
      const rel = nodePath.posix.join(g.dir, child);
      const full = nodePath.join(ws.projectRoot, g.dir, child);
      if (!statSafeIsDir(full)) continue;
      groups[g.key].push(describePackage(full, rel, g.key));
      scanned += 1;
    }
  }

  const rootVerificationCommands = buildRootVerificationCommands(ws);
  const perPackageVerificationHints: IMonorepoVerificationHint[] = [];
  for (const list of Object.values(groups)) {
    for (const p of list) {
      for (const [name, value] of Object.entries(p.scripts)) {
        if (!TRACKED_SCRIPTS.has(name)) continue;
        if (typeof value !== 'string' || !value) continue;
        perPackageVerificationHints.push({
          packagePath: p.path,
          script: name,
          command: buildPackageRunCommand(ws, p.path, name),
        });
      }
    }
  }

  const boundaryCandidates = buildBoundaryCandidates(groups);
  const presetRecommendations = buildPresetRecommendations(ws);
  const notes = buildNotes(ws, groups);

  return {
    rootPath: ws.projectRoot,
    workspaces: workspacesArr,
    apps: groups.apps,
    packages: groups.packages,
    libs: groups.libs,
    rootVerificationCommands,
    perPackageVerificationHints,
    boundaryCandidates,
    presetRecommendations,
    notes,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function statSafeIsDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function describePackage(
  full: string,
  rel: string,
  group: 'apps' | 'packages' | 'libs',
): IMonorepoPackage {
  const pkgJsonPath = nodePath.join(full, 'package.json');
  let name: string | undefined;
  const scripts: Record<string, string> = {};
  let hasTsConfig = false;
  if (existsSync(pkgJsonPath)) {
    try {
      const raw = readFileSync(pkgJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        name?: string;
        scripts?: Record<string, string>;
      };
      if (typeof parsed.name === 'string') name = parsed.name;
      if (parsed.scripts) {
        for (const [k, v] of Object.entries(parsed.scripts)) {
          if (typeof v === 'string') scripts[k] = v;
        }
      }
    } catch {
      // Ignore unreadable JSON — we still emit the package entry.
    }
  }
  hasTsConfig = existsSync(nodePath.join(full, 'tsconfig.json'));
  // Optional: probe for a src/ folder marker.
  try {
    readdirSync(full);
  } catch {
    // ignore
  }
  return {
    path: rel,
    group,
    ...(name ? { name } : {}),
    scripts,
    hasTsConfig,
  };
}

function buildRootVerificationCommands(ws: IWorkspaceSummary): string[] {
  const out: string[] = [];
  const runner = pickRunner(ws);
  for (const name of ['test', 'typecheck', 'lint', 'build']) {
    const v = ws.scripts[name];
    if (typeof v === 'string' && v.length > 0) {
      out.push(`${runner} ${name}`);
    }
  }
  if (out.length === 0) {
    // Even with no scripts, suggest the deterministic checks the engine knows
    // about so the user has *something* to run.
    out.push('bun x tsc -p tsconfig.base.json --noEmit');
    out.push('shrk doctor');
    out.push('shrk check boundaries');
  }
  return [...new Set(out)];
}

function buildPackageRunCommand(
  ws: IWorkspaceSummary,
  pkgPath: string,
  script: string,
): string {
  // We do not assume a specific monorepo runner. Emit a `--cwd` invocation
  // when the manager supports it; otherwise emit a doc-friendly fallback.
  switch (ws.packageManager.manager) {
    case 'bun':
      return `bun --cwd ${pkgPath} run ${script}`;
    case 'pnpm':
      return `pnpm --filter ./${pkgPath} run ${script}`;
    case 'yarn':
      return `yarn workspace ${pkgPath} ${script}`;
    case 'npm':
      return `npm run ${script} --workspace ${pkgPath}`;
    default:
      return `(cd ${pkgPath} && npm run ${script})`;
  }
}

function pickRunner(ws: IWorkspaceSummary): string {
  switch (ws.packageManager.manager) {
    case 'bun':
      return 'bun run';
    case 'pnpm':
      return 'pnpm';
    case 'yarn':
      return 'yarn';
    case 'npm':
      return 'npm run';
    default:
      return 'npm run';
  }
}

function buildBoundaryCandidates(
  groups: Record<'apps' | 'packages' | 'libs', IMonorepoPackage[]>,
): IMonorepoBoundaryCandidate[] {
  const out: IMonorepoBoundaryCandidate[] = [];
  // Standard rule: packages/* should not import from apps/*.
  if (groups.packages.length > 0 && groups.apps.length > 0) {
    out.push({
      id: 'architecture.packages.no-imports-from-apps',
      title: 'packages/* must not import from apps/*',
      from: ['packages/**'],
      forbiddenImports: ['apps/**'],
      reason: 'packages/ + apps/ both present; packages depending on apps inverts the expected dependency direction',
    });
  }
  // Standard rule: libs/* should not import from apps/*.
  if (groups.libs.length > 0 && groups.apps.length > 0) {
    out.push({
      id: 'architecture.libs.no-imports-from-apps',
      title: 'libs/* must not import from apps/*',
      from: ['libs/**'],
      forbiddenImports: ['apps/**'],
      reason: 'libs/ + apps/ both present; libs depending on apps inverts the expected dependency direction',
    });
  }
  return out;
}

function buildPresetRecommendations(ws: IWorkspaceSummary): string[] {
  const out: string[] = [];
  // Nothing fancy: hint to use 'nx-style' / 'monorepo' presets when available.
  // The actual preset picker still runs via `recommendPresets`; this is the
  // monorepo-flavored recommendation list shown alongside it.
  if (ws.profiles.includes(WorkspaceProfile.HasNx)) {
    out.push('nx-monorepo');
  } else if (ws.profiles.includes(WorkspaceProfile.HasPackageWorkspaces)) {
    out.push('package-workspaces');
  } else {
    out.push('generic-monorepo');
  }
  return out;
}

function buildNotes(
  ws: IWorkspaceSummary,
  groups: Record<'apps' | 'packages' | 'libs', IMonorepoPackage[]>,
): string[] {
  const out: string[] = [];
  const counts = [
    groups.apps.length > 0 ? `${groups.apps.length} app(s)` : null,
    groups.packages.length > 0 ? `${groups.packages.length} package(s)` : null,
    groups.libs.length > 0 ? `${groups.libs.length} lib(s)` : null,
  ].filter((s): s is string => s !== null);
  if (counts.length > 0) {
    out.push(`Detected monorepo layout: ${counts.join(', ')}.`);
  }
  if (ws.profiles.includes(WorkspaceProfile.HasNx)) {
    out.push('Nx workspace detected — preset suggestions reflect Nx conventions.');
  }
  if (ws.profiles.includes(WorkspaceProfile.HasPackageWorkspaces)) {
    out.push('package.json workspaces detected.');
  }
  if (groups.apps.length === 0 && groups.packages.length === 0 && groups.libs.length === 0) {
    out.push('Monorepo signals detected but no apps/packages/libs directories — keep onboarding bounded.');
  }
  return out;
}
