// React 19+ preset family.
//
// Eight presets — seven focused on a single slice of the modernisation
// surface, one comprehensive `react-19-modern` that composes the rest.
// Targets HasReact workspaces with weight 11-12 so the recommender
// prefers these when the workspace is React-based. The existing legacy
// `frontend-app` (weight 6) stays for projects pinned to it.
//
// Each preset's `paths` references the canonical React SPA structure
// (src/components, src/hooks, src/pages, src/lib) — the init paths
// advisory annotator flags any of these that don't exist in the live
// workspace, so RSC-framework users (Next.js app router under app/) see
// the mismatch immediately.

import { WorkspaceProfile } from '@shrkcrft/workspace';
import { definePreset } from '../define/define-preset.ts';
import type { IPreset } from '../model/preset.ts';
import {
  COMMON_AGENT_BRIEFING,
  COMMON_PIPELINE_CONTEXT_ONLY,
  COMMON_PIPELINE_FEATURE_DEV,
  COMMON_PIPELINE_UNIT_TEST,
  COMMON_SAFETY_RULE,
  OVERVIEW_DOC,
  REACT_PATH_COMPONENTS,
  REACT_PATH_HOOKS,
  REACT_PATH_LIB,
  REACT_PATH_PAGES,
} from './shared-snippets.ts';
import {
  REACT19_ASYNC_TRANSITIONS,
  REACT19_AVOID_PROP_DRILLING,
  REACT19_CLIENT_STATE_PROPORTIONAL,
  REACT19_COMPILER_AUTO_MEMO,
  REACT19_CONTEXT_AS_PROVIDER,
  REACT19_CUSTOM_HOOK_NAMING,
  REACT19_DOCUMENT_METADATA,
  REACT19_EFFECT_CLEANUP,
  REACT19_FORMS_LIBRARY,
  REACT19_FORM_ACTIONS,
  REACT19_FUNCTION_COMPONENTS,
  REACT19_IMAGE_OPTIMIZATION,
  REACT19_KEYS_FOR_RESET,
  REACT19_LAZY_SUSPENSE,
  REACT19_MSW,
  REACT19_NO_DERIVED_STATE_IN_EFFECT,
  REACT19_NO_FETCH_IN_EFFECT,
  REACT19_NO_REACT_FC,
  REACT19_PROPS_INTERFACE,
  REACT19_REF_AS_PROP,
  REACT19_RULES_OF_HOOKS,
  REACT19_SELF_CLOSING,
  REACT19_SERVER_ACTIONS,
  REACT19_SERVER_COMPONENTS_DEFAULT,
  REACT19_SERVER_STATE_LIBRARY,
  REACT19_STABLE_KEYS,
  REACT19_STREAMING_SSR,
  REACT19_STRICT_MODE,
  REACT19_STYLESHEETS_IN_TREE,
  REACT19_SUSPENSE_BOUNDARIES,
  REACT19_TEST_BEHAVIOR_NOT_IMPL,
  REACT19_TESTING_LIBRARY,
  REACT19_USE_ACTION_STATE,
  REACT19_USE_CLIENT_BOUNDARY,
  REACT19_USE_DEFERRED_VALUE,
  REACT19_USE_EFFECT_FOR_EXTERNAL_SYNC,
  REACT19_USE_FORM_STATUS,
  REACT19_USE_HOOK,
  REACT19_USE_OPTIMISTIC,
  REACT19_USE_TRANSITION,
  REACT19_VIRTUALIZE_LISTS,
  REACT19_VITEST,
} from './react19-snippets.ts';

const REACT19_TAGS = ['react', 'react-19', 'frontend'];
const REACT19_NEXT_COMMANDS = [
  'shrk doctor',
  'shrk task "<task>"',
  'shrk ci scaffold github-actions --quickstart',
];

// ─── 1) Modern component shape ────────────────────────────────────────────

