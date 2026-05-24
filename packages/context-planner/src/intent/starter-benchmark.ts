import { INTENT_BENCHMARK_SCHEMA, type IIntentBenchmark } from './benchmark.ts';

/**
 * Curated starter benchmark covering the canonical phrasings the
 * classifier should handle on day one. Used by `shrk context
 * benchmark seed` to bootstrap a fresh fixture. Authors are expected
 * to grow the set per project — especially when a new task verb
 * starts cropping up in real PRs but lands in `unknown`.
 *
 * Conflict-resolution priority in the classifier today:
 *   release > migration > bug-fix > refactor > docs > feature
 */
export const STARTER_INTENT_BENCHMARK: IIntentBenchmark = {
  schema: INTENT_BENCHMARK_SCHEMA,
  cases: [
    // bug-fix
    { task: 'fix the broken login flow', expected: 'bug-fix' },
    { task: 'auth crashes when password is empty', expected: 'bug-fix' },
    { task: 'regression on date parsing', expected: 'bug-fix' },
    { task: 'NPE in the dashboard renderer', expected: 'bug-fix', notes: 'NPE keyword maps via `error`' },

    // feature
    { task: 'add a dark mode toggle to settings', expected: 'feature' },
    { task: 'create a new export-as-csv command', expected: 'feature' },
    { task: 'implement webhook delivery retries', expected: 'feature' },
    { task: 'introduce per-tenant rate limiting', expected: 'feature' },

    // refactor
    { task: 'refactor the dashboard panel registry', expected: 'refactor' },
    { task: 'rename `processRow` to `applyRow`', expected: 'refactor' },
    { task: 'extract auth helpers into their own module', expected: 'refactor' },
    { task: 'simplify the search-index builder', expected: 'refactor' },

    // docs
    { task: 'update the README quickstart', expected: 'docs' },
    { task: 'document the new context-planner API', expected: 'docs' },
    { task: 'write a guide for arch contracts', expected: 'docs' },

    // release
    { task: 'cut release 0.2.0', expected: 'release' },
    { task: 'run release preflight', expected: 'release' },
    { task: 'publish alpha tag for the cli package', expected: 'release' },

    // migration
    { task: 'migrate from joi to zod', expected: 'migration' },
    { task: 'upgrade typescript to 5.6', expected: 'migration' },
    { task: 'deprecate the legacy boundary API', expected: 'migration' },
  ],
};
