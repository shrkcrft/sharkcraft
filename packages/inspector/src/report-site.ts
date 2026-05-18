import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { buildAreaMap, renderAreaMapMarkdown, type IAreaMap } from './area-map.ts';
import { buildCoverageReport } from './coverage-report.ts';
import { buildDriftReport } from './drift.ts';
import { evaluatePolicy } from './policy-engine.ts';
import {
  listFeatureBundles,
  type IFeatureBundle,
} from './feature-bundle.ts';
import {
  buildReviewPacketV3,
  renderReviewCommentV3,
  type IReviewPacketV3,
} from './review-packet-v3.ts';
import {
  renderQualityBaselineHtml,
  readQualityBaseline,
} from './quality-baseline.ts';
import { buildQualityReport } from './quality-report.ts';
import { renderBundleValidationHtml } from './bundle-validate-html.ts';
import { renderImpactHtml } from './impact-render.ts';
import { renderImpactDot, renderImpactMermaid } from './impact-graph.ts';
import { renderImpactGraphSvg } from './impact-graph-render.ts';
import { listConstructs, warmConstructCache } from './construct-registry.ts';
import type { IImpactAnalysis } from './impact-analysis.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export interface IBuildReportSiteOptions {
  bundleId?: string;
  /** Optional path to a pre-built review packet JSON to embed (v3 preferred). */
  reviewPacketFile?: string;
  /** Optional inclusion list — when present, only listed pages render. */
  include?: readonly ReportSitePage[];
  /** Optional path to a single impact report JSON to embed. */
  impactFile?: string;
  /** Optional directory of impact-report-*.json files to embed as a list. */
  impactDir?: string;
  /**
   * When true, every embedded impact detail page also gets its Mermaid + DOT
   * graph source rendered as copy-pasteable text. No JS / no external renderer
   * required. Optionally we try `mmdc` or `dot` if available, but the page
   * always works without them.
   */
  withImpactGraphs?: boolean;
  /**
   * When true (and `withImpactGraphs` is set), SharkCraft also tries to render
   * the Mermaid + DOT source to SVG via `mmdc` / `dot` if those binaries are on
   * PATH. Always best-effort: if the binary is missing or the render fails,
   * the source-only behaviour is preserved.
   *
   * Setting this opts the user into running an external subprocess against
   * locally-generated source files only.
   */
  renderImpactGraphs?: boolean;
  /** Optional title shown in the report-site banner. */
  title?: string;
  /** Optional brand text shown in the page nav. */
  brand?: string;
  /** Optional URL of the safety-matrix doc to surface in the nav. */
  safetyMatrixUrl?: string;
  /** Optional URL of the runtime-compatibility report. */
  runtimeCompatibilityUrl?: string;
  /** Optional path to a bundle-diff JSON to embed. */
  bundleDiffFile?: string;
  /** Optional path to a pack-compat JSON report to embed as `pack-compat.html`. */
  packCompatFile?: string;
}

export type ReportSitePage =
  | 'overview'
  | 'quality'
  | 'bundles'
  | 'review'
  | 'coverage'
  | 'drift'
  | 'policies'
  | 'adoption'
  | 'safety'
  | 'impact'
  | 'area-map'
  | 'constructs'
  | 'pack-compat';

export interface IReportSiteResult {
  outputDir: string;
  files: readonly string[];
  /** Page → relative path map for quick links. */
  pages: Record<string, string>;
  /** Number of impact reports embedded. */
  impactCount: number;
  /** Whether a review packet was embedded. */
  hasReview: boolean;
  /** Pages we deliberately wrote a placeholder for. */
  placeholderPages: readonly ReportSitePage[];
  /** Mermaid / DOT artifacts written by --with-impact-graphs. */
  impactGraphFiles?: readonly { impact: number; format: 'mermaid' | 'dot'; file: string }[];
  /** SVG artifacts produced by --render-impact-graphs. */
  impactSvgFiles?: readonly {
    impact: number;
    format: 'mermaid' | 'dot';
    file: string;
    renderer: 'mmdc' | 'dot';
  }[];
  /** Per-graph render diagnostics (e.g. renderer-missing). */
  impactRenderDiagnostics?: readonly {
    impact: number;
    format: 'mermaid' | 'dot';
    rendered: boolean;
    reason?: string;
    renderer?: string | null;
  }[];
}

export interface IReportSitePage {
  id: ReportSitePage;
  file: string;
  title: string;
  kind: 'page' | 'detail' | 'placeholder';
  populated: boolean;
}

