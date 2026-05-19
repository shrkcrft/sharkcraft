// React 19+ rule snippets.
//
// Covers: function components (no React.FC, no class components for new
// code), ref-as-a-prop (no more forwardRef in the common case), Context
// rendered as a provider directly, the new Actions surface (useActionState
// / useFormStatus / useOptimistic / use()), async transitions, document
// metadata in the component tree, React Compiler auto-memoization (and
// the implication for hand-rolled useMemo / useCallback), useEffect
// discipline (sync-with-external-systems ONLY), Suspense + concurrent
// features (useTransition / useDeferredValue), TanStack Query for server
// state and React Hook Form + Zod for forms, Vitest + Testing Library
// + userEvent + MSW testing patterns, and React Server Components +
// 'use client' + Server Actions for framework-driven fullstack apps.
//
// Each snippet is a string injected verbatim into a generated
// `sharkcraft/*.ts` file. `defineKnowledgeEntry`, `KnowledgeType`, and
// `KnowledgePriority` are provided by the local-mirror preamble the
// synthesizer prepends.

import { ruleSnippet } from './r26-snippets.ts';

// ─── Modern component shape ────────────────────────────────────────────────

export const REACT19_FUNCTION_COMPONENTS = ruleSnippet({
  id: 'react19.function-components',
  title: 'New components are function components — no class components',
  priority: 'critical',
  tags: ['react', 'react-19', 'components'],
  appliesWhen: ['generate-component', 'refactor'],
  content:
    'Write every new component as a plain function: `export function Profile(props: ProfileProps) { ... }`. No `class extends Component`, no `React.PureComponent`. The only legitimate class-component touch is when porting / interop with a legacy boundary.',
});

export const REACT19_NO_REACT_FC = ruleSnippet({
  id: 'react19.no-react-fc',
  title: 'Do not type components as React.FC',
  priority: 'high',
  tags: ['react', 'react-19', 'typescript'],
  appliesWhen: ['generate-component', 'review'],
  content:
    'Type the props directly and annotate the function: `function Profile(props: ProfileProps): ReactNode { ... }`. `React.FC` injects an implicit `children` prop, drops generics, and the community has moved away from it. If a component takes children, declare them in the props interface explicitly.',
});

export const REACT19_PROPS_INTERFACE = ruleSnippet({
  id: 'react19.props-interface',
  title: 'Declare props as an interface, not an inline type',
  priority: 'medium',
  tags: ['react', 'react-19', 'typescript', 'components'],
  appliesWhen: ['generate-component'],
  content:
    'Define `interface IProfileProps { … }` (or `ProfileProps` if your style avoids the I-prefix) above the component. Inline `{ user, count }: { user: User; count: number }` is fine for one-off components but doesn\'t scale — once a prop type appears in two places, lift it into an interface.',
});

export const REACT19_REF_AS_PROP = ruleSnippet({
  id: 'react19.ref-as-prop',
  title: 'Pass ref as a regular prop — no forwardRef',
  priority: 'high',
  tags: ['react', 'react-19', 'components', 'refs'],
  appliesWhen: ['generate-component', 'refactor'],
  content:
    'React 19 lets you accept `ref` as a normal prop: `function Input({ ref, ...props }: InputProps) { return <input ref={ref} {...props} /> }`. No more `forwardRef`, no more displayName boilerplate. Only keep `forwardRef` when you have to support a React <19 consumer.',
});

export const REACT19_CONTEXT_AS_PROVIDER = ruleSnippet({
  id: 'react19.context-as-provider',
  title: 'Use <Context> directly as the provider',
  priority: 'medium',
  tags: ['react', 'react-19', 'context'],
  appliesWhen: ['generate-component'],
  content:
    'React 19 renders `<MyContext value={x}>{...}</MyContext>` instead of `<MyContext.Provider value={x}>`. The `.Provider` form is deprecated for new code. Consumer-side, prefer the `use(MyContext)` hook over `useContext(MyContext)` — `use()` works inside conditionals too.',
});

export const REACT19_DOCUMENT_METADATA = ruleSnippet({
  id: 'react19.document-metadata',
  title: 'Render <title> / <meta> / <link> inside the component tree',
  priority: 'medium',
  tags: ['react', 'react-19', 'metadata', 'seo'],
  appliesWhen: ['generate-component', 'add-page'],
  content:
    'React 19 hoists `<title>`, `<meta>`, and `<link>` tags out of components and into `<head>`. No more react-helmet, no more `useEffect(() => { document.title = x; })`. For Next.js app router, this works alongside the framework\'s metadata API.',
});

