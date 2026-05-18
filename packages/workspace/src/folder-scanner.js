import { existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
const DEFAULT_IGNORE = new Set([
    'node_modules',
    '.git',
    '.idea',
    '.vscode',
    'dist',
    'build',
    '.cache',
    '.nx',
    '.turbo',
    'coverage',
]);
export function shallowScanFolder(dir) {
    if (!existsSync(dir))
        return { path: dir, exists: false, files: 0, dirs: 0 };
    try {
        let files = 0;
        let dirs = 0;
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory())
                dirs += 1;
            else if (e.isFile())
                files += 1;
        }
        return { path: dir, exists: true, files, dirs };
    }
    catch {
        return { path: dir, exists: true, files: 0, dirs: 0 };
    }
}
export function listTopLevelDirs(projectRoot, limit = 40) {
    if (!existsSync(projectRoot))
        return [];
    try {
        return readdirSync(projectRoot, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !DEFAULT_IGNORE.has(e.name))
            .map((e) => e.name)
            .slice(0, limit);
    }
    catch {
        return [];
    }
}
export function findFiles(startDir, pattern, options = {}) {
    const { maxDepth = 4, ignore = DEFAULT_IGNORE } = options;
    const out = [];
    function walk(dir, depth) {
        if (depth > maxDepth)
            return;
        try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                const name = String(e.name);
                if (ignore.has(name))
                    continue;
                const full = nodePath.join(dir, name);
                if (e.isDirectory())
                    walk(full, depth + 1);
                else if (e.isFile() && pattern.test(name))
                    out.push(full);
            }
        }
        catch {
            return;
        }
    }
    if (existsSync(startDir) && statSync(startDir).isDirectory())
        walk(startDir, 0);
    return out;
}
