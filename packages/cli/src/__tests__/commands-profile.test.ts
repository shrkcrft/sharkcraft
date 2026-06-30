/**
 * Tests for `shrk commands --profile <id>` / `shrk commands profile <id>` —
 * the curated catalog view that renders the surface a profile sees (e.g.
 * `agent` hides CI/release/pack-maintenance machinery an inline coding agent
 * doesn't need). Commands stay callable; the profile is a listing filter.
 *
 *   - The pure builder excludes exactly the profile's `hidden` commands.
 *   - The `agent` profile hides interactive verbs (e.g. `ask`) but keeps
 *     core read surfaces (e.g. `doctor`).
 *   - The `developer` profile hides nothing.
 *   - An unknown profile id returns undefined (→ exit 2 in the command).
 *   - The command routes `--profile agent --json` to the curated view.
 */

import { describe, expect, test } from 'bun:test';
import { COMMAND_CATALOG } from '../commands/command-catalog.ts';
import {
  buildCommandsProfileView,
  makeCommandsCommand,
} from '../commands/commands.command.ts';
import { CommandRegistry, type ParsedArgs } from '../command-registry.ts';

describe('buildCommandsProfileView', () => {
  test('agent profile hides interactive/machinery verbs but keeps core reads', () => {
    const view = buildCommandsProfileView('agent');
    expect(view).toBeDefined();
    if (!view) return;
    // The agent profile hides something (it's a curation profile).
    expect(view.hidden.length).toBeGreaterThan(0);
    // Interactive verb is hidden and absent from the curated listing.
    expect(view.hidden).toContain('ask');
    expect(view.entries.some((e) => e.command === 'ask')).toBe(false);
    // Core read surfaces survive.
    expect(view.entries.some((e) => e.command === 'doctor')).toBe(true);
    // Fewer than the full catalog, but not empty.
    expect(view.entries.length).toBeLessThan(view.catalogTotal);
    expect(view.entries.length).toBeGreaterThan(0);
  });

  test('no entry in the curated view is one the profile hides (invariant)', () => {
    const view = buildCommandsProfileView('agent');
    expect(view).toBeDefined();
    if (!view) return;
    const hidden = new Set(view.hidden);
    expect(view.entries.every((e) => !hidden.has(e.command))).toBe(true);
  });

  test('developer profile hides nothing → full catalog', () => {
    const view = buildCommandsProfileView('developer');
    expect(view).toBeDefined();
    if (!view) return;
    expect(view.hidden.length).toBe(0);
    expect(view.entries.length).toBe(COMMAND_CATALOG.length);
    expect(view.catalogTotal).toBe(COMMAND_CATALOG.length);
  });

  test('unknown profile id → undefined', () => {
    expect(buildCommandsProfileView('does-not-exist')).toBeUndefined();
  });
});

describe('shrk commands --profile (routing)', () => {
  async function runCapture(
    positional: string[],
    flags: Map<string, string | boolean>,
  ): Promise<{ code: number; out: string }> {
    const cmd = makeCommandsCommand(new CommandRegistry());
    const args: ParsedArgs = { positional, flags, multiFlags: new Map() };
    const original = process.stdout.write.bind(process.stdout);
    let out = '';
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await cmd.run(args);
      return { code, out };
    } finally {
      process.stdout.write = original;
    }
  }

  test('--profile agent --json emits the curated view', async () => {
    const { code, out } = await runCapture(
      [],
      new Map<string, string | boolean>([
        ['profile', 'agent'],
        ['json', true],
      ]),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.profile).toBe('agent');
    expect(parsed.hiddenCount).toBeGreaterThan(0);
    expect(parsed.total).toBe(parsed.entries.length);
    expect(parsed.total).toBeLessThan(parsed.catalogTotal);
  });
});
