import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildAdoptionReport,
  buildCoverageReport,
  buildDriftReport,
  buildOnboardingAdoptionPlan,
  buildOnboardingPlan,
  buildQualityReport,
  buildReportSite,
  buildSafetyAudit,
  inspectSharkcraft,
  readAdoptionState,
  renderAdoptionReportHtml,
  renderAdoptionReportMarkdown,
  renderAdoptionReportText,
  renderDevSessionHtml,
  renderDevSessionFinalReport,
  renderImpactGraph,
  renderImpactHtml,
  renderImpactMarkdown,
  renderImpactText,
  type ImpactGraphFormat,
  renderReviewComment,
  renderReviewHtml,
  renderQualityHtml,
  renderSafetyHtml,
  scanDevSession,
  type IImpactAnalysis,
  type IQualityConfig,
  type IReviewPacket,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import { COMMAND_CATALOG } from './command-catalog.ts';

type Format = 'text' | 'markdown' | 'html' | 'json';

const VALID_FORMATS: ReadonlySet<Format> = new Set(['text', 'markdown', 'html', 'json'] as Format[]);

interface IDispatchArgs extends ParsedArgs {}

export const reportCommand: ICommandHandler = {
  name: 'report',
  description:
    'Render runtime reports in text / markdown / html / json. Subcommands: adoption / session / quality / safety / review / coverage / drift / graph.',
  usage:
    'shrk report <adoption|session <id>|quality|safety|review <packet.json>|coverage|drift|graph> [--format text|markdown|html|json] [--output <path>] [--collapse-long-sections] [--max-items N] [--include-raw-json] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const sliced: IDispatchArgs = { ...args, positional: args.positional.slice(1) };
    switch (sub) {
      case 'adoption':
        return reportAdoption(sliced);
      case 'session':
        return reportSession(sliced);
      case 'quality':
        return reportQuality(sliced);
      case 'safety':
        return reportSafety(sliced);
      case 'review':
        return reportReview(sliced);
      case 'coverage':
        return reportCoverage(sliced);
      case 'drift':
        return reportDrift(sliced);
      case 'graph':
        return reportGraph(sliced);
      case 'site':
        return reportSite(sliced);
      case 'impact':
        return reportImpact(sliced);
      case 'language':
      case 'languages':
        return reportLanguage(sliced);
      default:
        process.stderr.write(
          'Usage: shrk report <adoption|session <id>|quality|safety|review <packet.json>|coverage|drift|graph|site|impact <impact.json>|language> [options]\n',
        );
        return 2;
    }
  },
};

