/**
 * Why a declared reference could not be resolved — as opposed to resolving
 * NOWHERE (a `*-missing` finding) (round 12, ONE-CHANGE).
 */
export enum UnresolvableReason {
  /** Its kind's registry is empty in this workspace — declare one (the declaration table names how). */
  RegistryEmpty = 'registry-empty',
  /** No builtin, config key, local file or pack key can EVER fill its kind (THE declarability authority). */
  UndeclarableKind = 'undeclarable-kind',
}
