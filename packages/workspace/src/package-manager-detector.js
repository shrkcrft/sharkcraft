import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
export var PackageManager;
(function (PackageManager) {
    PackageManager["Bun"] = "bun";
    PackageManager["Pnpm"] = "pnpm";
    PackageManager["Yarn"] = "yarn";
    PackageManager["Npm"] = "npm";
    PackageManager["Unknown"] = "unknown";
})(PackageManager || (PackageManager = {}));
export function detectPackageManager(projectRoot, pkg) {
    const evidence = [];
    if (pkg?.packageManager) {
        const [name, version] = pkg.packageManager.split('@');
        evidence.push(`packageManager field: ${pkg.packageManager}`);
        const manager = (name ?? '').toLowerCase();
        if (manager === 'bun')
            return { manager: PackageManager.Bun, version, evidence };
        if (manager === 'pnpm')
            return { manager: PackageManager.Pnpm, version, evidence };
        if (manager === 'yarn')
            return { manager: PackageManager.Yarn, version, evidence };
        if (manager === 'npm')
            return { manager: PackageManager.Npm, version, evidence };
    }
    if (existsSync(nodePath.join(projectRoot, 'bun.lockb'))) {
        evidence.push('bun.lockb present');
        return { manager: PackageManager.Bun, evidence };
    }
    if (existsSync(nodePath.join(projectRoot, 'bun.lock'))) {
        evidence.push('bun.lock present');
        return { manager: PackageManager.Bun, evidence };
    }
    if (existsSync(nodePath.join(projectRoot, 'pnpm-lock.yaml'))) {
        evidence.push('pnpm-lock.yaml present');
        return { manager: PackageManager.Pnpm, evidence };
    }
    if (existsSync(nodePath.join(projectRoot, 'yarn.lock'))) {
        evidence.push('yarn.lock present');
        return { manager: PackageManager.Yarn, evidence };
    }
    if (existsSync(nodePath.join(projectRoot, 'package-lock.json'))) {
        evidence.push('package-lock.json present');
        return { manager: PackageManager.Npm, evidence };
    }
    return { manager: PackageManager.Unknown, evidence };
}
