/**
 * Centralised failure-to-success hint formatter.
 *
 * Keeps the "next command" message consistent across high-friction
 * commands. Each helper emits a compact one-paragraph "Next commands"
 * block on stdout.
 */
export interface IFailureHint {
  label: string;
  command: string;
  /** Optional doc link. */
  doc?: string;
}

export function renderFailureHints(hints: readonly IFailureHint[]): string {
  if (hints.length === 0) return '';
  const lines: string[] = [];
  lines.push('');
  lines.push('Next commands:');
  for (const h of hints) {
    lines.push(`  $ ${h.command}   # ${h.label}`);
    if (h.doc) lines.push(`     docs: ${h.doc}`);
  }
  return lines.join('\n') + '\n';
}

// ── Convenience hint builders ──────────────────────────────────────────

export function doctorHints(): IFailureHint[] {
  return [
    { label: 'preview fix suggestions', command: 'shrk fix preview --action-hints' },
    { label: 'list suppressions', command: 'shrk doctor suppressions list' },
    { label: 'watch loop', command: 'shrk doctor --watch --once' },
  ];
}

export function staleKnowledgeHints(): IFailureHint[] {
  return [
    { label: 'preview rename', command: 'shrk knowledge rename-symbol <old> <new> --dry-run' },
    { label: 'list references', command: 'shrk knowledge references <id>' },
    { label: 'fix preview', command: 'shrk fix preview --knowledge-stale' },
  ];
}

export function templateDriftHints(): IFailureHint[] {
  return [
    { label: 'fix preview', command: 'shrk fix preview --template-drift' },
    { label: 'inspect template', command: 'shrk templates get <id>' },
    { label: 'verify paths', command: 'shrk templates verify-paths' },
  ];
}

export function fuzzyImpactAmbiguousHints(): IFailureHint[] {
  return [
    { label: 'resolve only', command: 'shrk impact <query> --resolve-only' },
    { label: 'trace alternatives', command: 'shrk trace <query>' },
  ];
}

export function agentTestMissingExpectedHints(): IFailureHint[] {
  return [
    { label: 'explain a missing id', command: 'shrk why <id> --for-task "<task>"' },
    { label: 'explain why not', command: 'shrk why-not <id> --for-task "<task>"' },
  ];
}

export function ciReportEmptyHints(): IFailureHint[] {
  return [
    { label: 'scaffold integrity gates', command: 'shrk ci scaffold github-actions --with-integrity' },
    { label: 'run gates locally', command: 'shrk quality --ci' },
  ];
}

export function feedbackRulesDoctorHints(): IFailureHint[] {
  return [
    { label: 'list rules', command: 'shrk feedback rules list --with-pack-rules' },
    { label: 'ingest sample', command: 'shrk feedback ingest <file> --with-pack-rules' },
  ];
}

/**
 * Standardised error footer for important failures.
 *
 *   Next:
 *     <command>
 *
 *   Why:
 *     <one sentence>
 *
 *   More detail (optional):
 *     <command>
 *
 * Centralized so unknown-command / ambiguous-command / apply-rejected /
 * signature-mismatch / contract-gate-blocked / folder-op-unsafe /
 * doctor-failed / self-config-doctor-failed / stale-pack-signature /
 * project-coupling-audit / templates-drift / knowledge-stale-check all
 * read the same way.
 */
export interface IErrorFooter {
  next: string;
  why: string;
  more?: string | readonly string[];
}

export function renderErrorFooter(footer: IErrorFooter): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Next:');
  lines.push(`  $ ${footer.next}`);
  lines.push('');
  lines.push('Why:');
  lines.push(`  ${footer.why}`);
  if (footer.more) {
    lines.push('');
    lines.push('More detail:');
    const moreCommands = typeof footer.more === 'string' ? [footer.more] : footer.more;
    for (const cmd of moreCommands) {
      lines.push(`  $ ${cmd}`);
    }
  }
  return lines.join('\n') + '\n';
}

