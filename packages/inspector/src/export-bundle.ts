import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import { getBundleDir, readFeatureBundle, type IFeatureBundle } from './feature-bundle.ts';
import { getDevSessionDir, readDevSessionState } from './dev-session.ts';

export interface IExportResult {
  outputDir: string;
  files: readonly string[];
  format: 'folder';
}

function copyDir(src: string, dest: string): string[] {
  const out: string[] = [];
  if (!existsSync(src)) return out;
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src)) {
    const s = nodePath.join(src, e);
    const d = nodePath.join(dest, e);
    let st;
    try {
      st = statSync(s);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...copyDir(s, d));
    else if (st.isFile()) {
      copyFileSync(s, d);
      out.push(d);
    }
  }
  return out;
}

function writeSummary(dir: string, title: string, body: string): string {
  const file = nodePath.join(dir, 'summary.md');
  writeFileSync(file, `# ${title}\n\n${body}\n`, 'utf8');
  return file;
}

export function exportFeatureBundle(
  cwd: string,
  bundleId: string,
  outputDir: string,
): IExportResult | null {
  const bundle = readFeatureBundle(cwd, bundleId);
  if (!bundle) return null;
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];
  const src = getBundleDir(cwd, bundleId);
  files.push(...copyDir(src, outputDir));
  files.push(
    writeSummary(
      outputDir,
      `Feature bundle: ${bundle.task}`,
      buildBundleSummary(bundle),
    ),
  );
  return { outputDir, files, format: 'folder' };
}

export function exportDevSession(
  cwd: string,
  sessionId: string,
  outputDir: string,
): IExportResult | null {
  const session = readDevSessionState(cwd, sessionId);
  if (!session) return null;
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];
  const src = getDevSessionDir(cwd, sessionId);
  files.push(...copyDir(src, outputDir));
  files.push(
    writeSummary(
      outputDir,
      `Dev session: ${session.task}`,
      `Phase: ${session.phase}\n\nPlans: ${session.plans.length}\nValidations: ${session.validations.length}\n`,
    ),
  );
  return { outputDir, files, format: 'folder' };
}

export function exportQuality(
  cwd: string,
  outputDir: string,
  report: unknown,
): IExportResult {
  mkdirSync(outputDir, { recursive: true });
  const file = nodePath.join(outputDir, 'quality.json');
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
  const sum = writeSummary(outputDir, 'Quality export', 'See quality.json');
  return { outputDir, files: [file, sum], format: 'folder' };
}

export function exportReview(
  cwd: string,
  packetFile: string,
  outputDir: string,
): IExportResult | null {
  if (!existsSync(packetFile)) return null;
  mkdirSync(outputDir, { recursive: true });
  const destPacket = nodePath.join(outputDir, 'review-packet.json');
  copyFileSync(packetFile, destPacket);
  let body = 'See review-packet.json';
  try {
    const parsed = JSON.parse(readFileSync(packetFile, 'utf8')) as { changedFiles?: readonly string[] };
    body = `Changed files: ${parsed.changedFiles?.length ?? 0}\n`;
  } catch {
    /* ignore */
  }
  const sum = writeSummary(outputDir, 'Review packet export', body);
  return { outputDir, files: [destPacket, sum], format: 'folder' };
}

function buildBundleSummary(bundle: IFeatureBundle): string {
  return [
    `Status: ${bundle.status}`,
    `Plans: ${bundle.plans.length}`,
    `Risk: ${bundle.riskLevel}`,
    `Next: ${bundle.nextAction ?? '(none)'}`,
    '',
    `Affected areas:`,
    ...(bundle.affectedAreas.map((a) => `- ${a}`)),
  ].join('\n');
}
