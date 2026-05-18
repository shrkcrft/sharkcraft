/**
 * Pack-contributed policy check declaration. Packs that ship
 * `policyCheckFiles` default-export an array of these definitions.
 *
 * SharkCraft's policy engine executes the predicate against the current
 * inspection plus plan/bundle targets. A predicate must be a pure function
 * (no shell, no network).
 */
export type PolicySeverityLabel = 'info' | 'warning' | 'error' | 'critical';

export type PolicyCheckTypeLabel =
  | 'path'
  | 'import'
  | 'ownership'
  | 'command'
  | 'template'
  | 'plan'
  | 'bundle'
  | 'session';

export interface IPackPolicyCheckEvaluation {
  message: string;
  suggestedFix?: string;
  context?: Record<string, unknown>;
}

export interface IPackPolicyCheck {
  id: string;
  title: string;
  severity?: PolicySeverityLabel;
  checkType?: PolicyCheckTypeLabel;
  evaluate: (input: {
    projectRoot: string;
    planTargets: readonly string[];
    bundleAffectedFiles: readonly string[];
  }) => boolean | IPackPolicyCheckEvaluation;
}

export function definePackPolicyCheck(check: IPackPolicyCheck): IPackPolicyCheck {
  return check;
}
