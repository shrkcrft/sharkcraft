import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
const ROOT_MARKERS = [
    'package.json',
    'bun.lockb',
    'pnpm-workspace.yaml',
    'nx.json',
    'tsconfig.base.json',
    '.git',
];
export function detectProjectRoot(startDir = process.cwd()) {
    let current = nodePath.resolve(startDir);
    while (true) {
        const found = ROOT_MARKERS.filter((m) => existsSync(nodePath.join(current, m)));
        if (found.length > 0)
            return { root: current, markers: found };
        const parent = nodePath.dirname(current);
        if (parent === current)
            return { root: nodePath.resolve(startDir), markers: [] };
        current = parent;
    }
}
