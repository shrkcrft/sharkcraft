import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { AppErrorImpl, ERROR_CODES, err, ok } from '@shrkcrft/core';
export const SAVED_PLAN_SCHEMA = 'sharkcraft.plan/v1';
export function buildSavedPlan(input) {
    const out = {
        schema: SAVED_PLAN_SCHEMA,
        templateId: input.templateId,
        variables: { ...input.variables },
        projectRoot: input.projectRoot,
        createdAt: new Date().toISOString(),
        expectedChanges: input.plan.changes.map((c) => ({
            type: String(c.type),
            relativePath: c.relativePath,
            sizeBytes: c.sizeBytes,
        })),
    };
    if (input.name !== undefined)
        out.name = input.name;
    if (input.note !== undefined)
        out.note = input.note;
    return out;
}
export function savePlanToFile(plan, filePath) {
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
        return ok(undefined);
    }
    catch (e) {
        return err(new AppErrorImpl(ERROR_CODES.FILE_WRITE_ERROR, `Failed to save plan: ${filePath}`, {
            details: { filePath },
            cause: e,
        }));
    }
}
export function readPlanFromFile(filePath) {
    if (!existsSync(filePath)) {
        return err(new AppErrorImpl(ERROR_CODES.NOT_FOUND, `Plan file not found: ${filePath}`, {
            details: { filePath },
        }));
    }
    let raw;
    try {
        raw = readFileSync(filePath, 'utf8');
    }
    catch (e) {
        return err(new AppErrorImpl(ERROR_CODES.FILE_READ_ERROR, `Failed to read plan: ${filePath}`, {
            details: { filePath },
            cause: e,
        }));
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, `Plan file is not valid JSON: ${filePath}`, {
            cause: e,
        }));
    }
    const validation = validateSavedPlanShape(parsed);
    if (!validation.ok)
        return err(validation.error);
    return ok(validation.value);
}
function validateSavedPlanShape(value) {
    if (!value || typeof value !== 'object') {
        return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan must be a JSON object'));
    }
    const obj = value;
    if (obj.schema !== SAVED_PLAN_SCHEMA) {
        return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, `Unsupported plan schema: ${String(obj.schema)} (expected ${SAVED_PLAN_SCHEMA})`));
    }
    if (typeof obj.templateId !== 'string' || !obj.templateId) {
        return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: templateId must be a non-empty string'));
    }
    if (obj.variables === null || typeof obj.variables !== 'object') {
        return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: variables must be an object'));
    }
    for (const [k, v] of Object.entries(obj.variables)) {
        if (typeof v !== 'string') {
            return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, `Plan: variables.${k} must be a string (got ${typeof v})`));
        }
    }
    if (typeof obj.projectRoot !== 'string' || !obj.projectRoot) {
        return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: projectRoot must be a non-empty string'));
    }
    if (typeof obj.createdAt !== 'string') {
        return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: createdAt must be a string'));
    }
    if (obj.name !== undefined && typeof obj.name !== 'string') {
        return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: name must be a string'));
    }
    return ok(obj);
}
/**
 * Compare the saved plan's expected changes with a freshly-computed plan's
 * changes. Returns an empty array when they match.
 */
export function diffPlanChanges(saved, fresh) {
    if (!saved.expectedChanges)
        return [];
    const byPath = new Map();
    const freshByPath = new Map(fresh.changes.map((c) => [c.relativePath, c]));
    for (const expected of saved.expectedChanges) {
        const actual = freshByPath.get(expected.relativePath);
        if (!actual) {
            byPath.set(expected.relativePath, { relativePath: expected.relativePath, kind: 'removed' });
            continue;
        }
        if (String(actual.type) !== expected.type) {
            byPath.set(expected.relativePath, {
                relativePath: expected.relativePath,
                kind: 'type-changed',
                detail: `${expected.type} → ${String(actual.type)}`,
            });
            continue;
        }
        if (actual.sizeBytes !== expected.sizeBytes) {
            byPath.set(expected.relativePath, {
                relativePath: expected.relativePath,
                kind: 'size-changed',
                detail: `${expected.sizeBytes}B → ${actual.sizeBytes}B`,
            });
        }
    }
    for (const actual of fresh.changes) {
        const knownExpected = saved.expectedChanges.find((e) => e.relativePath === actual.relativePath);
        if (!knownExpected) {
            byPath.set(actual.relativePath, { relativePath: actual.relativePath, kind: 'added' });
        }
    }
    return [...byPath.values()];
}