export type ErrorFooterKind =
  | 'unknown-command'
  | 'ambiguous-command'
  | 'apply-rejected'
  | 'signature-mismatch'
  | 'contract-gate-blocked'
  | 'folder-op-unsafe'
  | 'doctor-failed'
  | 'self-config-doctor-failed'
  | 'stale-pack-signature'
  | 'project-coupling-audit-failed'
  | 'templates-drift-failed'
  | 'knowledge-stale-check-failed';

/**
 * Canonical footer per failure kind. Returns `undefined` if the
 * caller wants to fall through to a bespoke message (we don't crash if
 * a new kind is added without a wired footer).
 */
export function errorFooterFor(kind: ErrorFooterKind, context?: { task?: string }): IErrorFooter | undefined {
  const task = context?.task ?? '<task>';
  switch (kind) {
    case 'unknown-command':
      return {
        next: `shrk recommend "${task}"`,
        why: 'Free-form input routes to the canonical human entrypoint — `shrk recommend` ranks commands for a query without writes.',
        more: ['shrk commands', 'shrk commands suggest "<partial>"', 'shrk start-here'],
      };
    case 'ambiguous-command':
      return {
        next: 'shrk commands suggest "<partial>"',
        why: 'Multiple commands matched the input — narrow it down or pick the canonical entrypoint.',
        more: ['shrk commands explain <cmd>', 'shrk commands overlaps'],
      };
    case 'apply-rejected':
      return {
        next: 'shrk plan review <plan.json>',
        why: 'The apply gate refused the plan — review the safety report before retrying.',
        more: ['shrk plan verify <plan.json>', 'shrk safety audit --deep'],
      };
    case 'signature-mismatch':
      return {
        next: 'shrk plan verify <plan.json>',
        why: 'The plan signature does not match the source content — re-sign or regenerate before retrying.',
        more: ['shrk plan sign <plan.json>', 'shrk gen <template> --save-plan <plan.json>'],
      };
    case 'contract-gate-blocked':
      return {
        next: 'shrk contract status <id>',
        why: 'The contract gate refused the apply — inspect the contract before approving.',
        more: ['shrk contract check <id>', 'shrk contract approve <id>'],
      };
    case 'folder-op-unsafe':
      return {
        next: 'shrk plan review <plan.json>',
        why: 'The plan touches files outside the project scope — review before applying.',
        more: ['shrk safety audit --deep', 'shrk check boundaries --changed-only'],
      };
    case 'doctor-failed':
      return {
        next: 'shrk doctor',
        why: 'Workspace doctor reported errors — fix or suppress them before continuing.',
        more: ['shrk doctor suppressions list', 'shrk fix preview --action-hints', 'shrk self-config doctor'],
      };
    case 'self-config-doctor-failed':
      return {
        next: 'shrk self-config doctor',
        why: 'The cross-reference doctor reported issues — fix the contributions or rebuild the graph.',
        more: ['shrk packs doctor --require-signatures', 'shrk self-config graph'],
      };
    case 'stale-pack-signature':
      return {
        next: 'shrk packs sign <pack>',
        why: 'A pack manifest changed after it was signed — re-sign to restore the trust chain.',
        more: ['shrk packs verify <pack>', 'shrk packs signature-status'],
      };
    case 'project-coupling-audit-failed':
      return {
        next: 'shrk audit project-coupling audit --token "<token>" --fail-on engine',
        why: 'Project-specific tokens leaked into the SharkCraft engine — move them into the appropriate pack.',
        more: ['shrk impact --files "<file>"', 'shrk explore packages/<pkg>'],
      };
    case 'templates-drift-failed':
      return {
        next: 'shrk templates drift --min-severity warning',
        why: 'A template body diverged from its declared shape — regenerate or update the template.',
        more: ['shrk fix preview --template-drift', 'shrk templates verify-paths'],
      };
    case 'knowledge-stale-check-failed':
      return {
        next: 'shrk knowledge stale-check --ci',
        why: 'A knowledge anchor moved or vanished — refresh the anchor or remove the entry.',
        more: ['shrk fix preview --knowledge-stale', 'shrk knowledge references <id>'],
      };
  }
}
