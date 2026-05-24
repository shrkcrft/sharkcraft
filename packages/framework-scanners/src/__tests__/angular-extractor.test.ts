import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, EdgeKind } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function setupAngularFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-fw-ng-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'web', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'web', 'package.json'),
    JSON.stringify({ name: '@demo/web', main: 'src/main.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'web', 'src', 'app.component.ts'),
    [
      "import { Component } from '@angular/core';",
      "@Component({ selector: 'app-root', standalone: true, templateUrl: './app.component.html' })",
      "export class AppComponent {}",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'web', 'src', 'data.service.ts'),
    [
      "import { Injectable } from '@angular/core';",
      "@Injectable({ providedIn: 'root' })",
      "export class DataService { items: string[] = []; }",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'web', 'src', 'app.module.ts'),
    [
      "import { NgModule } from '@angular/core';",
      "import { AppComponent } from './app.component.ts';",
      "@NgModule({ imports: [AppComponent], declarations: [], providers: [] })",
      "export class AppModule {}",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'web', 'src', 'currency.pipe.ts'),
    [
      "import { Pipe, PipeTransform } from '@angular/core';",
      "@Pipe({ name: 'currency-custom' })",
      "export class CurrencyPipe implements PipeTransform { transform(v: number) { return '$' + v; } }",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'web', 'src', 'highlight.directive.ts'),
    [
      "import { Directive } from '@angular/core';",
      "@Directive({ selector: '[appHighlight]' })",
      "export class HighlightDirective {}",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'web', 'src', 'noop.ts'),
    "export const helper = () => 1;",
  );
  return root;
}

describe('angular extractor', () => {
  test('detects component / module / service / pipe / directive', () => {
    const root = setupAngularFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['angular'] });
      expect(r.manifest.countsBySubtype['angular:component']).toBe(1);
      expect(r.manifest.countsBySubtype['angular:service']).toBe(1);
      expect(r.manifest.countsBySubtype['angular:module']).toBe(1);
      expect(r.manifest.countsBySubtype['angular:pipe']).toBe(1);
      expect(r.manifest.countsBySubtype['angular:directive']).toBe(1);

      const api = FrameworkQueryApi.fromStore(root);
      const component = api.list({ framework: 'angular', subtype: 'component' })[0]!;
      expect(component.label).toBe('AppComponent');
      expect(component.data?.['selector']).toBe('app-root');
      expect(component.data?.['standalone']).toBe(true);
      expect(component.data?.['templateUrl']).toBe('./app.component.html');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('module captures imports / declarations / providers', () => {
    const root = setupAngularFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['angular'] });
      const api = FrameworkQueryApi.fromStore(root);
      const mod = api.list({ framework: 'angular', subtype: 'module' })[0]!;
      expect((mod.data?.['imports'] as string[])).toContain('AppComponent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('framework-declares edges land', () => {
    const root = setupAngularFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['angular'] });
      const api = FrameworkQueryApi.fromStore(root);
      const declaresEdges = api.edges().filter((e) => e.kind === EdgeKind.FrameworkDeclares);
      expect(declaresEdges.length).toBeGreaterThanOrEqual(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips files with no Angular signal', () => {
    const root = setupAngularFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['angular'] });
      const api = FrameworkQueryApi.fromStore(root);
      expect(api.forFile('packages/web/src/noop.ts').length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
