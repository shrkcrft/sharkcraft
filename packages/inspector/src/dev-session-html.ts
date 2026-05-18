import { DevSessionPhase, type IDevSessionLoad } from './dev-session.ts';

export interface IRenderDevSessionHtmlOptions {
  /** Computed next-action hint. */
  nextActionLine?: string;
  /** Whether to include file:// links to local session files. Default true. */
  includeFileLinks?: boolean;
}

/**
 * Render a fully self-contained HTML report for a dev session. No external
 * assets, no JS, no network — works as a local file via `file://`.
 */
export function renderDevSessionHtml(
  load: IDevSessionLoad,
  options: IRenderDevSessionHtmlOptions = {},
): string {
  const state = load.state;
  const task = load.task || state?.task || '(unknown task)';
  const includeLinks = options.includeFileLinks !== false;
  const sections: string[] = [];

  sections.push(`<h1>Dev session: ${esc(load.id)}</h1>`);
  sections.push(`<p class="task"><strong>Task:</strong> ${esc(task)}</p>`);

  if (state) {
    sections.push(`<dl class="meta">
      <dt>Phase</dt><dd><span class="phase phase-${esc(state.phase)}">${esc(state.phase)}</span></dd>
      <dt>Created</dt><dd>${esc(state.createdAt)}</dd>
      <dt>Updated</dt><dd>${esc(state.updatedAt)}</dd>
      <dt>Project root</dt><dd><code>${esc(state.projectRoot)}</code></dd>
    </dl>`);
  } else {
    sections.push('<p class="warn">Legacy session (no session.json) — details are limited to on-disk artifacts.</p>');
  }

  sections.push(renderTimeline(load));
  sections.push(renderPlans(load, includeLinks));
  sections.push(renderAppliedPlans(load));
  sections.push(renderValidations(load));
  sections.push(renderReports(load, includeLinks));
  sections.push(renderCommands(load));
  sections.push(renderRisks(load));

  if (options.nextActionLine) {
    sections.push(`<h2>Next action</h2><pre class="next">${esc(options.nextActionLine)}</pre>`);
  } else if (state?.nextAction) {
    sections.push(`<h2>Next action</h2><pre class="next">${esc(state.nextAction)}</pre>`);
  }

  return wrapHtml(`SharkCraft session ${load.id}`, sections.join('\n'));
}

function renderTimeline(load: IDevSessionLoad): string {
  const state = load.state;
  if (!state) {
    return `<h2>Timeline</h2><p>No session.json — timeline reconstructed from filesystem only.</p>`;
  }
  const rows: string[] = [];
  rows.push(`<tr><td>${esc(state.createdAt)}</td><td>session started</td></tr>`);
  for (const p of state.plans) {
    const verb = p.status === 'intent' ? 'intent created' : 'plan saved';
    rows.push(`<tr><td>${esc(p.createdAt)}</td><td>${esc(verb)}: <code>${esc(p.file)}</code> (template <code>${esc(p.templateId)}</code>)</td></tr>`);
  }
  for (const a of state.appliedPlans) {
    rows.push(`<tr><td>${esc(a.appliedAt)}</td><td>applied plan <code>${esc(a.file)}</code></td></tr>`);
  }
  for (const v of state.validations) {
    rows.push(
      `<tr><td>${esc(v.finishedAt)}</td><td>validation ${v.passed ? '<span class="ok">passed</span>' : '<span class="fail">FAILED</span>'} (${v.commandsRun.length} cmd, ${v.boundaryViolations} boundary)</td></tr>`,
    );
  }
  if (state.phase === DevSessionPhase.Completed) {
    rows.push(`<tr><td>${esc(state.updatedAt)}</td><td>session completed</td></tr>`);
  }
  return `<h2>Timeline</h2><table class="timeline"><tbody>${rows.join('\n')}</tbody></table>`;
}