export interface IReportSiteManifest {
  schema: 'sharkcraft.report-site-manifest/v1';
  outputDir: string;
  generatedAt: string;
  pages: readonly IReportSitePage[];
  notes: readonly string[];
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface IPageShellOptions {
  /** Set true to mark the current page in the nav. */
  current?: ReportSitePage;
}

const NAV: readonly { id: ReportSitePage; href: string; title: string }[] = [
  { id: 'overview', href: 'index.html', title: 'Overview' },
  { id: 'quality', href: 'quality.html', title: 'Quality' },
  { id: 'bundles', href: 'bundles.html', title: 'Bundles' },
  { id: 'review', href: 'review.html', title: 'Review' },
  { id: 'impact', href: 'impact.html', title: 'Impact' },
  { id: 'coverage', href: 'coverage.html', title: 'Coverage' },
  { id: 'drift', href: 'drift.html', title: 'Drift' },
  { id: 'policies', href: 'policies.html', title: 'Policies' },
  { id: 'area-map', href: 'area-map.html', title: 'Area map' },
  { id: 'constructs', href: 'constructs.html', title: 'Constructs' },
  { id: 'pack-compat', href: 'pack-compat.html', title: 'Pack compat' },
];

interface IPageShellOptionsExt extends IPageShellOptions {
  description?: string;
  emptyState?: { title: string; body: string };
  commandHints?: readonly string[];
  brand?: string;
  siteTitle?: string;
  safetyMatrixUrl?: string;
  runtimeCompatibilityUrl?: string;
}

const SITE_GENERATED_AT = new Date().toISOString();

function pageShellImpl(title: string, body: string, options: IPageShellOptionsExt = {}): string {
  const extraLinks: string[] = [];
  if (options.safetyMatrixUrl)
    extraLinks.push(`<a href="${esc(options.safetyMatrixUrl)}">Safety matrix</a>`);
  if (options.runtimeCompatibilityUrl)
    extraLinks.push(`<a href="${esc(options.runtimeCompatibilityUrl)}">Runtime compat</a>`);
  const nav =
    (options.brand ? `<span class="brand">${esc(options.brand)}</span>` : '') +
    NAV.map((n) => {
      const isCurrent = n.id === options.current;
      return `<a href="${n.href}"${isCurrent ? ' class="current"' : ''}>${esc(n.title)}</a>`;
    }).join('') +
    extraLinks.join('');
  const banner = options.siteTitle
    ? `<div class="banner"><strong>${esc(options.siteTitle)}</strong></div>`
    : '';
  const description = options.description
    ? `<p class="muted page-desc">${esc(options.description)}</p>`
    : '';
  const emptyState = options.emptyState
    ? `<div class="empty"><h3>${esc(options.emptyState.title)}</h3><p>${esc(options.emptyState.body)}</p></div>`
    : '';
  const commandHints =
    options.commandHints && options.commandHints.length > 0
      ? `<aside class="hints"><h3>Helpful commands</h3><ul>${options.commandHints.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul></aside>`
      : '';
  const titleSuffix = options.brand ? esc(options.brand) : 'SharkCraft';
  const footer = `<footer class="footer">Generated by ${titleSuffix} · ${esc(SITE_GENERATED_AT)} · <a href="index.html">index</a></footer>`;
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>${titleSuffix} — ${esc(title)}</title>`,
    '<style>',
    'body{font:14px/1.45 -apple-system,sans-serif;max-width:1080px;margin:24px auto;padding:0 16px;color:#1f2328}',
    'nav{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #d0d7de;margin-bottom:16px;flex-wrap:wrap}',
    'nav a{color:#0969da;text-decoration:none}',
    'nav a:hover{text-decoration:underline}',
    'nav a.current{font-weight:700;color:#1f2328;text-decoration:underline}',
    'h1{font-size:22px;border-bottom:1px solid #d0d7de;padding-bottom:8px}',
    'h2{font-size:16px;margin-top:24px}',
    'h3{font-size:14px;margin-top:16px}',
    'table{border-collapse:collapse;width:100%;margin:8px 0}',
    'th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}',
    'th{background:#f6f8fa}',
    'code,pre{background:#f6f8fa;padding:1px 4px;border-radius:4px;font-size:12px}',
    '.tag{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}',
    '.tag.ok{background:#dafbe1;color:#1a7f37}',
    '.tag.warn{background:#fff8c5;color:#9a6700}',
    '.tag.fail{background:#ffebe9;color:#cf222e}',
    '.tag.info{background:#eaeef2;color:#57606a}',
    '.muted{color:#57606a}',
    '.page-desc{margin-top:-4px;font-size:13px}',
    '.empty{border:1px dashed #d0d7de;border-radius:8px;padding:12px 16px;margin:16px 0;background:#fafbfc}',
    '.empty h3{margin-top:0}',
    '.hints{border-left:3px solid #0969da;background:#f6f8fa;padding:8px 12px;margin:16px 0;border-radius:0 6px 6px 0}',
    '.hints h3{margin-top:0;font-size:13px;color:#0969da}',
    '.hints ul{margin:4px 0;padding-left:18px}',
    '.footer{margin-top:32px;padding-top:8px;border-top:1px solid #d0d7de;color:#57606a;font-size:12px}',
    '.footer a{color:#57606a}',
    '.brand{font-weight:700;color:#1f2328;margin-right:auto;letter-spacing:0.2px}',
    '.banner{background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px}',
    '</style></head><body>',
    '<nav>',
    nav,
    '</nav>',
    banner,
    description,
    emptyState,
    body,
    commandHints,
    footer,
    '</body></html>',
  ].join('\n') + '\n';
}

function loadImpactReports(options: IBuildReportSiteOptions): IImpactAnalysis[] {
  const out: IImpactAnalysis[] = [];
  const seen = new Set<string>();
  const tryLoad = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as IImpactAnalysis;
      if (
        data &&
        typeof data === 'object' &&
        (data.schema === 'sharkcraft.impact-analysis/v2' ||
          (data as { schema?: string }).schema?.startsWith('sharkcraft.impact-analysis'))
      ) {
        out.push(data);
      }
    } catch {
      /* ignore */
    }
  };
  if (options.impactFile) tryLoad(options.impactFile);
  if (options.impactDir) {
    try {
      for (const f of readdirSync(options.impactDir)) {
        if (!f.endsWith('.json')) continue;
        const full = nodePath.join(options.impactDir, f);
        try {
          if (!statSync(full).isFile()) continue;
        } catch {
          continue;
        }
        tryLoad(full);
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

function impactSummaryRow(impact: IImpactAnalysis): string {
  const target = impact.normalizedTargets[0] ?? impact.specifier ?? impact.task ?? '(unknown)';
  const risk = impact.risk;
  const tag = risk === 'critical' ? 'fail' : risk === 'high' || risk === 'medium' ? 'warn' : 'ok';
  return [
    `<tr><td><code>${esc(target)}</code></td>`,
    `<td><span class="tag ${tag}">${esc(risk.toUpperCase())}</span></td>`,
    `<td>${impact.directDependents.length}</td>`,
    `<td>${impact.transitiveDependents.length}</td>`,
    `<td>${impact.affectedPackages.length}</td>`,
    `<td>${impact.potentialBoundaryRisks.length}</td>`,
    `<td>${impact.affectedPolicies.length}</td></tr>`,
  ].join('');
}

function impactIndexBody(impacts: readonly IImpactAnalysis[]): string {
  const rows = impacts.map(impactSummaryRow).join('');
  return `<h1>Impact reports (${impacts.length})</h1>
<table><thead><tr><th>Target</th><th>Risk</th><th>Direct</th><th>Transitive</th><th>Packages</th><th>Boundary</th><th>Policy</th></tr></thead>
<tbody>${rows}</tbody></table>
<p class="muted">Per-report pages: ${impacts
    .map((_, i) => `<a href="impact-${i + 1}.html">impact-${i + 1}</a>`)
    .join(' · ')}</p>`;
}

function impactPlaceholderBody(): string {
  return `<h1>Impact</h1>
  <p><em>No impact report selected.</em></p>
  <p>Generate one with one of:</p>
  <ul>
    <li><code>shrk impact --since main --format json &gt; .sharkcraft/reports/impact.json &amp;&amp; shrk report site --impact .sharkcraft/reports/impact.json</code></li>
    <li><code>shrk impact src/services/user.service.ts --format html --output .sharkcraft/reports/impact-direct.html</code> (standalone)</li>
    <li><code>shrk report site --impact-dir .sharkcraft/reports/impact</code> — embed every <code>*.json</code> in a folder.</li>
  </ul>`;
}

export async function buildReportSite(
  inspection: ISharkcraftInspection,
  outputDir: string,
  options: IBuildReportSiteOptions = {},
): Promise<IReportSiteResult> {
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];
  const placeholderPages: ReportSitePage[] = [];
  const write = (name: string, content: string): void => {
    const p = nodePath.join(outputDir, name);
    writeFileSync(p, content, 'utf8');
    files.push(p);
  };
  // Branding wrapper — applies optional --title / --brand / --safety-matrix /
  // --runtime-compat to every page consistently.
  const shell = (title: string, body: string, shellOpts: IPageShellOptionsExt = {}): string =>
    pageShellImpl(title, body, {
      ...shellOpts,
      ...(options.brand ? { brand: options.brand } : {}),
      ...(options.title ? { siteTitle: options.title } : {}),
      ...(options.safetyMatrixUrl ? { safetyMatrixUrl: options.safetyMatrixUrl } : {}),
      ...(options.runtimeCompatibilityUrl
        ? { runtimeCompatibilityUrl: options.runtimeCompatibilityUrl }
        : {}),
    });

  const quality = await buildQualityReport({ inspection, config: {} });
  const coverage = buildCoverageReport(inspection);
  let drift;
  try {
    drift = buildDriftReport(inspection);
  } catch {
    drift = { findings: [], counts: { error: 0, warning: 0, info: 0 } };
  }
  const policy = await evaluatePolicy(inspection);
  const areas = buildAreaMap(inspection);
  const bundles = listFeatureBundles(inspection.projectRoot);
  // Warm construct cache so packs contribute to the constructs page.
  await warmConstructCache(inspection);
  const constructs = listConstructs(inspection);
  const baselineFile = nodePath.join(
    inspection.projectRoot,
    'sharkcraft',
    'quality-baseline.json',
  );
  const baseline = readQualityBaseline(baselineFile);
  let review: IReviewPacketV3 | null = null;
  if (options.bundleId || options.reviewPacketFile) {
    const opts: { bundleId?: string } = {};
    if (options.bundleId) opts.bundleId = options.bundleId;
    review = await buildReviewPacketV3(inspection, opts);
  }
  const impacts = loadImpactReports(options);

  // index.html
  const indexBody = `
    <h1>SharkCraft report</h1>
    <p class="muted">Generated ${esc(new Date().toISOString())}</p>
    <table>
      <tr><th>Quality score</th><td>${quality.score} <span class="tag ${quality.overall === 'fail' ? 'fail' : quality.overall === 'warn' ? 'warn' : 'ok'}">${esc(quality.overall.toUpperCase())}</span></td></tr>
      <tr><th>Blockers</th><td>${quality.blockers}</td></tr>
      <tr><th>Warnings</th><td>${quality.warnings}</td></tr>
      <tr><th>Coverage overall</th><td>${coverage.overall}</td></tr>
      <tr><th>Drift findings</th><td>${drift.findings.length}</td></tr>
      <tr><th>Policy registrations</th><td>${policy.registrations.length}</td></tr>
      <tr><th>Areas</th><td>${areas.areas.length}</td></tr>
      <tr><th>Bundles</th><td>${bundles.length}</td></tr>
      <tr><th>Constructs</th><td>${constructs.length}</td></tr>
      <tr><th>Impact reports</th><td>${impacts.length}</td></tr>
    </table>
    <h2>Deep links</h2>
    <ul>
      ${NAV.filter((n) => n.id !== 'overview')
        .map((n) => `<li><a href="${n.href}">${esc(n.title)}</a></li>`)
        .join('')}
    </ul>`;
  write(
    'index.html',
    shell('Overview', indexBody, {
      current: 'overview',
      description: 'High-level snapshot of the SharkCraft state. Every page below is a deep link.',
      commandHints: [
        'shrk report site --output .sharkcraft/reports/site',
        'shrk report site --manifest',
      ],
    }),
  );

  // quality.html
  let qualityBody = `<h1>Quality</h1>`;
  qualityBody += `<p>Overall: <span class="tag ${quality.overall === 'fail' ? 'fail' : quality.overall === 'warn' ? 'warn' : 'ok'}">${esc(quality.overall.toUpperCase())}</span> · Score: ${quality.score} · Blockers: ${quality.blockers} · Warnings: ${quality.warnings}</p>`;
  qualityBody += '<table><thead><tr><th>Gate</th><th>Result</th><th>Notes</th></tr></thead><tbody>';
  for (const g of quality.gates) {
    qualityBody += `<tr><td><code>${esc(g.id)}</code></td><td><span class="tag ${g.passed ? 'ok' : g.blocking ? 'fail' : 'warn'}">${g.passed ? 'OK' : g.blocking ? 'BLOCK' : 'WARN'}</span></td><td>${esc(g.notes.join('; '))}</td></tr>`;
  }
  qualityBody += '</tbody></table>';
  if (baseline) {
    qualityBody += '<h2>Baseline</h2>';
    qualityBody += `<p>Captured ${esc(baseline.createdAt)} (toolkit ${esc(baseline.sharkcraftVersion)})</p>`;
    qualityBody += `<p>Score: ${baseline.qualityScore} · Readiness: ${baseline.readinessScore} · Blockers: ${baseline.blockers} · Warnings: ${baseline.warnings}</p>`;
    write('quality-baseline.html', renderQualityBaselineHtml(baseline));
    qualityBody += '<p><a href="quality-baseline.html">Full baseline detail →</a></p>';
  }
  write(
    'quality.html',
    shell('Quality', qualityBody, {
      current: 'quality',
      description: 'Quality gate matrix. Each gate is run by `shrk quality` and `shrk quality baseline compare`.',
      commandHints: ['shrk quality --strict --ci', 'shrk quality baseline diff latest previous'],
    }),
  );

  // bundles.html
  let bundlesBody = `<h1>Bundles (${bundles.length})</h1>`;
  if (bundles.length === 0) bundlesBody += '<p><em>No bundles in this workspace.</em></p>';
  bundlesBody += '<table><thead><tr><th>ID</th><th>Task</th><th>Status</th><th>Plans</th><th>Validations</th></tr></thead><tbody>';
  for (const b of bundles) {
    bundlesBody += `<tr><td><code>${esc(b.id)}</code></td><td>${esc(b.task)}</td><td>${esc(b.status)}</td><td>${b.plans.length}</td><td>${b.validations.length}</td></tr>`;
  }
  bundlesBody += '</tbody></table>';
  for (const b of bundles) {
    const last = b.validations[b.validations.length - 1];
    if (last) {
      const validationHtml = renderBundleValidationHtml(b as IFeatureBundle, last);
      write(`bundle-${b.id}.html`, validationHtml);
      bundlesBody += `<p><a href="bundle-${esc(b.id)}.html">→ ${esc(b.id)} validation</a></p>`;
    }
  }
  write(
    'bundles.html',
    shell('Bundles', bundlesBody, {
      current: 'bundles',
      description: 'Feature workflow bundles and their latest validation runs.',
      commandHints: ['shrk bundle list', 'shrk bundle replay --all --report --html'],
    }),
  );

  // review.html
  let reviewBody = `<h1>Review</h1>`;
  if (review) {
    reviewBody += renderReviewCommentV3(review, { format: 'html' });
    // Deep-link to affected files (link to area-map for now).
    reviewBody += `<p>See affected areas in <a href="area-map.html">the area map</a> and dependents in <a href="impact.html">impact</a>.</p>`;
  } else {
    reviewBody += `<p><em>No review packet selected.</em></p>
    <p>Generate one of the following to populate this page:</p>
    <ul>
      <li><code>shrk report site --bundle &lt;bundleId&gt;</code> — render a bundle's review.</li>
      <li><code>shrk report site --review &lt;packet.json&gt;</code> — render a saved packet.</li>
      <li><code>shrk review packet --v3 --json &gt; /tmp/review.json &amp;&amp; shrk report site --review /tmp/review.json</code></li>
    </ul>`;
    placeholderPages.push('review');
  }
  write(
    'review.html',
    shell('Review', reviewBody, {
      current: 'review',
      description: review
        ? 'Rendered review packet for the selected bundle/packet.'
        : 'Placeholder — pass --bundle or --review to populate.',
      commandHints: ['shrk review packet --v3 --since origin/main', 'shrk report site --bundle <id>'],
    }),
  );

  // impact.html — index of impact reports (or placeholder).
  const impactGraphFiles: { impact: number; format: 'mermaid' | 'dot'; file: string }[] = [];
  const impactSvgFiles: {
    impact: number;
    format: 'mermaid' | 'dot';
    file: string;
    renderer: 'mmdc' | 'dot';
  }[] = [];
  const impactRenderDiagnostics: {
    impact: number;
    format: 'mermaid' | 'dot';
    rendered: boolean;
    reason?: string;
    renderer?: string | null;
  }[] = [];
  if (impacts.length > 0) {
    write(
      'impact.html',
      shell('Impact', impactIndexBody(impacts), {
        current: 'impact',
        description: `${impacts.length} impact report(s) embedded — click through for detail.`,
        commandHints: [
          'shrk impact --since origin/main --format json > impact.json',
          'shrk report impact impact.json --format html --include-graph',
          'shrk report site --with-impact-graphs',
        ],
      }),
    );
    // Per-report detail pages.
    for (let i = 0; i < impacts.length; i += 1) {
      const impact = impacts[i]!;
      let html = renderImpactHtml(impact);
      if (options.withImpactGraphs) {
        const mermaid = renderImpactMermaid(impact);
        const dot = renderImpactDot(impact);
        const mermaidFile = `impact-${i + 1}.mmd`;
        const dotFile = `impact-${i + 1}.dot`;
        write(mermaidFile, mermaid);
        write(dotFile, dot);
        impactGraphFiles.push({ impact: i + 1, format: 'mermaid', file: mermaidFile });
        impactGraphFiles.push({ impact: i + 1, format: 'dot', file: dotFile });
        // Optional SVG rendering — opt-in via --render-impact-graphs. Runs a
        // local subprocess against the just-written source files; degrades
        // gracefully if the renderer isn't installed.
        let mermaidSvgLink = '';
        let dotSvgLink = '';
        if (options.renderImpactGraphs) {
          const mermaidSvgPath = nodePath.join(outputDir, `impact-${i + 1}.mermaid.svg`);
          const dotSvgPath = nodePath.join(outputDir, `impact-${i + 1}.dot.svg`);
          const mermaidResult = await renderImpactGraphSvg({
            sourceFile: nodePath.join(outputDir, mermaidFile),
            svgFile: mermaidSvgPath,
            format: 'mermaid',
          });
          if (mermaidResult.rendered && mermaidResult.svgFile) {
            files.push(mermaidResult.svgFile);
            impactSvgFiles.push({
              impact: i + 1,
              format: 'mermaid',
              file: `impact-${i + 1}.mermaid.svg`,
              renderer: mermaidResult.renderer!,
            });
            mermaidSvgLink = ` · <a href="impact-${i + 1}.mermaid.svg">svg</a>`;
          }
          impactRenderDiagnostics.push({
            impact: i + 1,
            format: 'mermaid',
            rendered: mermaidResult.rendered,
            ...(mermaidResult.reason ? { reason: mermaidResult.reason } : {}),
            renderer: mermaidResult.renderer,
          });
          const dotResult = await renderImpactGraphSvg({
            sourceFile: nodePath.join(outputDir, dotFile),
            svgFile: dotSvgPath,
            format: 'dot',
          });
          if (dotResult.rendered && dotResult.svgFile) {
            files.push(dotResult.svgFile);
            impactSvgFiles.push({
              impact: i + 1,
              format: 'dot',
              file: `impact-${i + 1}.dot.svg`,
              renderer: dotResult.renderer!,
            });
            dotSvgLink = ` · <a href="impact-${i + 1}.dot.svg">svg</a>`;
          }
          impactRenderDiagnostics.push({
            impact: i + 1,
            format: 'dot',
            rendered: dotResult.rendered,
            ...(dotResult.reason ? { reason: dotResult.reason } : {}),
            renderer: dotResult.renderer,
          });
        }
        // Inject the graph source into the impact detail page.
        const inject = [
          '<h2>Graph source</h2>',
          '<p class="muted">Copy into <a href="https://mermaid.live">mermaid.live</a> or render locally with <code>dot</code> / <code>mmdc</code>. SharkCraft never starts a renderer or fetches anything unless you opt in with <code>--render-impact-graphs</code>.</p>',
          `<details><summary>Mermaid (<a href="${mermaidFile}">download</a>${mermaidSvgLink})</summary><pre>${esc(mermaid)}</pre></details>`,
          `<details><summary>DOT (<a href="${dotFile}">download</a>${dotSvgLink})</summary><pre>${esc(dot)}</pre></details>`,
        ].join('\n');
        // Place graph source before the trailing </body> tag.
        html = html.replace('</body>', inject + '\n</body>');
      }
      write(`impact-${i + 1}.html`, html);
    }
  } else {
    write(
      'impact.html',
      shell('Impact', impactPlaceholderBody(), {
        current: 'impact',
        description: 'No impact report selected.',
        emptyState: {
          title: 'No impact report embedded',
          body: 'Pass --impact <path> or --impact-dir <dir> to populate this page.',
        },
        commandHints: [
          'shrk impact --since origin/main --format json > .sharkcraft/reports/impact.json',
          'shrk report site --impact .sharkcraft/reports/impact.json',
        ],
      }),
    );
    placeholderPages.push('impact');
  }

  // coverage.html
  let coverageBody = `<h1>Coverage</h1><p>Overall: ${coverage.overall}</p>`;
  coverageBody += '<table><thead><tr><th>Category</th><th>Score</th></tr></thead><tbody>';
  for (const c of coverage.categories) {
    coverageBody += `<tr><td>${esc(c.id)}</td><td>${c.score}</td></tr>`;
  }
  coverageBody += '</tbody></table>';
  write(
    'coverage.html',
    shell('Coverage', coverageBody, {
      current: 'coverage',
      description: 'Coverage of structured knowledge per category.',
      commandHints: ['shrk coverage --json', 'shrk drift'],
    }),
  );

  // drift.html
  let driftBody = `<h1>Drift</h1><p>Errors: ${drift.counts.error}; Warnings: ${drift.counts.warning}; Info: ${drift.counts.info}</p>`;
  driftBody += '<table><thead><tr><th>Severity</th><th>Category</th><th>Message</th></tr></thead><tbody>';
  for (const f of drift.findings.slice(0, 200)) {
    driftBody += `<tr><td>${esc(f.severity)}</td><td>${esc(f.category)}</td><td>${esc(f.message)}</td></tr>`;
  }
  driftBody += '</tbody></table>';
  write(
    'drift.html',
    shell('Drift', driftBody, {
      current: 'drift',
      description: 'Drift between live state and structured knowledge.',
      commandHints: ['shrk drift --json', 'shrk drift baseline-create'],
    }),
  );

  // policies.html
  let policyBody = `<h1>Policies</h1><p>Registered: ${policy.registrations.length}; Findings: ${policy.checks.length}; Passed: ${policy.summary.passed}</p>`;
  policyBody += '<h2>Registered</h2>';
  policyBody += '<table><thead><tr><th>ID</th><th>Source</th><th>Severity</th><th>File</th></tr></thead><tbody>';
  for (const r of policy.registrations) {
    policyBody += `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.source)}</td><td>${esc(r.severity)}</td><td><code>${esc(r.sourceFile)}</code></td></tr>`;
  }
  policyBody += '</tbody></table>';
  if (policy.checks.length > 0) {
    policyBody += '<h2>Findings</h2><ul>';
    for (const c of policy.checks) {
      policyBody += `<li>[${esc(c.severity)}] <code>${esc(c.id)}</code> — ${esc(c.message)}</li>`;
    }
    policyBody += '</ul>';
  }
  write(
    'policies.html',
    shell('Policies', policyBody, {
      current: 'policies',
      description: 'Registered policy checks + the most recent run.',
      commandHints: ['shrk policy run --json', 'shrk policy snapshot --all --gate'],
    }),
  );

  // area-map.html
  write(
    'area-map.html',
    shell('Area map', renderAreaMapHtmlBody(areas), {
      current: 'area-map',
      description: 'Folders grouped by area kind with their boundary rules and risk scores.',
      commandHints: ['shrk repo areas', 'shrk check boundaries --json'],
    }),
  );

  // constructs.html
  if (constructs.length === 0) {
    write(
      'constructs.html',
      shell(
        'Constructs',
        `<h1>Constructs</h1>`,
        {
          current: 'constructs',
          description: 'No constructs registered yet.',
          emptyState: {
            title: 'Add constructs',
            body: 'Define them in `sharkcraft/constructs.ts` with `defineConstruct({...})`, or run `shrk constructs infer --write-drafts` and review the drafts.',
          },
          commandHints: ['shrk constructs infer', 'shrk constructs adopt --write-patch'],
        },
      ),
    );
    placeholderPages.push('constructs');
  } else {
    let cb = `<h1>Constructs (${constructs.length})</h1>`;
    cb += '<table><thead><tr><th>ID</th><th>Type</th><th>Title</th><th>Files</th><th>Public API</th><th>Source</th></tr></thead><tbody>';
    for (const c of constructs) {
      const fileLinks = (c.files ?? [])
        .slice(0, 5)
        .map((f) => `<code>${esc(f)}</code>`)
        .join(', ');
      const api = (c.publicApi ?? []).map((a) => `<code>${esc(a)}</code>`).join(', ');
      cb += `<tr><td><code>${esc(c.id)}</code></td><td>${esc(c.type)}</td><td>${esc(c.title)}</td><td>${fileLinks || '<span class="muted">—</span>'}</td><td>${api || '<span class="muted">—</span>'}</td><td>${esc(c.source)}${c.packageName ? ` <span class="muted">(${esc(c.packageName)})</span>` : ''}</td></tr>`;
    }
    cb += '</tbody></table>';
    cb += `<p class="muted">See also: <a href="area-map.html">area map</a>, <a href="impact.html">impact</a>.</p>`;
    write(
      'constructs.html',
      shell('Constructs', cb, {
        current: 'constructs',
        description: 'Constructs registered via local config or pack contributions.',
        commandHints: ['shrk constructs list', 'shrk constructs trace <id>'],
      }),
    );
  }

  // Pack compat page (optional).
  const wantPackCompat = !options.include || options.include.includes('pack-compat');
  if (wantPackCompat) {
    let body = '<h2>Pack compatibility</h2>';
    if (options.packCompatFile && existsSync(options.packCompatFile)) {
      try {
        const compat = JSON.parse(readFileSync(options.packCompatFile, 'utf8')) as Record<string, unknown> & {
          pack?: string;
          consumerRoot?: string | null;
          symbolCompat?: Record<string, unknown>;
        };
        const sym = (compat.symbolCompat ?? {}) as {
          pluginApiSource?: string | null;
          pluginApiResolution?: string;
          sourceMode?: string;
          confidence?: string;
          availableSymbols?: readonly string[];
          missingSymbols?: readonly string[];
          findings?: readonly { symbol: string; status: string; files: readonly string[] }[];
          suggestions?: readonly string[];
          filesInspected?: readonly string[];
        };
        const escHtml = (s: unknown): string =>
          String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        body += `<p class="muted">pack: <code>${escHtml(compat.pack ?? '(unknown)')}</code></p>`;
        body += `<p class="muted">consumer root: <code>${escHtml(compat.consumerRoot ?? '(unspecified)')}</code></p>`;
        body += '<table><tbody>';
        body += `<tr><th>plugin-api source</th><td><code>${escHtml(sym.pluginApiSource ?? '(not found)')}</code></td></tr>`;
        body += `<tr><th>plugin-api resolution</th><td>${escHtml(sym.pluginApiResolution ?? '')}</td></tr>`;
        body += `<tr><th>source mode</th><td>${escHtml(sym.sourceMode ?? '')}</td></tr>`;
        body += `<tr><th>confidence</th><td>${escHtml(sym.confidence ?? '')}</td></tr>`;
        body += `<tr><th>files inspected</th><td>${(sym.filesInspected ?? []).length}</td></tr>`;
        body += `<tr><th>available symbols</th><td>${(sym.availableSymbols ?? []).length}</td></tr>`;
        body += `<tr><th>missing symbols</th><td>${(sym.missingSymbols ?? []).length}</td></tr>`;
        body += '</tbody></table>';
        if ((sym.missingSymbols ?? []).length > 0) {
          body += '<h3>Missing symbols</h3><ul>';
          for (const s of sym.missingSymbols ?? []) body += `<li><code>${escHtml(s)}</code></li>`;
          body += '</ul>';
        }
        if ((sym.findings ?? []).length > 0) {
          body += '<h3>Findings</h3><table><thead><tr><th>symbol</th><th>status</th><th>files</th></tr></thead><tbody>';
          for (const f of sym.findings ?? []) {
            body += `<tr><td><code>${escHtml(f.symbol)}</code></td><td>${escHtml(f.status)}</td><td>${(f.files ?? []).length}</td></tr>`;
          }
          body += '</tbody></table>';
        }
        if ((sym.suggestions ?? []).length > 0) {
          body += '<h3>Suggestions</h3><ul>';
          for (const s of sym.suggestions ?? []) body += `<li>${escHtml(s)}</li>`;
          body += '</ul>';
        }
      } catch (e) {
        body += `<p class="muted">Could not parse <code>${(e as Error).message}</code></p>`;
        placeholderPages.push('pack-compat');
      }
    } else {
      body +=
        '<p>Run <code>shrk packs compat &lt;pack&gt; --consumer-root &lt;repo&gt; --json &gt; pack-compat.json</code> ' +
        'then rebuild the report site with <code>--pack-compat pack-compat.json</code> to populate this page.</p>';
      placeholderPages.push('pack-compat');
    }
    write(
      'pack-compat.html',
      shell('Pack compatibility', body, {
        current: 'pack-compat',
        description: 'Pack symbol compatibility report.',
        commandHints: ['shrk packs compat <pack> --consumer-root <repo> --json'],
      }),
    );
  }

  // Pages map for quick reference.
  const pages: Record<string, string> = {};
  for (const f of files) {
    const rel = nodePath.basename(f);
    if (rel.endsWith('.html')) {
      const id = rel.replace(/\.html$/, '');
      pages[id] = rel;
    }
  }
  return {
    outputDir,
    files,
    pages,
    impactCount: impacts.length,
    hasReview: Boolean(review),
    placeholderPages,
    ...(impactGraphFiles.length > 0 ? { impactGraphFiles } : {}),
    ...(impactSvgFiles.length > 0 ? { impactSvgFiles } : {}),
    ...(impactRenderDiagnostics.length > 0 ? { impactRenderDiagnostics } : {}),
  };
}

function renderAreaMapHtmlBody(map: IAreaMap): string {
  const lines: string[] = [];
  lines.push('<h1>Area map</h1>');
  lines.push(`<p class="muted">${map.areas.length} areas · ${map.unclassifiedFiles} unclassified files</p>`);
  lines.push('<table><thead><tr><th>Kind</th><th>Files</th><th>Paths</th><th>Boundary rules</th><th>Risk</th></tr></thead><tbody>');
  for (const a of map.areas) {
    lines.push(
      `<tr><td>${esc(a.kind)}</td><td>${a.fileCount}</td><td>${a.paths.map((p) => `<code>${esc(p)}</code>`).join(', ')}</td><td>${a.boundaryRuleIds.length}</td><td>${a.riskScore}</td></tr>`,
    );
  }
  lines.push('</tbody></table>');
  lines.push(`<details><summary>Markdown export</summary><pre>${esc(renderAreaMapMarkdown(map))}</pre></details>`);
  return lines.join('\n');
}

export function buildReportSiteManifest(
  result: IReportSiteResult,
  hasReview: boolean,
): IReportSiteManifest {
  const all: { id: ReportSitePage; file: string; title: string }[] = [
    { id: 'overview', file: 'index.html', title: 'Overview' },
    { id: 'quality', file: 'quality.html', title: 'Quality' },
    { id: 'bundles', file: 'bundles.html', title: 'Bundles' },
    { id: 'review', file: 'review.html', title: 'Review' },
    { id: 'impact', file: 'impact.html', title: 'Impact' },
    { id: 'coverage', file: 'coverage.html', title: 'Coverage' },
    { id: 'drift', file: 'drift.html', title: 'Drift' },
    { id: 'policies', file: 'policies.html', title: 'Policies' },
    { id: 'area-map', file: 'area-map.html', title: 'Area map' },
    { id: 'constructs', file: 'constructs.html', title: 'Constructs' },
  ];
  const populatedKey = (id: ReportSitePage): string =>
    id === 'overview' ? 'index' : id;
  const reviewPopulated = hasReview;
  const impactPopulated = result.impactCount > 0;
  const placeholderSet = new Set(result.placeholderPages);
  const pages: IReportSitePage[] = all.map((p) => {
    let populated = result.pages[populatedKey(p.id)] !== undefined;
    if (p.id === 'review') populated = reviewPopulated;
    if (p.id === 'impact') populated = impactPopulated;
    if (placeholderSet.has(p.id)) populated = false;
    return {
      id: p.id,
      file: p.file,
      title: p.title,
      kind: populated ? 'page' : 'placeholder',
      populated,
    };
  });
  const notes: string[] = [];
  if (!reviewPopulated) notes.push('review.html is a placeholder — re-run with --bundle or --review to populate.');
  if (!impactPopulated)
    notes.push('impact.html is a placeholder — re-run with --impact or --impact-dir to populate.');
  if (placeholderSet.has('constructs')) notes.push('constructs.html shows authoring guidance because no constructs are registered.');
  if (result.impactGraphFiles && result.impactGraphFiles.length > 0) {
    notes.push(
      `impact-graph artifacts embedded: ${result.impactGraphFiles.length} files (mermaid + dot).`,
    );
  }
  return {
    schema: 'sharkcraft.report-site-manifest/v1',
    outputDir: result.outputDir,
    generatedAt: new Date().toISOString(),
    pages,
    notes,
  };
}