export const REACT_19_MODERN_COMPONENTS: IPreset = definePreset({
  id: 'react-19-modern-components',
  title: 'React 19 — modern component shape',
  description:
    'Function components only (no class components, no React.FC), props declared as interfaces, ref accepted as a regular prop (no forwardRef in the common case), <Context> rendered as the provider directly, document metadata in the component tree, scoped stylesheets via <link precedence>.',
  tags: [...REACT19_TAGS, 'components'],
  appliesTo: [WorkspaceProfile.HasReact, WorkspaceProfile.IsFrontend],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      REACT19_FUNCTION_COMPONENTS,
      REACT19_NO_REACT_FC,
      REACT19_PROPS_INTERFACE,
      REACT19_REF_AS_PROP,
      REACT19_CONTEXT_AS_PROVIDER,
      REACT19_DOCUMENT_METADATA,
      REACT19_STYLESHEETS_IN_TREE,
      REACT19_SELF_CLOSING,
    ],
    paths: [REACT_PATH_COMPONENTS, REACT_PATH_HOOKS, REACT_PATH_LIB],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'React 19 modern components',
        'Function components only. No React.FC, no class components for new code. Props live in interfaces. Refs are regular props. <MyContext value={x}>{children}</MyContext> — no .Provider. Document metadata (<title>, <meta>) renders inside the tree; React hoists it.',
      ),
    },
  },
  recommendedNextCommands: REACT19_NEXT_COMMANDS,
});

// ─── 2) Hooks discipline ──────────────────────────────────────────────────

export const REACT_19_HOOKS_DISCIPLINE: IPreset = definePreset({
  id: 'react-19-hooks-discipline',
  title: 'React 19 — hooks discipline',
  description:
    'Rules of hooks enforced via eslint-plugin-react-hooks (errors, not warnings). useEffect is for external-system sync only — derived state is computed during render, event responses live in handlers, fetches live in a server-state library, state resets are keyed. Custom hooks start with `use` and clean up their subscriptions.',
  tags: [...REACT19_TAGS, 'hooks'],
  appliesTo: [WorkspaceProfile.HasReact],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      REACT19_RULES_OF_HOOKS,
      REACT19_USE_EFFECT_FOR_EXTERNAL_SYNC,
      REACT19_NO_DERIVED_STATE_IN_EFFECT,
      REACT19_NO_FETCH_IN_EFFECT,
      REACT19_CUSTOM_HOOK_NAMING,
      REACT19_EFFECT_CLEANUP,
      REACT19_KEYS_FOR_RESET,
    ],
    paths: [REACT_PATH_HOOKS, REACT_PATH_COMPONENTS],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'React 19 hooks discipline',
        'Hooks at the top, never conditional. useEffect ONLY for syncing with external systems. Derived values are computed in render. Fetches go through TanStack Query / SWR / RTK Query. State resets use a `key` prop on the consumer, not a useEffect.',
      ),
    },
  },
  recommendedNextCommands: REACT19_NEXT_COMMANDS,
});

// ─── 3) Actions + forms (React 19) ────────────────────────────────────────

export const REACT_19_ACTIONS_FORMS: IPreset = definePreset({
  id: 'react-19-actions-forms',
  title: 'React 19 — Actions, async transitions, optimistic UI',
  description:
    'The React 19 Actions surface: <form action> for submission, useActionState for result + pending + error in one hook, useFormStatus for child-level pending UI, useOptimistic for instant feedback on mutations, use() for promises and contexts in conditionals, async functions passed to startTransition / useTransition.',
  tags: [...REACT19_TAGS, 'actions', 'forms'],
  appliesTo: [WorkspaceProfile.HasReact, WorkspaceProfile.IsFrontend],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      REACT19_FORM_ACTIONS,
      REACT19_USE_ACTION_STATE,
      REACT19_USE_FORM_STATUS,
      REACT19_USE_OPTIMISTIC,
      REACT19_USE_HOOK,
      REACT19_ASYNC_TRANSITIONS,
    ],
    paths: [REACT_PATH_COMPONENTS, REACT_PATH_HOOKS],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'React 19 Actions',
        '<form action={async (fd) => ...}> for submission. useActionState owns pending + result. useFormStatus inside form children for spinners. useOptimistic for instant UI on writes. use(promise) inside Suspense. startTransition accepts async functions.',
      ),
    },
  },
  recommendedNextCommands: REACT19_NEXT_COMMANDS,
});

// ─── 4) State management — server, client, forms ─────────────────────────

