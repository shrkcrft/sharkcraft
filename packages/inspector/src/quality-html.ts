/**
 * Self-contained HTML rendering for the quality report. No external assets,
 * no JS, dark-mode aware.
 */
import type { IQualityReport } from './quality-report.ts';

const CSS = `
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#0f1419;color:#e6e1cf;padding:2rem;line-height:1.55}
h1,h2,h3{margin-top:1.4rem;color:#bae67e}
table{border-collapse:collapse;width:100%;margin:.8rem 0}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #2a3138}
th{background:#1c2329;color:#9aa5b0}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:.25rem;font-size:.75rem;font-weight:600;text-transform:uppercase}
.b-pass{background:#28432e;color:#bae67e}.b-warn{background:#3a3a2e;color:#ffd580}.b-fail{background:#5a1f1f;color:#ff9f9f}
.b-skip{background:#2e3a4a;color:#7fd0ff}
pre{background:#1c2329;padding:.8rem;border-radius:.4rem;overflow-x:auto}
code{background:#1c2329;padding:.05rem .3rem;border-radius:.2rem}
.score{font-size:2.2rem;font-weight:700}
@media (prefers-color-scheme: light){body{background:#fafaf7;color:#1f2329}h1,h2,h3{color:#266a2e}th{background:#eee;color:#222}pre,code{background:#eee}}
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function badgeFor(overall: 'pass' | 'warn' | 'fail'): string {
  if (overall === 'pass') return `<span class="badge b-pass">${overall}</span>`;
  if (overall === 'warn') return `<span class="badge b-warn">${overall}</span>`;
  return `<span class="badge b-fail">${overall}</span>`;
}

export function renderQualityHtml(report: IQualityReport): string {
  const out: string[] = [];
  out.push('<!doctype html>');
  out.push('<html lang="en"><head><meta charset="utf-8"><title>SharkCraft quality report</title>');
  out.push(`<style>${CSS}</style></head><body>`);
  out.push('<h1>SharkCraft quality report</h1>');
  out.push('<p>');
  out.push(`<span class="score">${report.score}</span>&nbsp;${badgeFor(report.overall)}`);
  out.push(`&nbsp;blockers <strong>${report.blockers}</strong> · warnings <strong>${report.warnings}</strong>`);
  out.push('</p>');
  out.push('<h2>Gates</h2>');
  out.push('<table><thead><tr><th>Gate</th><th>Verdict</th><th>Blocking</th><th>Executed</th><th>Notes</th></tr></thead><tbody>');
  for (const g of report.gates) {
    const tag = g.passed ? 'b-pass' : g.blocking ? 'b-fail' : 'b-warn';
    const verdict = g.passed ? 'pass' : g.blocking ? 'fail' : 'warn';
    out.push(
      `<tr><td><code>${escapeHtml(g.id)}</code> — ${escapeHtml(g.label)}</td>` +
        `<td><span class="badge ${tag}">${verdict}</span></td>` +
        `<td>${g.blocking ? 'yes' : 'no'}</td>` +
        `<td>${g.executed ? 'yes' : `<span class="badge b-skip">skipped</span>`}</td>` +
        `<td>${g.notes.map(escapeHtml).join('<br>')}</td></tr>`,
    );
  }
  out.push('</tbody></table>');
  if (report.drift) {
    out.push('<h2>Drift</h2>');
    const counts = (report.drift as unknown as { counts?: Record<string, number> }).counts ?? {};
    out.push('<table><tbody>');
    for (const [k, v] of Object.entries(counts)) {
      out.push(`<tr><th>${escapeHtml(k)}</th><td>${v}</td></tr>`);
    }
    out.push('</tbody></table>');
  }
  if (report.nextRecommendations.length > 0) {
    out.push('<h2>Next recommendations</h2><ul>');
    for (const r of report.nextRecommendations) out.push(`<li>${escapeHtml(r)}</li>`);
    out.push('</ul>');
  }
  out.push('</body></html>');
  return out.join('\n') + '\n';
}
