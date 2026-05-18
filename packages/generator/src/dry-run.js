import { existsSync, readFileSync } from 'node:fs';
import { safeResolveTargetPath } from '@shrkcrft/core';
import { renderTemplate, validateTemplateVariables, } from '@shrkcrft/templates';
import { OverwriteStrategy } from "./overwrite-strategy.js";
import { FileChangeType } from "./file-change.js";
import { decideForExisting, summarizeConflicts } from "./conflict-handler.js";
import { buildNameVariables } from "./naming-strategy.js";
export function planGeneration(template, request) {
    const warnings = [];
    const overwriteStrategy = request.overwriteStrategy ?? OverwriteStrategy.Never;
    const nameVars = request.name ? buildNameVariables(request.name) : {};
    const merged = { ...nameVars, ...request.variables };
    const validation = validateTemplateVariables(template.variables, merged);
    if (!validation.valid) {
        for (const issue of validation.issues)
            warnings.push(`${issue.variable}: ${issue.message}`);
        return {
            plan: {
                templateId: template.id,
                templateName: template.name,
                changes: [],
                totalFiles: 0,
                hasConflicts: false,
                warnings,
                postGenerationNotes: template.postGenerationNotes ?? [],
            },
            safe: false,
        };
    }
    const rendered = renderTemplate(template, validation.resolved);
    const changes = [];
    for (const file of rendered.files) {
        let safe;
        try {
            safe = safeResolveTargetPath(file.targetPath, request.projectRoot);
        }
        catch (e) {
            const err = e;
            changes.push({
                type: FileChangeType.Conflict,
                absolutePath: err.rawPath,
                relativePath: err.rawPath,
                contents: file.content,
                reason: `Refused unsafe target path (${err.code}): ${err.message}`,
                sizeBytes: Buffer.byteLength(file.content, 'utf8'),
            });
            continue;
        }
        const absolutePath = safe.absolutePath;
        const relPath = safe.relativePath;
        if (existsSync(absolutePath)) {
            let existing = '';
            try {
                existing = readFileSync(absolutePath, 'utf8');
            }
            catch {
                // unreadable existing file — treat as conflict
            }
            const decision = decideForExisting(file.overwrite ? OverwriteStrategy.Overwrite : overwriteStrategy, existing, file.content);
            changes.push({
                type: decision.type,
                absolutePath,
                relativePath: relPath,
                contents: file.content,
                reason: decision.reason,
                sizeBytes: Buffer.byteLength(file.content, 'utf8'),
            });
        }
        else {
            changes.push({
                type: FileChangeType.Create,
                absolutePath,
                relativePath: relPath,
                contents: file.content,
                reason: 'New file (does not exist)',
                sizeBytes: Buffer.byteLength(file.content, 'utf8'),
            });
        }
    }
    const { hasConflicts } = summarizeConflicts(changes);
    return {
        plan: {
            templateId: template.id,
            templateName: template.name,
            changes,
            totalFiles: changes.length,
            hasConflicts,
            warnings,
            postGenerationNotes: rendered.postGenerationNotes,
        },
        safe: !hasConflicts && changes.length > 0,
    };
}
