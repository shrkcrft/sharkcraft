const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * Deterministic content key for the CCR store. A 64-bit FNV-1a hash rendered
 * as 16 lowercase hex chars — dependency-free, stable across processes and
 * platforms, and collision-resistant enough for a local content cache. The
 * same bytes always produce the same key, which is what makes compression
 * reproducible (same workspace ⇒ same markers).
 */
export function ccrKey(content: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i);
    hash = (hash ^ BigInt(code & 0xff)) * FNV_PRIME & MASK_64;
    hash = (hash ^ BigInt((code >> 8) & 0xff)) * FNV_PRIME & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}
