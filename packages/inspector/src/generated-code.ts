import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { findFiles } from '@shrkcrft/workspace';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const GENERATED_CODE_SCHEMA = 'sharkcraft.generated-code/v1';

export enum GeneratedConfidence {
  High = 'high',
  Medium = 'medium',
  Low = 'low',
}

export enum GeneratedKind {
  Marker = 'marker',
  OpenApi = 'openapi',
  GraphQL = 'graphql',
  Protobuf = 'protobuf',
  PrismaClient = 'prisma-client',
  AngularEnv = 'angular-environment',
  AngularRouter = 'angular-router',
  Dist = 'dist',
  Lockfile = 'lockfile',
  Vendor = 'vendor',
  Snapshot = 'snapshot',
  /** Per-language markers. */
  JavaGenerated = 'java-generated',
  CSharpGenerated = 'csharp-generated',
  PythonGenerated = 'python-generated',
  GoGenerated = 'go-generated',
  RustGenerated = 'rust-generated',
  Unknown = 'unknown',
}

/** Scan depth selector for generated-code detection. */
export enum GeneratedScanDepth {
  /** 4096 bytes / 30 lines per file, 600 files (existing default). */
  Standard = 'standard',
  /** 16384 bytes / 200 lines per file, 2000 files. */
  Deep = 'deep',
  /** 65536 bytes / capped full scan per file, 5000 files. */
  Extreme = 'extreme',
}

export interface IGeneratedFileEntry {
  path: string;
  kind: GeneratedKind;
  confidence: GeneratedConfidence;
  reason: string;
  markerLine?: number;
}

export interface IGeneratedRoot {
  /** Project-relative path of the directory. */
  path: string;
  kind: GeneratedKind;
  confidence: GeneratedConfidence;
  reason: string;
  /** Number of generated files detected under this root. */
  fileCount: number;
}

export interface IProtectedRule {
  id: string;
  title: string;
  content: string;
  /** Path globs the rule applies to. */
  patterns: readonly string[];
  reason: string;
}

export interface IRecommendedGeneratedPolicy {
  id: string;
  title: string;
  description: string;
  /** Suggested policy id / file in sharkcraft/policies.ts */
  suggestedId: string;
  patterns: readonly string[];
  reason: string;
}

export interface IGeneratedCodeReport {
  schema: typeof GENERATED_CODE_SCHEMA;
  projectRoot: string;
  generatedFiles: readonly IGeneratedFileEntry[];
  handwrittenFiles: readonly string[];
  mixedFiles: readonly string[];
  generatedRoots: readonly IGeneratedRoot[];
  protectedRules: readonly IProtectedRule[];
  recommendedPolicyRules: readonly IRecommendedGeneratedPolicy[];
  /** Total files scanned. */
  filesScanned: number;
  /** Limitations / sampling notes. */
  limitations: readonly string[];
}

export interface IBuildGeneratedCodeReportOptions {
  inspection: ISharkcraftInspection;
  /** Max files to peek at for header markers. Default 600 (overrides depth). */
  fileScanLimit?: number;
  /** Max bytes per file head read. Default 4096 (overrides depth). */
  headBytes?: number;
  /** Convenience selector — sets sensible scan limit/head bytes/line count. Default `standard`. */
  depth?: GeneratedScanDepth;
}

const DEFAULT_SCAN_LIMIT = 600;
const DEFAULT_HEAD_BYTES = 4096;
const DEFAULT_HEAD_LINES = 30;

const DEPTH_LIMITS: Readonly<Record<GeneratedScanDepth, { scanLimit: number; headBytes: number; headLines: number }>> = {
  [GeneratedScanDepth.Standard]: { scanLimit: 600, headBytes: 4096, headLines: 30 },
  [GeneratedScanDepth.Deep]: { scanLimit: 2000, headBytes: 16384, headLines: 200 },
  [GeneratedScanDepth.Extreme]: { scanLimit: 5000, headBytes: 65536, headLines: 600 },
};

