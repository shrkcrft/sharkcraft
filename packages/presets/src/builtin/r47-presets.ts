import { WorkspaceProfile } from '@shrkcrft/workspace';
import { definePreset } from '../define/define-preset.ts';
import type { IPreset } from '../model/preset.ts';
import {
  ANGULAR_PATH_APP,
  ANGULAR_PATH_COMPONENTS,
  ANGULAR_PATH_SERVICES,
  COMMON_AGENT_BRIEFING,
  COMMON_SAFETY_RULE,
  NEST_PATH_E2E,
  NEST_PATH_SRC,
  OVERVIEW_DOC,
} from './shared-snippets.ts';

// Universal adoption (top 5) — canonical-id aliases.
//
// Why: canonical preset ids are `nest-service` and `angular-app`. The
// engine also ships `nestjs-service` and 12 angular variants
// (`modern-angular`, `angular-signals-first`, …). New users type the
// canonical id and expect it to work. These aliases compose the
// existing presets so users get the *same* asset set as before.
//
// Weight is bumped by 1 above the composed preset so the recommender
// picks the canonical alias when both match the same profiles.

export const NEST_SERVICE_PRESET: IPreset = definePreset({
  id: 'nest-service',
  title: 'NestJS service',
  description:
    'Canonical alias for the NestJS service preset. Composes the `nestjs-service` baseline: typed controllers, providers under a module, DTO validation pipes, e2e tests under `test/`.',
  tags: ['nest', 'nestjs', 'service', 'backend'],
  appliesTo: [WorkspaceProfile.HasNestJS, WorkspaceProfile.IsBackend, WorkspaceProfile.IsService],
  weight: 9,
  composes: ['nestjs-service'],
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE],
    paths: [NEST_PATH_SRC, NEST_PATH_E2E],
    templates: [],
    pipelines: [],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'NestJS service',
        'Controllers stay thin; business logic lives in providers under a module. DTOs validate at the boundary. e2e tests live under `test/`.',
      ),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk ci scaffold github-actions --quickstart',
    'shrk task "<task>"',
  ],
});

export const ANGULAR_APP_PRESET: IPreset = definePreset({
  id: 'angular-app',
  title: 'Angular app',
  description:
    'Canonical alias for a modern Angular app. Composes `modern-angular` (signals-first, OnPush, standalone components, RxJS disciplined). Use the more specific `angular-*` variants only if you want a narrower subset.',
  tags: ['angular', 'app', 'frontend'],
  appliesTo: [WorkspaceProfile.HasAngular, WorkspaceProfile.IsFrontend],
  weight: 10,
  composes: ['modern-angular'],
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE],
    paths: [ANGULAR_PATH_APP, ANGULAR_PATH_COMPONENTS, ANGULAR_PATH_SERVICES],
    templates: [],
    pipelines: [],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Angular app',
        'Modern Angular baseline: signals-first reactivity, OnPush change detection, standalone components, RxJS used deliberately, accessible templates.',
      ),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk ci scaffold github-actions --quickstart',
    'shrk task "<task>"',
  ],
});

export const CANONICAL_ALIAS_PRESETS: readonly IPreset[] = Object.freeze([
  NEST_SERVICE_PRESET,
  ANGULAR_APP_PRESET,
]);
