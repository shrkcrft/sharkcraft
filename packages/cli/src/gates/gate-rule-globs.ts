import {
  resolveSourceGlobs,
  type IBaselineRule,
  type IGeneratedArtifactRule,
  type IPolicyRule,
  type IRegistrationIdiom,
  type IRegistryDeclaration,
  type IWiringRule,
  type IWiringSource,
} from '@shrkcrft/core';
import { matchesAny } from '@shrkcrft/boundaries';
import type { IGateRuleView } from './gate-rule-view.ts';

/**
 * The FOOTPRINT of a gate rule: every project-relative glob it reads.
 *
 * `--changed-only` is only trustworthy if the footprint is complete. A rule
 * scoped by its declared side alone would go unevaluated when the change edits
 * the REGISTERED side — a registration deleted in file B silently skipping the
 * rule declared over file A is the precise bug this plane exists to catch, so
 * every side, every hop, and every watched input counts.
 */
export function gateRuleGlobs(view: IGateRuleView): readonly string[] {
  if (view.plane === 'policy') return (view.raw as IPolicyRule).files ?? [];
  if (view.plane === 'baseline') {
    const rule = view.raw as IBaselineRule;
    // `watchFiles` is the ONLY footprint a command compute has — without it a
    // command baseline can never be scoped, so it always runs (see below).
    return [
      ...gateRuleSources(view).flatMap(sourceGlobs),
      ...(rule.watchFiles ?? []),
      rule.baseline,
    ];
  }
  if (view.plane === 'generated') {
    const rule = view.raw as IGeneratedArtifactRule;
    return [
      ...rule.generatedGlob,
      ...(rule.sources ?? []).flatMap((s) => s.glob),
      ...(rule.handMaintained ?? []),
    ];
  }
  return gateRuleSources(view).flatMap(sourceGlobs);
}

/**
 * Every glob one source reads: the files it scans, plus an `import-edges`
 * source's TARGET globs.
 *
 * A fence whose footprint covered only the consumer side would go unevaluated
 * when the target subtree moved — and "cannot be proven out of scope" must
 * always resolve to staying IN scope, never to a quiet skip.
 */
function sourceGlobs(src: IWiringSource): readonly string[] {
  return [...resolveSourceGlobs(src), ...(src.to?.files ?? [])];
}

/**
 * EVERY extraction source a rule reads — both wiring sides, every union sink,
 * every chain hop, a registry's consumer, all three registration roles.
 *
 * Collecting all of them (not just the rule's primary side) is what lets the
 * coverage view name every consumer of a shared extractor. A rule that `$use`s
 * one on its *registered* side is just as bound to that definition as one that
 * uses it on `declared`, and listing only half of them would understate exactly
 * the guarantee the shared extractor exists to provide.
 */
export function gateRuleSources(view: IGateRuleView): readonly IWiringSource[] {
  switch (view.plane) {
    case 'wiring': {
      const rule = view.raw as IWiringRule;
      return [
        rule.declared,
        ...(Array.isArray(rule.registered)
          ? (rule.registered as readonly IWiringSource[])
          : rule.registered
            ? [rule.registered as IWiringSource]
            : []),
        ...(rule.chain ?? []),
      ].filter((s): s is IWiringSource => s !== undefined);
    }
    case 'registry': {
      const decl = view.raw as IRegistryDeclaration;
      return decl.consumer ? [decl.source, decl.consumer] : [decl.source];
    }
    case 'registration': {
      const idiom = view.raw as IRegistrationIdiom;
      return [idiom.declared, idiom.provided, idiom.consumed];
    }
    case 'baseline': {
      const source = (view.raw as IBaselineRule).compute.source;
      return source ? [source] : [];
    }
    default:
      // `policy` and `generated` select files by glob, not by an extraction
      // source, so neither can reference a shared extractor.
      return [];
  }
}

/**
 * Whether a rule's footprint intersects the changed set.
 *
 * A rule with NO resolvable footprint (a command baseline with no
 * `watchFiles`) cannot be proven out of scope, so it stays IN scope. Guessing
 * "probably unaffected" is how a `--changed-only` run silently stops checking
 * the one thing that broke.
 */
export function ruleTouchedBy(view: IGateRuleView, changed: readonly string[]): boolean {
  const globs = gateRuleGlobs(view).filter((g) => g.length > 0);
  if (globs.length === 0) return true;
  return changed.some((file) => matchesAny(file, globs));
}