export const REACT19_STYLESHEETS_IN_TREE = ruleSnippet({
  id: 'react19.stylesheets-in-tree',
  title: 'Use <link rel="stylesheet" precedence> for scoped stylesheets',
  priority: 'low',
  tags: ['react', 'react-19', 'styles'],
  appliesWhen: ['generate-component'],
  content:
    'React 19 deduplicates `<link rel="stylesheet" href="..." precedence="default" />` rendered inside components and orders them by precedence. Use this for component-scoped stylesheet loading without manual `<head>` manipulation.',
});

export const REACT19_SELF_CLOSING = ruleSnippet({
  id: 'react19.self-closing',
  title: 'Self-close JSX elements with no children',
  priority: 'low',
  tags: ['react', 'react-19', 'jsx'],
  appliesWhen: ['generate-component'],
  content:
    'Use `<Component prop="x" />` for elements with no children, not `<Component prop="x"></Component>`. Standard JSX convention; eslint-plugin-react has `self-closing-comp` to enforce it.',
});

// ─── Hooks discipline ─────────────────────────────────────────────────────

export const REACT19_RULES_OF_HOOKS = ruleSnippet({
  id: 'react19.rules-of-hooks',
  title: 'Hooks at the top of the function, never conditional',
  priority: 'critical',
  tags: ['react', 'react-19', 'hooks'],
  appliesWhen: ['generate-component', 'generate-hook'],
  content:
    'Call hooks at the top level — never inside conditionals, loops, or nested functions. They identify by call order. Run `eslint-plugin-react-hooks` with `rules-of-hooks` and `exhaustive-deps` both as errors, not warnings.',
});

export const REACT19_USE_EFFECT_FOR_EXTERNAL_SYNC = ruleSnippet({
  id: 'react19.use-effect-for-external-sync',
  title: 'useEffect is for syncing with external systems — nothing else',
  priority: 'critical',
  tags: ['react', 'react-19', 'hooks', 'effects'],
  appliesWhen: ['generate-component', 'review'],
  content:
    'useEffect is the escape hatch into the world outside React (DOM subscriptions, web APIs, timers, non-React state stores). Anything that can be derived during render goes in render. Anything that responds to a user event goes in an event handler. Anything that resets state when a prop changes uses a `key` prop on the consuming component, not an effect.',
});

export const REACT19_NO_DERIVED_STATE_IN_EFFECT = ruleSnippet({
  id: 'react19.no-derived-state-in-effect',
  title: 'Derived state is computed during render, not in useEffect',
  priority: 'critical',
  tags: ['react', 'react-19', 'hooks', 'effects'],
  appliesWhen: ['generate-component', 'review'],
  content:
    'If `derived` is a pure function of `a` and `b`, write `const derived = compute(a, b)` inline — not `const [derived, setDerived] = useState(); useEffect(() => setDerived(compute(a, b)), [a, b])`. The effect path runs an extra render, makes the UI flash, and breaks under StrictMode.',
});

export const REACT19_NO_FETCH_IN_EFFECT = ruleSnippet({
  id: 'react19.no-fetch-in-effect',
  title: 'Don\'t fetch in useEffect — use a server-state library',
  priority: 'high',
  tags: ['react', 'react-19', 'effects', 'data'],
  appliesWhen: ['generate-component'],
  content:
    'Manual fetch-in-useEffect re-implements caching, deduping, refetching, race-condition handling, and error states badly. Use TanStack Query (React Query), SWR, RTK Query, or React 19\'s `use(promise)` inside a Suspense boundary. The only useEffect for I/O is for setting up a long-lived subscription (WebSocket / SSE) that the libraries don\'t cover.',
});

export const REACT19_CUSTOM_HOOK_NAMING = ruleSnippet({
  id: 'react19.custom-hook-naming',
  title: 'Custom hooks start with `use` and live next to consumers',
  priority: 'medium',
  tags: ['react', 'react-19', 'hooks'],
  appliesWhen: ['generate-hook'],
  content:
    'Custom hooks export a function named `useFoo`. The naming is what enables eslint-plugin-react-hooks to verify the rules. Co-locate the hook with the component(s) that consume it; promote to `src/hooks/` only when used across features.',
});

