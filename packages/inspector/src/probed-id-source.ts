/**
 * The asset kinds whose id-list fields the self-config doctor probes through
 * THE id resolver via {@link PROBED_ID_FIELDS} (each value is also the
 * finding's `sourceKind` and the prefix of its `<source>-<label>-missing` code).
 */
export enum ProbedIdSource {
  Template = 'template',
  RegistrationHint = 'registration-hint',
  Convention = 'convention',
}
