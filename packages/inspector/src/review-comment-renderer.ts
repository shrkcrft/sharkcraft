import type { IReviewPacket } from './review-packet.ts';

export interface IRenderReviewCommentOptions {
  /** Optional title for the comment header. */
  title?: string;
  /** Include the AI reviewer instructions block. Default true. */
  includeReviewerInstructions?: boolean;
  /** Include the artifacts note at the bottom. Default true. */
  includeArtifactsNote?: boolean;
  /** Output format. 'github' wraps long sections in <details>, 'markdown' is plain. Default 'github'. */
  format?: 'github' | 'markdown';
  /** Truncate changed files list to N entries. Default 20. */
  maxFiles?: number;
  /** Truncate relevant rules list to N entries. Default 30. */
  maxRules?: number;
  /** Wrap long sections in <details> (GitHub-only). Default true when format='github'. */
  collapseLongSections?: boolean;
  /** Include boundary issues section. Default true. */
  includeBoundaries?: boolean;
  /** Include coverage summary when artifact is provided. */
  includeCoverage?: boolean;
  /** Include drift summary when artifact is provided. */
  includeDrift?: boolean;
  /** Optional boundaries artifact (parsed from `shrk check boundaries --json`). */
  boundariesArtifact?: { counts?: { error?: number; warning?: number; info?: number }; rulesEvaluated?: number };
  /** Optional coverage artifact (parsed from `shrk coverage --json`). */
  coverageArtifact?: { overall?: number; categories?: readonly { id: string; score: number }[] };
  /** Optional drift artifact (parsed from `shrk drift --json`). */
  driftArtifact?: { stale?: readonly { id: string }[]; total?: number };
  /** Artifact links/names to render in the artifacts section. */
  artifactLinks?: readonly { name: string; href?: string }[];
}

/**
 * Render a review packet as a human-readable Markdown PR comment. The function
 * accepts a packet read from JSON (the runtime shape may have extra fields —
 * we read only the documented ones). Returns Markdown only.
 */
