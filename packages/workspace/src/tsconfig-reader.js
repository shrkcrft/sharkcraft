import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { AppErrorImpl, ERROR_CODES, err, ok } from '@shrkcrft/core';
const TSCONFIG_NAMES = ['tsconfig.json', 'tsconfig.base.json'];
export function readTsConfig(projectRoot) {
    for (const name of TSCONFIG_NAMES) {
        const file = nodePath.join(projectRoot, name);
        if (existsSync(file)) {
            try {
                const text = readFileSync(file, 'utf8');
                // strip // comments and trailing commas to handle JSON-with-comments tsconfigs
                const cleaned = text
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
                    .replace(/,(\s*[}\]])/g, '$1');
                const parsed = JSON.parse(cleaned);
                const compilerOptions = parsed.compilerOptions ?? {};
                return ok({
                    target: compilerOptions.target,
                    module: compilerOptions.module,
                    strict: compilerOptions.strict,
                    paths: compilerOptions.paths,
                    baseUrl: compilerOptions.baseUrl,
                    extends: parsed.extends,
                    raw: parsed,
                });
            }
            catch (e) {
                return err(new AppErrorImpl(ERROR_CODES.FILE_READ_ERROR, `Failed to parse ${name}: ${file}`, {
                    details: { file },
                    cause: e,
                }));
            }
        }
    }
    return ok(null);
}
