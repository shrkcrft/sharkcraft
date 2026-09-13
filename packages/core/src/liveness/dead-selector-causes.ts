/**
 * THE only source of the explanation a dead selector unit is printed with
 * (round 13, spec 13.1). The round-12 question offered two causes and omitted
 * the common third — the target does not exist yet — which a pre-emptive
 * fence writes on purpose. An r77 lock forbids the old wording anywhere in
 * `packages/*\/src`.
 */
export const DEAD_SELECTOR_CAUSES = 'typo, retired target, or a target that does not exist yet (see expectEmpty)';