export function renderReviewComment(
  packet: IReviewPacket,
  options: IRenderReviewCommentOptions = {},
): string {
  const includeReviewer = options.includeReviewerInstructions !== false;
  const includeArtifacts = options.includeArtifactsNote !== false;
  const includeBoundaries = options.includeBoundaries !== false;
  const includeCoverage = options.includeCoverage === true && options.coverageArtifact !== undefined;
  const includeDrift = options.includeDrift === true && options.driftArtifact !== undefined;
  const format = options.format ?? 'github';
  const maxFiles = options.maxFiles ?? 20;
  const maxRules = options.maxRules ?? 30;
  const collapse = options.collapseLongSections !== false && format === 'github';
  const out: string[] = [];
  const title = options.title ?? 'SharkCraft review';
  out.push(`## ${title}`);
  out.push('');
  out.push(renderSummary(packet, options));
  out.push('');

  // Changed files — collapsible when long.
  out.push('### Changed files');
  out.push('');
  if (packet.changedFiles.length === 0) {
    out.push('_No changed files detected._');
  } else {
    const slice = packet.changedFiles.slice(0, maxFiles);
    const overflow = packet.changedFiles.length > maxFiles;
    if (collapse && packet.changedFiles.length > 10) {
      out.push('<details>');
      out.push(`<summary>${packet.changedFiles.length} file(s) — click to expand</summary>`);
      out.push('');
    }
    for (const f of slice) out.push(`- \`${f}\``);
    if (overflow) out.push(`- …and ${packet.changedFiles.length - maxFiles} more.`);
    if (collapse && packet.changedFiles.length > 10) {
      out.push('');
      out.push('</details>');
    }
  }
  out.push('');

  out.push('### Risks');
  out.push('');
  const risks = collectRisks(packet);
  if (risks.length === 0) {
    out.push('_No risks flagged by the deterministic checks._');
  } else {
    for (const r of risks) out.push(`- ${r}`);
  }
  out.push('');

  if (includeBoundaries) {
    out.push('### Boundary issues');
    out.push('');
    if (packet.boundaryViolations.length === 0) {
      out.push('_No boundary violations in the change set._');
    } else {
      for (const v of packet.boundaryViolations) {
        out.push(
          `- **${v.severity.toUpperCase()}** \`${v.file}:${v.line}\` imports \`${v.importSpecifier}\` — rule \`${v.ruleId}\``,
        );
        if (v.message) out.push(`  - ${v.message}`);
      }
    }
    out.push('');
  }

  if (includeCoverage) {
    out.push('### Coverage summary');
    out.push('');
    const a = options.coverageArtifact!;
    if (typeof a.overall === 'number') {
      out.push(`- Overall: **${a.overall}%**`);
    }
    if (Array.isArray(a.categories)) {
      const low = a.categories.filter((c) => c.score < 80);
      if (low.length === 0) {
        out.push('- No categories below 80%.');
      } else {
        for (const c of low) out.push(`- ${c.id}: ${c.score}%`);
      }
    }
    out.push('');
  }

  if (includeDrift) {
    out.push('### Drift summary');
    out.push('');
    const a = options.driftArtifact!;
    const stale = Array.isArray(a.stale) ? a.stale.length : 0;
    out.push(`- Stale entries: **${stale}** of ${a.total ?? '?'}`);
    if (Array.isArray(a.stale)) {
      for (const s of a.stale.slice(0, 10)) out.push(`  - ${s.id}`);
    }
    out.push('');
  }

  out.push('### Suggested checks');
  out.push('');
  if (packet.verificationCommands.length === 0) {
    out.push('_No verification commands configured._');
  } else {
    for (const c of packet.verificationCommands) {
      out.push(`- \`${c}\``);
    }
  }
  out.push('');

  if (packet.relevantRules.length > 0) {
    out.push('### Relevant rules');
    out.push('');
    const rules = packet.relevantRules.slice(0, maxRules);
    for (const r of rules) {
      out.push(`- **${r.id}** — ${r.title}`);
    }
    if (packet.relevantRules.length > maxRules) {
      out.push(`- …and ${packet.relevantRules.length - maxRules} more.`);
    }
    out.push('');
  }

  if (includeReviewer && packet.reviewerInstructions) {
    out.push('### AI reviewer instructions');
    out.push('');
    if (collapse) {
      out.push('<details>');
      out.push('<summary>Click to expand</summary>');
      out.push('');
    }
    out.push(packet.reviewerInstructions);
    if (collapse) {
      out.push('');
      out.push('</details>');
    }
    out.push('');
  }

  if (options.artifactLinks && options.artifactLinks.length > 0) {
    out.push('### Artifacts');
    out.push('');
    for (const a of options.artifactLinks) {
      out.push(a.href ? `- [\`${a.name}\`](${a.href})` : `- \`${a.name}\``);
    }
    out.push('');
  }
  if (includeArtifacts) {
    out.push('---');
    out.push(
      '_Generated by `shrk review render-comment`. The full review packet JSON is uploaded as a CI artifact._',
    );
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function renderSummary(
  packet: IReviewPacket,
  options: IRenderReviewCommentOptions,
): string {
  const parts = [
    `${packet.changedFiles.length} file(s) changed`,
    `${packet.boundaryViolations.length} boundary violation(s)`,
    `${packet.missingTestsHeuristic.length} potentially missing test(s)`,
  ];
  if (options.coverageArtifact?.overall !== undefined) {
    parts.push(`coverage ${options.coverageArtifact.overall}%`);
  }
  if (options.driftArtifact?.stale && options.driftArtifact.stale.length > 0) {
    parts.push(`${options.driftArtifact.stale.length} stale`);
  }
  return `**Summary:** ${parts.join(' · ')}`;
}

function collectRisks(packet: IReviewPacket): string[] {
  const out: string[] = [];
  if (packet.boundaryViolations.length > 0) {
    out.push(
      `${packet.boundaryViolations.length} boundary violation(s) in changed files — see below.`,
    );
  }
  if (packet.missingTestsHeuristic.length > 0) {
    out.push(
      `Possibly missing tests: ${packet.missingTestsHeuristic.length} source file(s) without a sibling spec.`,
    );
    for (const m of packet.missingTestsHeuristic.slice(0, 5)) {
      out.push(`  • ${m}`);
    }
  }
  return out;
}
