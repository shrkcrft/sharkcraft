/**
 * THE field → kind binding table for the asset id-list fields the self-config
 * doctor probes (round 12, 12.3).
 *
 * The 12.3 defect was a BINDING, not a missing registry: `discovery.profileIds`
 * (a WorkspaceProfile applicability filter) was probed against
 * `migration-profile`, a readiness-gate registry, so it sat at NOT VERIFIED
 * forever — and filling that unrelated registry flipped the doctor to a false
 * "not registered" for a real, detected profile. The template path answered
 * the same question against the same wrong kind with no empty-registry guard.
 *
 * The doctor's template, registration-hint and convention families iterate
 * THIS table (each row through `probeIds`, THE resolver's loud-skip path), and
 * the r76 binding lock proves every `*Ids` field of `IConventionAppliesTo`,
 * `IRegistrationHintDiscovery` and template `metadata` has a row naming a
 * declarable kind — so a new id-bearing field cannot ship unbound, and a
 * binding cannot silently point at the wrong registry again.
 */
import type { IProbedIdField } from './i-probed-id-field.ts';
import { ProbedIdSource } from './probed-id-source.ts';

export const PROBED_ID_FIELDS: readonly IProbedIdField[] = Object.freeze([
  { source: ProbedIdSource.Template, field: 'metadata.requiredConventionIds', kind: 'convention', label: 'convention' },
  { source: ProbedIdSource.Template, field: 'metadata.requiredHelperIds', kind: 'helper', label: 'helper' },
  { source: ProbedIdSource.Template, field: 'metadata.requiredProfileIds', kind: 'workspace-profile', label: 'profile' },
  {
    source: ProbedIdSource.Template,
    field: 'metadata.registrationHintIds',
    kind: 'registration-hint',
    label: 'registration-hint',
  },
  {
    source: ProbedIdSource.RegistrationHint,
    field: 'discovery.conventionIds',
    kind: 'convention',
    label: 'convention',
  },
  {
    source: ProbedIdSource.RegistrationHint,
    field: 'discovery.profileIds',
    kind: 'workspace-profile',
    label: 'profile',
  },
  { source: ProbedIdSource.Convention, field: 'appliesTo.profileIds', kind: 'workspace-profile', label: 'profile' },
] satisfies readonly IProbedIdField[]);