function renderPlans(load: IDevSessionLoad, includeLinks: boolean): string {
  const state = load.state;
  if (!state || state.plans.length === 0) {
    return '<h2>Plans</h2><p><em>No plans saved.</em></p>';
  }
  const rows = state.plans.map((p) => {
    const link = includeLinks ? `<a href="file://${esc(load.dir)}/plans/${esc(p.file)}">plans/${esc(p.file)}</a>` : `<code>plans/${esc(p.file)}</code>`;
    const missing =
      p.missingVariables.length > 0
        ? `<br><small>missing: ${p.missingVariables.map(esc).join(', ')}</small>`
        : '';
    const review = p.reviewReportFile
      ? `<br><small>review: <code>reports/${esc(p.reviewReportFile)}</code></small>`
      : '';
    return `<tr>
      <td><strong>${esc(p.name)}</strong></td>
      <td>${esc(p.templateId)}</td>
      <td>${link}${missing}${review}</td>
      <td><span class="status status-${esc(p.status)}">${esc(p.status)}</span>${p.signed ? ' <span class="signed">signed</span>' : ''}</td>
    </tr>`;
  });
  return `<h2>Plans</h2><table class="plans">
    <thead><tr><th>Name</th><th>Template</th><th>File</th><th>Status</th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>`;
}

function renderAppliedPlans(load: IDevSessionLoad): string {
  const state = load.state;
  if (!state || state.appliedPlans.length === 0) {
    return '<h2>Applied plans</h2><p><em>None recorded (apply is the explicit human step).</em></p>';
  }
  const rows = state.appliedPlans.map((a) => {
    const sig = a.signatureStatus ? `<small>signature: ${esc(a.signatureStatus)}</small>` : '';
    const div = a.divergenceAccepted ? '<small class="warn"> · diverged</small>' : '';
    const files = a.changedFiles && a.changedFiles.length > 0
      ? `<details><summary>${a.changedFiles.length} file(s)</summary><ul>${a.changedFiles.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul></details>`
      : '';
    return `<tr><td><code>plans/${esc(a.file)}</code></td><td>${esc(a.appliedAt)}</td><td>${sig}${div}${files}</td></tr>`;
  });
  return `<h2>Applied plans</h2><table class="applied">
    <thead><tr><th>File</th><th>Applied at</th><th>Details</th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>`;
}

function renderValidations(load: IDevSessionLoad): string {
  const state = load.state;
  if (!state || state.validations.length === 0) {
    return '<h2>Validations</h2><p><em>Not run.</em></p>';
  }
  const blocks = state.validations.map((v) => {
    const cmds = v.commandsRun
      .map((c) => `<li>${c.passed ? '<span class="ok">✓</span>' : '<span class="fail">✗</span>'} <code>${esc(c.command)}</code>${c.note ? ' — ' + esc(c.note) : ''}</li>`)
      .join('');
    return `<div class="validation ${v.passed ? 'pass' : 'fail'}">
      <h3>${esc(v.finishedAt)} — ${v.passed ? '<span class="ok">PASSED</span>' : '<span class="fail">FAILED</span>'}</h3>
      <p>Report: <code>reports/${esc(v.reportFile)}</code> · boundary=${v.boundaryViolations} · warnings=${v.warnings}</p>
      <ul>${cmds}</ul>
    </div>`;
  });
  return `<h2>Validations</h2>${blocks.join('\n')}`;
}

function renderReports(load: IDevSessionLoad, includeLinks: boolean): string {
  if (load.reportsOnDisk.length === 0) {
    return '<h2>Reports</h2><p><em>No reports captured.</em></p>';
  }
  const items = load.reportsOnDisk
    .map((r) => {
      const link = includeLinks
        ? `<a href="file://${esc(load.dir)}/reports/${esc(r)}">${esc(r)}</a>`
        : `<code>${esc(r)}</code>`;
      return `<li>${link}</li>`;
    })
    .join('');
  return `<h2>Reports</h2><ul class="reports">${items}</ul>`;
}

