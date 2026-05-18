// Modern Angular 18 / 19 / 20 / 21 preset family.
//
// Six presets — five focused on a single area of the modernisation surface,
// one comprehensive that composes the rest. They target Angular workspaces
// (HasAngular) with `weight` set above `modern-angular` (R26, weight 9) so
// the recommender prefers them when the workspace shape allows.
//
// Each preset's `paths` includes the standard Angular structure
// (src/app/, src/app/components/, src/app/services/) so the init paths
// advisory annotator can verify against the live workspace.

import { WorkspaceProfile } from '@shrkcrft/workspace';
import { definePreset } from '../define/define-preset.ts';
import type { IPreset } from '../model/preset.ts';
import {
  ANGULAR_PATH_APP,
  ANGULAR_PATH_COMPONENTS,
  ANGULAR_PATH_SERVICES,
  COMMON_AGENT_BRIEFING,
  COMMON_PIPELINE_CONTEXT_ONLY,
  COMMON_PIPELINE_FEATURE_DEV,
  COMMON_PIPELINE_UNIT_TEST,
  COMMON_SAFETY_RULE,
  OVERVIEW_DOC,
} from './shared-snippets.ts';
import {
  NG21_AFTER_RENDER,
  NG21_BOOTSTRAP_APPLICATION,
  NG21_CONTROL_FLOW,
  NG21_DEFER,
  NG21_HTTP_RESOURCE,
  NG21_HYBRID_RENDERING,
  NG21_INJECT_FN,
  NG21_LET_TEMPLATE,
  NG21_LINKED_SIGNAL,
  NG21_MODEL_TWO_WAY,
  NG21_NG_OPTIMIZED_IMAGE,
  NG21_NO_EFFECT_FOR_DERIVED,
  NG21_NO_NGMODULES,
  NG21_NO_ZONE_APIS,
  NG21_PROVIDE_HTTP_FETCH,
  NG21_PROVIDED_IN_ROOT,
  NG21_RESOURCE_API,
  NG21_SELF_CLOSING_TAGS,
  NG21_SIGNAL_CONTENT_CHILD,
  NG21_SIGNAL_FORMS_INTEROP,
  NG21_SIGNAL_INPUTS,
  NG21_SIGNAL_OUTPUTS,
  NG21_SIGNAL_STATE,
  NG21_SIGNAL_VIEW_CHILD,
  NG21_TEST_NO_DETECT_CHANGES_OUTSIDE,
  NG21_TEST_SIGNAL_INPUT,
  NG21_ZONELESS,
} from './angular21-snippets.ts';

const NG21_TAGS = ['angular', 'angular-21', 'modern'];
const NG21_NEXT_COMMANDS = [
  'shrk doctor',
  'shrk task "<task>"',
  'shrk ci scaffold github-actions --quickstart',
];

// ─── 1) Signals — state, queries, inputs, outputs, model ─────────────────

export const ANGULAR_21_SIGNALS: IPreset = definePreset({
  id: 'angular-21-signals',
  title: 'Angular 21 — signal-everything',
  description:
    'Signal-based local state, queries (viewChild / viewChildren / contentChild / contentChildren as functions), inputs (input() / input.required()), outputs (output()), and two-way bindings (model()). Replaces every @Input/@Output/@ViewChild decorator with its signal-era counterpart.',
  tags: [...NG21_TAGS, 'signals'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NG21_SIGNAL_STATE,
      NG21_LINKED_SIGNAL,
      NG21_NO_EFFECT_FOR_DERIVED,
      NG21_SIGNAL_VIEW_CHILD,
      NG21_SIGNAL_CONTENT_CHILD,
      NG21_SIGNAL_INPUTS,
      NG21_SIGNAL_OUTPUTS,
      NG21_MODEL_TWO_WAY,
      NG21_SIGNAL_FORMS_INTEROP,
    ],
    paths: [ANGULAR_PATH_APP, ANGULAR_PATH_COMPONENTS, ANGULAR_PATH_SERVICES],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Angular 21 signals',
        'No @Input, no @Output, no @ViewChild, no EventEmitter. Local state in signal(), derived in computed()/linkedSignal(), side effects in effect(), queries via viewChild()/contentChild(), I/O via input()/output()/model().',
      ),
    },
  },
  recommendedNextCommands: NG21_NEXT_COMMANDS,
});