export const REACT19_EFFECT_CLEANUP = ruleSnippet({
  id: 'react19.effect-cleanup',
  title: 'Every useEffect with a subscription returns a cleanup',
  priority: 'high',
  tags: ['react', 'react-19', 'effects'],
  appliesWhen: ['generate-component'],
  content:
    'If the effect adds a listener, opens a socket, sets a timer, or subscribes to anything, return a function that tears it down. StrictMode mounts components twice in dev specifically to surface missing cleanups — fix them in dev, not in production.',
});

// ─── Actions / forms (React 19) ───────────────────────────────────────────

export const REACT19_FORM_ACTIONS = ruleSnippet({
  id: 'react19.form-actions',
  title: 'Use <form action> with Actions for submission',
  priority: 'high',
  tags: ['react', 'react-19', 'forms', 'actions'],
  appliesWhen: ['generate-component', 'generate-form'],
  content:
    'React 19 forms call their `action` prop with the FormData on submit: `<form action={async (fd) => save(fd)}>`. The DOM form is reset on success automatically. Pair with useActionState for pending / result state and useFormStatus inside child components for spinners — no more manual onSubmit + e.preventDefault + isSubmitting state.',
});

export const REACT19_USE_ACTION_STATE = ruleSnippet({
  id: 'react19.use-action-state',
  title: 'useActionState replaces "result + pending + error" state triplets',
  priority: 'high',
  tags: ['react', 'react-19', 'actions', 'hooks'],
  appliesWhen: ['generate-component', 'generate-form'],
  content:
    '`const [state, formAction, isPending] = useActionState(action, initialState)`. The hook owns pending state, the most recent return value of `action`, and re-invocations across submits. Wire `formAction` to the form\'s `action` prop; the hook handles the rest.',
});

export const REACT19_USE_FORM_STATUS = ruleSnippet({
  id: 'react19.use-form-status',
  title: 'useFormStatus inside form children for pending UI',
  priority: 'medium',
  tags: ['react', 'react-19', 'actions', 'hooks'],
  appliesWhen: ['generate-component'],
  content:
    'A submit button that needs to know whether the parent form is mid-submission calls `const { pending } = useFormStatus()` — no prop drilling, no shared state. Only works inside a `<form>` descendant.',
});

export const REACT19_USE_OPTIMISTIC = ruleSnippet({
  id: 'react19.use-optimistic',
  title: 'useOptimistic for instant UI on mutations',
  priority: 'medium',
  tags: ['react', 'react-19', 'actions', 'optimistic'],
  appliesWhen: ['generate-component'],
  content:
    '`const [optimisticList, addOptimistic] = useOptimistic(list, (cur, item) => [...cur, item])`. Call `addOptimistic(newItem)` before kicking off the server action; if the action fails, React automatically reverts. Skip the manual rollback-on-error machinery.',
});

export const REACT19_USE_HOOK = ruleSnippet({
  id: 'react19.use-hook',
  title: 'use() to read promises and contexts conditionally',
  priority: 'high',
  tags: ['react', 'react-19', 'hooks'],
  appliesWhen: ['generate-component'],
  content:
    '`const data = use(promise)` unwraps a thrown-promise into a Suspense boundary. `use(MyContext)` reads context — and unlike useContext, it works inside conditionals and loops. Don\'t create the promise inside the component body on every render — pass it in as a prop or pull it from a cache.',
});

export const REACT19_ASYNC_TRANSITIONS = ruleSnippet({
  id: 'react19.async-transitions',
  title: 'startTransition / useTransition accept async functions',
  priority: 'medium',
  tags: ['react', 'react-19', 'concurrent', 'transitions'],
  appliesWhen: ['generate-component'],
  content:
    'React 19 lets you pass an async function to `startTransition` / `useTransition`. Use it for "navigate then load data" or "mutate then revalidate" flows — `isPending` stays true until the async work resolves, so the UI can show a quiet pending state without jank.',
});

// ─── State management ────────────────────────────────────────────────────

