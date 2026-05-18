/**
 * `shrk map` — high-level repository overview.
 *
 * Read-only structural snapshot intended for humans and agents to gain a
 * 30-second understanding of "what is this repo". Sources its data from
 * the existing inspection so it never re-walks the filesystem from scratch.
 *
 * The map is deterministic: given the same project, two consecutive calls
 * produce the same output (modulo `generatedAt`).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const REPOSITORY_MAP_SCHEMA = 'sharkcraft.repository-map/v1';

export type MapFormat = 'text' | 'markdown' | 'html' | 'json';
export type MapInclude =
  | 'constructs'
  | 'boundaries'
  | 'packages'
  | 'apps'
  | 'docs'
  | 'tests'
  | 'scripts'
  | 'all';

export interface IRepositoryMapPackage {
  name: string;
  path: string;
  kind: 'package' | 'app' | 'example';
  hasDist: boolean;
  hasTests: boolean;
}

export interface IRepositoryMapConstruct {
  kind: string;
  count: number;
}

export interface IRepositoryMap {
  schema: typeof REPOSITORY_MAP_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  rootSummary: {
    name: string;
    version: string;
    private: boolean;
    description: string;
    packageManager: string;
  };
  detectedProfiles: readonly string[];
  workspaces: readonly string[];
  packages: readonly IRepositoryMapPackage[];
  apps: readonly IRepositoryMapPackage[];
  examples: readonly IRepositoryMapPackage[];
  importantFolders: readonly { path: string; purpose: string }[];
  constructs: readonly IRepositoryMapConstruct[];
  boundariesCount: number;
  policiesCount: number;
  docsCount: number;
  testsCount: number;
  scriptsCount: number;
  pathConventions: readonly { id: string; pattern: string }[];
  ownershipSummary: { areas: number; rules: number };
  recommendedFirstCommands: readonly string[];
  /** Per-language file counts (typescript, java, python, go, rust, csharp, javascript). */
  languageCounts?: Readonly<Record<string, number>>;
}

