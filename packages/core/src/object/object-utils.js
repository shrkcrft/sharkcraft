export function deepFreeze(value) {
    if (value === null || typeof value !== 'object')
        return value;
    for (const key of Object.keys(value)) {
        const v = value[key];
        if (v && typeof v === 'object' && !Object.isFrozen(v)) {
            deepFreeze(v);
        }
    }
    return Object.freeze(value);
}
export function isPlainObject(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === null || proto === Object.prototype;
}
export function merge(a, b) {
    const result = { ...a };
    for (const key of Object.keys(b)) {
        const av = result[key];
        const bv = b[key];
        if (isPlainObject(av) && isPlainObject(bv)) {
            result[key] = merge(av, bv);
        }
        else if (bv !== undefined) {
            result[key] = bv;
        }
    }
    return result;
}
export function pick(obj, keys) {
    const result = {};
    for (const key of keys) {
        if (key in obj)
            result[key] = obj[key];
    }
    return result;
}
export function omit(obj, keys) {
    const keySet = new Set(keys);
    const result = {};
    for (const key of Object.keys(obj)) {
        if (!keySet.has(key)) {
            result[key] = obj[key];
        }
    }
    return result;
}
export function uniqueBy(items, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const key = keyFn(item);
        if (!seen.has(key)) {
            seen.add(key);
            out.push(item);
        }
    }
    return out;
}
export function groupBy(items, keyFn) {
    const out = {};
    for (const item of items) {
        const key = keyFn(item);
        (out[key] ??= []).push(item);
    }
    return out;
}
