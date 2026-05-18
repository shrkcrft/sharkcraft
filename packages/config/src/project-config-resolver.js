import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
const PROJECT_ROOT_MARKERS = [
    'package.json',
    'bun.lockb',
    'pnpm-workspace.yaml',
    'nx.json',
    'tsconfig.base.json',
    '.git',
];
export function detectProjectRoot(startDir) {
    let current = nodePath.resolve(startDir);
    const seen = [];
    while (true) {
        const found = PROJECT_ROOT_MARKERS.filter((m) => existsSync(nodePath.join(current, m)));
        if (found.length > 0)
            return { root: current, markers: found };
        const parent = nodePath.dirname(current);
        if (parent === current) {
            return { root: nodePath.resolve(startDir), markers: seen };
        }
        current = parent;
    }
}
export function findSharkcraftDir(projectRoot, configuredDir = 'sharkcraft') {
    const candidate = nodePath.join(projectRoot, configuredDir);
    if (existsSync(candidate)) {
        try {
            if (statSync(candidate).isDirectory())
                return candidate;
        }
        catch {
            return null;
        }
    }
    return null;
}