export const REACT19_SERVER_STATE_LIBRARY = ruleSnippet({
  id: 'react19.server-state-library',
  title: 'Server state lives in a query library, not useState',
  priority: 'critical',
  tags: ['react', 'react-19', 'state', 'data'],
  appliesWhen: ['generate-component', 'fetch-data'],
  content:
    'TanStack Query (React Query), SWR, or RTK Query own the cache for data that originates on the server. They handle dedup, background refetch, stale-while-revalidate, invalidation, optimistic updates, and SSR hydration. Putting fetched data in `useState` re-implements them — badly.',
});

export const REACT19_CLIENT_STATE_PROPORTIONAL = ruleSnippet({
  id: 'react19.client-state-proportional',
  title: 'Pick client state shape to match its scope',
  priority: 'high',
  tags: ['react', 'react-19', 'state'],
  appliesWhen: ['generate-component'],
  content:
    'Local: `useState` / `useReducer`. Within a subtree: lift state to the lowest common ancestor. Cross-tree, infrequent updates: Context. Cross-tree, frequent updates: a real store (Zustand for ergonomics, Jotai for atomic, Redux Toolkit for time-travel debugging). Don\'t use Context for high-frequency updates — every consumer re-renders on every change.',
});

export const REACT19_FORMS_LIBRARY = ruleSnippet({
  id: 'react19.forms-library',
  title: 'Non-trivial forms use React Hook Form + Zod (or React 19 Actions)',
  priority: 'medium',
  tags: ['react', 'react-19', 'forms'],
  appliesWhen: ['generate-form'],
  content:
    'Forms with conditional fields, async validation, dirty-tracking, or complex submit state belong in React Hook Form + Zod (`zodResolver`). Forms that are pure submit-and-forget can use React 19 Actions + useActionState directly. Controlled-state-only forms ("a useState per field") work for 2-field forms and break around field 5.',
});

export const REACT19_AVOID_PROP_DRILLING = ruleSnippet({
  id: 'react19.avoid-prop-drilling',
  title: 'Lift state only as high as it needs to go',
  priority: 'medium',
  tags: ['react', 'react-19', 'state', 'composition'],
  appliesWhen: ['refactor'],
  content:
    'If a piece of state lives 4+ components above its consumers, refactor: extract a Context, move it to a store, or restructure via composition (pass children instead of props). Long prop-drilling chains are a refactoring signal, not a permanent fixture.',
});

export const REACT19_KEYS_FOR_RESET = ruleSnippet({
  id: 'react19.keys-for-reset',
  title: 'Reset component state with a key prop, not useEffect',
  priority: 'high',
  tags: ['react', 'react-19', 'state'],
  appliesWhen: ['generate-component'],
  content:
    'To force a component to reset its internal state when an input changes (e.g. switching to a different user), pass `<Editor key={userId} user={user} />`. React unmounts the old instance and mounts a fresh one. No useEffect that watches userId and calls a bunch of setStates.',
});

// ─── Performance ─────────────────────────────────────────────────────────

export const REACT19_COMPILER_AUTO_MEMO = ruleSnippet({
  id: 'react19.compiler-auto-memo',
  title: 'React Compiler memoizes for you — drop hand-rolled useMemo/useCallback',
  priority: 'high',
  tags: ['react', 'react-19', 'performance', 'compiler'],
  appliesWhen: ['configure', 'review'],
  content:
    'Enable the React Compiler (babel-plugin-react-compiler) and it inserts memoization automatically. Hand-written useMemo / useCallback / React.memo become noise — keep them only on the few hot paths the profiler proves the compiler can\'t optimise. With the compiler off, hand-memoize ONLY when measured (DevTools profiler), not preemptively.',
});

export const REACT19_LAZY_SUSPENSE = ruleSnippet({
  id: 'react19.lazy-suspense',
  title: 'Code-split heavy / rarely-used components with React.lazy + Suspense',
  priority: 'high',
  tags: ['react', 'react-19', 'performance', 'code-splitting'],
  appliesWhen: ['add-route', 'optimize-bundle'],
  content:
    'Route-level components, modals, heavy editors, and large dependency islands go behind `React.lazy(() => import(...))` + `<Suspense fallback={...}>`. Each lazy import becomes its own chunk. Don\'t lazy-load above-the-fold critical components — the network round-trip costs more than the bundle saving.',
});

