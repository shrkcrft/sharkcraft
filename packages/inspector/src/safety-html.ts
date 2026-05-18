/**
 * Self-contained HTML rendering for the safety audit. No external assets,
 * no JS, dark-mode aware.
 */
import type { ISafetyAuditReport } from './safety-audit.ts';

const CSS = `
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#0f1419;color:#e6e1cf;padding:2rem;line-height:1.55}
h1,h2,h3{margin-top:1.4rem;color:#bae67e}
table{border-collapse:collapse;width:100%;margin:.8rem 0}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #2a3138}
th{background:#1c2329;color:#9aa5b0}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:.25rem;font-size:.75rem;font-weight:600;text-transform:uppercase}
.b-ok{background:#28432e;color:#bae67e}.b-warn{background:#3a3a2e;color:#ffd580}.b-bad{background:#5a1f1f;color:#ff9f9f}
pre{background:#1c2329;padding:.8rem;border-radius:.4rem;overflow-x:auto}
code{background:#1c2329;padding:.05rem .3rem;border-radius:.2rem}
.note{padding:.6rem .8rem;background:#1c2329;border-left:3px solid #bae67e;border-radius:.2rem;margin:.6rem 0}
@media (prefers-color-scheme: light){body{background:#fafaf7;color:#1f2329}h1,h2,h3{color:#266a2e}th{background:#eee;color:#222}pre,code{background:#eee}.note{background:#eee;border-left-color:#266a2e}}
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function commandTable(title: string, items: ISafetyAuditReport['commands']['readOnly']): string {
  if (items.length === 0) return '';
  const out: string[] = [];
  out.push(`<h3>${escapeHtml(title)} (${items.length})</h3>`);
  out.push('<table><thead><tr><th>Command</th><th>Category</th><th>Safety</th><th>Description</th></tr></thead><tbody>');
  for (const c of items) {
    out.push(
      `<tr><td><code>${escapeHtml(c.command)}</code></td>` +
        `<td>${escapeHtml(c.category)}</td>` +
        `<td><code>${escapeHtml(c.safetyLevel)}</code></td>` +
        `<td>${escapeHtml(c.description)}</td></tr>`,
    );
  }
  out.push('</tbody></table>');
  return out.join('\n');
}

export function renderSafetyHtml(report: ISafetyAuditReport): string {
  const out: string[] = [];
  out.push('<!doctype html>');
  out.push('<html lang="en"><head><meta charset="utf-8"><title>SharkCraft safety audit</title>');
  out.push(`<style>${CSS}</style></head><body>`);
  out.push('<h1>SharkCraft safety audit</h1>');
  out.push(
    `<p class="note"><strong>MCP read-only invariant:</strong> <span class="badge ${
      report.mcp.anyWritable ? 'b-bad' : 'b-ok'
    }">${report.mcp.anyWritable ? 'violated' : 'enforced'}</span></p>`,
  );
  out.push('<h2>MCP tools</h2>');
  out.push('<table><thead><tr><th>Tool</th><th>canWrite</th><th>Description</th></tr></thead><tbody>');
  for (const t of report.mcp.tools) {
    out.push(
      `<tr><td><code>${escapeHtml(t.name)}</code></td>` +
        `<td><span class="badge ${t.canWrite ? 'b-bad' : 'b-ok'}">${t.canWrite ? 'true' : 'false'}</span></td>` +
        `<td>${escapeHtml(t.description)}</td></tr>`,
    );
  }
  out.push('</tbody></table>');

  out.push('<h2>Commands by safety level</h2>');
  out.push(commandTable('writes-source', report.commands.writesSource));
  out.push(commandTable('writes-drafts', report.commands.writesDrafts));
  out.push(commandTable('writes-session', report.commands.writesSession));
  out.push(commandTable('runs-shell', report.commands.runsShell));
  out.push(commandTable('requires-review', report.commands.requiresReview));
  out.push(commandTable('read-only', report.commands.readOnly));

  out.push('<h2>Verifications</h2>');
  out.push(`<p>Trusted local: <strong>${report.verifications.trusted.length}</strong> · Pack-contributed: <strong>${report.verifications.pack.length}</strong> · Untrusted local: <strong>${report.verifications.untrusted.length}</strong></p>`);

  out.push('<h2>Packs</h2>');
  out.push(
    `<p>Discovered: <strong>${report.packs.discovered}</strong>; verified <strong>${report.packs.signedAndVerified}</strong>; signed-not-verified <strong>${report.packs.signedNotVerified}</strong>; unsigned <strong>${report.packs.unsigned}</strong>; invalid <strong>${report.packs.invalid}</strong></p>`,
  );

  out.push('<h2>Plan signing</h2>');
  out.push(
    `<p>Secret env: <code>${escapeHtml(report.planSigning.secretEnv)}</code> — ${
      report.planSigning.secretConfigured
        ? '<span class="badge b-ok">configured</span>'
        : '<span class="badge b-warn">missing</span>'
    }</p>`,
  );

  if (report.recommendations.length > 0) {
    out.push('<h2>Recommendations</h2><ul>');
    for (const r of report.recommendations) out.push(`<li>${escapeHtml(r)}</li>`);
    out.push('</ul>');
  }
  out.push('</body></html>');
  return out.join('\n') + '\n';
}