// ─── 2) Zoneless ──────────────────────────────────────────────────────────

export const ANGULAR_21_ZONELESS: IPreset = definePreset({
  id: 'angular-21-zoneless',
  title: 'Angular 21 — zoneless change detection',
  description:
    'Bootstrap with provideZonelessChangeDetection() and remove zone.js entirely. Codifies the "no NgZone APIs, signals drive CD" posture, plus the migration hints (signal-first state, afterNextRender for DOM-aware work).',
  tags: [...NG21_TAGS, 'zoneless', 'performance'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NG21_ZONELESS,
      NG21_NO_ZONE_APIS,
      NG21_SIGNAL_STATE,
      NG21_AFTER_RENDER,
      NG21_BOOTSTRAP_APPLICATION,
      NG21_PROVIDE_HTTP_FETCH,
    ],
    paths: [ANGULAR_PATH_APP, ANGULAR_PATH_COMPONENTS, ANGULAR_PATH_SERVICES],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Angular 21 zoneless',
        'CD runs when signals change, inputs update, or events fire — not on every microtask. No NgZone.run / runOutsideAngular. DOM-aware code uses afterNextRender(). HttpClient uses the fetch backend.',
      ),
    },
  },
  recommendedNextCommands: NG21_NEXT_COMMANDS,
});

// ─── 3) Modern control flow + template ergonomics ────────────────────────

export const ANGULAR_21_CONTROL_FLOW: IPreset = definePreset({
  id: 'angular-21-control-flow',
  title: 'Angular 21 — modern template control flow',
  description:
    'Built-in @if / @for / @switch / @defer / @let blocks instead of *ngIf / *ngFor / [ngSwitch], self-closing component tags, NgOptimizedImage. Includes the migration guidance for legacy templates.',
  tags: [...NG21_TAGS, 'templates', 'control-flow'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NG21_CONTROL_FLOW,
      NG21_DEFER,
      NG21_LET_TEMPLATE,
      NG21_SELF_CLOSING_TAGS,
      NG21_NG_OPTIMIZED_IMAGE,
    ],
    paths: [ANGULAR_PATH_APP, ANGULAR_PATH_COMPONENTS],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Angular 21 control flow',
        '@if / @for (track is REQUIRED) / @switch / @defer / @let. Self-closing tags for content-less components. NgOptimizedImage with explicit width/height for every raster image.',
      ),
    },
  },
  recommendedNextCommands: [
    ...NG21_NEXT_COMMANDS,
    'ng generate @angular/core:control-flow',
  ],
});

// ─── 4) Resource API — declarative async (signal-native) ─────────────────

export const ANGULAR_21_RESOURCE: IPreset = definePreset({
  id: 'angular-21-resource',
  title: 'Angular 21 — resource() / httpResource() / linkedSignal',
  description:
    'Declarative async state via resource() and httpResource(). Replaces the hand-rolled subscribe+loading+error triplet with a typed state machine driven by signals. Includes the linkedSignal pattern for writable derived values.',
  tags: [...NG21_TAGS, 'async', 'resource'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NG21_RESOURCE_API,
      NG21_HTTP_RESOURCE,
      NG21_LINKED_SIGNAL,
      NG21_PROVIDE_HTTP_FETCH,
      NG21_SIGNAL_STATE,
    ],
    paths: [ANGULAR_PATH_SERVICES, ANGULAR_PATH_APP],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Angular 21 resource API',
        'resource({ request, loader }) is the canonical async primitive — exposes value()/status()/error()/reload() as signals. httpResource(() => `/api/...`) for read endpoints. linkedSignal for writable state that follows a source.',
      ),
    },
  },
  recommendedNextCommands: NG21_NEXT_COMMANDS,
});