export const REACT19_VIRTUALIZE_LISTS = ruleSnippet({
  id: 'react19.virtualize-lists',
  title: 'Virtualize lists past ~100 visible items',
  priority: 'high',
  tags: ['react', 'react-19', 'performance', 'lists'],
  appliesWhen: ['generate-component'],
  content:
    'A list that can grow past a few hundred rows uses a virtualizer (TanStack Virtual, react-window, react-virtuoso). Rendering 10k DOM nodes blocks the main thread regardless of how clever your memoization is.',
});

export const REACT19_STABLE_KEYS = ruleSnippet({
  id: 'react19.stable-keys',
  title: 'List keys are stable and unique — never the array index',
  priority: 'critical',
  tags: ['react', 'react-19', 'lists', 'performance'],
  appliesWhen: ['generate-component', 'review'],
  content:
    'Use the item\'s id (or a stable composite). `key={index}` makes React reuse DOM nodes when you reorder, splice, or filter — state from row 3 leaks into row 2. The only safe use of `key={index}` is for a static list that never changes shape.',
});

export const REACT19_IMAGE_OPTIMIZATION = ruleSnippet({
  id: 'react19.image-optimization',
  title: 'Images: explicit width/height, lazy by default, framework helper if available',
  priority: 'high',
  tags: ['react', 'react-19', 'performance', 'images'],
  appliesWhen: ['generate-component'],
  content:
    'Every `<img>` has width + height attributes (prevents layout shift) and `loading="lazy"` for below-the-fold images. In Next.js use `<Image>`; in Vite SPAs use a CDN with responsive `srcset` (or imgix / Cloudinary / Cloudflare Images). Don\'t ship a 4MB hero JPEG in 2026.',
});

// ─── Concurrent rendering ────────────────────────────────────────────────

export const REACT19_USE_TRANSITION = ruleSnippet({
  id: 'react19.use-transition',
  title: 'Wrap expensive state updates in startTransition / useTransition',
  priority: 'high',
  tags: ['react', 'react-19', 'concurrent', 'performance'],
  appliesWhen: ['generate-component'],
  content:
    'For state updates whose work blocks the input (filter typing, tab switching, sort changes), call `startTransition(() => setSlow(x))`. React keeps the input responsive and processes the slow update at lower priority. Pair with `useDeferredValue` when you want to lag a derived render behind the source signal.',
});

export const REACT19_USE_DEFERRED_VALUE = ruleSnippet({
  id: 'react19.use-deferred-value',
  title: 'useDeferredValue for derived expensive renders',
  priority: 'medium',
  tags: ['react', 'react-19', 'concurrent'],
  appliesWhen: ['generate-component'],
  content:
    '`const slow = useDeferredValue(query)` lets the input update immediately while the slow downstream view (filtered list, charts) re-renders at lower priority. React 19 takes an `initialValue` argument so SSR-hydrated pages render the cheap form first.',
});

export const REACT19_SUSPENSE_BOUNDARIES = ruleSnippet({
  id: 'react19.suspense-boundaries',
  title: 'Plan Suspense boundaries deliberately',
  priority: 'high',
  tags: ['react', 'react-19', 'concurrent', 'suspense'],
  appliesWhen: ['generate-component'],
  content:
    'Each `<Suspense>` boundary defines what falls back when a `use(promise)` inside it is pending. Put boundaries at the level of UI that should reveal together; placing one at the page root and another at the sidebar lets them stream independently. Don\'t over-nest — too many boundaries cause UI thrash.',
});

export const REACT19_STRICT_MODE = ruleSnippet({
  id: 'react19.strict-mode',
  title: 'Run StrictMode in dev, fix what it surfaces',
  priority: 'high',
  tags: ['react', 'react-19', 'concurrent', 'safety'],
  appliesWhen: ['configure'],
  content:
    'Wrap the dev tree in `<StrictMode>`. It runs effects, reducers, and constructors twice in dev to catch missing cleanups, accidental shared state, and impure renders. If your code breaks under StrictMode, it will break under React\'s concurrent features in production.',
});

// ─── Testing ─────────────────────────────────────────────────────────────

export const REACT19_VITEST = ruleSnippet({
  id: 'react19.vitest',
  title: 'Vitest is the default test runner for Vite-based React apps',
  priority: 'high',
  tags: ['react', 'react-19', 'testing'],
  appliesWhen: ['configure', 'generate-test'],
  content:
    'Vitest is ESM-first, Vite-native, and runs ~5× faster than Jest in dev for the same suite. The Jest API surface is compatible. Stick with Jest only if you have heavy Jest infrastructure that hasn\'t been ported.',
});

