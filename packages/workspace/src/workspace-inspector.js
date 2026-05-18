import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { detectProjectRoot } from "./project-root-detector.js";
import { readPackageJson } from "./package-json-reader.js";
import { detectPackageManager } from "./package-manager-detector.js";
import { detectFrameworks } from "./framework-detector.js";
import { readTsConfig } from "./tsconfig-reader.js";
import { listTopLevelDirs } from "./folder-scanner.js";
export async function inspectWorkspace(options = {}) {
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
        topLevelDirs: listTopLevelDirs(root),
        hasSharkcraftFolder,
        sharkcraftPath: hasSharkcraftFolder ? sharkcraftPath : null,
        raw: { packageJson: pkg },
    };
}
function safeIsDir(p) {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