export const REACT_19_STATE: IPreset = definePreset({
  id: 'react-19-state',
  title: 'React 19 — state management (server, client, forms)',
  description:
    'Server state in TanStack Query / SWR / RTK Query (never useState). Client state in the right shape for its scope: local useState, lifted state for siblings, Context for low-frequency cross-tree, a real store (Zustand / Jotai / RTK) for high-frequency cross-tree. Forms past trivial use React Hook Form + Zod.',
  tags: [...REACT19_TAGS, 'state'],
  appliesTo: [WorkspaceProfile.HasReact],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      REACT19_SERVER_STATE_LIBRARY,
      REACT19_CLIENT_STATE_PROPORTIONAL,
      REACT19_FORMS_LIBRARY,
      REACT19_AVOID_PROP_DRILLING,
      REACT19_KEYS_FOR_RESET,
    ],
    paths: [REACT_PATH_COMPONENTS, REACT_PATH_HOOKS, REACT_PATH_LIB],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'React 19 state',
        'Server state belongs in a query library — TanStack Query is the default. Client state is sized to its scope: local / lifted / Context (low-frequency only) / store (high-frequency). Non-trivial forms use React Hook Form + Zod. Long prop-drilling chains are a refactor signal.',
      ),
    },
  },
  recommendedNextCommands: REACT19_NEXT_COMMANDS,
});

// ─── 5) Performance — Compiler, lazy, virtualization, images ─────────────

export const REACT_19_PERFORMANCE: IPreset = definePreset({
  id: 'react-19-performance',
  title: 'React 19 — performance baseline',
  description:
    'React Compiler for automatic memoization (drops most hand-rolled useMemo / useCallback). Route-level code-splitting via React.lazy + Suspense. Virtualization past ~100 visible rows. Stable list keys (never the array index). Image dimensions explicit; lazy by default.',
  tags: [...REACT19_TAGS, 'performance'],
  appliesTo: [WorkspaceProfile.HasReact],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      REACT19_COMPILER_AUTO_MEMO,
      REACT19_LAZY_SUSPENSE,
      REACT19_VIRTUALIZE_LISTS,
      REACT19_STABLE_KEYS,
      REACT19_IMAGE_OPTIMIZATION,
    ],
    paths: [REACT_PATH_COMPONENTS, REACT_PATH_PAGES],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'React 19 performance',
        'Turn on the React Compiler (babel-plugin-react-compiler) and stop hand-rolling memo unless the profiler says otherwise. Route boundaries lazy-load. Long lists virtualize. List keys are stable ids, never the array index. Images carry explicit width/height + loading="lazy".',
      ),
    },
  },
  recommendedNextCommands: REACT19_NEXT_COMMANDS,
});

// ─── 6) Concurrent rendering ──────────────────────────────────────────────

export const REACT_19_CONCURRENT: IPreset = definePreset({
  id: 'react-19-concurrent',
  title: 'React 19 — concurrent rendering',
  description:
    'useTransition / startTransition to keep input responsive under slow updates, useDeferredValue (with React 19\'s initialValue) for lagged derived renders, deliberate Suspense-boundary placement for streaming reveal, StrictMode in dev to surface concurrency bugs early.',
  tags: [...REACT19_TAGS, 'concurrent'],
  appliesTo: [WorkspaceProfile.HasReact],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      REACT19_USE_TRANSITION,
      REACT19_USE_DEFERRED_VALUE,
      REACT19_SUSPENSE_BOUNDARIES,
      REACT19_STRICT_MODE,
      REACT19_ASYNC_TRANSITIONS,
    ],
    paths: [REACT_PATH_COMPONENTS, REACT_PATH_PAGES],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'React 19 concurrent rendering',
        'Slow updates go through startTransition. Derived expensive views use useDeferredValue. Suspense boundaries are placed where a UI region should reveal together. StrictMode catches missing cleanups and impure renders in dev. React 19: startTransition accepts async functions.',
      ),
    },
  },
  recommendedNextCommands: REACT19_NEXT_COMMANDS,
});

// ─── 7) Testing ──────────────────────────────────────────────────────────

export const REACT_19_TESTING: IPreset = definePreset({
  id: 'react-19-testing',
  title: 'React 19 — Vitest + Testing Library + userEvent + MSW',
  description:
    'Vitest for Vite-based apps, @testing-library/react for rendering + querying, userEvent.setup() for interactions (not fireEvent), MSW for network mocking, behavior-not-implementation as the testing posture.',
  tags: [...REACT19_TAGS, 'testing'],
  appliesTo: [WorkspaceProfile.HasReact],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      REACT19_VITEST,
      REACT19_TESTING_LIBRARY,
      REACT19_TEST_BEHAVIOR_NOT_IMPL,
      REACT19_MSW,
    ],
    paths: [REACT_PATH_COMPONENTS, REACT_PATH_HOOKS],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_UNIT_TEST],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'React 19 testing',
        'Vitest runs the suite. @testing-library/react queries by role/label/text. userEvent.setup() drives the keyboard + pointer. MSW intercepts fetch at the network. Asserts target what the user sees — not internal hooks or state.',
      ),
    },
  },
  recommendedNextCommands: REACT19_NEXT_COMMANDS,
});