const GENERATED_DIR_HINTS: ReadonlyArray<{
  re: RegExp;
  kind: GeneratedKind;
  confidence: GeneratedConfidence;
  reason: string;
}> = [
  { re: /(^|\/)dist(\/|$)/, kind: GeneratedKind.Dist, confidence: GeneratedConfidence.High, reason: 'Compiled build output directory.' },
  { re: /(^|\/)build(\/|$)/, kind: GeneratedKind.Dist, confidence: GeneratedConfidence.Medium, reason: 'Common build output directory.' },
  { re: /(^|\/)out(\/|$)/, kind: GeneratedKind.Dist, confidence: GeneratedConfidence.Low, reason: 'Sometimes a build output directory.' },
  { re: /(^|\/)\.next(\/|$)/, kind: GeneratedKind.Dist, confidence: GeneratedConfidence.High, reason: 'Next.js build output.' },
  { re: /(^|\/)\.nuxt(\/|$)/, kind: GeneratedKind.Dist, confidence: GeneratedConfidence.High, reason: 'Nuxt build output.' },
  { re: /(^|\/)\.angular(\/|$)/, kind: GeneratedKind.Dist, confidence: GeneratedConfidence.High, reason: 'Angular CLI cache output.' },
  { re: /(^|\/)\.svelte-kit(\/|$)/, kind: GeneratedKind.Dist, confidence: GeneratedConfidence.High, reason: 'SvelteKit build output.' },
  { re: /(^|\/)coverage(\/|$)/, kind: GeneratedKind.Snapshot, confidence: GeneratedConfidence.High, reason: 'Test coverage report.' },
  { re: /(^|\/)__snapshots__(\/|$)/, kind: GeneratedKind.Snapshot, confidence: GeneratedConfidence.High, reason: 'Test snapshots — auto-managed by the test runner.' },
  { re: /(^|\/)generated(\/|$)/, kind: GeneratedKind.Marker, confidence: GeneratedConfidence.High, reason: 'Folder explicitly named generated.' },
  { re: /(^|\/)__generated__(\/|$)/, kind: GeneratedKind.Marker, confidence: GeneratedConfidence.High, reason: 'Folder explicitly named __generated__.' },
  { re: /(^|\/)gen(\/|$)/, kind: GeneratedKind.Marker, confidence: GeneratedConfidence.Medium, reason: 'Folder named gen (often a generated code root).' },
  // Per-language generated source roots.
  { re: /(^|\/)target\/generated-sources(\/|$)/, kind: GeneratedKind.JavaGenerated, confidence: GeneratedConfidence.High, reason: 'Maven generated-sources root.' },
  { re: /(^|\/)target\/generated-test-sources(\/|$)/, kind: GeneratedKind.JavaGenerated, confidence: GeneratedConfidence.High, reason: 'Maven generated-test-sources root.' },
  { re: /(^|\/)build\/generated(\/|$)/, kind: GeneratedKind.JavaGenerated, confidence: GeneratedConfidence.High, reason: 'Gradle build/generated root.' },
  { re: /(^|\/)obj(\/|$)/, kind: GeneratedKind.CSharpGenerated, confidence: GeneratedConfidence.High, reason: 'C# obj/ build artifacts.' },
  { re: /(^|\/)\.openapi-generator(\/|$)/, kind: GeneratedKind.OpenApi, confidence: GeneratedConfidence.High, reason: 'OpenAPI generator cache.' },
  { re: /(^|\/)prisma\/generated(\/|$)/, kind: GeneratedKind.PrismaClient, confidence: GeneratedConfidence.High, reason: 'Prisma generated client root.' },
  { re: /(^|\/)proto(\/|$)/, kind: GeneratedKind.Protobuf, confidence: GeneratedConfidence.Medium, reason: 'Proto-buffers folder.' },
  { re: /(^|\/)graphql(\/|$)/, kind: GeneratedKind.GraphQL, confidence: GeneratedConfidence.Low, reason: 'May contain generated GraphQL types.' },
  { re: /node_modules(\/|$)/, kind: GeneratedKind.Vendor, confidence: GeneratedConfidence.High, reason: 'Vendored dependency tree — never hand-edit.' },
  { re: /\.nx\/cache(\/|$)/, kind: GeneratedKind.Dist, confidence: GeneratedConfidence.High, reason: 'Nx cache.' },
];

const LOCKFILES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
]);

const ENV_FILE_RE = /(^|\/)src\/environments\/environment(\.[^/]+)?\.ts$/;
const ANGULAR_ROUTES_GEN_RE = /(^|\/)\.angular\//;

