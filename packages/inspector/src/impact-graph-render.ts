/**
 * Optional static SVG rendering for impact graphs.
 *
 * SharkCraft never invokes a renderer unless the user passes
 * `--render-impact-graphs` / `--render-svg` — and even then the renderer
 * runs as a local subprocess against locally-generated source files,
 * never against remote input.
 *
 * Supported renderers (best-effort, neither required):
 * - Mermaid: `mmdc` (mermaid-cli). Reads stdin or a `.mmd` file, writes `.svg`.
 * - DOT:     `dot` (graphviz). Reads `.dot`, writes `.svg`.
 *
 * If the renderer binary is missing, this module degrades gracefully and
 * returns `{ rendered: false, reason: 'renderer-missing', renderer: null }`
 * so callers can keep the source-only behaviour.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { promisify } from 'node:util';
import type { ImpactGraphFormat } from './impact-graph.ts';

const execFileAsync = promisify(execFile);

export const IMPACT_GRAPH_RENDER_SCHEMA = 'sharkcraft.impact-graph-render/v1';

export interface IImpactGraphRenderResult {
  schema: typeof IMPACT_GRAPH_RENDER_SCHEMA;
  format: ImpactGraphFormat;
  /** Whether the renderer actually produced an SVG. */
  rendered: boolean;
  /** Renderer binary used (when `rendered === true`). */
  renderer: 'mmdc' | 'dot' | null;
  /** Absolute path to the SVG when rendered. */
  svgFile: string | null;
  /** Reason for skipping the render, if any. */
  reason?: 'renderer-missing' | 'renderer-failed' | 'source-missing' | 'disabled';
  /** Captured stderr/stdout when the renderer failed (truncated). */
  stderr?: string;
}

interface IRunOptions {
  /** Override the renderer binary path (test injection). */
  override?: { mmdc?: string | null; dot?: string | null };
  /** Timeout per render in milliseconds. Default: 30s. */
  timeoutMs?: number;
}

async function which(binary: string): Promise<string | null> {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = await execFileAsync(cmd, [binary], { timeout: 5000 });
    const path = result.stdout.toString().trim().split(/\r?\n/)[0];
    if (path && path.length > 0) return path;
  } catch {
    /* not on PATH */
  }
  return null;
}

async function resolveRenderer(
  format: ImpactGraphFormat,
  options: IRunOptions,
): Promise<{ binary: 'mmdc' | 'dot'; path: string } | null> {
  if (format === 'mermaid') {
    if (options.override?.mmdc === null) return null;
    if (options.override?.mmdc) return { binary: 'mmdc', path: options.override.mmdc };
    const path = await which('mmdc');
    if (path) return { binary: 'mmdc', path };
    return null;
  }
  if (format === 'dot') {
    if (options.override?.dot === null) return null;
    if (options.override?.dot) return { binary: 'dot', path: options.override.dot };
    const path = await which('dot');
    if (path) return { binary: 'dot', path };
    return null;
  }
  return null;
}

export interface IRenderImpactGraphSvgInput {
  /** Absolute path to the source file (`.mmd` or `.dot`). */
  sourceFile: string;
  /** Absolute path where the SVG should be written. */
  svgFile: string;
  format: ImpactGraphFormat;
}

/**
 * Render an existing graph source file to SVG. Returns a result struct;
 * never throws. If the renderer binary is missing, returns
 * `{ rendered: false, reason: 'renderer-missing' }`.
 */
export async function renderImpactGraphSvg(
  input: IRenderImpactGraphSvgInput,
  options: IRunOptions = {},
): Promise<IImpactGraphRenderResult> {
  if (!existsSync(input.sourceFile)) {
    return {
      schema: IMPACT_GRAPH_RENDER_SCHEMA,
      format: input.format,
      rendered: false,
      renderer: null,
      svgFile: null,
      reason: 'source-missing',
    };
  }
  const resolved = await resolveRenderer(input.format, options);
  if (!resolved) {
    return {
      schema: IMPACT_GRAPH_RENDER_SCHEMA,
      format: input.format,
      rendered: false,
      renderer: null,
      svgFile: null,
      reason: 'renderer-missing',
    };
  }
  // Make sure the parent directory exists.
  mkdirSync(nodePath.dirname(input.svgFile), { recursive: true });
  const timeout = options.timeoutMs ?? 30_000;
  try {
    if (resolved.binary === 'mmdc') {
      // `mmdc -i <in> -o <out>`. We always pass file paths — never stdin —
      // so the renderer never sees data the user didn't already have on disk.
      await execFileAsync(
        resolved.path,
        ['-i', input.sourceFile, '-o', input.svgFile, '-q'],
        { timeout },
      );
    } else {
      // `dot -Tsvg <in> -o <out>`.
      await execFileAsync(
        resolved.path,
        ['-Tsvg', input.sourceFile, '-o', input.svgFile],
        { timeout },
      );
    }
    if (!existsSync(input.svgFile)) {
      return {
        schema: IMPACT_GRAPH_RENDER_SCHEMA,
        format: input.format,
        rendered: false,
        renderer: resolved.binary,
        svgFile: null,
        reason: 'renderer-failed',
      };
    }
    return {
      schema: IMPACT_GRAPH_RENDER_SCHEMA,
      format: input.format,
      rendered: true,
      renderer: resolved.binary,
      svgFile: input.svgFile,
    };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    const stderr =
      typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf8') ?? err.message;
    return {
      schema: IMPACT_GRAPH_RENDER_SCHEMA,
      format: input.format,
      rendered: false,
      renderer: resolved.binary,
      svgFile: null,
      reason: 'renderer-failed',
      stderr: stderr.slice(0, 4000),
    };
  }
}

/**
 * Write the graph source to disk and then attempt to render it. Convenience
 * helper for the report-site path where we already have the source body.
 */
export async function writeAndRenderImpactGraph(input: {
  sourceBody: string;
  sourceFile: string;
  svgFile: string;
  format: ImpactGraphFormat;
  options?: IRunOptions;
}): Promise<IImpactGraphRenderResult> {
  mkdirSync(nodePath.dirname(input.sourceFile), { recursive: true });
  writeFileSync(input.sourceFile, input.sourceBody, 'utf8');
  return renderImpactGraphSvg(
    { sourceFile: input.sourceFile, svgFile: input.svgFile, format: input.format },
    input.options ?? {},
  );
}