function renderCommands(load: IDevSessionLoad): string {
  const id = load.id;
  const cmds: Array<[string, string]> = [
    ['plan', `shrk dev plan ${id} --template <id> --name <name> [--var k=v ...]`],
    ['apply', `shrk apply .sharkcraft/sessions/${id}/plans/<plan>.json --verify-signature`],
    ['apply (session-aware)', `shrk apply .sharkcraft/sessions/${id}/plans/<plan>.json --session ${id} --verify-signature`],
    ['validate', `shrk dev validate ${id}`],
    ['report', `shrk dev report ${id}`],
  ];
  return `<h2>Commands</h2><dl class="cmds">${cmds.map(([k, v]) => `<dt>${esc(k)}</dt><dd><pre>${esc(v)}</pre></dd>`).join('')}</dl>`;
}

function renderRisks(load: IDevSessionLoad): string {
  const state = load.state;
  const risks: string[] = [];
  if (state) {
    const last = state.validations[state.validations.length - 1];
    if (last && !last.passed) risks.push('Last validation failed — review report before shipping.');
    if (state.plans.some((p) => p.missingVariables.length > 0)) {
      risks.push('One or more plans have unresolved variables (intent only).');
    }
    if (state.plans.length > 0 && state.appliedPlans.length === 0 && state.phase !== DevSessionPhase.Completed) {
      risks.push('Plans saved but not applied — apply is the explicit human step.');
    }
    for (const w of state.warnings) risks.push(w);
  }
  if (risks.length === 0) {
    return '<h2>Remaining risks</h2><p><em>No risks flagged by deterministic checks.</em></p>';
  }
  return `<h2>Remaining risks</h2><ul class="risks">${risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
}

function wrapHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --bg:#fff; --fg:#1c1c1f; --muted:#666; --accent:#2b6cb0; --ok:#1c7a3e; --warn:#a16207; --fail:#c0392b; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#1a1a1d; --fg:#e4e4e7; --muted:#a1a1aa; --accent:#60a5fa; --ok:#22c55e; --warn:#f59e0b; --fail:#ef4444; }
}
body { background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 1024px; margin-left: auto; margin-right: auto; }
h1, h2, h3 { line-height: 1.2; }
h1 { font-size: 1.8rem; }
h2 { margin-top: 2rem; border-bottom: 1px solid var(--muted); padding-bottom: .3rem; }
code, pre { background: rgba(127,127,127,.12); padding: .1em .35em; border-radius: 3px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .92em; }
pre { padding: .65rem .8rem; overflow-x: auto; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; }
dl.meta dt { color: var(--muted); }
table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid rgba(127,127,127,.18); vertical-align: top; }
th { font-weight: 600; color: var(--muted); font-size: .85em; text-transform: uppercase; letter-spacing: .03em; }
.ok { color: var(--ok); }
.warn { color: var(--warn); }
.fail { color: var(--fail); }
.phase, .status { display: inline-block; padding: .1em .55em; border-radius: 3px; font-size: .85em; background: rgba(127,127,127,.18); }
.phase-completed, .status-applied { background: rgba(34,197,94,.2); color: var(--ok); }
.phase-validated { background: rgba(34,197,94,.2); color: var(--ok); }
.phase-validation_failed { background: rgba(239,68,68,.2); color: var(--fail); }
.phase-applied { background: rgba(45,127,255,.2); color: var(--accent); }
.signed { background: rgba(34,197,94,.2); color: var(--ok); padding: .05em .35em; border-radius: 3px; font-size: .8em; }
.validation { margin: .75rem 0; padding: .75rem 1rem; border-left: 3px solid var(--muted); }
.validation.pass { border-color: var(--ok); }
.validation.fail { border-color: var(--fail); }
.next { background: rgba(45,127,255,.1); border-left: 3px solid var(--accent); }
ul.risks li { color: var(--warn); }
a { color: var(--accent); }
.footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid rgba(127,127,127,.2); color: var(--muted); font-size: .85em; }
</style>
</head>
<body>
${body}
<p class="footer">Generated by <code>shrk dev report --html</code> — fully local, no telemetry, no network.</p>
</body>
</html>
`;
}

function esc(value: string | undefined | null): string {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