const FILE_MARKERS: ReadonlyArray<{
  re: RegExp;
  kind: GeneratedKind;
  reason: string;
  /** Only apply this marker when the file's extension matches. */
  ext?: readonly string[];
}> = [
  { re: /\bDO NOT EDIT\b/i, kind: GeneratedKind.Marker, reason: '"DO NOT EDIT" header.' },
  { re: /@generated\b/i, kind: GeneratedKind.Marker, reason: '@generated marker.' },
  { re: /auto-?generated/i, kind: GeneratedKind.Marker, reason: '"auto-generated" header.' },
  { re: /\bgenerated by\b/i, kind: GeneratedKind.Marker, reason: '"generated by ..." attribution.' },
  { re: /this file was automatically generated/i, kind: GeneratedKind.Marker, reason: 'Auto-generation banner.' },
  { re: /Code generated by .*; DO NOT EDIT/i, kind: GeneratedKind.GoGenerated, reason: 'Go-style generated banner.', ext: ['.go'] },
  { re: /openapi-generator/i, kind: GeneratedKind.OpenApi, reason: 'OpenAPI generator banner.' },
  { re: /swagger-codegen/i, kind: GeneratedKind.OpenApi, reason: 'Swagger codegen banner.' },
  { re: /graphql-code-generator/i, kind: GeneratedKind.GraphQL, reason: 'graphql-codegen banner.' },
  { re: /protoc-gen-/i, kind: GeneratedKind.Protobuf, reason: 'protoc-gen banner.' },
  { re: /prisma-client-js/i, kind: GeneratedKind.PrismaClient, reason: 'Prisma client banner.' },
  // Per-language markers.
  { re: /@javax\.annotation\.Generated\b/, kind: GeneratedKind.JavaGenerated, reason: 'javax.annotation.Generated annotation.', ext: ['.java'] },
  { re: /@jakarta\.annotation\.Generated\b/, kind: GeneratedKind.JavaGenerated, reason: 'jakarta.annotation.Generated annotation.', ext: ['.java'] },
  { re: /@Generated\s*\(/, kind: GeneratedKind.JavaGenerated, reason: 'Java @Generated annotation.', ext: ['.java'] },
  { re: /\[GeneratedCode\s*\(/i, kind: GeneratedKind.CSharpGenerated, reason: '[GeneratedCode] attribute.', ext: ['.cs'] },
  { re: /<auto-generated[^>]*>/i, kind: GeneratedKind.CSharpGenerated, reason: '<auto-generated/> doc comment.', ext: ['.cs'] },
  { re: /^\s*#\s*@generated\b/m, kind: GeneratedKind.PythonGenerated, reason: 'Python @generated comment.', ext: ['.py'] },
  { re: /generated by protoc/i, kind: GeneratedKind.Protobuf, reason: 'protoc generated banner.' },
  { re: /generated by bindgen/i, kind: GeneratedKind.RustGenerated, reason: 'rust-bindgen generated banner.', ext: ['.rs'] },
];

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.py', '.rs', '.cs', '.java', '.kt', '.swift', '.proto', '.graphql', '.gql']);

export function buildGeneratedCodeReport(
  options: IBuildGeneratedCodeReportOptions,
): IGeneratedCodeReport {
  const inspection = options.inspection;
  const depth = options.depth ?? GeneratedScanDepth.Standard;
  const depthLimits = DEPTH_LIMITS[depth];
  const scanLimit = options.fileScanLimit ?? depthLimits.scanLimit;
  const headBytes = options.headBytes ?? depthLimits.headBytes;
  const headLines = depthLimits.headLines;
  const projectRoot = inspection.projectRoot;
  const limitations: string[] = [];

  const generatedFiles: IGeneratedFileEntry[] = [];
  const handwrittenFiles: string[] = [];
  const mixedFiles: string[] = [];

  const rootCounts = new Map<string, IGeneratedRoot>();

  const recordRoot = (
    path: string,
    kind: GeneratedKind,
    confidence: GeneratedConfidence,
    reason: string,
  ): void => {
    const key = `${path}|${kind}`;
    const prev = rootCounts.get(key);
    if (prev) {
      rootCounts.set(key, { ...prev, fileCount: prev.fileCount + 1 });
      return;
    }
    rootCounts.set(key, { path, kind, confidence, reason, fileCount: 1 });
  };

  let scanned = 0;
  const files = enumerateRepoFiles(inspection);
  for (const file of files) {
    const rel = file;
    const abs = nodePath.isAbsolute(rel) ? rel : nodePath.join(projectRoot, rel);

    // Lockfiles + Angular environment.
    const base = nodePath.basename(rel);
    if (LOCKFILES.has(base)) {
      generatedFiles.push({
        path: rel,
        kind: GeneratedKind.Lockfile,
        confidence: GeneratedConfidence.High,
        reason: 'Package-manager lockfile.',
      });
      recordRoot(nodePath.dirname(rel), GeneratedKind.Lockfile, GeneratedConfidence.High, 'Lockfile location.');
      continue;
    }
    if (ENV_FILE_RE.test(rel)) {
      generatedFiles.push({
        path: rel,
        kind: GeneratedKind.AngularEnv,
        confidence: GeneratedConfidence.Medium,
        reason: 'Angular environment file (often substituted at build time).',
      });
      continue;
    }
    if (ANGULAR_ROUTES_GEN_RE.test(rel)) {
      generatedFiles.push({
        path: rel,
        kind: GeneratedKind.AngularRouter,
        confidence: GeneratedConfidence.High,
        reason: 'Under .angular/ build directory.',
      });
      continue;
    }

    let matchedDir: { kind: GeneratedKind; confidence: GeneratedConfidence; reason: string } | undefined;
    for (const hint of GENERATED_DIR_HINTS) {
      if (hint.re.test(rel)) {
        matchedDir = { kind: hint.kind, confidence: hint.confidence, reason: hint.reason };
        // Find segment that triggered the match for root attribution.
        const m = rel.match(hint.re);
        if (m) {
          const idx = rel.indexOf(m[0]);
          const root = rel.slice(0, idx + m[0].length).replace(/\/$/, '');
          recordRoot(root, hint.kind, hint.confidence, hint.reason);
        }
        break;
      }
    }
    if (matchedDir) {
      generatedFiles.push({
        path: rel,
        kind: matchedDir.kind,
        confidence: matchedDir.confidence,
        reason: matchedDir.reason,
      });
      continue;
    }

    const ext = nodePath.extname(rel).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) {
      handwrittenFiles.push(rel);
      continue;
    }

    // Peek at file head.
    if (scanned >= scanLimit) {
      handwrittenFiles.push(rel);
      continue;
    }
    let head = '';
    try {
      if (existsSync(abs) && statSync(abs).isFile()) {
        const fd = readFileSync(abs);
        head = fd.slice(0, headBytes).toString('utf8');
        scanned += 1;
      }
    } catch {
      head = '';
    }
    if (!head) {
      handwrittenFiles.push(rel);
      continue;
    }

    let matched: { kind: GeneratedKind; reason: string; line: number } | undefined;
    const lines = head.split(/\r?\n/);
    const scanLines = lines.slice(0, headLines);
    const lowerExt = ext;
    for (let i = 0; i < scanLines.length; i += 1) {
      const line = scanLines[i] ?? '';
      for (const marker of FILE_MARKERS) {
        if (marker.ext && !marker.ext.includes(lowerExt)) continue;
        if (marker.re.test(line)) {
          matched = { kind: marker.kind, reason: marker.reason, line: i + 1 };
          break;
        }
      }
      if (matched) break;
    }
    if (matched) {
      generatedFiles.push({
        path: rel,
        kind: matched.kind,
        confidence: GeneratedConfidence.High,
        reason: matched.reason,
        markerLine: matched.line,
      });
      continue;
    }

    handwrittenFiles.push(rel);
  }

  if (scanned >= scanLimit) {
    limitations.push(`File-content scan limited to ${scanLimit} files; some generated headers may be missed.`);
  }

  const generatedRoots = Array.from(rootCounts.values()).sort((a, b) => b.fileCount - a.fileCount);

  const protectedRules: IProtectedRule[] = [];
  if (generatedRoots.length > 0) {
    protectedRules.push({
      id: 'generated.no-manual-edit',
      title: 'Do not hand-edit generated files',
      content:
        'Files under generated roots are produced by tooling. Manual edits will be lost on the next regeneration. If a change is needed, modify the generator input (schema/template/config) and re-run codegen.',
      patterns: generatedRoots.map((r) => `${r.path}/**`),
      reason: 'Generated-code policy boundary; avoids silent regressions.',
    });
  }
  if (generatedFiles.some((f) => f.kind === GeneratedKind.Marker || f.kind === GeneratedKind.OpenApi || f.kind === GeneratedKind.GraphQL || f.kind === GeneratedKind.Protobuf || f.kind === GeneratedKind.PrismaClient)) {
    protectedRules.push({
      id: 'generated.respect-do-not-edit',
      title: 'Respect @generated / DO NOT EDIT markers',
      content:
        'Files annotated with @generated, "DO NOT EDIT", or a code-generator banner must not be edited by hand. The change belongs in the generator source.',
      patterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.go', '**/*.rs'],
      reason: 'Marker-driven generated-code protection.',
    });
  }

  const recommendedPolicyRules: IRecommendedGeneratedPolicy[] = [];
  if (generatedRoots.length > 0) {
    recommendedPolicyRules.push({
      id: 'policy.generated-roots-readonly',
      title: 'Treat generated roots as read-only by default',
      description:
        'Plans that modify files under generated roots require an explicit "generated" intent on the task contract. Otherwise the plan is rejected at review.',
      suggestedId: 'policy.generated-readonly',
      patterns: generatedRoots.map((r) => `${r.path}/**`),
      reason: 'Prevents agents from silently overwriting generated output.',
    });
  }

  return {
    schema: GENERATED_CODE_SCHEMA,
    projectRoot,
    generatedFiles,
    handwrittenFiles,
    mixedFiles,
    generatedRoots,
    protectedRules,
    recommendedPolicyRules,
    filesScanned: scanned,
    limitations,
  };
}

function enumerateRepoFiles(inspection: ISharkcraftInspection): readonly string[] {
  const found = findFiles(inspection.projectRoot, /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|cs|java|kt|swift|proto|graphql|gql|d\.ts)$/i, { maxDepth: 6 });
  const rel = found.map((f) => nodePath.relative(inspection.projectRoot, f));
  const set = new Set(rel);
  for (const f of inspection.sourceFiles) {
    // Drop any path that escapes the project root (e.g. absolute paths inside
    // node_modules that the knowledge loader picked up via pack discovery).
    if (nodePath.isAbsolute(f)) {
      const r = nodePath.relative(inspection.projectRoot, f);
      if (r.startsWith('..')) continue;
      if (r.includes('node_modules')) continue;
      set.add(r);
    } else {
      if (f.includes('node_modules')) continue;
      set.add(f);
    }
  }
  return Array.from(set).sort();
}

export function renderGeneratedCodeReportText(report: IGeneratedCodeReport): string {
  const lines: string[] = [];
  lines.push(`=== Generated-code report ===`);
  lines.push(`  generated files     ${report.generatedFiles.length}`);
  lines.push(`  handwritten files   ${report.handwrittenFiles.length}`);
  lines.push(`  generated roots     ${report.generatedRoots.length}`);
  lines.push(`  files scanned       ${report.filesScanned}`);
  if (report.generatedRoots.length > 0) {
    lines.push('');
    lines.push('Generated roots:');
    for (const r of report.generatedRoots.slice(0, 25)) {
      lines.push(`  - ${r.path}  [${r.kind} / ${r.confidence}]  ${r.reason} (${r.fileCount} files)`);
    }
  }
  if (report.protectedRules.length > 0) {
    lines.push('');
    lines.push('Protected rules:');
    for (const rule of report.protectedRules) {
      lines.push(`  - ${rule.id} — ${rule.title}`);
    }
  }
  if (report.limitations.length > 0) {
    lines.push('');
    lines.push('Limitations:');
    for (const l of report.limitations) lines.push(`  - ${l}`);
  }
  return lines.join('\n');
}

export function renderGeneratedCodeReportMarkdown(report: IGeneratedCodeReport): string {
  const lines: string[] = [];
  lines.push('# Generated-code report');
  lines.push('');
  lines.push(`- Generated files: **${report.generatedFiles.length}**`);
  lines.push(`- Handwritten files: **${report.handwrittenFiles.length}**`);
  lines.push(`- Generated roots: **${report.generatedRoots.length}**`);
  lines.push(`- Files scanned for markers: **${report.filesScanned}**`);
  if (report.generatedRoots.length > 0) {
    lines.push('');
    lines.push('## Roots');
    lines.push('');
    lines.push('| Path | Kind | Confidence | Files | Reason |');
    lines.push('|---|---|---|---|---|');
    for (const r of report.generatedRoots) {
      lines.push(`| \`${r.path}\` | ${r.kind} | ${r.confidence} | ${r.fileCount} | ${r.reason} |`);
    }
  }
  if (report.protectedRules.length > 0) {
    lines.push('');
    lines.push('## Recommended protected rules');
    lines.push('');
    for (const r of report.protectedRules) {
      lines.push(`### ${r.title}`);
      lines.push('');
      lines.push(r.content);
      lines.push('');
      lines.push(`Applies to: ${r.patterns.map((p) => `\`${p}\``).join(', ')}`);
      lines.push('');
    }
  }
  if (report.recommendedPolicyRules.length > 0) {
    lines.push('');
    lines.push('## Recommended policy rules');
    lines.push('');
    for (const r of report.recommendedPolicyRules) {
      lines.push(`- **${r.title}** (\`${r.suggestedId}\`) — ${r.description}`);
    }
  }
  if (report.limitations.length > 0) {
    lines.push('');
    lines.push('## Limitations');
    lines.push('');
    for (const l of report.limitations) lines.push(`- ${l}`);
  }
  return lines.join('\n');
}

export function renderGeneratedCodeReportJson(report: IGeneratedCodeReport): string {
  return JSON.stringify(report, null, 2);
}
