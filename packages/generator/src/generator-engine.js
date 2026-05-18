import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppErrorImpl, ERROR_CODES, err, ok, } from '@shrkcrft/core';
import { planGeneration } from "./dry-run.js";
import { FileChangeType } from "./file-change.js";
export function generate(template, request) {
    const dryRun = planGeneration(template, request);
    const plan = dryRun.plan;
    if (!request.write) {
        return ok({
            plan,
            summary: {
                written: 0,
                skipped: plan.changes.filter((c) => c.type === FileChangeType.Skip).length,
                conflicts: plan.changes.filter((c) => c.type === FileChangeType.Conflict).length,
                totalBytes: 0,
            },
            written: [],
        });
    }
    if (plan.hasConflicts) {
        return err(new AppErrorImpl(ERROR_CODES.TARGET_FILE_EXISTS, 'Generation refused: plan has conflicts (use --force / different overwrite strategy)', { details: { conflicts: plan.changes.filter((c) => c.type === FileChangeType.Conflict) } }));
    }
    const written = [];
    let totalBytes = 0;
    let skipped = 0;
    for (const change of plan.changes) {
        if (change.type === FileChangeType.Skip) {
            skipped += 1;
            continue;
        }
        if (change.type === FileChangeType.Create || change.type === FileChangeType.Update) {
            try {
                mkdirSync(dirname(change.absolutePath), { recursive: true });
                writeFileSync(change.absolutePath, change.contents, 'utf8');
                written.push(change);
                totalBytes += change.sizeBytes;
            }
            catch (e) {
                return err(new AppErrorImpl(ERROR_CODES.FILE_WRITE_ERROR, `Failed to write ${change.absolutePath}`, { details: { path: change.absolutePath }, cause: e }));
            }
        }
    }
    return ok({
        plan,
        summary: { written: written.length, skipped, conflicts: 0, totalBytes },
        written,
    });
}
