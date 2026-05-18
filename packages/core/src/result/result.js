import { AppErrorImpl, ERROR_CODES } from "./errors.js";
export function ok(value) {
    return { ok: true, value };
}
export function err(error) {
    return { ok: false, error };
}
export function isOk(r) {
    return r.ok === true;
}
export function isErr(r) {
    return r.ok === false;
}
export function unwrap(r) {
    if (r.ok)
        return r.value;
    throw r.error instanceof Error ? r.error : new Error(JSON.stringify(r.error));
}
export function map(r, fn) {
    return r.ok ? ok(fn(r.value)) : r;
}
export function flatMap(r, fn) {
    return r.ok ? fn(r.value) : r;
}
export async function tryAsync(fn) {
    try {
        return ok(await fn());
    }
    catch (e) {
        return err(new AppErrorImpl(ERROR_CODES.UNKNOWN, e instanceof Error ? e.message : String(e), { cause: e }));
    }
}
export function trySync(fn) {
    try {
        return ok(fn());
    }
    catch (e) {
        return err(new AppErrorImpl(ERROR_CODES.UNKNOWN, e instanceof Error ? e.message : String(e), { cause: e }));
    }
}