async function reportLanguage(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const {
    detectLanguageProfiles,
    buildLanguageCommandReport,
    scanPolyglotDependencies,
    buildPolyglotBoundaryReport,
    loadRepositoryMemory,
    renderLanguageProfilesMarkdown,
    renderLanguageProfilesText,
    renderLanguageCommandsMarkdown,
    renderLanguageCommandsText,
    renderPolyglotDependenciesText,
    renderPolyglotBoundaryReportText,
    renderPolyglotBoundaryReportMarkdown,
  } = await import('@shrkcrft/inspector');
  const profiles = detectLanguageProfiles(cwd);
  const commands = buildLanguageCommandReport(cwd, profiles);
  const deps = scanPolyglotDependencies(cwd);
  const includeBoundaries = flagBool(args, 'include-boundaries');
  const includeMemory = flagBool(args, 'include-memory');
  const boundary = includeBoundaries ? buildPolyglotBoundaryReport({ projectRoot: cwd, cached: profiles, graph: deps }) : undefined;
  const memory = includeMemory ? loadRepositoryMemory(cwd) : undefined;
  const format = resolveFormat(args, 'text');
  const combined = { profiles, commands, dependencies: deps, ...(boundary ? { boundary } : {}), ...(memory ? { memoryHotspots: memory.languageHotspots ?? [] } : {}) };
  let body: string;
  if (format === 'json') body = JSON.stringify(versioned('language', combined), null, 2) + '\n';
  else if (format === 'markdown') {
    body =
      renderLanguageProfilesMarkdown(profiles) +
      '\n' +
      renderLanguageCommandsMarkdown(commands) +
      '\n## Polyglot dependencies\n\n```text\n' +
      renderPolyglotDependenciesText(deps) +
      '```\n' +
      (boundary ? '\n' + renderPolyglotBoundaryReportMarkdown(boundary) : '') +
      (memory && memory.languageHotspots ? '\n## Memory hotspots by language\n\n' + memory.languageHotspots.map((h) => `- \`${h.language}\` — ${h.fileCount} files, weight ${h.totalWeight}`).join('\n') + '\n' : '');
  } else if (format === 'html') {
    body = baseHtml(
      'SharkCraft language report',
      `<h1>Language report</h1><pre>${escapeHtml(
        renderLanguageProfilesText(profiles) + '\n' +
        renderLanguageCommandsText(commands) + '\n' +
        renderPolyglotDependenciesText(deps) +
        (boundary ? '\n' + renderPolyglotBoundaryReportText(boundary) : '') +
        (memory && memory.languageHotspots ? '\n' + memory.languageHotspots.map((h) => `- ${h.language} — ${h.fileCount} files, weight ${h.totalWeight}`).join('\n') : '')
      )}</pre>`,
    );
  } else {
    body =
      renderLanguageProfilesText(profiles) +
      '\n' +
      renderLanguageCommandsText(commands) +
      '\n' +
      renderPolyglotDependenciesText(deps) +
      (boundary ? '\n' + renderPolyglotBoundaryReportText(boundary) : '') +
      (memory && memory.languageHotspots ? '\n=== Memory hotspots by language ===\n' + memory.languageHotspots.map((h) => `  - ${h.language}: ${h.fileCount} files, weight ${h.totalWeight}`).join('\n') + '\n' : '');
  }
  return writeOrPrint(args, cwd, body);
}

