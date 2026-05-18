import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { detectProjectRoot } from './project-root-detector.ts';
import { readPackageJson } from './package-json-reader.ts';
import { detectPackageManager } from './package-manager-detector.ts';
import { detectFrameworks } from './framework-detector.ts';
import { readTsConfig } from './tsconfig-reader.ts';
import { listTopLevelDirs } from './folder-scanner.ts';
import { detectProfiles } from './profile-detector.ts';
import type { IWorkspaceSummary } from './workspace-summary.ts';

export interface InspectWorkspaceOptions {
  startDir?: string;
  sharkcraftDirName?: string;
}

export async function inspectWorkspace(
  options: InspectWorkspaceOptions = {},
): Promise<IWorkspaceSummary> {
  const startDir = options.startDir ?? process.cwd();
  const sharkcraftDirName = options.sharkcraftDirName ?? 'sharkcraft';

  const { root } = detectProjectRoot(startDir);
  const pkgResult = readPackageJson(root);
  const pkg = pkgResult.ok ? pkgResult.value : null;
  const pkgManager = detectPackageManager(root, pkg);
  const frameworks = detectFrameworks(root, pkg);
  const tsConfigResult = readTsConfig(root);
  const tsConfig = tsConfigResult.ok ? tsConfigResult.value : null;

  const sharkcraftPath = nodePath.join(root, sharkcraftDirName);
  const hasSharkcraftFolder = existsSync(sharkcraftPath) && safeIsDir(sharkcraftPath);
  const topLevelDirs = listTopLevelDirs(root);
  const profileResult = detectProfiles({
    packageJson: pkg,
    frameworks,
    topLevelDirs,
    hasTsConfig: tsConfig !== null,
  });

  return {
    projectRoot: root,
    hasPackageJson: pkg !== null,
    packageName: pkg?.name,
    packageVersion: pkg?.version,
    description: pkg?.description,
    packageManager: pkgManager,
    frameworks,
    hasTypeScript: frameworks.some((f) => f.id === 'typescript') || tsConfig !== null,
    tsConfig,
    scripts: pkg?.scripts ?? {},
    dependencies: pkg?.dependencies ?? {},
    devDependencies: pkg?.devDependencies ?? {},
    topLevelDirs,
    hasSharkcraftFolder,
    sharkcraftPath: hasSharkcraftFolder ? sharkcraftPath : null,
    profiles: profileResult.profiles,
    profileEvidence: profileResult.evidence,
    raw: { packageJson: pkg },
  };
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
