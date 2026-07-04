/**
 * `--resolve` support for `shrk registry <name> exists <id>`.
 *
 * The noun an author types is not always the exact registered slug. `--resolve`
 * bridges that vocabulary gap before the existence check so a duplicate guard
 * can't return a false "not declared" for a construct that DOES exist under its
 * canonical id (a25 §2.4). Resolution is deterministic and layered, most
 * author-controlled first:
 *
 *   1. the registry's declared `aliases` map (explicit synonym → canonical),
 *   2. a case-insensitive exact match against the declared ids,
 *   3. singular/plural normalization (`commands` ↔ `command`),
 *   4. suffix strip/append (`button` ↔ `button-command`, `foo` ↔ `foo.tool`).
 *
 * Layers 3 and 4 CHAIN: the singular/plural variants and the suffix transform
 * compose, so a doubly-off noun still lands (`buttons` →(plural)→ `button`
 * →(suffix)→ `button-command`) where a single layer would no-op. When both
 * transforms fire, the resolution reports `SingularPluralSuffix`.
 *
 * The first candidate that lands on a DECLARED id wins; when nothing resolves,
 * the noun is returned unchanged and unmatched (the honest "genuinely not
 * declared" answer). No layer invents an id that isn't in the registry.
 */

/** How a noun resolved to its canonical registered id (for a truthful report). */
export enum ERegistryResolveVia {
  Identity = 'identity',
  Alias = 'alias',
  Case = 'case-fold',
  SingularPlural = 'singular/plural',
  Suffix = 'suffix',
  /** Both a singular/plural AND a suffix transform were applied (chained). */
  SingularPluralSuffix = 'singular/plural+suffix',
}

export interface IRegistryResolution {
  /** The canonical id to test for existence (may equal the input noun). */
  readonly canonical: string;
  /** True when `canonical` is actually a declared id in the registry. */
  readonly matched: boolean;
  /** Which normalization layer produced `canonical`. */
  readonly via: ERegistryResolveVia;
}

function singularPluralVariants(noun: string): string[] {
  const out: string[] = [];
  const lower = noun.toLowerCase();
  if (lower.endsWith('ies')) out.push(noun.slice(0, -3) + 'y');
  if (lower.endsWith('s')) out.push(noun.slice(0, -1));
  if (lower.endsWith('y')) out.push(noun.slice(0, -1) + 'ies');
  out.push(noun + 's');
  return out;
}

/**
 * Resolve a human/synonym `noun` to a canonical registered id. `declaredIds` is
 * the registry's actual declared id list (so no layer can resolve to something
 * that isn't declared); `aliases` is the registry's optional declared map.
 */
export function resolveRegistryNoun(
  declaredIds: readonly string[],
  aliases: Readonly<Record<string, string>> | undefined,
  noun: string,
): IRegistryResolution {
  const idSet = new Set(declaredIds);

  // 1. Author-declared alias map — highest priority, honored even if it points
  //    at an id the current scan didn't find (the author asserted the mapping).
  const aliased = aliases?.[noun];
  if (aliased !== undefined) {
    return { canonical: aliased, matched: idSet.has(aliased), via: ERegistryResolveVia.Alias };
  }

  // Exact identity.
  if (idSet.has(noun)) {
    return { canonical: noun, matched: true, via: ERegistryResolveVia.Identity };
  }

  const lower = noun.toLowerCase();

  // 2. Case-insensitive exact.
  const ciHit = declaredIds.find((d) => d.toLowerCase() === lower);
  if (ciHit !== undefined) {
    return { canonical: ciHit, matched: true, via: ERegistryResolveVia.Case };
  }

  // 3 + 4. Chained singular/plural × suffix strip/append.
  //
  // Build an ordered candidate list — the noun itself first, then its
  // singular/plural variants (plural variants BEFORE the suffix test) — and for
  // EACH candidate test an exact (case-insensitive) match against the declared
  // ids, then a suffix strip, then a suffix append. The first candidate that
  // lands on a DECLARED id wins. Because the transforms compose, a doubly-off
  // noun (`buttons` →(plural)→ `button` →(suffix)→ `button-command`) resolves
  // where either layer alone would no-op. `via` records which transforms fired:
  // a variant matching exactly is `SingularPlural`, the original noun matching
  // by suffix is `Suffix`, and a variant matching by suffix is the chained
  // `SingularPluralSuffix`. The original noun can never match here EXACTLY (the
  // identity / case-fold short-circuits above already handled that).
  const candidates = [noun, ...singularPluralVariants(noun)];
  for (const candidate of candidates) {
    const isVariant = candidate !== noun;
    const cLower = candidate.toLowerCase();

    const exact = declaredIds.find((d) => d.toLowerCase() === cLower);
    if (exact !== undefined && isVariant) {
      return { canonical: exact, matched: true, via: ERegistryResolveVia.SingularPlural };
    }

    const suffixStripped = declaredIds.find((d) => {
      const stripped = d.replace(/[-_.][a-z0-9]+$/i, '');
      return stripped.toLowerCase() === cLower && stripped.toLowerCase() !== d.toLowerCase();
    });
    if (suffixStripped !== undefined) {
      return {
        canonical: suffixStripped,
        matched: true,
        via: isVariant ? ERegistryResolveVia.SingularPluralSuffix : ERegistryResolveVia.Suffix,
      };
    }

    for (const d of declaredIds) {
      const m = d.match(/([-_.][a-z0-9]+)$/i);
      if (m && `${cLower}${m[1]!.toLowerCase()}` === d.toLowerCase()) {
        return {
          canonical: d,
          matched: true,
          via: isVariant ? ERegistryResolveVia.SingularPluralSuffix : ERegistryResolveVia.Suffix,
        };
      }
    }
  }

  // Nothing resolved — the honest unmatched identity.
  return { canonical: noun, matched: false, via: ERegistryResolveVia.Identity };
}
