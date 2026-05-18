import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { detectProjectRoot, inspectWorkspace } from '@shrkcrft/workspace';
import {
  applyPresetPlan,
  BUILTIN_PRESETS,
  PresetRegistry,
  previewPresetApplication,
  recommendPresets
} from '@shrkcrft/presets';
import { listBuiltInSurfaceProfiles, suggestSurfaceProfile } from '@shrkcrft/inspector';
import { INIT_FILES } from '../init/init-templates.ts';
import { buildDetectedBlock, renderDetectedBlockText } from '../init/detected-block.ts';
import { ensureSharkcraftGitignore, renderGitignorePatch } from '../init/gitignore.ts';
import { applySurfaceTextEdit } from '../surface/surface-config-writer.ts';
import { flagBool, flagString, type ICommandHandler, type ParsedArgs, resolveCwd } from '../command-registry.ts';
import { bullet, header } from '../output/format-output.ts';

const LEGACY_PRESET_ID = 'legacy-init';

interface IInitMode {
  presetId: string;
  dryRun: boolean;
  force: boolean;
  merge: boolean;
  showDetectedProfiles: boolean;
  /** When true, leave `.gitignore` untouched. */
  skipGitignore: boolean;
  /**
   * Explicit surface-profile override. When omitted, init detects
   * the workspace shape and picks one of the built-in profiles.
   */
  surfaceProfile?: string;
  /**
   * Surfaced reason for the detected profile (shown in the next-
   * steps block and persisted as a comment in `sharkcraft.config.ts`).
   */
  surfaceProfileReason?: string;
}

interface ISurfaceProfileDecision {
  profile: string;
  reason: string;
  source: 'override' | 'detected';
}

async function resolveSurfaceProfile(
  cwd: string,
  override: string | undefined,
): Promise<ISurfaceProfileDecision> {
  if (override) {
    const all = listBuiltInSurfaceProfiles() as readonly string[];
    if (!all.includes(override)) {
      throw new Error(
        `Unknown --surface-profile "${override}". Choose one of: ${all.join(', ')}.`,
      );
    }
    return {
      profile: override,
      reason: 'explicit --surface-profile override.',
      source: 'override',
    };
  }
  const ws = await inspectWorkspace({ startDir: cwd });
  const sug = suggestSurfaceProfile(ws.profiles);
  return {
    profile: sug.profile,
    reason: sug.reason,
    source: 'detected',
  };
}

/**
 * Inject the chosen surface profile into the generated
 * `sharkcraft.config.ts`. Idempotent: if a `surface:` block already
 * names the same profile, the file is left untouched.
 */