export const REACT19_TESTING_LIBRARY = ruleSnippet({
  id: 'react19.testing-library',
  title: 'Test through the DOM with @testing-library/react + userEvent',
  priority: 'critical',
  tags: ['react', 'react-19', 'testing'],
  appliesWhen: ['generate-test'],
  content:
    'Render the component, query by role / label / text (NOT by class name or test-id-everywhere), and drive interactions with `userEvent.setup()` — never `fireEvent` unless you need a raw DOM event. The Testing Library guideline: "the more your tests resemble the way your software is used, the more confidence they can give you".',
});

export const REACT19_TEST_BEHAVIOR_NOT_IMPL = ruleSnippet({
  id: 'react19.test-behavior-not-impl',
  title: 'Test behavior, not implementation details',
  priority: 'high',
  tags: ['react', 'react-19', 'testing'],
  appliesWhen: ['generate-test', 'review'],
  content:
    'A test that asserts "useState was called with x" or "this internal hook fired" breaks every refactor without proving anything about user-visible behavior. Assert what the user sees and can do: text on screen, fields, buttons, navigation. If the test passes after gutting the implementation, you wrote it well.',
});

export const REACT19_MSW = ruleSnippet({
  id: 'react19.msw',
  title: 'Mock HTTP at the network layer with MSW',
  priority: 'high',
  tags: ['react', 'react-19', 'testing', 'http'],
  appliesWhen: ['generate-test'],
  content:
    'Mock Service Worker intercepts fetch/XHR at the network layer, so your component code runs unchanged. Define handlers once in `src/test/handlers.ts` and override per-test with `server.use(...)`. Beats per-test `jest.mock` of fetch by a wide margin.',
});

// ─── React Server Components (framework apps) ────────────────────────────

export const REACT19_SERVER_COMPONENTS_DEFAULT = ruleSnippet({
  id: 'react19.server-components-default',
  title: 'In RSC frameworks, components are server-rendered by default',
  priority: 'critical',
  tags: ['react', 'react-19', 'rsc'],
  appliesWhen: ['generate-component'],
  content:
    'In Next.js app router (or any RSC framework), the default is a Server Component — runs on the server, ships zero JS for itself, can be async, can read from a database directly. Only opt into a Client Component when you need interactivity (state, effects, event handlers, browser-only APIs). Going server-first keeps bundle size small.',
});

export const REACT19_USE_CLIENT_BOUNDARY = ruleSnippet({
  id: 'react19.use-client-boundary',
  title: 'Push "use client" as far down the tree as possible',
  priority: 'high',
  tags: ['react', 'react-19', 'rsc'],
  appliesWhen: ['generate-component', 'refactor'],
  content:
    'A `"use client"` directive marks a Client Component AND every component imported by it. Place it on the smallest leaf that actually needs client behavior — the form, the toggle, the chart — not on the entire page. A page-level "use client" defeats the point of RSC.',
});

export const REACT19_SERVER_ACTIONS = ruleSnippet({
  id: 'react19.server-actions',
  title: 'Server Actions over manual API routes for mutations',
  priority: 'high',
  tags: ['react', 'react-19', 'rsc', 'actions'],
  appliesWhen: ['generate-form', 'mutate-data'],
  content:
    'In RSC frameworks, define a server function with `"use server"` and pass it directly as a form `action` or call it from an event handler. No manual API route, no manual fetch + JSON serialize. Validate the input at the top of the action (zod) — never trust a payload just because it came in over the action wire.',
});

export const REACT19_STREAMING_SSR = ruleSnippet({
  id: 'react19.streaming-ssr',
  title: 'Stream SSR with Suspense boundaries for fast TTFB',
  priority: 'medium',
  tags: ['react', 'react-19', 'ssr', 'rsc'],
  appliesWhen: ['configure'],
  content:
    'Server-rendered apps stream HTML through Suspense boundaries: the shell ships first, slow data fills in as it resolves. Wrap slow data fetches in a Suspense boundary so they don\'t hold up the shell. Don\'t await every fetch at the top of the route — it blocks TTFB on the slowest one.',
});
