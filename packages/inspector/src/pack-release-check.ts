import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { validatePackManifest, type ISharkCraftPackManifest } from '@shrkcrft/plugin-api';

export const PACK_RELEASE_CHECK_SCHEMA = 'sharkcraft.pack-release-check/v1';

export type CheckSeverity = 'info' | 'warning' | 'error';

export interface IPackReleaseFinding {
  code: string;
  severity: CheckSeverity;
  message: string;
  /** Free-text guidance for the human reviewer. */
  suggestedFix?: string;
  /** Optional copy-pasteable shell command for the human reviewer. */
  suggestedCommand?: string;
  /** Path of the offending file (when applicable). */
  file?: string;
}

export interface IPackReleaseCheck {
  schema: typeof PACK_RELEASE_CHECK_SCHEMA;
  packPath: string;
  manifestFile: string | null;
  packageJsonFile: string | null;
  contributionsFound: number;
  findings: readonly IPackReleaseFinding[];
  passed: boolean;
}

function findManifest(packPath: string): { manifestFile: string | null; pkgFile: string | null } {
  const pkgFile = nodePath.join(packPath, 'package.json');
  if (!existsSync(pkgFile)) return { manifestFile: null, pkgFile: null };
  let pkg: { sharkcraft?: { manifest?: string }; files?: readonly string[] } = {};
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  } catch {
    /* ignore */
  }
  const rel = pkg.sharkcraft?.manifest;
  if (!rel) return { manifestFile: null, pkgFile };
  const manifestFile = nodePath.resolve(packPath, rel);
  return { manifestFile: existsSync(manifestFile) ? manifestFile : null, pkgFile };
}

async function loadManifest(file: string): Promise<ISharkCraftPackManifest | null> {
  try {
    if (file.endsWith('.json')) {
      return JSON.parse(readFileSync(file, 'utf8')) as ISharkCraftPackManifest;
    }
    const { pathToFileURL } = await import('node:url');
    const mod = (await import(pathToFileURL(file).href)) as {
      default?: ISharkCraftPackManifest;
      manifest?: ISharkCraftPackManifest;
    };
    return mod.default ?? mod.manifest ?? null;
  } catch {
    return null;
  }
}

function checkFilesWhitelist(
  pkgFile: string,
  manifestFile: string | null,
): IPackReleaseFinding | null {
  let pkg: { files?: readonly string[] } = {};
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  } catch {
    return null;
  }
  if (!pkg.files || pkg.files.length === 0) {
    return {
      code: 'no-files-whitelist',
      severity: 'warning',
      message: 'package.json has no "files" whitelist — all files will be published.',
      suggestedFix: 'Add a "files" array to your package.json so publishes ship only the assets you intend.',
      suggestedCommand:
        'jq \'.files = ["dist", "src/assets/**", "src/sharkcraft.plugin.signed.json"]\' package.json > package.json.tmp && mv package.json.tmp package.json',
      file: pkgFile,
    };
  }
  if (manifestFile) {
    const rel = nodePath.relative(nodePath.dirname(pkgFile), manifestFile).split(nodePath.sep).join('/');
    // The signed manifest needs to ship; check if the patterns cover it.
    const covered = pkg.files.some((p) => {
      if (p === rel) return true;
      const segment = p.split('/')[0]!;
      return rel.startsWith(segment);
    });
    if (!covered) {
      return {
        code: 'manifest-not-in-files',
        severity: 'warning',
        message: `Signed manifest "${rel}" is not covered by package.json "files".`,
        suggestedFix: `Add "${rel}" (or its directory prefix) to package.json files[] so the signed manifest ships with the pack.`,
        suggestedCommand:
          `# Edit package.json: ensure "files" contains "${rel}" or its parent directory.`,
        file: pkgFile,
      };
    }
  }
  return null;
}

