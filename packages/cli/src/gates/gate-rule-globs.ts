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
import { globListSelects, wiringLabeledSources } from '@shrkcrft/boundaries';
import type { IGateRuleView } from './gate-rule-view.ts';

/**
 * The FOOTPRINT of a gate rule, as the glob LISTS it reads — one per source's
 * `files`, per `import-edges` `to.files`, per watched input, per generated
 * writer. Kept as separate lists because a `!` entry subtracts from ITS OWN
 * list only: flattened, one source's `!x` would hide a file another source
 * reads (and a changeset touching x would skip a rule it does touch).
 *
 * `--changed-only` is only trustworthy if the footprint is complete. A rule
 * scoped by its declared side alone would go unevaluated when the change edits
 * the REGISTERED side — a registration deleted in file B silently skipping the
 * rule declared over file A is the precise bug this plane exists to catch, so
 * every side, every hop, and every watched input counts.
 */
export function gateRuleGlobLists(view: IGateRuleView): readonly (readonly string[])[] {
  if (view.plane === 'policy') {
    const files = (view.raw as IPolicyRule).files ?? [];
    return files.length > 0 ? [files] : [];
  }
  if (view.plane === 'baseline') {
    const rule = view.raw as IBaselineRule;
    // `watchFiles` is the ONLY footprint a command compute has — without it a
    // command baseline can never be scoped, so it always runs (see below).
    return [
      ...gateRuleSources(view).flatMap(sourceGlobLists),
      ...(rule.watchFiles && rule.watchFiles.length > 0 ? [rule.watchFiles] : []),
      // A ceiling rule has no committed artifact — its pinned value is the
      // number in the config, so its footprint is its compute alone.
      ...(rule.baseline ? [[rule.baseline]] : []),
    ];
  }
  if (view.plane === 'generated') {
    const rule = view.raw as IGeneratedArtifactRule;
    return [
      rule.generatedGlob,
      ...(rule.sources ?? []).map((s) => s.glob),
      ...(rule.handMaintained && rule.handMaintained.length > 0 ? [rule.handMaintained] : []),
    ];
  }
  return gateRuleSources(view).flatMap(sourceGlobLists);
}

/**
 * Every glob a gate rule reads, flattened — for DISPLAY only. A scope question
 * ("does this change touch the rule?") goes through {@link gateRuleGlobLists}
 * per list ({@link ruleTouchedBy}), never through this union.
 */
export function gateRuleGlobs(view: IGateRuleView): readonly string[] {
  return gateRuleGlobLists(view).flat();
}

/**
 * The glob lists one source reads: the files it scans, plus an `import-edges`
 * source's TARGET globs.
 *
 * A fence whose footprint covered only the consumer side would go unevaluated
 * when the target subtree moved — and "cannot be proven out of scope" must
 * always resolve to staying IN scope, never to a quiet skip.
 */
function sourceGlobLists(src: IWiringSource): readonly (readonly string[])[] {
  const files = resolveSourceGlobs(src);
  const to = src.to?.files ?? [];
  return [...(files.length > 0 ? [files] : []), ...(to.length > 0 ? [to] : [])];
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
  return gateRuleLabeledSources(view).map((s) => s.source);
}

/** A registry's sources, named `source` / `consumer` — THE labels its markers and dead units are qualified by. */
export function registryLabeledSources(
  decl: IRegistryDeclaration,
): readonly { readonly label: string; readonly source: IWiringSource }[] {
  return decl.consumer
    ? [
        { label: 'source', source: decl.source },
        { label: 'consumer', source: decl.consumer },
      ]
    : [{ label: 'source', source: decl.source }];
}

/** A registration idiom's roles, named `declared` / `provided` / `consumed` — the labels `measureRegistrationRoles` settles them under. */
export function registrationLabeledSources(
  idiom: IRegistrationIdiom,
): readonly { readonly label: string; readonly source: IWiringSource }[] {
  return [
    { label: 'declared', source: idiom.declared },
    { label: 'provided', source: idiom.provided },
    { label: 'consumed', source: idiom.consumed },
  ];
}

/**
 * {@link gateRuleSources}, each named by the side it plays (`declared`,
 * `registered[1]`, `chain[0]`, `consumer`, …) — the ONE enumeration of a
 * rule's sources, so a report naming a dead glob by its side cannot list a
 * different set of sides than the extractor-consumer report does.
 */
export function gateRuleLabeledSources(
  view: IGateRuleView,
): readonly { readonly label: string; readonly source: IWiringSource }[] {
  switch (view.plane) {
    case 'wiring':
      // THE wiring side labels (round 13) — the engine's own enumeration, so a
      // unit is named by one side label here and in `check wiring`.
      return wiringLabeledSources(view.raw as IWiringRule);
    case 'registry':
      return registryLabeledSources(view.raw as IRegistryDeclaration);
    case 'registration':
      return registrationLabeledSources(view.raw as IRegistrationIdiom);
    case 'baseline': {
      const source = (view.raw as IBaselineRule).compute.source;
      return source ? [{ label: 'compute.source', source }] : [];
    }
    default:
      // `policy` and `generated` select files by glob, not by an extraction
      // source, so neither can reference a shared extractor.
      return [];
  }
}

/**
 * Whether a rule's footprint intersects the changed set: some changed file is
 * SELECTED by one of the rule's glob lists (`globListSelects` — an inclusion
 * glob matches, none of that list's negations does). Exact per list, so a
 * changeset touching only files the rule excludes does not select it, and one
 * source's `!` can never hide another source's file.
 *
 * A rule with NO resolvable footprint (a command baseline with no
 * `watchFiles`) cannot be proven out of scope, so it stays IN scope. Guessing
 * "probably unaffected" is how a `--changed-only` run silently stops checking
 * the one thing that broke.
 */
export function ruleTouchedBy(view: IGateRuleView, changed: readonly string[]): boolean {
  const lists = gateRuleGlobLists(view)
    .map((l) => l.filter((g) => g.length > 0))
    .filter((l) => l.length > 0);
  if (lists.length === 0) return true;
  return lists.some((l) => changed.some((file) => globListSelects(file, l)));
}