// ─── 5) Modern DI + lifecycle + bootstrap ────────────────────────────────

export const ANGULAR_21_MODERN_DI: IPreset = definePreset({
  id: 'angular-21-modern-di',
  title: 'Angular 21 — inject(), no NgModules, bootstrap modern',
  description:
    'inject() function over constructor parameters, providedIn root for tree-shakeable services, no new NgModules, bootstrapApplication() with the provideX() function family, afterNextRender() for DOM-aware lifecycle.',
  tags: [...NG21_TAGS, 'di', 'lifecycle', 'bootstrap'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NG21_INJECT_FN,
      NG21_PROVIDED_IN_ROOT,
      NG21_NO_NGMODULES,
      NG21_BOOTSTRAP_APPLICATION,
      NG21_AFTER_RENDER,
      NG21_PROVIDE_HTTP_FETCH,
    ],
    paths: [ANGULAR_PATH_APP, ANGULAR_PATH_SERVICES],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Angular 21 modern DI + bootstrap',
        'inject() over constructor injection. @Injectable({ providedIn: "root" }) for tree-shakeable services. No new @NgModule. main.ts uses bootstrapApplication(AppComponent, { providers: [provideRouter, provideHttpClient(withFetch()), provideZonelessChangeDetection(), provideAnimationsAsync()] }).',
      ),
    },
  },
  recommendedNextCommands: NG21_NEXT_COMMANDS,
});

// ─── 6) The whole stack — composes all of the above ──────────────────────

export const ANGULAR_21_MODERN: IPreset = definePreset({
  id: 'angular-21-modern',
  title: 'Angular 21 — modern stack (signals + zoneless + control-flow + resource + DI)',
  description:
    'The canonical preset for a new Angular 21 app. Composes signals-everything, zoneless CD, modern control flow, resource() async, and inject()-based DI — plus the testing rules for signal inputs and SSR-safe HTTP. Use this unless you specifically want a narrower slice.',
  tags: [...NG21_TAGS, 'comprehensive'],
  appliesTo: [WorkspaceProfile.HasAngular, WorkspaceProfile.IsFrontend],
  weight: 12,
  composes: [
    'angular-21-signals',
    'angular-21-zoneless',
    'angular-21-control-flow',
    'angular-21-resource',
    'angular-21-modern-di',
  ],
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      // Extras that don't fit into any single focused preset:
      NG21_HYBRID_RENDERING,
      NG21_TEST_SIGNAL_INPUT,
      NG21_TEST_NO_DETECT_CHANGES_OUTSIDE,
    ],
    paths: [ANGULAR_PATH_APP, ANGULAR_PATH_COMPONENTS, ANGULAR_PATH_SERVICES],
    templates: [],
    pipelines: [
      COMMON_PIPELINE_CONTEXT_ONLY,
      COMMON_PIPELINE_FEATURE_DEV,
      COMMON_PIPELINE_UNIT_TEST,
    ],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Angular 21 modern stack',
        'No decorators where a signal-era function exists. Zoneless CD. @if/@for/@defer/@let templates. resource() and httpResource() for async. inject() everywhere. bootstrapApplication with provideX functions — no NgModules. SSR via per-route RenderMode tags. Test signal inputs via fixture.componentRef.setInput().',
      ),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk surface list',
    'shrk task "<task>"',
    'ng generate @angular/core:control-flow',
    'ng generate @angular/core:signal-input-migration',
    'ng generate @angular/core:signal-queries-migration',
    'ng generate @angular/core:output-migration',
  ],
  surfaceProfile: 'small-app',
});

export const ANGULAR_21_PRESETS: readonly IPreset[] = Object.freeze([
  ANGULAR_21_SIGNALS,
  ANGULAR_21_ZONELESS,
  ANGULAR_21_CONTROL_FLOW,
  ANGULAR_21_RESOURCE,
  ANGULAR_21_MODERN_DI,
  ANGULAR_21_MODERN,
]);
