import type { IBaselineRule } from '../baseline/baseline-rule.ts';
import type { IRegistrationIdiom } from './registration-idiom.ts';
import type { IRegistryDeclaration } from './registry-declaration.ts';
import { resolveExtractorRef, type ExtractorMap } from './resolve-extractor-ref.ts';
import type { IWiringRule, IWiringSource } from './wiring-rule.ts';

/**
 * Plane-wide `$use` resolution — one walk that rewrites EVERY source of every
 * data-defined rule against the named `extractors` map.
 *
 * It lives here, next to the rule types, because the alternative is each plane
 * remembering to resolve its own sources: the registry consumer side, the
 * wiring `chain` hops, the baseline compute. One forgotten site would leave an
 * unresolved `$use` reaching an engine, where it reads as "a source with no
 * files" and matches nothing — a silent pass, which is the exact failure this
 * plane exists to prevent.
 */

/** A rule whose `$use` could not be resolved, with the reason. */
export interface IExtractorRefError {
  /** Dotted path to the offending source, e.g. `wiringRules[handlers].declared`. */
  readonly path: string;
  readonly message: string;
}

/** The config planes that carry extractor sources. */
export interface IExtractorHostPlanes {
  readonly wiringRules?: readonly IWiringRule[];
  readonly registries?: readonly IRegistryDeclaration[];
  readonly registrationGraph?: readonly IRegistrationIdiom[];
  readonly baselines?: readonly IBaselineRule[];
}

/** The rewritten planes plus every unresolvable reference found on the way. */
export interface IResolvedPlanes extends IExtractorHostPlanes {
  readonly errors: readonly IExtractorRefError[];
}

/** Resolve one source, recording any failure against `path`. */
function one(
  source: IWiringSource,
  extractors: ExtractorMap | undefined,
  path: string,
  errors: IExtractorRefError[],
): IWiringSource {
  const resolved = resolveExtractorRef(source, extractors);
  if (resolved.error) errors.push({ path, message: resolved.error });
  return resolved.source;
}

/** Resolve an optional source, preserving `undefined`. */
function maybe(
  source: IWiringSource | undefined,
  extractors: ExtractorMap | undefined,
  path: string,
  errors: IExtractorRefError[],
): IWiringSource | undefined {
  return source === undefined ? undefined : one(source, extractors, path, errors);
}

/** Resolve every source of one wiring rule (both sides, every `chain` hop). */
function resolveWiringRule(
  rule: IWiringRule,
  extractors: ExtractorMap | undefined,
  errors: IExtractorRefError[],
): IWiringRule {
  const at = `wiringRules[${rule.id}]`;
  const declared = maybe(rule.declared, extractors, `${at}.declared`, errors);
  const registered = Array.isArray(rule.registered)
    ? (rule.registered as readonly IWiringSource[]).map((s, i) =>
        one(s, extractors, `${at}.registered[${i}]`, errors),
      )
    : maybe(rule.registered as IWiringSource | undefined, extractors, `${at}.registered`, errors);
  const chain = rule.chain?.map((s, i) => one(s, extractors, `${at}.chain[${i}]`, errors));
  return {
    ...rule,
    ...(declared ? { declared } : {}),
    ...(registered ? { registered } : {}),
    ...(chain ? { chain } : {}),
  };
}

/**
 * Rewrite every plane's sources with their `$use` references resolved.
 *
 * Planes absent from `planes` stay absent (rather than becoming empty arrays),
 * so a caller can spread the result over a config without inventing planes the
 * repo never declared.
 */
export function resolvePlaneExtractors(
  planes: IExtractorHostPlanes,
  extractors: ExtractorMap | undefined,
): IResolvedPlanes {
  const errors: IExtractorRefError[] = [];

  const wiringRules = planes.wiringRules?.map((r) => resolveWiringRule(r, extractors, errors));

  const registries = planes.registries?.map((r) => {
    const at = `registries[${r.name}]`;
    const consumer = maybe(r.consumer, extractors, `${at}.consumer`, errors);
    return {
      ...r,
      source: one(r.source, extractors, `${at}.source`, errors),
      ...(consumer ? { consumer } : {}),
    };
  });

  const registrationGraph = planes.registrationGraph?.map((r) => {
    const at = `registrationGraph[${r.name}]`;
    return {
      ...r,
      declared: one(r.declared, extractors, `${at}.declared`, errors),
      provided: one(r.provided, extractors, `${at}.provided`, errors),
      consumed: one(r.consumed, extractors, `${at}.consumed`, errors),
    };
  });

  const baselines = planes.baselines?.map((r) => {
    if (r.compute.source === undefined) return r;
    return {
      ...r,
      compute: {
        ...r.compute,
        source: one(r.compute.source, extractors, `baselines[${r.id}].compute.source`, errors),
      },
    };
  });

  return {
    ...(wiringRules ? { wiringRules } : {}),
    ...(registries ? { registries } : {}),
    ...(registrationGraph ? { registrationGraph } : {}),
    ...(baselines ? { baselines } : {}),
    errors,
  };
}