async function reportSite(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const output = flagString(args, 'output') ?? '.sharkcraft/reports/site';
  const abs = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
  const opts: {
    bundleId?: string;
    reviewPacketFile?: string;
    impactFile?: string;
    impactDir?: string;
    withImpactGraphs?: boolean;
    renderImpactGraphs?: boolean;
    title?: string;
    brand?: string;
    safetyMatrixUrl?: string;
    runtimeCompatibilityUrl?: string;
    bundleDiffFile?: string;
    packCompatFile?: string;
  } = {};
  const bundle = flagString(args, 'bundle');
  if (bundle) opts.bundleId = bundle;
  const review = flagString(args, 'review');
  if (review) opts.reviewPacketFile = review;
  const impactFlag = flagString(args, 'impact');
  if (impactFlag) {
    opts.impactFile = nodePath.isAbsolute(impactFlag) ? impactFlag : nodePath.resolve(cwd, impactFlag);
  }
  const impactDirFlag = flagString(args, 'impact-dir');
  if (impactDirFlag) {
    opts.impactDir = nodePath.isAbsolute(impactDirFlag)
      ? impactDirFlag
      : nodePath.resolve(cwd, impactDirFlag);
  }
  if (flagBool(args, 'with-impact-graphs')) opts.withImpactGraphs = true;
  if (flagBool(args, 'render-impact-graphs')) {
    opts.withImpactGraphs = true;
    opts.renderImpactGraphs = true;
  }
  const title = flagString(args, 'title');
  if (title) opts.title = title;
  const brand = flagString(args, 'brand');
  if (brand) opts.brand = brand;
  const safetyUrl = flagString(args, 'safety-matrix');
  if (safetyUrl) opts.safetyMatrixUrl = safetyUrl;
  const compatUrl = flagString(args, 'runtime-compat');
  if (compatUrl) opts.runtimeCompatibilityUrl = compatUrl;
  const bundleDiff = flagString(args, 'bundle-diff');
  if (bundleDiff) opts.bundleDiffFile = nodePath.isAbsolute(bundleDiff) ? bundleDiff : nodePath.resolve(cwd, bundleDiff);
  const packCompat = flagString(args, 'pack-compat');
  if (packCompat) opts.packCompatFile = nodePath.isAbsolute(packCompat) ? packCompat : nodePath.resolve(cwd, packCompat);
  const r = await buildReportSite(inspection, abs, opts);
  // Also write languages.html alongside the rest of the site.
  try {
    const {
      detectLanguageProfiles,
      buildLanguageCommandReport,
      scanPolyglotDependencies,
      renderLanguageProfilesMarkdown,
      renderLanguageCommandsMarkdown,
      renderPolyglotDependenciesText,
    } = await import('@shrkcrft/inspector');
    const profiles = detectLanguageProfiles(cwd);
    const commands = buildLanguageCommandReport(cwd, profiles);
    const deps = scanPolyglotDependencies(cwd);
    const md =
      renderLanguageProfilesMarkdown(profiles) +
      '\n' +
      renderLanguageCommandsMarkdown(commands) +
      '\n## Polyglot dependencies\n\n```text\n' +
      renderPolyglotDependenciesText(deps) +
      '```\n';
    const html = baseHtml('Languages — SharkCraft report site', `<h1>Languages</h1><pre>${escapeHtml(md)}</pre>`);
    const langFile = nodePath.join(r.outputDir, 'languages.html');
    writeFileSync(langFile, html, 'utf8');
    (r.files as unknown as string[]).push(langFile);
  } catch {
    // Best-effort; never break report site on language detection failures.
  }
  if (flagBool(args, 'manifest')) {
    const { buildReportSiteManifest } = await import('@shrkcrft/inspector');
    const manifest = buildReportSiteManifest(r, Boolean(bundle || review));
    process.stdout.write(asJson(manifest) + '\n');
    return 0;
  }
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        outputDir: r.outputDir,
        files: r.files,
        pages: r.pages,
        impactCount: r.impactCount,
        hasReview: r.hasReview,
        ...(r.impactGraphFiles ? { impactGraphFiles: r.impactGraphFiles } : {}),
        ...(r.impactSvgFiles ? { impactSvgFiles: r.impactSvgFiles } : {}),
        ...(r.impactRenderDiagnostics ? { impactRenderDiagnostics: r.impactRenderDiagnostics } : {}),
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(`Wrote ${r.files.length} file(s) → ${r.outputDir}\n`);
  for (const f of r.files) process.stdout.write(`  + ${f}\n`);
  if (r.impactGraphFiles && r.impactGraphFiles.length > 0) {
    process.stdout.write(
      `\nEmbedded ${r.impactGraphFiles.length} impact-graph artifact(s).\n`,
    );
  }
  if (r.impactSvgFiles && r.impactSvgFiles.length > 0) {
    process.stdout.write(
      `Rendered ${r.impactSvgFiles.length} impact-graph SVG(s) via ${[
        ...new Set(r.impactSvgFiles.map((f) => f.renderer)),
      ].join('/')}.\n`,
    );
  } else if (r.impactRenderDiagnostics && r.impactRenderDiagnostics.length > 0) {
    const skipped = r.impactRenderDiagnostics.filter((d) => !d.rendered);
    if (skipped.length > 0) {
      const reasons = [...new Set(skipped.map((s) => s.reason).filter(Boolean))];
      process.stdout.write(
        `Skipped SVG rendering for ${skipped.length} graph(s): ${reasons.join(', ') || 'renderer-missing'}.\n`,
      );
    }
  }
  return 0;
}

function resolveFormat(args: ParsedArgs, defaultIfJsonFlag: Format = 'text'): Format {
  const f = flagString(args, 'format');
  if (f && !VALID_FORMATS.has(f as Format)) {
    process.stderr.write(`Invalid --format "${f}". Use text|markdown|html|json.\n`);
    process.exit(2);
  }
  if (f) return f as Format;
  if (flagBool(args, 'json')) return 'json';
  return defaultIfJsonFlag;
}

function writeOrPrint(args: ParsedArgs, cwd: string, body: string): number {
  const out = flagString(args, 'output');
  if (out) {
    const abs = nodePath.isAbsolute(out) ? out : nodePath.resolve(cwd, out);
    writeFileSync(abs, body, 'utf8');
    if (flagBool(args, 'json'))
      process.stdout.write(asJson({ wrote: abs, bytes: Buffer.byteLength(body) }) + '\n');
    else process.stdout.write(`Wrote report to ${abs}\n`);
    return 0;
  }
  process.stdout.write(body);
  return 0;
}

