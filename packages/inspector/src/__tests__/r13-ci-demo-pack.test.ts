import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  DemoScenario,
  getDemoScript,
  listDemoScenarios,
  renderBundleReplayWorkflow,
  renderDemoScriptShell,
  renderQualityCiWorkflow,
  runPackReleaseCheck,
} from '../index.ts';

describe('r13 CI scaffolds', () => {
  test('quality scaffold includes selected gates', () => {
    const yml = renderQualityCiWorkflow({
      withQuality: true,
      withPolicy: true,
      withImpact: true,
      withReportSite: true,
    });
    expect(yml).toContain('SharkCraft doctor');
    expect(yml).toContain('Quality gate');
    expect(yml).toContain('Policy snapshot gate');
    expect(yml).toContain('Impact (since origin/main)');
    expect(yml).toContain('Build static report site');
    expect(yml).toContain('Upload SharkCraft reports');
  });

  test('quality scaffold without gates still runs doctor + artifact upload', () => {
    const yml = renderQualityCiWorkflow({});
    expect(yml).toContain('SharkCraft doctor');
    expect(yml).toContain('Upload SharkCraft reports');
    expect(yml).not.toContain('Policy snapshot gate');
  });

  test('bundle-replay scaffold supports schedule + report site', () => {
    const yml = renderBundleReplayWorkflow({ schedule: 'weekly', withReportSite: true });
    expect(yml).toContain('SharkCraft bundle replay');
    expect(yml).toContain('cron');
    expect(yml).toContain('Build static report site');
  });

  test('bundle-replay manual schedule omits cron', () => {
    const yml = renderBundleReplayWorkflow({ schedule: 'manual' });
    expect(yml).not.toContain('cron');
    expect(yml).toContain('workflow_dispatch');
  });
});

describe('r13 demo scripts', () => {
  test('list returns 4 scenarios', () => {
    const list = listDemoScenarios();
    expect(list.length).toBe(4);
  });

  test('renders bash with comments and verification commands', () => {
    const script = getDemoScript(DemoScenario.PlatformPlugin);
    const body = renderDemoScriptShell(script);
    expect(body).toContain('#!/usr/bin/env bash');
    expect(body).toContain('shrk plugin lifecycle profiles');
    expect(body).toContain('set -euo pipefail');
  });

  test('every scenario contains at least one verification-style command', () => {
    for (const s of listDemoScenarios()) {
      const body = renderDemoScriptShell(getDemoScript(s));
      // Either a verification command, a status command, or a doctor call.
      expect(body).toMatch(/shrk (doctor|quality|policy|packs|bundle|report|search|impact|brief)/);
    }
  });
});

describe('r13 pack release-check', () => {
  test('passes a hand-crafted minimal pack', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r13-pack-'));
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify(
        {
          name: '@example/demo',
          version: '0.0.1',
          sharkcraft: { manifest: './manifest.json' },
          files: ['manifest.json', 'src'],
        },
        null,
        2,
      ),
    );
    mkdirSync(nodePath.join(root, 'src'));
    writeFileSync(
      nodePath.join(root, 'src/knowledge.ts'),
      `export default [];`,
    );
    writeFileSync(
      nodePath.join(root, 'manifest.json'),
      JSON.stringify({
        schema: 'sharkcraft.pack/v1',
        info: { name: '@example/demo', version: '0.0.1' },
        contributions: { knowledgeFiles: ['./src/knowledge.ts'] },
      }),
    );
    const result = await runPackReleaseCheck(root);
    expect(result.passed).toBe(true);
    expect(result.contributionsFound).toBe(1);
  });

  test('catches a broken contribution path', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r13-pack-bad-'));
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({ name: '@x/y', version: '0.0.1', sharkcraft: { manifest: './m.json' } }),
    );
    writeFileSync(
      nodePath.join(root, 'm.json'),
      JSON.stringify({
        schema: 'sharkcraft.pack/v1',
        info: { name: '@x/y', version: '0.0.1' },
        contributions: { knowledgeFiles: ['./missing.ts'] },
      }),
    );
    const result = await runPackReleaseCheck(root);
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.code === 'contribution-missing')).toBe(true);
  });
});
