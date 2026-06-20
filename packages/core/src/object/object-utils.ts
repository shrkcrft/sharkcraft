export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as object)) {
    const v = (value as Record<string, unknown>)[key];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return Object.freeze(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Assign an own enumerable data property. Plain `target[key] = value` invokes
 * the `Object.prototype.__proto__` setter for a key literally equal to
 * `"__proto__"` (a real own key after `JSON.parse`), which silently drops the
 * value (or pollutes the prototype) — so build these objects via defineProperty.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Read an OWN property value (returns undefined when the key isn't an own prop). */
function getOwn(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

export function merge<A extends Record<string, unknown>, B extends Record<string, unknown>>(
  a: A,
  b: B,
): A & B {
  const result: Record<string, unknown> = { ...a };
  for (const key of Object.keys(b)) {
    const av = getOwn(result, key);
    const bv = (b as Record<string, unknown>)[key];
    if (isPlainObject(av) && isPlainObject(bv)) {
      setOwn(result, key, merge(av, bv));
    } else if (bv !== undefined) {
      setOwn(result, key, bv);
    }
  }
  return result as A & B;
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    // Own-property check (not `key in obj`, which walks the prototype chain, so
    // pick(obj, ['toString']) would otherwise copy the inherited function).
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      setOwn(result as Record<string, unknown>, key as string, obj[key]);
    }
  }
  return result;
}

export function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const keySet = new Set<keyof T>(keys);
  const result = {} as Omit<T, K>;
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (!keySet.has(key)) {
      setOwn(result as Record<string, unknown>, key as string, obj[key]);
    }
  }
  return result;
}

export function uniqueBy<T, K>(items: readonly T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

export function groupBy<T, K extends string | number>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const key = keyFn(item);
    (out[key] ??= []).push(item);
  }
  return out;
}
