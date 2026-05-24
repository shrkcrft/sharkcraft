import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, EdgeKind, NodeKind } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function setupNestFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-fw-nest-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'api', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'api', 'package.json'),
    JSON.stringify({ name: '@demo/api', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'api', 'src', 'users.controller.ts'),
    [
      "import { Controller, Get, Post, Param } from '@nestjs/common';",
      "@Controller('users')",
      "export class UsersController {",
      "  @Get(':id')",
      "  findOne(@Param('id') id: string) { return { id }; }",
      "  @Post()",
      "  create() { return { ok: true }; }",
      "}",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'api', 'src', 'users.service.ts'),
    [
      "import { Injectable } from '@nestjs/common';",
      "@Injectable()",
      "export class UsersService {",
      "  findAll() { return []; }",
      "}",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'api', 'src', 'app.module.ts'),
    [
      "import { Module } from '@nestjs/common';",
      "import { UsersController } from './users.controller.ts';",
      "import { UsersService } from './users.service.ts';",
      "@Module({ controllers: [UsersController], providers: [UsersService] })",
      "export class AppModule {}",
    ].join('\n'),
  );
  // A non-Nest file the extractor should skip.
  writeFileSync(
    join(root, 'packages', 'api', 'src', 'index.ts'),
    "export const apiVersion = '1.0';",
  );
  return root;
}

describe('nestjs extractor', () => {
  test('emits controller, module, provider, and route entities', () => {
    const root = setupNestFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['nestjs'] });
      expect(r.manifest.schema).toBe('sharkcraft.framework/v1');
      expect(r.manifest.countsByFramework['nestjs']).toBeGreaterThan(0);
      expect(r.manifest.countsBySubtype['nestjs:controller']).toBe(1);
      expect(r.manifest.countsBySubtype['nestjs:provider']).toBe(1);
      expect(r.manifest.countsBySubtype['nestjs:module']).toBe(1);
      expect(r.manifest.countsBySubtype['nestjs:route']).toBe(2);

      const api = FrameworkQueryApi.fromStore(root);
      const controllers = api.list({ framework: 'nestjs', subtype: 'controller' });
      expect(controllers.length).toBe(1);
      expect(controllers[0]!.label).toBe('UsersController');
      expect(controllers[0]!.path).toBe('packages/api/src/users.controller.ts');

      const routes = api.routes();
      expect(routes.length).toBe(2);
      const getRoute = routes.find((r) => r.method === 'GET')!;
      expect(getRoute.path).toBe('/users/:id');
      expect(getRoute.handler).toBe('UsersController.findOne');
      const postRoute = routes.find((r) => r.method === 'POST')!;
      expect(postRoute.path).toBe('/users');
      expect(postRoute.handler).toBe('UsersController.create');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('module captures controllers + providers in data', () => {
    const root = setupNestFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['nestjs'] });
      const api = FrameworkQueryApi.fromStore(root);
      const modules = api.list({ framework: 'nestjs', subtype: 'module' });
      expect(modules.length).toBe(1);
      const mod = modules[0]!;
      expect((mod.data?.['controllers'] as string[]).includes('UsersController')).toBe(true);
      expect((mod.data?.['providers'] as string[]).includes('UsersService')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('framework-declares + handles-route edges are wired', () => {
    const root = setupNestFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['nestjs'] });
      const api = FrameworkQueryApi.fromStore(root);
      const declaresEdges = api
        .edges()
        .filter((e) => e.kind === EdgeKind.FrameworkDeclares);
      expect(declaresEdges.length).toBeGreaterThanOrEqual(5);
      const handlesEdges = api.edges().filter((e) => e.kind === EdgeKind.HandlesRoute);
      expect(handlesEdges.length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips non-Nest files cheaply via fileMatches pre-filter', () => {
    const root = setupNestFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['nestjs'] });
      // index.ts has no nest signal; should not produce entities.
      const api = FrameworkQueryApi.fromStore(root);
      expect(api.forFile('packages/api/src/index.ts').length).toBe(0);
      expect(r.filesScanned).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('NodeKind.FrameworkEntity', () => {
  test('emitted entities use the FrameworkEntity node kind', () => {
    const root = setupNestFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['nestjs'] });
      const api = FrameworkQueryApi.fromStore(root);
      const controllers = api.list({ framework: 'nestjs', subtype: 'controller' });
      expect(controllers[0]!.kind).toBe(NodeKind.FrameworkEntity);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
