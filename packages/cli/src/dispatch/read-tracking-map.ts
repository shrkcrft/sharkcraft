/**
 * A `Map` that records which keys were READ — the substrate of the dispatcher's
 * post-run unknown-flag detector.
 *
 * `runCliInner` swaps `parsed.flags` / `parsed.multiFlags` for tracking copies
 * before a handler runs; afterwards, a supplied flag the handler never read was
 * silently dropped. `get` / `has` / `delete` mark one key. Any whole-map read
 * (iteration, spread, `forEach`, `keys`, `values`, `entries`) marks EVERY key,
 * so a handler that forwards or copies its flags is never accused of ignoring
 * them — the detector errs toward silence, never toward a false rejection.
 */
export class ReadTrackingMap<K, V> extends Map<K, V> {
  private readonly readKeys = new Set<K>();
  private everyKeyRead = false;

  /** A tracking copy of `source`: its entries, nothing marked read yet. */
  static from<K, V>(source: ReadonlyMap<K, V>): ReadTrackingMap<K, V> {
    const out = new ReadTrackingMap<K, V>();
    for (const [key, value] of source) out.set(key, value);
    return out;
  }

  override get(key: K): V | undefined {
    this.readKeys.add(key);
    return super.get(key);
  }

  override has(key: K): boolean {
    this.readKeys.add(key);
    return super.has(key);
  }

  override delete(key: K): boolean {
    this.readKeys.add(key);
    return super.delete(key);
  }

  override keys() {
    this.everyKeyRead = true;
    return super.keys();
  }

  override values() {
    this.everyKeyRead = true;
    return super.values();
  }

  override entries() {
    this.everyKeyRead = true;
    return super.entries();
  }

  override forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    this.everyKeyRead = true;
    super.forEach(callbackfn, thisArg);
  }

  override [Symbol.iterator]() {
    this.everyKeyRead = true;
    return super[Symbol.iterator]();
  }

  /** True when `key` was read — individually, or by a whole-map read. */
  wasRead(key: K): boolean {
    return this.everyKeyRead || this.readKeys.has(key);
  }
}