// ─── 8) React Server Components (RSC frameworks) ─────────────────────────

export const REACT_19_RSC: IPreset = definePreset({
  id: 'react-19-rsc',
  title: 'React 19 — Server Components + Server Actions',
  description:
    'For framework-driven fullstack apps (Next.js app router, Remix, Waku): components are Server Components by default; "use client" is pushed to leaf components that actually need interactivity; Server Actions replace manual API routes for mutations; SSR streams through Suspense boundaries.',
  tags: [...REACT19_TAGS, 'rsc', 'ssr'],
  appliesTo: [WorkspaceProfile.HasReact, WorkspaceProfile.IsFrontend],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      REACT19_SERVER_COMPONENTS_DEFAULT,
      REACT19_USE_CLIENT_BOUNDARY,
      REACT19_SERVER_ACTIONS,
      REACT19_STREAMING_SSR,
      REACT19_SUSPENSE_BOUNDARIES,
    ],
    paths: [REACT_PATH_COMPONENTS, REACT_PATH_PAGES, REACT_PATH_LIB],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'React 19 Server Components',
        'Server-first by default in RSC frameworks. "use client" lives at the smallest interactive leaf, not the page root. Mutations go through Server Actions ("use server" functions) instead of manual API routes. SSR streams: shell ships first, slow data fills via Suspense.',
      ),
    },
  },
  recommendedNextCommands: REACT19_NEXT_COMMANDS,
});

// ─── 9) The whole stack — composes 1-7 ──────────────────────────────────

export const REACT_19_MODERN: IPreset = definePreset({
  id: 'react-19-modern',
  title: 'React 19 — modern stack (components + hooks + actions + state + perf + concurrent + testing)',
  description:
    'The canonical preset for a new React 19+ app. Composes seven focused presets — components, hooks discipline, Actions, state, performance, concurrent, testing — and leaves RSC opt-in via the separate react-19-rsc preset (only relevant for framework apps).',
  tags: [...REACT19_TAGS, 'comprehensive'],
  appliesTo: [WorkspaceProfile.HasReact, WorkspaceProfile.IsFrontend],
  weight: 12,
  composes: [
    'react-19-modern-components',
    'react-19-hooks-discipline',
    'react-19-actions-forms',
    'react-19-state',
    'react-19-performance',
    'react-19-concurrent',
    'react-19-testing',
  ],
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      // StrictMode and stable keys are baseline enough to repeat here.
      REACT19_STRICT_MODE,
      REACT19_STABLE_KEYS,
    ],
    paths: [REACT_PATH_COMPONENTS, REACT_PATH_HOOKS, REACT_PATH_PAGES, REACT_PATH_LIB],
    templates: [],
    pipelines: [
      COMMON_PIPELINE_CONTEXT_ONLY,
      COMMON_PIPELINE_FEATURE_DEV,
      COMMON_PIPELINE_UNIT_TEST,
    ],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'React 19 modern stack',
        'Function components, no React.FC, ref-as-prop. Hooks at the top, useEffect only for external sync. <form action> + useActionState + useOptimistic for forms. TanStack Query for server state; the right shape for client state. React Compiler does memo for you. Lazy + Suspense for code-split. useTransition / useDeferredValue under load. Vitest + Testing Library + userEvent + MSW. Add react-19-rsc if the project is on a Server Components framework.',
      ),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk surface list',
    'shrk task "<task>"',
    'shrk presets get react-19-rsc   # add this preset if using Next.js / Remix / Waku',
  ],
  surfaceProfile: 'small-app',
});

export const REACT_19_PRESETS: readonly IPreset[] = Object.freeze([
  REACT_19_MODERN_COMPONENTS,
  REACT_19_HOOKS_DISCIPLINE,
  REACT_19_ACTIONS_FORMS,
  REACT_19_STATE,
  REACT_19_PERFORMANCE,
  REACT_19_CONCURRENT,
  REACT_19_TESTING,
  REACT_19_RSC,
  REACT_19_MODERN,
]);