async function reportAdoption(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const plan = buildOnboardingPlan(inspection, {});
  const adoption = buildOnboardingAdoptionPlan({ inspection, plan });
  const state = readAdoptionState(cwd);
  const report = buildAdoptionReport({ projectRoot: cwd, plan: adoption, state });
  const format = resolveFormat(args);
  let body: string;
  if (format === 'json') body = JSON.stringify(versioned('adoption', report), null, 2) + '\n';
  else if (format === 'markdown') body = renderAdoptionReportMarkdown(report);
  else if (format === 'html') body = renderAdoptionReportHtml(report);
  else body = renderAdoptionReportText(report);
  return writeOrPrint(args, cwd, body);
}

async function reportSession(args: ParsedArgs): Promise<number> {
  const id = args.positional[0];
  if (!id) {
    process.stderr.write('Usage: shrk report session <id> [--format html|markdown|json]\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const load = scanDevSession(cwd, id);
  if (!load || !load.state) {
    process.stderr.write(`Session not found: ${id}\n`);
    return 1;
  }
  const format = resolveFormat(args);
  let body: string;
  if (format === 'json')
    body = JSON.stringify(versioned('session', { id, state: load.state }), null, 2) + '\n';
  else if (format === 'html') body = renderDevSessionHtml(load);
  else if (format === 'markdown' || format === 'text')
    body = renderDevSessionFinalReport(load, {});
  else body = JSON.stringify(load, null, 2) + '\n';
  return writeOrPrint(args, cwd, body);
}

async function reportQuality(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const cfgUnknown = inspection.config as unknown as { qualityGates?: IQualityConfig };
  const cfg = cfgUnknown?.qualityGates ?? {};
  const report = await buildQualityReport({
    inspection,
    config: cfg,
    strict: flagBool(args, 'strict'),
  });
  const format = resolveFormat(args);
  let body: string;
  if (format === 'json') body = JSON.stringify(versioned('quality', report), null, 2) + '\n';
  else if (format === 'html') body = renderQualityHtml(report);
  else body = renderQualityText(report);
  return writeOrPrint(args, cwd, body);
}

async function reportSafety(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  // Lazy-load MCP tool list (kept consistent with `shrk safety audit`).
  const mcpMod = (await import('@shrkcrft/mcp-server')) as { ALL_TOOLS?: ReadonlyArray<{ name: string; description: string }> };
  const tools = mcpMod.ALL_TOOLS ?? [];
  const audit = buildSafetyAudit({
    inspection,
    catalog: COMMAND_CATALOG,
    mcpTools: tools.map((t) => ({ name: t.name, description: t.description, canWrite: false })),
    planSecretEnv: 'SHARKCRAFT_PLAN_SECRET',
    planSecretConfigured: typeof process.env.SHARKCRAFT_PLAN_SECRET === 'string' && process.env.SHARKCRAFT_PLAN_SECRET.length > 0,
  });
  const format = resolveFormat(args);
  let body: string;
  if (format === 'json') body = JSON.stringify(versioned('safety', audit), null, 2) + '\n';
  else if (format === 'html') body = renderSafetyHtml(audit);
  else body = renderSafetyText(audit);
  return writeOrPrint(args, cwd, body);
}

async function reportReview(args: ParsedArgs): Promise<number> {
  const file = args.positional[0];
  if (!file) {
    process.stderr.write('Usage: shrk report review <packet.json> [--format html|markdown|json]\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const abs = nodePath.isAbsolute(file) ? file : nodePath.resolve(cwd, file);
  if (!existsSync(abs)) {
    process.stderr.write(`Packet not found: ${abs}\n`);
    return 1;
  }
  const packet = JSON.parse(readFileSync(abs, 'utf8')) as IReviewPacket;
  const format = resolveFormat(args);
  let body: string;
  if (format === 'json') body = JSON.stringify(versioned('review', packet), null, 2) + '\n';
  else if (format === 'html')
    body = renderReviewHtml(packet, {
      ...(flagBool(args, 'collapse-long-sections') ? { collapseLongSections: true } : {}),
      ...(flagString(args, 'max-items') ? { maxItems: parseInt(flagString(args, 'max-items')!, 10) } : {}),
    });
  else body = renderReviewComment(packet, {});
  return writeOrPrint(args, cwd, body);
}

async function reportCoverage(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const r = buildCoverageReport(inspection);
  const format = resolveFormat(args);
  let body: string;
  if (format === 'json') body = JSON.stringify(versioned('coverage', r), null, 2) + '\n';
  else if (format === 'markdown') body = renderCoverageMarkdown(r);
  else if (format === 'html') body = renderCoverageHtml(r);
  else body = renderCoverageText(r);
  return writeOrPrint(args, cwd, body);
}

async function reportDrift(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const r = buildDriftReport(inspection);
  const format = resolveFormat(args);
  let body: string;
  if (format === 'json') body = JSON.stringify(versioned('drift', r), null, 2) + '\n';
  else if (format === 'markdown') body = renderDriftMarkdown(r);
  else if (format === 'html') body = renderDriftHtml(r);
  else body = renderDriftText(r);
  return writeOrPrint(args, cwd, body);
}

async function reportImpact(args: ParsedArgs): Promise<number> {
  const file = args.positional[0];
  if (!file) {
    process.stderr.write('Usage: shrk report impact <impact-report.json> [--format html|markdown|text|json] [--include-graph [--graph-format mermaid|dot]]\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const abs = nodePath.isAbsolute(file) ? file : nodePath.resolve(cwd, file);
  if (!existsSync(abs)) {
    process.stderr.write(`Impact report not found: ${abs}\n`);
    return 1;
  }
  const impact = JSON.parse(readFileSync(abs, 'utf8')) as IImpactAnalysis;
  const format = resolveFormat(args, 'text');
  let body: string;
  if (format === 'json') body = JSON.stringify(versioned('impact', impact), null, 2) + '\n';
  else if (format === 'markdown') body = renderImpactMarkdown(impact);
  else if (format === 'html') body = renderImpactHtml(impact);
  else body = renderImpactText(impact);

  if (flagBool(args, 'include-graph')) {
    const gfmt = (flagString(args, 'graph-format') ?? 'mermaid') as ImpactGraphFormat;
    const graph = renderImpactGraph(impact, gfmt);
    if (format === 'html') {
      // Embed the graph source as preformatted text (no JS rendering).
      const escaped = graph
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      body = body.replace(
        /<\/body>/i,
        `<h2>Dependency graph (${gfmt})</h2><pre>${escaped}</pre></body>`,
      );
    } else if (format === 'markdown') {
      body += `\n\n## Dependency graph (${gfmt})\n\n\`\`\`${gfmt}\n${graph}\`\`\`\n`;
    } else if (format !== 'json') {
      body += `\n--- Dependency graph (${gfmt}) ---\n${graph}`;
    }
  }
  return writeOrPrint(args, cwd, body);
}

async function reportGraph(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  // We don't include the whole graph by default to keep the body sane;
  // include counts + node-type breakdown.
  const summary = {
    nodes: {
      knowledge: inspection.knowledgeEntries.length,
      templates: inspection.templates.length,
      pipelines: inspection.pipelines.length,
      packs: inspection.packs.validPacks.length,
    },
  };
  const format = resolveFormat(args);
  let body: string;
  if (format === 'json') body = JSON.stringify(versioned('graph', summary), null, 2) + '\n';
  else body = JSON.stringify(summary, null, 2) + '\n';
  return writeOrPrint(args, cwd, body);
}

// ─── Dashboard-ready JSON envelope ────────────────────────────────────────────

interface IRuntimeReportEnvelope<T> {
  schema: 'sharkcraft.runtime-report/v1';
  reportKind: string;
  generatedAt: string;
  payload: T;
}

function versioned<T>(kind: string, payload: T): IRuntimeReportEnvelope<T> {
  return {
    schema: 'sharkcraft.runtime-report/v1',
    reportKind: kind,
    generatedAt: new Date().toISOString(),
    payload,
  };
}

// ─── Tiny text/markdown renderers used by the group ───────────────────────────

function renderQualityText(r: Awaited<ReturnType<typeof buildQualityReport>>): string {
  const out: string[] = [];
  out.push('=== Quality report ===');
  out.push(`  overall    ${r.overall}`);
  out.push(`  score      ${r.score}`);
  out.push(`  blockers   ${r.blockers}`);
  out.push(`  warnings   ${r.warnings}`);
  out.push('');
  for (const g of r.gates) {
    const tag = g.passed ? 'OK  ' : g.blocking ? 'FAIL' : 'WARN';
    out.push(`  ${tag} ${g.id.padEnd(18)} ${g.label}`);
  }
  return out.join('\n') + '\n';
}

function renderSafetyText(audit: ReturnType<typeof buildSafetyAudit>): string {
  const out: string[] = [];
  out.push('=== Safety audit ===');
  out.push(`  MCP anyWritable    ${audit.mcp.anyWritable}`);
  out.push(`  writes-source      ${audit.commands.writesSource.length}`);
  out.push(`  writes-drafts      ${audit.commands.writesDrafts.length}`);
  out.push(`  writes-session     ${audit.commands.writesSession.length}`);
  out.push(`  runs-shell         ${audit.commands.runsShell.length}`);
  out.push(`  read-only          ${audit.commands.readOnly.length}`);
  out.push('');
  if (audit.recommendations.length > 0) {
    out.push('Recommendations:');
    for (const r of audit.recommendations) out.push(`  - ${r}`);
  }
  return out.join('\n') + '\n';
}

function renderCoverageText(r: ReturnType<typeof buildCoverageReport>): string {
  const counts = (r as unknown as { counts?: Record<string, number> }).counts ?? {};
  const out: string[] = ['=== Coverage ==='];
  for (const [k, v] of Object.entries(counts)) out.push(`  ${k.padEnd(22)} ${v}`);
  return out.join('\n') + '\n';
}

function renderCoverageMarkdown(r: ReturnType<typeof buildCoverageReport>): string {
  const counts = (r as unknown as { counts?: Record<string, number> }).counts ?? {};
  const lines: string[] = ['# Coverage', '', '| Axis | Count |', '|---|---|'];
  for (const [k, v] of Object.entries(counts)) lines.push(`| \`${k}\` | ${v} |`);
  return lines.join('\n') + '\n';
}

function renderCoverageHtml(r: ReturnType<typeof buildCoverageReport>): string {
  return baseHtml('SharkCraft coverage', `<h1>Coverage</h1><pre>${JSON.stringify(r, null, 2)}</pre>`);
}

function renderDriftText(r: ReturnType<typeof buildDriftReport>): string {
  const counts = (r as unknown as { counts?: Record<string, number> }).counts ?? {};
  const out: string[] = ['=== Drift ==='];
  for (const [k, v] of Object.entries(counts)) out.push(`  ${k.padEnd(22)} ${v}`);
  return out.join('\n') + '\n';
}

function renderDriftMarkdown(r: ReturnType<typeof buildDriftReport>): string {
  const counts = (r as unknown as { counts?: Record<string, number> }).counts ?? {};
  const lines: string[] = ['# Drift', '', '| Severity | Count |', '|---|---|'];
  for (const [k, v] of Object.entries(counts)) lines.push(`| \`${k}\` | ${v} |`);
  return lines.join('\n') + '\n';
}

function renderDriftHtml(r: ReturnType<typeof buildDriftReport>): string {
  return baseHtml('SharkCraft drift', `<h1>Drift</h1><pre>${escapeHtml(JSON.stringify(r, null, 2))}</pre>`);
}

function baseHtml(title: string, content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1419;color:#e6e1cf;padding:2rem;line-height:1.55}pre{background:#1c2329;padding:.8rem;border-radius:.4rem;overflow-x:auto}h1{color:#bae67e}@media (prefers-color-scheme: light){body{background:#fafaf7;color:#1f2329}pre{background:#eee}}</style>
</head><body>${content}</body></html>\n`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
