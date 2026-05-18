/**
 * Self-contained HTML rendering for review packets. Dark-mode aware, no
 * external assets. Optional collapsible long sections via <details>.
 */
import type { IReviewPacket } from './review-packet.ts';

export interface IRenderReviewHtmlOptions {
  /** Render long sections (e.g. >12 entries) inside collapsible <details>. */
  collapseLongSections?: boolean;
  /** Cap rendered list length per section. Default unlimited. */
  maxItems?: number;
}

const CSS = `
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#0f1419;color:#e6e1cf;padding:2rem;line-height:1.55}
h1,h2,h3{margin-top:1.4rem;color:#bae67e}
table{border-collapse:collapse;width:100%;margin:.8rem 0}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #2a3138}
th{background:#1c2329;color:#9aa5b0}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:.25rem;font-size:.75rem;font-weight:600;text-transform:uppercase}
.b-info{background:#2e3a4a;color:#7fd0ff}.b-warn{background:#3a3a2e;color:#ffd580}.b-bad{background:#5a1f1f;color:#ff9f9f}
pre{background:#1c2329;padding:.8rem;border-radius:.4rem;overflow-x:auto}
code{background:#1c2329;padding:.05rem .3rem;border-radius:.2rem}
details > summary{cursor:pointer;font-weight:600}
@media (prefers-color-scheme: light){body{background:#fafaf7;color:#1f2329}h1,h2,h3{color:#266a2e}th{background:#eee;color:#222}pre,code{background:#eee}}
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function listSection(
  title: string,
  items: readonly string[],
  collapse: boolean,
  threshold = 12,
): string {
  if (items.length === 0) return '';
  const inner = `<ul>${items.map((i) => `<li><code>${escapeHtml(i)}</code></li>`).join('')}</ul>`;
  if (collapse && items.length > threshold) {
    return `<h2>${escapeHtml(title)} (${items.length})</h2><details><summary>Show ${items.length} entries</summary>${inner}</details>`;
  }
  return `<h2>${escapeHtml(title)} (${items.length})</h2>${inner}`;
}

export function renderReviewHtml(
  packet: IReviewPacket,
  options: IRenderReviewHtmlOptions = {},
): string {
  const maxItems = options.maxItems ?? Infinity;
  const collapse = options.collapseLongSections ?? false;
  const slice = <T>(arr: readonly T[]): readonly T[] => (maxItems === Infinity ? arr : arr.slice(0, maxItems));

  const out: string[] = [];
  out.push('<!doctype html>');
  out.push('<html lang="en"><head><meta charset="utf-8"><title>SharkCraft review packet</title>');
  out.push(`<style>${CSS}</style></head><body>`);
  out.push('<h1>SharkCraft PR review packet</h1>');
  out.push(`<p>Changed files: <strong>${packet.changedFiles.length}</strong>; Boundary issues: <strong>${packet.boundaryViolations.length}</strong>; Recommended checks: <strong>${packet.verificationCommands.length}</strong></p>`);

  out.push(listSection('Changed files', slice(packet.changedFiles) as readonly string[], collapse));
  out.push(listSection('Affected path conventions', slice(packet.affectedPaths) as readonly string[], collapse));

  if (packet.relevantRules.length > 0) {
    out.push('<h2>Relevant rules</h2>');
    out.push('<table><thead><tr><th>Id</th><th>Title</th><th>Reason</th></tr></thead><tbody>');
    for (const r of slice(packet.relevantRules) as readonly { id: string; title: string; reason: string }[]) {
      out.push(`<tr><td><code>${escapeHtml(r.id)}</code></td><td>${escapeHtml(r.title)}</td><td>${escapeHtml(r.reason)}</td></tr>`);
    }
    out.push('</tbody></table>');
  }

  if (packet.relevantTemplates.length > 0) {
    out.push('<h2>Relevant templates</h2>');
    out.push('<ul>');
    for (const t of slice(packet.relevantTemplates) as readonly { id: string; name: string }[])
      out.push(`<li><code>${escapeHtml(t.id)}</code> — ${escapeHtml(t.name)}</li>`);
    out.push('</ul>');
  }

  if (packet.boundaryViolations.length > 0) {
    out.push('<h2>Boundary violations</h2>');
    out.push('<table><thead><tr><th>Rule</th><th>File</th><th>Import</th><th>Severity</th><th>Message</th></tr></thead><tbody>');
    for (const b of slice(packet.boundaryViolations) as IReviewPacket['boundaryViolations']) {
      const cls = b.severity === 'error' ? 'b-bad' : 'b-warn';
      out.push(
        `<tr><td><code>${escapeHtml(b.ruleId)}</code></td>` +
          `<td><code>${escapeHtml(b.file)}:${b.line}</code></td>` +
          `<td><code>${escapeHtml(b.importSpecifier)}</code></td>` +
          `<td><span class="badge ${cls}">${escapeHtml(b.severity)}</span></td>` +
          `<td>${escapeHtml(b.message)}</td></tr>`,
      );
    }
    out.push('</tbody></table>');
  }

  if (packet.missingTestsHeuristic.length > 0) {
    out.push(listSection('Possibly missing tests', slice(packet.missingTestsHeuristic) as readonly string[], collapse));
  }

  if (packet.verificationCommands.length > 0) {
    out.push('<h2>Recommended checks</h2><pre>');
    for (const c of packet.verificationCommands) out.push(escapeHtml(c));
    out.push('</pre>');
  }

  out.push('<h2>AI reviewer instructions</h2>');
  out.push(`<pre>${escapeHtml(packet.reviewerInstructions)}</pre>`);

  out.push('</body></html>');
  return out.join('\n') + '\n';
}