interface IRootSummary {
  name: string;
  version: string;
  private: boolean;
  description: string;
  packageManager: string;
}

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function summarizeRoot(projectRoot: string): IRootSummary {
  const pkg = readJsonSafe<{
    name?: string;
    version?: string;
    private?: boolean;
    description?: string;
    packageManager?: string;
  }>(nodePath.join(projectRoot, 'package.json'));
  return {
    name: pkg?.name ?? '(unknown)',
    version: pkg?.version ?? '0.0.0',
    private: pkg?.private === true,
    description: pkg?.description ?? '',
    packageManager: pkg?.packageManager ?? 'bun',
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function describePackage(absDir: string, projectRoot: string): IRepositoryMapPackage | null {
  const pkg = readJsonSafe<{ name?: string }>(nodePath.join(absDir, 'package.json'));
  if (!pkg) return null;
  const hasDist = existsSync(nodePath.join(absDir, 'dist'));
  const hasTests =
    existsSync(nodePath.join(absDir, 'src', '__tests__')) ||
    existsSync(nodePath.join(absDir, 'tests')) ||
    existsSync(nodePath.join(absDir, 'test'));
  const rel = nodePath.relative(projectRoot, absDir);
  const isApp = rel.startsWith('apps/');
  const isExample = rel.startsWith('examples/');
  return {
    name: pkg.name ?? rel,
    path: rel,
    kind: isApp ? 'app' : isExample ? 'example' : 'package',
    hasDist,
    hasTests,
  };
}

function listWorkspacePackages(projectRoot: string): IRepositoryMapPackage[] {
  const out: IRepositoryMapPackage[] = [];
  for (const root of ['packages', 'apps', 'examples']) {
    const dir = nodePath.join(projectRoot, root);
    if (!existsSync(dir)) continue;
    for (const entry of safeReaddir(dir)) {
      const full = nodePath.join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      const p = describePackage(full, projectRoot);
      if (p) out.push(p);
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function countDirEntries(dir: string, pred: (entry: string) => boolean): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of safeReaddir(dir)) {
    if (pred(entry)) n += 1;
  }
  return n;
}

function listImportantFolders(projectRoot: string): { path: string; purpose: string }[] {
  const out: { path: string; purpose: string }[] = [];
  const known: { dir: string; purpose: string }[] = [
    { dir: 'packages', purpose: 'monorepo libraries' },
    { dir: 'apps', purpose: 'deployable applications' },
    { dir: 'examples', purpose: 'consumer-style integration fixtures' },
    { dir: 'docs', purpose: 'human-readable reference' },
    { dir: 'scripts', purpose: 'release / build / lint tooling' },
    { dir: 'sharkcraft', purpose: 'SharkCraft configuration + asset registries' },
    { dir: 'e2e', purpose: 'end-to-end tests (Playwright)' },
    { dir: '.sharkcraft', purpose: 'cached SharkCraft state (bundles, sessions, reports)' },
  ];
  for (const k of known) {
    if (existsSync(nodePath.join(projectRoot, k.dir))) out.push({ path: k.dir, purpose: k.purpose });
  }
  return out;
}

export interface IBuildRepositoryMapOptions {
  include?: readonly MapInclude[];
}

export async function buildRepositoryMap(
  inspection: ISharkcraftInspection,
  options: IBuildRepositoryMapOptions = {},
): Promise<IRepositoryMap> {
  const projectRoot = inspection.projectRoot;
  const include = options.include && options.include.length > 0 ? options.include : (['all'] as MapInclude[]);
  const wantAll = include.includes('all');
  const want = (key: MapInclude): boolean => wantAll || include.includes(key);
  const root = summarizeRoot(projectRoot);
  const allPackages = listWorkspacePackages(projectRoot);
  const packages = want('packages') ? allPackages.filter((p) => p.kind === 'package') : [];
  const apps = want('apps') ? allPackages.filter((p) => p.kind === 'app') : [];
  const examples = want('packages') ? allPackages.filter((p) => p.kind === 'example') : [];
  const docsDir = nodePath.join(projectRoot, 'docs');
  const scriptsDir = nodePath.join(projectRoot, 'scripts');
  const constructs: IRepositoryMapConstruct[] = [];
  const paths = inspection.pathService?.list?.() ?? [];
  const presets = inspection.presetRegistry?.list?.() ?? [];
  const boundaries = inspection.boundaryRegistry?.list?.() ?? [];
  if (want('constructs')) {
    constructs.push({ kind: 'rule', count: inspection.knowledgeEntries.length });
    constructs.push({ kind: 'template', count: inspection.templates.length });
    constructs.push({ kind: 'pipeline', count: inspection.pipelines.length });
    constructs.push({ kind: 'path', count: paths.length });
    constructs.push({ kind: 'preset', count: presets.length });
    constructs.push({ kind: 'pack', count: inspection.packs?.discoveredPacks?.length ?? 0 });
  }
  const pathConventions = paths.slice(0, 12).map((p) => ({
    id: p.id,
    pattern: ((p as { pattern?: string }).pattern ?? p.id) as string,
  }));
  const importantFolders = listImportantFolders(projectRoot);
  const recommendedFirstCommands = [
    'shrk start-here',
    'shrk doctor',
    'shrk commands primary',
    'shrk brief "<task>"',
    'shrk release readiness',
  ];
  const frameworks = (inspection.workspace?.frameworks ?? []).map((f) =>
    ((f as { id?: string; label?: string }).id ?? (f as { label?: string }).label ?? ''),
  ).filter(Boolean);
  const workspaces = readJsonSafe<{ workspaces?: string[] }>(nodePath.join(projectRoot, 'package.json'))?.workspaces ?? [];
  // Language counts overlay. Best-effort — failure does not break the map.
  let languageCounts: Record<string, number> | undefined;
  try {
    const { detectLanguageProfiles } = await import('./languages/index.ts');
    const profiles = detectLanguageProfiles(projectRoot);
    languageCounts = {};
    for (const p of profiles.profiles) languageCounts[p.language] = p.fileCount;
  } catch {
    languageCounts = undefined;
  }
  return {
    schema: REPOSITORY_MAP_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    rootSummary: root,
    detectedProfiles: frameworks as readonly string[],
    workspaces: workspaces as readonly string[],
    packages,
    apps,
    examples,
    importantFolders,
    constructs,
    boundariesCount: boundaries.length,
    policiesCount: 0,
    docsCount: want('docs')
      ? countDirEntries(docsDir, (e) => e.endsWith('.md'))
      : 0,
    testsCount: want('tests')
      ? allPackages.filter((p) => p.hasTests).length
      : 0,
    scriptsCount: want('scripts')
      ? countDirEntries(scriptsDir, (e) => e.endsWith('.ts') || e.endsWith('.js'))
      : 0,
    pathConventions,
    ownershipSummary: {
      areas: 0,
      rules: inspection.knowledgeEntries.length,
    },
    recommendedFirstCommands,
    ...(languageCounts ? { languageCounts } : {}),
  };
}

export function renderRepositoryMapText(map: IRepositoryMap): string {
  const lines: string[] = [];
  lines.push(`# Repository map — ${map.rootSummary.name} @ ${map.rootSummary.version}`);
  lines.push('');
  lines.push(`Description: ${map.rootSummary.description}`);
  lines.push(`Package manager: ${map.rootSummary.packageManager}`);
  lines.push(`Profiles: ${map.detectedProfiles.join(', ') || '(none detected)'}`);
  lines.push('');
  lines.push('## Workspaces');
  for (const ws of map.workspaces) lines.push(`  - ${ws}`);
  if (map.workspaces.length === 0) lines.push('  (none)');
  lines.push('');
  lines.push(`## Packages (${map.packages.length})`);
  for (const p of map.packages) lines.push(`  - ${p.name}  [${p.path}]${p.hasDist ? ' dist' : ''}${p.hasTests ? ' tests' : ''}`);
  if (map.apps.length > 0) {
    lines.push('');
    lines.push(`## Apps (${map.apps.length})`);
    for (const p of map.apps) lines.push(`  - ${p.name}  [${p.path}]`);
  }
  if (map.examples.length > 0) {
    lines.push('');
    lines.push(`## Examples (${map.examples.length})`);
    for (const p of map.examples) lines.push(`  - ${p.name}  [${p.path}]`);
  }
  lines.push('');
  lines.push('## Important folders');
  for (const f of map.importantFolders) lines.push(`  - ${f.path}/  — ${f.purpose}`);
  lines.push('');
  lines.push('## Constructs');
  for (const c of map.constructs) lines.push(`  - ${c.kind}: ${c.count}`);
  lines.push(`  - boundaries: ${map.boundariesCount}`);
  lines.push(`  - policies: ${map.policiesCount}`);
  lines.push(`  - docs: ${map.docsCount}`);
  lines.push(`  - scripts: ${map.scriptsCount}`);
  lines.push('');
  if (map.pathConventions.length > 0) {
    lines.push('## Path conventions');
    for (const p of map.pathConventions) lines.push(`  - ${p.id}: ${p.pattern}`);
    lines.push('');
  }
  lines.push('## Recommended first commands');
  for (const c of map.recommendedFirstCommands) lines.push(`  $ ${c}`);
  return lines.join('\n') + '\n';
}

export function renderRepositoryMapMarkdown(map: IRepositoryMap): string {
  const lines: string[] = [];
  lines.push(`# Repository map — \`${map.rootSummary.name}\` @ \`${map.rootSummary.version}\``);
  lines.push('');
  lines.push(`> ${map.rootSummary.description}`);
  lines.push('');
  lines.push(`- **Package manager:** \`${map.rootSummary.packageManager}\``);
  lines.push(`- **Profiles:** ${map.detectedProfiles.join(', ') || '_none detected_'}`);
  lines.push(`- **Workspaces:** ${map.workspaces.join(', ') || '_none_'}`);
  lines.push('');
  lines.push('## Packages');
  for (const p of map.packages) {
    lines.push(`- \`${p.name}\` — \`${p.path}\`${p.hasDist ? ' · dist' : ''}${p.hasTests ? ' · tests' : ''}`);
  }
  if (map.apps.length > 0) {
    lines.push('');
    lines.push('## Apps');
    for (const p of map.apps) lines.push(`- \`${p.name}\` — \`${p.path}\``);
  }
  if (map.examples.length > 0) {
    lines.push('');
    lines.push('## Examples');
    for (const p of map.examples) lines.push(`- \`${p.name}\` — \`${p.path}\``);
  }
  lines.push('');
  lines.push('## Important folders');
  for (const f of map.importantFolders) lines.push(`- \`${f.path}/\` — ${f.purpose}`);
  lines.push('');
  lines.push('## Constructs');
  for (const c of map.constructs) lines.push(`- ${c.kind}: ${c.count}`);
  lines.push(`- boundaries: ${map.boundariesCount}`);
  lines.push(`- policies: ${map.policiesCount}`);
  lines.push(`- docs: ${map.docsCount}`);
  lines.push(`- scripts: ${map.scriptsCount}`);
  lines.push('');
  lines.push('## Recommended first commands');
  for (const c of map.recommendedFirstCommands) lines.push(`\n\`\`\`bash\n${c}\n\`\`\``);
  return lines.join('\n') + '\n';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderRepositoryMapHtml(map: IRepositoryMap): string {
  const out: string[] = [];
  out.push('<!doctype html><html><head><meta charset="utf-8"><title>Repository map</title>');
  out.push('<style>');
  out.push('body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#1a1a1a;background:#fff}');
  out.push('h1{font-size:22px}h2{font-size:16px;margin-top:24px;border-bottom:1px solid #e1e4e8;padding-bottom:4px}');
  out.push('.muted{color:#586069}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}');
  out.push('table{border-collapse:collapse}td,th{padding:4px 10px;border:1px solid #d0d7de}');
  out.push('@media (prefers-color-scheme: dark){body{background:#0d1117;color:#c9d1d9}th{background:#161b22}.muted{color:#8b949e}}');
  out.push('</style></head><body>');
  out.push(`<h1>${esc(map.rootSummary.name)} <span class="muted">@ ${esc(map.rootSummary.version)}</span></h1>`);
  out.push(`<p class="muted">${esc(map.rootSummary.description)}</p>`);
  out.push('<h2>Packages</h2><ul>');
  for (const p of map.packages) out.push(`<li><code>${esc(p.name)}</code> — <code>${esc(p.path)}</code></li>`);
  out.push('</ul>');
  out.push('<h2>Constructs</h2><ul>');
  for (const c of map.constructs) out.push(`<li>${esc(c.kind)}: ${c.count}</li>`);
  out.push(`<li>boundaries: ${map.boundariesCount}</li>`);
  out.push(`<li>policies: ${map.policiesCount}</li>`);
  out.push('</ul>');
  out.push('<h2>Important folders</h2><ul>');
  for (const f of map.importantFolders) out.push(`<li><code>${esc(f.path)}/</code> — ${esc(f.purpose)}</li>`);
  out.push('</ul>');
  out.push('<h2>Recommended first commands</h2><ul>');
  for (const c of map.recommendedFirstCommands) out.push(`<li><code>${esc(c)}</code></li>`);
  out.push('</ul></body></html>');
  return out.join('\n') + '\n';
}

export function renderRepositoryMap(map: IRepositoryMap, format: MapFormat): string {
  if (format === 'json') return JSON.stringify(map, null, 2) + '\n';
  if (format === 'markdown') return renderRepositoryMapMarkdown(map);
  if (format === 'html') return renderRepositoryMapHtml(map);
  return renderRepositoryMapText(map);
}