export async function runPackReleaseCheck(packPath: string): Promise<IPackReleaseCheck> {
  const findings: IPackReleaseFinding[] = [];
  const absPath = nodePath.resolve(packPath);
  if (!existsSync(absPath)) {
    findings.push({
      code: 'pack-not-found',
      severity: 'error',
      message: `Pack path does not exist: ${absPath}`,
    });
    return {
      schema: PACK_RELEASE_CHECK_SCHEMA,
      packPath: absPath,
      manifestFile: null,
      packageJsonFile: null,
      contributionsFound: 0,
      findings,
      passed: false,
    };
  }
  const { manifestFile, pkgFile } = findManifest(absPath);
  if (!pkgFile) {
    findings.push({
      code: 'no-package-json',
      severity: 'error',
      message: 'No package.json found at pack path.',
    });
    return {
      schema: PACK_RELEASE_CHECK_SCHEMA,
      packPath: absPath,
      manifestFile: null,
      packageJsonFile: null,
      contributionsFound: 0,
      findings,
      passed: false,
    };
  }
  if (!manifestFile) {
    findings.push({
      code: 'no-manifest',
      severity: 'error',
      message: 'package.json sharkcraft.manifest is missing or points at a non-existent file.',
      suggestedFix: 'Sign the manifest with `shrk packs sign` and reference the .signed.json in package.json.',
      suggestedCommand: 'shrk packs sign <path-to-pack> --verify-after-sign',
      file: pkgFile,
    });
    return {
      schema: PACK_RELEASE_CHECK_SCHEMA,
      packPath: absPath,
      manifestFile: null,
      packageJsonFile: pkgFile,
      contributionsFound: 0,
      findings,
      passed: false,
    };
  }
  const manifest = await loadManifest(manifestFile);
  if (!manifest) {
    findings.push({
      code: 'manifest-load-failed',
      severity: 'error',
      message: `Failed to load manifest file: ${manifestFile}`,
      suggestedFix: 'Check the manifest exports a `definePackManifest({...})` default export and parses as JSON / TypeScript without errors.',
      file: manifestFile,
    });
    return {
      schema: PACK_RELEASE_CHECK_SCHEMA,
      packPath: absPath,
      manifestFile,
      packageJsonFile: pkgFile,
      contributionsFound: 0,
      findings,
      passed: false,
    };
  }
  const validation = validatePackManifest(manifest as unknown);
  if (!validation.valid) {
    for (const i of validation.issues) {
      findings.push({
        code: `manifest-invalid:${i.field}`,
        severity: 'error',
        message: i.message,
      });
    }
  }
  // Contribution file existence + load.
  let contributionsFound = 0;
  const c = manifest.contributions ?? {};
  const allBuckets: (keyof typeof c)[] = [
    'knowledgeFiles',
    'ruleFiles',
    'pathFiles',
    'templateFiles',
    'pipelineFiles',
    'docsFiles',
    'presetFiles',
    'boundaryFiles',
    'contextTestFiles',
    'agentTestFiles',
    'scaffoldPatternFiles',
    'policyCheckFiles',
    'constructFiles',
    'constructFacetFiles',
    'playbookFiles',
    'searchTuningFiles',
  ];
  for (const key of allBuckets) {
    const list = (c as Record<string, readonly string[] | undefined>)[key];
    if (!list || list.length === 0) continue;
    for (const rel of list) {
      const full = nodePath.resolve(absPath, rel);
      if (!existsSync(full)) {
        findings.push({
          code: 'contribution-missing',
          severity: 'error',
          message: `${key} entry "${rel}" missing at ${full}.`,
          suggestedFix: `Either restore the file under ${absPath}/${rel} or remove it from manifest.contributions.${key}.`,
          file: full,
        });
      } else {
        contributionsFound += 1;
        // Try to import to catch parse errors. Skip docs/markdown.
        if (/\.(ts|js|mjs|cjs)$/.test(rel)) {
          try {
            const { pathToFileURL } = await import('node:url');
            await import(pathToFileURL(full).href);
          } catch (e) {
            const message = (e as Error).message;
            const helperMissing =
              /does not provide an export named|is not exported by|has no exported member|not a function/i.test(message);
            findings.push({
              code: helperMissing ? 'contribution-helper-missing' : 'contribution-load-failed',
              severity: 'error',
              message: `${key} entry "${rel}" failed to load: ${message}`,
              file: full,
              ...(helperMissing
                ? {
                    suggestedFix:
                      'The consumer\'s @shrkcrft/plugin-api version is missing a helper this contribution uses. Either bump the dependency, declare a `peerDependencies."@shrkcrft/plugin-api"` range that includes the helper, or rewrite the contribution as a structural object literal.',
                    suggestedCommand: 'shrk packs compat <path-to-pack>',
                  }
                : {
                    suggestedFix:
                      'Open the file and resolve the import or runtime error. Use `bun run packages/inspector/src/__tests__/load-pack.ts <file>` to reproduce.',
                  }),
            });
          }
        }
      }
    }
  }
  // Signature presence.
  if (!manifest.signature) {
    findings.push({
      code: 'unsigned-manifest',
      severity: 'warning',
      message:
        'Manifest has no HMAC signature. Adopters who run `shrk packs verify` will see signature status "missing-signature".',
      suggestedFix: 'Run `shrk packs sign <manifest.ts> --output ...signed.json` with SHARKCRAFT_PACK_SECRET set.',
      suggestedCommand: 'shrk packs sign ' + manifestFile + ' --verify-after-sign',
      file: manifestFile,
    });
  }
  // Files whitelist sanity.
  const filesFinding = checkFilesWhitelist(pkgFile, manifestFile);
  if (filesFinding) findings.push(filesFinding);

  const passed = findings.every((f) => f.severity !== 'error');
  return {
    schema: PACK_RELEASE_CHECK_SCHEMA,
    packPath: absPath,
    manifestFile,
    packageJsonFile: pkgFile,
    contributionsFound,
    findings,
    passed,
  };
}
