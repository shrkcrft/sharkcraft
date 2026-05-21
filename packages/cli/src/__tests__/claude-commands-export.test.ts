/**
 * Tests for `buildClaudeCommands` — the engine behind
 * `shrk export claude-commands`.
 *
 *   - Always emits the 4 static commands (follow-shrk / check-changes
 *     / shrk-brief / explain-file).
 *   - One `/new-<template>` per template in the inspection, capped
 *     deterministically.
 *   - Frontmatter is valid YAML — Claude Code parses the
 *     `description:` field to decide when to surface the command.
 *   - File paths are stable (.claude/commands/<slash>.md) and slash
 *     names are URL-safe.
 *   - Bodies reference real shrk commands (no broken instructions).
 *   - Determinism: same inspection → same output.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection } from '@shrkcrft/inspector';
import { buildClaudeCommands } from '../export/claude-commands-export.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const DOGFOOD = join(REPO_ROOT, 'examples/dogfood-target');

function inspectionWith(templates: Array<{ id: string; name?: string; description?: string }>): ISharkcraftInspection {
  // Cast a minimal stub — `buildClaudeCommands` only reads
  // `inspection.templates`. The full ISharkcraftInspection has many
  // fields; we only need `.templates` for these tests.
  return { templates } as unknown as ISharkcraftInspection;
}

describe('buildClaudeCommands — static commands', () => {
  test('always emits the 4 static commands regardless of templates', () => {
    const result = buildClaudeCommands(inspectionWith([]));
    const slashes = new Set(result.files.map((f) => f.slash));
    expect(slashes.has('follow-shrk')).toBe(true);
    expect(slashes.has('check-changes')).toBe(true);
    expect(slashes.has('shrk-brief')).toBe(true);
    expect(slashes.has('explain-file')).toBe(true);
  });

  test('static commands carry the source tag "static"', () => {
    const result = buildClaudeCommands(inspectionWith([]));
    const statics = result.files.filter((f) => f.source === 'static');
    expect(statics.length).toBe(4);
  });

  test('static commands include the canonical shrk commands they wrap', () => {
    const result = buildClaudeCommands(inspectionWith([]));
    const checkChanges = result.files.find((f) => f.slash === 'check-changes')!;
    expect(checkChanges.content).toContain('shrk check boundaries --changed-only');
    expect(checkChanges.content).toContain('shrk check imports');
    const shrkBrief = result.files.find((f) => f.slash === 'shrk-brief')!;
    expect(shrkBrief.content).toContain('shrk brief');
    expect(shrkBrief.content).toContain('shrk task');
    const explainFile = result.files.find((f) => f.slash === 'explain-file')!;
    expect(explainFile.content).toContain('shrk why');
    const follow = result.files.find((f) => f.slash === 'follow-shrk')!;
    expect(follow.content).toContain('shrk gen');
    expect(follow.content).toContain('shrk apply');
  });
});

describe('buildClaudeCommands — per-template commands', () => {
  test('emits /new-<tail> for each template, using the last dot-segment', () => {
    const result = buildClaudeCommands(
      inspectionWith([
        { id: 'typescript.service', name: 'TS Service' },
        { id: 'typescript.utility', name: 'TS Utility' },
      ]),
    );
    const slashes = new Set(result.files.map((f) => f.slash));
    expect(slashes.has('new-service')).toBe(true);
    expect(slashes.has('new-utility')).toBe(true);
  });

  test('collision handling: two templates with the same tail get disambiguated', () => {
    const result = buildClaudeCommands(
      inspectionWith([
        { id: 'typescript.service' },
        { id: 'python.service' },
      ]),
    );
    const slashes = result.files.map((f) => f.slash);
    // Sort is by id (alpha) — python.service comes first and keeps
    // `new-service`. typescript.service collides and falls back to
    // the full-id form.
    expect(slashes).toContain('new-service');
    expect(slashes).toContain('new-typescript-service');
  });

  test('respects maxTemplateCommands cap', () => {
    const templates = Array.from({ length: 25 }, (_, i) => ({
      id: `kind.tpl${i}`,
      name: `T${i}`,
    }));
    const result = buildClaudeCommands(inspectionWith(templates), {
      maxTemplateCommands: 5,
    });
    const templateFiles = result.files.filter((f) => f.source === 'template');
    expect(templateFiles.length).toBe(5);
  });

  test('per-template bodies reference shrk gen + apply + check', () => {
    const result = buildClaudeCommands(
      inspectionWith([{ id: 'typescript.service', name: 'Service' }]),
    );
    const body = result.files.find((f) => f.slash === 'new-service')!.content;
    expect(body).toContain('shrk gen typescript.service');
    expect(body).toContain('--dry-run --save-plan');
    expect(body).toContain('shrk apply');
    expect(body).toContain('--verify-signature --validate');
    expect(body).toContain('shrk check boundaries --changed-only');
  });
});

describe('buildClaudeCommands — file shape', () => {
  test('every file path matches .claude/commands/<slug>.md', () => {
    const result = buildClaudeCommands(
      inspectionWith([{ id: 'typescript.service' }]),
    );
    for (const f of result.files) {
      expect(f.path).toMatch(/^\.claude\/commands\/[a-z0-9-]+\.md$/);
    }
  });

  test('every file body starts with YAML frontmatter containing a description', () => {
    const result = buildClaudeCommands(
      inspectionWith([{ id: 'typescript.service' }]),
    );
    for (const f of result.files) {
      expect(f.content.startsWith('---\n')).toBe(true);
      // Frontmatter block: opening `---`, a description line somewhere,
      // closing `---`. Each file should have all three.
      expect(f.content).toMatch(/^---\n(?:.*\n)*?description:\s*.+\n(?:.*\n)*?---\n/);
    }
  });

  test('slash names are URL-safe (lowercase, dash-separated)', () => {
    const result = buildClaudeCommands(
      inspectionWith([
        { id: 'typescript.cli-command' },
        { id: 'mcp.MyTool' },
      ]),
    );
    for (const f of result.files) {
      expect(f.slash).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('buildClaudeCommands — determinism', () => {
  test('same inspection → identical files in identical order', () => {
    const inspection = inspectionWith([
      { id: 'b.second' },
      { id: 'a.first' },
    ]);
    const r1 = buildClaudeCommands(inspection);
    const r2 = buildClaudeCommands(inspection);
    expect(r1.files.length).toBe(r2.files.length);
    for (let i = 0; i < r1.files.length; i += 1) {
      expect(r1.files[i]!.path).toBe(r2.files[i]!.path);
      expect(r1.files[i]!.content).toBe(r2.files[i]!.content);
    }
  });

  test('templates are emitted in id order', () => {
    const result = buildClaudeCommands(
      inspectionWith([
        { id: 'z.last' },
        { id: 'a.first' },
        { id: 'm.middle' },
      ]),
    );
    const templateSlashes = result.files
      .filter((f) => f.source === 'template')
      .map((f) => f.slash);
    // After alpha sort of ids: a.first / m.middle / z.last
    expect(templateSlashes).toEqual(['new-first', 'new-middle', 'new-last']);
  });
});

describe('buildClaudeCommands — against a real inspection (dogfood)', () => {
  test('produces a valid file set for the dogfood example', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const result = buildClaudeCommands(inspection);
    // At least the 4 statics.
    expect(result.files.length).toBeGreaterThanOrEqual(4);
    for (const f of result.files) {
      expect(f.path.startsWith('.claude/commands/')).toBe(true);
      expect(f.content.startsWith('---\n')).toBe(true);
      expect(f.content).toContain('---\n');
      expect(f.slash.length).toBeGreaterThan(0);
    }
  });
});
