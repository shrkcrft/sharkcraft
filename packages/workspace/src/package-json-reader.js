import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { AppErrorImpl, ERROR_CODES, err, ok } from '@shrkcrft/core';
export function readPackageJson(projectRoot) {
    const pkgPath = nodePath.join(projectRoot, 'package.json');
    if (!existsSync(pkgPath))
        return ok(null);
    try {
        const raw = readFileSync(pkgPath, 'utf8');
        return ok(JSON.parse(raw));
    }
    catch (e) {
        return err(new AppErrorImpl(ERROR_CODES.FILE_READ_ERROR, `Failed to parse package.json: ${pkgPath}`, {
            details: { pkgPath },
            cause: e,
        }));
    }
}
