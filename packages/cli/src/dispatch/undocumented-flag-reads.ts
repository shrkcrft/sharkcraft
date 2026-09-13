/**
 * THE ledger of flags a command's code READS that its usage does not show yet
 * — keyed by the registered (trie) path, flags sorted.
 *
 * The post-run unknown-flag detector (`unread-flags.ts`) turns a `0` into
 * `usageExitFor(path)` when a supplied flag was never read and is not a flag
 * of the command. "A flag of the command" is its usage documentation PLUS this
 * ledger: many flags are read only behind a branch (`--force` only when the
 * output already exists, `--plan-format` only with `--plan`), so a run that
 * skipped the branch left a real flag unread — and without this ledger, a real
 * flag no usage names read as dropped input (`export claude-md --write
 * --force` wrote the file, then exited 2).
 *
 * Locked two-way against the code by `r75-flag-read-ledger`: every flag
 * literal a tracked handler can reach is documented or listed here, and every
 * entry here is still read and still undocumented. It is a RATCHET — the fix
 * for an entry is to document the flag in the command's usage, after which the
 * lock fails until the entry is deleted. On drift the lock prints the entries
 * as they should read.
 */
export const UNDOCUMENTED_FLAG_READS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  [
    'apply',
    [
      'all-verifications', 'allow-delete-folder', 'allow-folder-ops', 'allow-pack-commands', 'approval',
      'command', 'contract', 'validate-strict', 'verification',
    ],
  ],
  ['architecture map', ['json']],
  ['architecture violations', ['json']],
  ['audit project-coupling', ['fail-on', 'format', 'json', 'no-word-boundary', 'output']],
  ['baseline diff', ['changed-only', 'since']],
  ['baseline explain', ['changed-only', 'since']],
  ['baseline list', ['changed-only', 'id', 'since']],
  ['baseline update', ['changed-only', 'since']],
  ['boundaries enforce', ['json']],
  ['brief', ['chunked']],
  [
    'bundle',
    [
      'agent-tests', 'all-suggested', 'all-verifications', 'boundaries', 'context-tests', 'coverage', 'drift',
      'from-pipeline', 'html', 'name', 'report', 'session', 'since', 'template', 'test-impact',
      'validate-after-group', 'validate-final', 'var', 'verification', 'write-script',
    ],
  ],
  ['changes', ['json', 'label']],
  [
    'ci',
    [
      'changed-only', 'polyglot', 'pr-comment', 'preset', 'quickstart', 'with-agent-tests', 'with-doctor',
      'with-pack-signature-status', 'with-pr-checks', 'with-self-config-doctor',
    ],
  ],
  ['codemod', ['top']],
  ['completion', ['shell']],
  [
    'context',
    [
      'brief', 'commands-first', 'force', 'format', 'include-commands', 'include-docs', 'machine-json',
      'maxTokens', 'no-examples', 'no-paths', 'no-rules', 'no-templates', 'preset', 'scope', 'summary', 'tag',
    ],
  ],
  ['contract', ['approval', 'expires', 'expires-at', 'expires-in', 'gates', 'intent', 'plan', 'secret-env']],
  ['dashboard diff', ['json']],
  ['dashboard export', ['json']],
  [
    'dev',
    [
      'all', 'all-verifications', 'allow-pack-commands', 'brief', 'command', 'name', 'open', 'sign',
      'template', 'var', 'verification',
    ],
  ],
  [
    'doctor',
    [
      'debug', 'fail-on-expired-acknowledgement', 'hide-acknowledged', 'loader-timeout', 'no-cache', 'paths',
      'show-na', 'strict-all', 'strict-errors', 'strict-warnings', 'verbose',
    ],
  ],
  ['drift', ['changed-only', 'files', 'since', 'staged']],
  ['explain', ['changed-only', 'id', 'no-cache', 'plane', 'since']],
  ['explore', ['json']],
  ['feedback', ['legacy']],
  [
    'fix',
    [
      'all', 'boundary', 'broken-agent-test-reference', 'broken-helper-reference',
      'broken-playbook-reference', 'broken-routing-hint-reference', 'convention', 'doctor', 'list',
      'missing-command-hint', 'missing-convention-reference', 'missing-template-reference', 'pack-conflicts',
      'self-config', 'stale-pack-signature',
    ],
  ],
  ['framework', ['no-packs']],
  ['gates explain', ['changed-only', 'id', 'no-cache', 'plane', 'since']],
  ['gates list', ['no-cache']],
  ['gates scaffold-selftest', ['no-cache']],
  ['gen', ['overwrite', 'sign']],
  ['generated list', ['id']],
  ['graph', ['compact', 'has-unresolved-imports', 'table']],
  ['help', ['full-help', 'verbose']],
  ['helper', ['output', 'save-plan', 'sign', 'source']],
  [
    'impact',
    [
      'language', 'no-persist', 'no-polyglot', 'plan-format', 'polyglot-mode', 'polyglot-only', 'task',
      'via-graph', 'write-starter',
    ],
  ],
  ['import', ['out']],
  [
    'ingest',
    [
      'adopt', 'depth', 'docs-first', 'dry-run', 'exclude', 'include', 'json', 'output', 'preset', 'profile',
      'task', 'write-patch',
    ],
  ],
  ['init', ['with-skill']],
  ['install smoke', ['temp-dir']],
  [
    'knowledge add',
    [
      'add-applies-when', 'add-forbidden-path', 'add-related', 'add-required-profile', 'add-scope', 'add-tag',
      'remove-anchor-id', 'remove-applies-when', 'remove-forbidden-path', 'remove-reference',
      'remove-related', 'remove-required-profile', 'remove-scope', 'remove-tag',
    ],
  ],
  ['knowledge remove', ['id']],
  ['knowledge search', ['appliesWhen', 'tag']],
  ['knowledge stale-check', ['paths']],
  [
    'knowledge update',
    [
      'add-applies-when', 'add-forbidden-path', 'add-required-profile', 'add-scope', 'add-tag',
      'applies-when', 'id', 'related', 'remove-applies-when', 'remove-forbidden-path',
      'remove-required-profile', 'remove-scope', 'remove-tag', 'scope', 'tag',
    ],
  ],
  ['knowledge verify', ['paths']],
  ['languages', ['explain-policy']],
  ['memory diff', ['json']],
  ['memory drift', ['json']],
  ['memory reset', ['json']],
  ['onboard', ['diff-format', 'force', 'format', 'no-auto-regenerate', 'output']],
  ['owners impact', ['json']],
  ['owners match', ['json']],
  ['ownership for', ['files']],
  [
    'pack author preview',
    [
      'applies-when', 'bad', 'description', 'forbidden', 'forbidden-path', 'good', 'owner', 'produced-anchor',
      'rationale', 'registration-hint', 'required-anchor', 'required-helper', 'required-profile', 'scope',
      'tag', 'verification',
    ],
  ],
  ['packs conflicts', ['json']],
  ['packs contributions', ['json']],
  ['packs sign', ['out']],
  ['packs signature-status', ['json']],
  ['packs watch', ['consumer', 'json']],
  ['paths best', ['json']],
  ['paths search', ['json']],
  ['pipelines context', ['maxTokens', 'scope']],
  ['plan simulate', ['json']],
  [
    'policy check',
    [
      'changed-only', 'explain-overrides', 'files', 'local-files', 'no-pack-policies',
      'record-override-audit', 'require-signed-policy-packs', 'since', 'staged',
    ],
  ],
  [
    'policy get',
    [
      'bundle', 'local-files', 'no-pack-policies', 'plan', 'require-signed-policy-packs', 'session',
    ],
  ],
  ['policy list', ['bundle', 'local-files', 'plan', 'session']],
  ['policy run', ['local-files', 'session']],
  ['policy-lint explain', ['id']],
  ['pr', ['from-bundle', 'from-session', 'full', 'json', 'verbose']],
  ['provenance show', ['id']],
  ['recommend', ['actions-only', 'full', 'include-gated', 'machine-json', 'top']],
  [
    'release',
    [
      'consumer-root', 'include-docs-check', 'include-examples-check', 'no-assertions', 'target',
      'with-knowledge-check', 'with-product-check',
    ],
  ],
  [
    'report',
    [
      'bundle', 'bundle-diff', 'impact-dir', 'include-boundaries', 'include-memory', 'review',
      'runtime-compat', 'safety-matrix',
    ],
  ],
  ['review', ['bundle', 'quality-baseline', 'v2', 'v3']],
  ['risk', ['include-memory']],
  ['rounds show', ['id']],
  [
    'rules add',
    [
      'add-applies-when', 'add-forbidden-path', 'add-related', 'add-required-profile', 'add-scope', 'add-tag',
      'remove-anchor-id', 'remove-applies-when', 'remove-forbidden-path', 'remove-reference',
      'remove-related', 'remove-required-profile', 'remove-scope', 'remove-tag', 'type',
    ],
  ],
  ['rules relevant', ['appliesWhen', 'tag']],
  ['rules remove', ['id']],
  ['rules scaffold', ['reason']],
  [
    'rules update',
    [
      'add-applies-when', 'add-forbidden-path', 'add-required-profile', 'add-scope', 'add-tag',
      'applies-when', 'id', 'related', 'remove-anchor-id', 'remove-applies-when', 'remove-forbidden-path',
      'remove-required-profile', 'remove-scope', 'remove-tag', 'scope', 'tag',
    ],
  ],
  ['schemas inventory', ['json']],
  ['schemas write', ['json']],
  ['search', ['full', 'json', 'top', 'type', 'verbose']],
  ['search-structural', ['description', 'force', 'id', 'title']],
  ['self-config', ['source']],
  [
    'smart-context plan-ahead',
    [
      'ai-plan', 'budget', 'cache-reference-threshold', 'cache-replay-threshold', 'debug', 'enhance',
      'enhance-passes', 'expansion-limit', 'expansion-tokens', 'focused', 'log-prompt', 'no-cache',
      'no-enhance', 'no-instructions', 'no-polish', 'no-refresh-index', 'plan', 'plus', 'refresh', 'save',
      'save-conversation', 'seed-tokens', 'since', 'stage1-max-tokens', 'stream', 'task-type', 'tiny-only',
    ],
  ],
  [
    'spec',
    [
      'all-verifications', 'allow-delete-folder', 'allow-folder-ops', 'allow-pack-commands',
      'allow-unknown-target', 'approval', 'asset-preview', 'batch', 'command', 'contract', 'explain-dispatch',
      'no-verify-signature', 'report', 'require-signature', 'session', 'target', 'trace', 'validate',
      'validate-strict', 'verification', 'verify-signature',
    ],
  ],
  [
    'spec implement',
    [
      'all-verifications', 'allow-delete-folder', 'allow-folder-ops', 'allow-pack-commands',
      'allow-unknown-target', 'approval', 'asset-preview', 'batch', 'command', 'contract', 'explain-dispatch',
      'force', 'no-verify-signature', 'reason', 'report', 'require-signature', 'session', 'target', 'trace',
      'validate', 'validate-strict', 'verification', 'verify-signature', 'write',
    ],
  ],
  ['spec verify', ['apply']],
  [
    'task',
    [
      'actions-only', 'brief', 'commands-first', 'compact', 'show-coverage-gaps', 'summary', 'verbose',
    ],
  ],
  ['templates drift', ['paths']],
  ['templates preview', ['json']],
  ['templates remove', ['id']],
  ['templates search', ['json']],
  [
    'templates smoke',
    [
      'ci', 'debounce', 'format', 'hide', 'llm-recommendations', 'min-severity', 'once', 'output', 'pack',
      'paths', 'provider', 'report', 'template', 'var', 'watch',
    ],
  ],
  ['templates snapshot', ['json']],
  [
    'templates update',
    [
      'applies-when', 'id', 'reference', 'related', 'remove-anchor-id', 'remove-reference', 'scope', 'tag',
    ],
  ],
  ['test', ['debounce', 'once', 'paths', 'pipeline', 'rule', 'template']],
  ['tests impact', ['json']],
  ['tests missing', ['json']],
  ['trace', ['language']],
  ['understand-task', ['explain', 'task']],
  ['validate-change', ['json']],
  ['watch', ['replace']],
]);
