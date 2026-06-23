/**
 * Derive `appliesWhen` tokens from a free-text task string.
 *
 * `shrk context` ranks knowledge entries via a lexical scorer. Foundational
 * rules (e.g. `architecture.layer-order`) declare an `appliesWhen` like
 * `generate-code` but share no surface tokens with a task such as "add a new
 * plugin command" — so without a derived `appliesWhen` signal they earn no
 * match reason and are dropped before priority is even considered.
 *
 * This maps task verbs/domains to the same canonical `appliesWhen` vocabulary
 * the inspector task-ranker uses, so the rule that *governs* the work surfaces
 * even when the wording doesn't overlap. Deterministic; no model in the loop.
 *
 * NOTE: the verb/domain vocabulary mirrors
 * `packages/inspector/src/task-ranker.ts`. The context layer cannot import the
 * higher inspector layer, so the small map is duplicated here on purpose — keep
 * the two in sync if either grows.
 */
const VERB_APPLIES_WHEN: { readonly regex: RegExp; readonly appliesWhen: readonly string[] }[] = [
  {
    regex: /\b(create|add|implement|generate|new|build|introduce|provide)\b/,
    appliesWhen: ['generate-code', 'generate-service', 'generate-utility', 'generate-template', 'create-feature'],
  },
  { regex: /\b(refactor|rewrite|migrate|extract|rename)\b/, appliesWhen: ['refactor'] },
  { regex: /\b(test|spec|coverage)\b/, appliesWhen: ['generate-test'] },
  { regex: /\b(fix|bug|broken|crash)\b/, appliesWhen: ['fix-bug'] },
  { regex: /\b(review|audit|inspect)\b/, appliesWhen: ['review-pr', 'review-code', 'check-boundaries'] },
];

const DOMAIN_APPLIES_WHEN: { readonly token: string; readonly appliesWhen: readonly string[] }[] = [
  { token: 'service', appliesWhen: ['generate-service'] },
  { token: 'utility', appliesWhen: ['generate-utility'] },
  { token: 'utilities', appliesWhen: ['generate-utility'] },
  { token: 'pipeline', appliesWhen: ['create-pipeline'] },
  { token: 'route', appliesWhen: ['generate-route'] },
];

export function deriveAppliesWhen(task: string): string[] {
  const text = task.toLowerCase();
  const out = new Set<string>();
  for (const v of VERB_APPLIES_WHEN) {
    if (v.regex.test(text)) for (const a of v.appliesWhen) out.add(a);
  }
  const tokens = new Set(text.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
  for (const d of DOMAIN_APPLIES_WHEN) {
    if (tokens.has(d.token)) for (const a of d.appliesWhen) out.add(a);
  }
  return [...out].sort();
}
