/**
 * What a declared asset reference points at.
 *
 * ONE vocabulary for every asset that can declare `references[]` — knowledge
 * entries, boundary rules, policy checks. It lives in core, below every
 * package that declares or checks a reference, so the boundary engine and the
 * inspector's staleness sweep read the same list the knowledge model does. Two
 * spellings of "which kinds exist" would be the two-authorities bug again: a
 * kind one validator accepts and another rejects.
 */
export type AssetReferenceKind =
  | 'file'
  | 'directory'
  | 'symbol'
  | 'command'
  | 'template'
  | 'playbook'
  | 'construct'
  | 'helper'
  | 'policy'
  | 'boundary-rule'
  | 'path-convention'
  | 'package'
  | 'url';

/** Every valid {@link AssetReferenceKind}, for schema-level membership checks. */
export const ASSET_REFERENCE_KINDS: readonly AssetReferenceKind[] = [
  'file',
  'directory',
  'symbol',
  'command',
  'template',
  'playbook',
  'construct',
  'helper',
  'policy',
  'boundary-rule',
  'path-convention',
  'package',
  'url',
];
