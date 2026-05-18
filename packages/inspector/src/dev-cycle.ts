/**
 * Dev cycle orchestrator.
 *
 * Plans (and renders) a deterministic sequence of read/check commands for a
 * given dev-cycle profile. The actual *execution* lives in the CLI command;
 * this module is pure data + planning.
 *
 * Profiles ship with the engine, and they all consist of read-only or
 * preview-only commands. Auto-fix and auto-apply are never produced here.
 */

export const DEV_CYCLE_SCHEMA = 'sharkcraft.dev-cycle/v1';

export enum DevCycleProfileId {
  SharkcraftSelf = 'sharkcraft-self',
  PackAuthor = 'pack-author',
  ProjectConsumer = 'project-consumer',
  Release = 'release',
}

export interface IDevCycleStep {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly canFail: boolean;
  readonly category: 'doctor' | 'check' | 'audit' | 'gate' | 'preview' | 'docs';
}

export interface IDevCycleProfile {
  readonly id: DevCycleProfileId;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly IDevCycleStep[];
}

const SHARKCRAFT_SELF: IDevCycleProfile = {
  id: DevCycleProfileId.SharkcraftSelf,
  title: 'SharkCraft self — coherence + safety',
  description:
    'End-to-end cycle for working on the SharkCraft engine itself. All read-only / preview-only.',
  steps: [
    { id: 'doctor', title: 'Workspace doctor', command: 'shrk doctor', canFail: false, category: 'doctor' },
    { id: 'self-config-doctor', title: 'Self-config doctor', command: 'shrk self-config doctor', canFail: true, category: 'doctor' },
    { id: 'knowledge-stale-check', title: 'Knowledge stale-check (CI)', command: 'shrk knowledge stale-check --ci', canFail: true, category: 'gate' },
    { id: 'templates-drift', title: 'Templates drift (warning+)', command: 'shrk templates drift --min-severity warning', canFail: true, category: 'gate' },
    { id: 'test-agent', title: 'Agent contract tests', command: 'shrk test agent', canFail: false, category: 'gate' },
    { id: 'commands-doctor', title: 'Commands doctor', command: 'shrk commands doctor', canFail: true, category: 'doctor' },
    { id: 'safety-audit', title: 'Safety audit (deep)', command: 'shrk safety audit --deep', canFail: false, category: 'audit' },
  ],
};

const PACK_AUTHOR: IDevCycleProfile = {
  id: DevCycleProfileId.PackAuthor,
  title: 'Pack author — quality + contributions',
  description: 'Cycle for authoring or maintaining a SharkCraft pack.',
  steps: [
    { id: 'packs-doctor', title: 'Packs doctor', command: 'shrk packs doctor', canFail: true, category: 'doctor' },
    { id: 'packs-contributions', title: 'Packs contributions inventory', command: 'shrk packs contributions', canFail: true, category: 'audit' },
    { id: 'packs-conflicts', title: 'Packs conflicts', command: 'shrk packs conflicts', canFail: true, category: 'audit' },
    { id: 'helper-doctor', title: 'Helper doctor (engine helpers)', command: 'shrk helper doctor', canFail: true, category: 'doctor' },
    { id: 'feedback-rules-doctor', title: 'Feedback rules doctor', command: 'shrk feedback rules doctor', canFail: true, category: 'doctor' },
    { id: 'self-config-doctor', title: 'Self-config doctor', command: 'shrk self-config doctor', canFail: true, category: 'doctor' },
  ],
};

const PROJECT_CONSUMER: IDevCycleProfile = {
  id: DevCycleProfileId.ProjectConsumer,
  title: 'Project consumer — daily dev safety',
  description: 'Daily safety loop for a project that consumes SharkCraft packs.',
  steps: [
    { id: 'doctor', title: 'Workspace doctor', command: 'shrk doctor', canFail: false, category: 'doctor' },
    { id: 'boundaries-changed-only', title: 'Boundaries (changed-only)', command: 'shrk check boundaries --changed-only', canFail: true, category: 'gate' },
    { id: 'conventions-check', title: 'Conventions check (changed)', command: 'shrk conventions check', canFail: true, category: 'gate' },
    { id: 'knowledge-stale-check', title: 'Knowledge stale-check', command: 'shrk knowledge stale-check', canFail: true, category: 'gate' },
    { id: 'templates-drift', title: 'Templates drift', command: 'shrk templates drift', canFail: true, category: 'gate' },
  ],
};

const RELEASE: IDevCycleProfile = {
  id: DevCycleProfileId.Release,
  title: 'Release — preflight + readiness',
  description: 'Cycle for shipping a release. Read-only inspection; humans run the actual publish.',
  steps: [
    { id: 'release-readiness', title: 'Release readiness (strict)', command: 'shrk release readiness --strict', canFail: false, category: 'gate' },
    { id: 'release-smoke', title: 'Release smoke (default scenarios)', command: 'shrk release smoke', canFail: true, category: 'gate' },
    { id: 'safety-audit', title: 'Safety audit', command: 'shrk safety audit', canFail: false, category: 'audit' },
    { id: 'product-check', title: 'Product check', command: 'shrk product check', canFail: true, category: 'gate' },
    { id: 'commands-doctor', title: 'Commands doctor', command: 'shrk commands doctor', canFail: true, category: 'doctor' },
  ],
};

export const BUILTIN_DEV_CYCLE_PROFILES: readonly IDevCycleProfile[] = [
  SHARKCRAFT_SELF,
  PACK_AUTHOR,
  PROJECT_CONSUMER,
  RELEASE,
];

export interface IDevCyclePlanReport {
  readonly schema: typeof DEV_CYCLE_SCHEMA;
  readonly profileId: DevCycleProfileId;
  readonly profileTitle: string;
  readonly steps: readonly IDevCycleStep[];
  readonly notes: readonly string[];
}

export function planDevCycle(profileId: DevCycleProfileId): IDevCyclePlanReport | null {
  const p = BUILTIN_DEV_CYCLE_PROFILES.find((x) => x.id === profileId);
  if (!p) return null;
  return {
    schema: DEV_CYCLE_SCHEMA,
    profileId: p.id,
    profileTitle: p.title,
    steps: p.steps,
    notes: [
      'All steps are read-only / preview-only. The cycle never auto-applies.',
      'When a step exits non-zero, the loop stops unless --continue-on-error is set.',
      'Run with --until-green to repeat until every non-`canFail` step passes.',
    ],
  };
}

export function listDevCycleProfiles(): readonly IDevCycleProfile[] {
  return BUILTIN_DEV_CYCLE_PROFILES;
}