function injectSurfaceProfile(
  sharkcraftDir: string,
  decision: ISurfaceProfileDecision,
): { written: boolean; configFile: string; alreadyMatched: boolean } {
  const configFile = nodePath.join(sharkcraftDir, 'sharkcraft.config.ts');
  if (!existsSync(configFile)) {
    return { written: false, configFile, alreadyMatched: false };
  }
  const original = readFileSync(configFile, 'utf8');
  const profileRegex = /profile\s*:\s*['"]([^'"]+)['"]/m;
  const existing = profileRegex.exec(original);
  if (existing && existing[1] === decision.profile) {
    return { written: false, configFile, alreadyMatched: true };
  }
  const updated = applySurfaceTextEdit(original, {
    profile: decision.profile,
    enabled: [],
    hidden: [],
  });
  const comment = `// surface.profile picked by \`shrk init\` (${decision.source}): ${decision.reason}\n`;
  // Insert the comment immediately above the surface block so it survives
  // re-writes of the surface block itself.
  const final = updated.replace(/(^\s*surface\s*:\s*\{)/m, `${comment}$1`);
  writeFileSync(configFile, final, 'utf8');
  return { written: true, configFile, alreadyMatched: false };
}

async function pickAutoPreset(cwd: string): Promise<{
  presetId: string;
  profiles: readonly string[];
  reasons: readonly string[];
}> {
  const ws = await inspectWorkspace({ startDir: cwd });
  const recs = recommendPresets([...BUILTIN_PRESETS], {
    profiles: ws.profiles,
    limit: 1,
  });
  const top = recs[0];
  if (!top) {
    return { presetId: 'generic', profiles: ws.profiles, reasons: ['no high-signal preset matched; fell back to generic'] };
  }
  return { presetId: top.preset.id, profiles: ws.profiles, reasons: top.reasons };
}

async function applyPresetInit(cwd: string, mode: IInitMode): Promise<number> {
  const registry = new PresetRegistry([...BUILTIN_PRESETS]);
  const preset = registry.get(mode.presetId);
  if (!preset) {
    process.stderr.write(
      `Unknown preset: ${mode.presetId}. Run \`shrk presets list\` to see options.\n`,
    );
    return 1;
  }
  const plan = previewPresetApplication(preset, {
    projectRoot: cwd,
    force: mode.force,
    merge: mode.merge,
  });

  if (mode.dryRun) {
    process.stdout.write(header('SharkCraft init — dry-run'));
    process.stdout.write(`Preset: ${preset.id} — ${preset.title}\n`);
    process.stdout.write(`Folder: ${plan.sharkcraftDir}\n`);
    if (mode.showDetectedProfiles) {
      try {
        const ws = await inspectWorkspace({ startDir: cwd });
        process.stdout.write(`Detected profiles: ${ws.profiles.join(', ') || '(none)'}\n`);
        // Include the structured Detected block so the user sees
        // exactly what was detected vs. what was guessed/inferred.
        const detected = buildDetectedBlock(cwd, ws);
        process.stdout.write(header('Detected'));
        process.stdout.write(renderDetectedBlockText(detected) + '\n');
      } catch {
        // best-effort; do not fail dry-run on inspect errors
      }
    }
    process.stdout.write('\nWould write:\n');
    for (const entry of plan.entries) {
      process.stdout.write(bullet(`[${entry.status}] ${entry.relPath}`) + '\n');
    }
    for (const warn of plan.warnings) {
      process.stdout.write(bullet(`(warning) ${warn}`) + '\n');
    }
    process.stdout.write('\nNext:\n');
    for (const cmd of preset.recommendedNextCommands ?? [
      'shrk init --zero-config --write',
      'shrk doctor',
      'shrk context --task "<task>"',
    ]) {
      process.stdout.write(bullet(`$ ${cmd}`) + '\n');
    }
    if (!mode.skipGitignore) {
      const patch = ensureSharkcraftGitignore({ cwd, dryRun: true });
      process.stdout.write('\n' + renderGitignorePatch(patch, true));
    }
    process.stdout.write('\nRun with --write to persist.\n');
    return 0;
  }

  const result = applyPresetPlan(plan);

  // Inject the surface profile into the generated config so the
  // user starts from a sensible default rather than the empty fallback.
  let surfaceProfileResult: ReturnType<typeof injectSurfaceProfile> | null = null;
  if (mode.surfaceProfile) {
    surfaceProfileResult = injectSurfaceProfile(plan.sharkcraftDir, {
      profile: mode.surfaceProfile,
      reason: mode.surfaceProfileReason ?? 'configured by init.',
      source: 'override',
    });
  }

  process.stdout.write(header('SharkCraft initialized'));
  process.stdout.write(`Preset: ${preset.id} — ${preset.title}\n`);
  process.stdout.write(`Folder: ${plan.sharkcraftDir}\n`);
  if (surfaceProfileResult) {
    if (surfaceProfileResult.written) {
      process.stdout.write(
        `Surface profile: ${mode.surfaceProfile} (written to sharkcraft.config.ts)\n`,
      );
    } else if (surfaceProfileResult.alreadyMatched) {
      process.stdout.write(
        `Surface profile: ${mode.surfaceProfile} (already set; no change)\n`,
      );
    }
  }
  if (mode.showDetectedProfiles) {
    try {
      const ws = await inspectWorkspace({ startDir: cwd });
      process.stdout.write(`Detected profiles: ${ws.profiles.join(', ') || '(none)'}\n`);
    } catch {
      /* ignore */
    }
  }
  if (result.written.length) {
    process.stdout.write('\nCreated files:\n');
    for (const p of result.written) process.stdout.write(bullet(p) + '\n');
  }
  if (result.skipped.length) {
    process.stdout.write('\nSkipped (already exist; use --force to overwrite):\n');
    for (const p of result.skipped) process.stdout.write(bullet(p) + '\n');
  }
  if (!mode.skipGitignore) {
    const patch = ensureSharkcraftGitignore({ cwd, dryRun: false });
    if (patch.added.length > 0) {
      process.stdout.write('\n' + renderGitignorePatch(patch, false));
    }
  }
  process.stdout.write('\nNext:\n');
  for (const cmd of preset.recommendedNextCommands ?? [
    'shrk doctor',
    'shrk context --task "<task>"',
  ]) {
    process.stdout.write(bullet(`$ ${cmd}`) + '\n');
  }
  process.stdout.write(
    bullet('Start the MCP server: `shrk mcp serve` (or run it via Claude Code)') + '\n',
  );
  return 0;
}

function applyLegacyInit(cwd: string, force: boolean): number {
  const { root } = detectProjectRoot(cwd);
  const sharkcraftDir = nodePath.join(root, 'sharkcraft');
  if (existsSync(sharkcraftDir) && !force) {
    process.stderr.write(
      `sharkcraft/ already exists at ${sharkcraftDir}. Use --force to overwrite individual files.\n`,
    );
    return 1;
  }
  mkdirSync(sharkcraftDir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of INIT_FILES) {
    const fullPath = nodePath.join(sharkcraftDir, file.relativePath);
    mkdirSync(nodePath.dirname(fullPath), { recursive: true });
    if (existsSync(fullPath) && !force) {
      skipped.push(file.relativePath);
      continue;
    }
    writeFileSync(fullPath, file.content, 'utf8');
    created.push(file.relativePath);
  }
  process.stdout.write(header('SharkCraft initialized'));
  process.stdout.write(`Preset: ${LEGACY_PRESET_ID} (full seed)\n`);
  process.stdout.write(`Folder: ${sharkcraftDir}\n`);
  if (created.length) {
    process.stdout.write('\nCreated files:\n');
    for (const c of created) process.stdout.write(bullet(c) + '\n');
  }
  if (skipped.length) {
    process.stdout.write('\nSkipped (already exist; use --force to overwrite):\n');
    for (const s of skipped) process.stdout.write(bullet(s) + '\n');
  }
  process.stdout.write('\nNext:\n');
  process.stdout.write(bullet('Run `shrk inspect` to see your project summary.') + '\n');
  process.stdout.write(bullet('Run `shrk knowledge list` to see what was seeded.') + '\n');
  process.stdout.write(bullet('Customize sharkcraft/rules.ts, paths.ts, templates.ts.') + '\n');
  return 0;
}

export const initCommand: ICommandHandler = {
  name: 'init',
  description:
    'Initialize a sharkcraft/ folder in the current repository. Pass --preset <id> to apply a built-in preset (default: generic). Use --zero-config or --preset auto to detect the workspace and pick a preset automatically. Use --legacy for the full pre-preset seed.',
  usage:
    'shrk init [--preset <id|auto>] [--zero-config] [--dry-run] [--write] [--legacy] [--force] [--merge] [--suggest-only] [--no-gitignore] [--surface-profile <id>]',
  async run(args: ParsedArgs): Promise<number> {
    const force = flagBool(args, 'force');
    const merge = flagBool(args, 'merge');
    const cwd = resolveCwd(args);

    const skipGitignore = flagBool(args, 'no-gitignore');

    if (flagBool(args, 'legacy')) {
      const code = applyLegacyInit(cwd, force);
      if (code === 0 && !skipGitignore) {
        const patch = ensureSharkcraftGitignore({ cwd, dryRun: false });
        if (patch.added.length > 0) {
          process.stdout.write('\n' + renderGitignorePatch(patch, false));
        }
      }
      return code;
    }

    // Suggest-only mode: detect profiles + print recommendations, do nothing else.
    if (flagBool(args, 'suggest-only')) {
      const ws = await inspectWorkspace({ startDir: cwd });
      const recs = recommendPresets([...BUILTIN_PRESETS], { profiles: ws.profiles });
      process.stdout.write(header('Suggested presets'));
      process.stdout.write(`Detected profiles: ${ws.profiles.join(', ') || '(none)'}\n\n`);
      for (const r of recs) {
        process.stdout.write(
          `  ${r.preset.id.padEnd(22)} ${r.confidence.padEnd(6)} ${r.preset.title}\n`,
        );
      }
      return 0;
    }

    const rawPreset = flagString(args, 'preset');
    const zeroConfig = flagBool(args, 'zero-config');
    const isAuto = zeroConfig || rawPreset === 'auto';

    let presetId: string;
    let showDetected = false;
    if (isAuto) {
      const picked = await pickAutoPreset(cwd);
      presetId = picked.presetId;
      showDetected = true;
      process.stdout.write(header('Zero-config preset selection'));
      process.stdout.write(`Detected profiles: ${picked.profiles.join(', ') || '(none)'}\n`);
      process.stdout.write(`Picked preset: ${presetId}\n`);
      if (picked.reasons.length) {
        process.stdout.write('Reasons:\n');
        for (const r of picked.reasons) process.stdout.write(bullet(r) + '\n');
      }
      process.stdout.write('\n');
    } else {
      presetId = rawPreset ?? 'generic';
    }

    // Dry-run default for zero-config; explicit --dry-run also wins.
    const dryRunFlag = flagBool(args, 'dry-run');
    const writeFlag = flagBool(args, 'write');
    const dryRun = (isAuto && !writeFlag) || (dryRunFlag && !writeFlag);

    // Surface profile detection / override.
    const surfaceProfileFlag = flagString(args, 'surface-profile');
    let surfaceDecision: ISurfaceProfileDecision | null = null;
    try {
      surfaceDecision = await resolveSurfaceProfile(cwd, surfaceProfileFlag ?? undefined);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 2;
    }
    if (dryRun) {
      process.stdout.write(
        `Surface profile: ${surfaceDecision.profile} (${surfaceDecision.source}) — ${surfaceDecision.reason}\n`,
      );
    }

    return applyPresetInit(cwd, {
      presetId,
      dryRun,
      force,
      merge,
      showDetectedProfiles: showDetected,
      skipGitignore,
      surfaceProfile: surfaceDecision.profile,
      surfaceProfileReason: surfaceDecision.reason,
    });
  },
};
