import { markedListFailOnEmptyConflict } from '../liveness/marked-list-fail-on-empty-conflict.ts';
import type { IExtractorHostPlanes, IExtractorRefError } from './resolve-plane-extractors.ts';
import { validateWiringSource } from './validate-wiring-source.ts';
import type { IWiringSource } from './wiring-rule.ts';

/**
 * THE post-resolution check of every `$use` source in the extractor-hosting
 * planes: `validateWiringSource` on the MERGED shape (the named extractor's
 * fields with the local overrides on top), one `{ path, message }` per problem.
 *
 * The schema cannot judge a `$use` source on its own — half its fields arrive
 * from the named extractor — so the "exactly one extraction mode, per-kind
 * required fields, a glob list with an inclusion" contract is enforced on the
 * source the engines will actually run. Three callers need the identical
 * answer (round 12 review, R12-X3): the config loader (a local rule fails the
 * load), the pack-plane merge seam (`resolveProjectConfig` — a pack element is
 * REJECTED, never adopted half-valid) and `gates try` (a candidate that would
 * not load is refused). The seam used to skip it, so a pack rule overriding an
 * extractor with a negation-only `files` was reported accepted by `packs
 * contributions` / `packs doctor` while `check wiring` called it misconfigured.
 *
 * Round 13 adds the two `expectEmpty` checks the schema cannot make either,
 * because the marks of a `$use` source arrive with the merge:
 *   - every mark names a unit of the RESOLVED list it sits on (a local `files`
 *     override replaces the extractor's markers wholesale — `resolveExtractorRef`
 *     — so a stray mark is a bug in that seam, refused rather than ignored);
 *   - a rule's PRIMARY source may not have every inclusion unit marked while
 *     the rule sets `failOnEmpty: true` (`markedListFailOnEmptyConflict`, the
 *     one conflict rule the schema applies to an inline list).
 *
 * `path` names the source (`wiringRules[<id>].declared`); `message` is
 * `(via extractor "<id>"): <problem>`, so `${path} ${message}` is the loader's
 * sentence. An inline (non-`$use`) source is the schema's to judge and is not
 * re-checked here.
 */
export function validateResolvedPlaneSources(planes: IExtractorHostPlanes): readonly IExtractorRefError[] {
  const problems: IExtractorRefError[] = [];
  const check = (
    source: IWiringSource | undefined,
    path: string,
    primaryOf?: { readonly failOnEmpty?: boolean },
  ): void => {
    if (!source || source.$use === undefined) return;
    const via = `(via extractor "${source.$use}")`;
    const problem = validateWiringSource(source);
    if (problem) problems.push({ path, message: `${via}: ${problem}` });
    const stray = strayUnitMarks(source);
    if (stray !== undefined) problems.push({ path, message: `${via}: ${stray}` });
    if (primaryOf !== undefined) {
      const conflict = markedListFailOnEmptyConflict(
        { units: source.files ?? [], marks: source.expectEmptyUnits ?? [] },
        'files',
        primaryOf.failOnEmpty,
      );
      if (conflict !== undefined) problems.push({ path, message: `${via}: ${conflict}` });
    }
  };
  for (const rule of planes.wiringRules ?? []) {
    const chained = (rule.chain ?? []).length > 0;
    check(rule.declared, `wiringRules[${rule.id}].declared`, chained ? undefined : rule);
    const registered = Array.isArray(rule.registered)
      ? (rule.registered as readonly IWiringSource[])
      : rule.registered
        ? [rule.registered as IWiringSource]
        : [];
    registered.forEach((s, i) => check(s, `wiringRules[${rule.id}].registered[${i}]`));
    (rule.chain ?? []).forEach((s, i) => check(s, `wiringRules[${rule.id}].chain[${i}]`, i === 0 ? rule : undefined));
  }
  for (const decl of planes.registries ?? []) {
    check(decl.source, `registries[${decl.name}].source`, decl);
    check(decl.consumer, `registries[${decl.name}].consumer`);
  }
  for (const idiom of planes.registrationGraph ?? []) {
    check(idiom.declared, `registrationGraph[${idiom.name}].declared`, idiom);
    check(idiom.provided, `registrationGraph[${idiom.name}].provided`);
    check(idiom.consumed, `registrationGraph[${idiom.name}].consumed`);
  }
  for (const rule of planes.baselines ?? []) {
    check(rule.compute.source, `baselines[${rule.id}].compute.source`, rule);
  }
  return problems;
}

/** Marks naming a unit their resolved list does not hold, as one sentence; `undefined` when every mark is placed. */
function strayUnitMarks(source: IWiringSource): string | undefined {
  const listed = (list: string): readonly string[] =>
    list === 'files' ? (source.files ?? []) : list === 'to.files' ? (source.to?.files ?? []) : [];
  const stray = (source.expectEmptyUnits ?? []).filter((m) => !listed(m.list).includes(m.unit));
  if (stray.length === 0) return undefined;
  return (
    `expectEmpty marks ${stray.map((m) => `${m.list} '${m.unit}'`).join(', ')}, which the resolved source does not ` +
    'list — a marker must name a unit of the list it sits on (a local `files` override replaces the extractor\'s markers)'
  );
}
