import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, EdgeKind } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';
import { extractPhpFile } from '@shrkcrft/graph';
import { fingerprintFile } from '@shrkcrft/graph';

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-php-laravel-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['services/*'] }, null, 2),
  );
  return root;
}

describe('php extractor', () => {
  test('captures namespace + class + interface + trait + enum + use specifiers', () => {
    const root = setup();
    try {
      const file = join(root, 'Service.php');
      writeFileSync(
        file,
        [
          '<?php',
          '',
          'namespace App\\Services;',
          '',
          'use App\\Models\\User;',
          'use App\\Repositories\\{UserRepo, RoleRepo as Role};',
          'use function App\\Helpers\\format;',
          '',
          '#[Service]',
          'final class UserService {',
          '  public function find(int $id): ?User { return null; }',
          '}',
          '',
          'interface Logger {}',
          'trait Loggable {}',
          'enum Status: string { case OK = "ok"; }',
          '',
          'function helper(): string { return ""; }',
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      expect(fp.language).toBe('php');
      const ex = extractPhpFile(fp, file);
      const names = ex.symbolNodes.map((s) => s.label).sort();
      expect(names).toEqual([
        'App\\Services', 'Loggable', 'Logger', 'Status', 'UserService', 'helper',
      ]);
      const specs = ex.rawImportSpecifiers.map((r) => r.specifier).sort();
      expect(specs).toEqual([
        'App\\Helpers\\format',
        'App\\Models\\User',
        'App\\Repositories\\RoleRepo',
        'App\\Repositories\\UserRepo',
      ]);
      expect(ex.fileNode.data?.['phpNamespace']).toBe('App\\Services');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('laravel extractor', () => {
  test('controllers + actions + models + Route:: routes + Route::resource', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'api', 'app', 'Http', 'Controllers'), { recursive: true });
      mkdirSync(join(root, 'services', 'api', 'app', 'Models'), { recursive: true });
      mkdirSync(join(root, 'services', 'api', 'routes'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'app.php' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'app', 'Http', 'Controllers', 'UserController.php'),
        [
          '<?php',
          'namespace App\\Http\\Controllers;',
          '',
          'class UserController extends Controller {',
          '  public function index() {}',
          '  public function show($id) {}',
          '  public function store() {}',
          '  protected function helper() {}',
          '}',
        ].join('\n'),
      );
      writeFileSync(
        join(root, 'services', 'api', 'app', 'Models', 'User.php'),
        [
          '<?php',
          'namespace App\\Models;',
          'use Illuminate\\Database\\Eloquent\\Model;',
          'class User extends Model {}',
        ].join('\n'),
      );
      writeFileSync(
        join(root, 'services', 'api', 'routes', 'api.php'),
        [
          '<?php',
          "Route::get('/health', [HealthController::class, 'check']);",
          "Route::post('/login', 'AuthController@login');",
          "Route::resource('users', UserController::class);",
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['laravel'] });
      expect(r.manifest.countsBySubtype['laravel:controller']).toBe(1);
      expect(r.manifest.countsBySubtype['laravel:model']).toBe(1);
      // 3 public actions, `helper` is protected and skipped.
      expect(r.manifest.countsBySubtype['laravel:action']).toBe(3);
      // 2 verb routes + 1 resource.
      expect(r.manifest.countsBySubtype['laravel:route']).toBe(3);
      const api = FrameworkQueryApi.fromStore(root);
      const labels = api.list({ framework: 'laravel', subtype: 'route' })
        .map((r) => r.label)
        .sort();
      expect(labels).toContain('GET /health → HealthController@check');
      expect(labels).toContain('POST /login → AuthController@login');
      expect(labels).toContain('RESOURCE /users → UserController');
      // HandlesRoute edges go controller → action.
      const handles = api.edges().filter((e) => e.kind === EdgeKind.HandlesRoute);
      expect(handles.length).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('astro api method detection', () => {
  test('emits one route per exported verb binding', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'web', 'src', 'pages', 'api'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'web', 'package.json'),
        JSON.stringify({ name: '@demo/web' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'web', 'src', 'pages', 'api', 'items.ts'),
        [
          'export const GET = () => new Response("ok");',
          'export async function POST(ctx: any) { return new Response("created"); }',
          'export function DELETE() { return new Response("gone"); }',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['astro'] });
      expect(r.manifest.countsBySubtype['astro:api-route']).toBe(3);
      const api = FrameworkQueryApi.fromStore(root);
      const labels = api.list({ framework: 'astro', subtype: 'api-route' })
        .map((r) => r.label)
        .sort();
      expect(labels).toEqual(['DELETE /api/items', 'GET /api/items', 'POST /api/items']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('phoenix scope module qualification', () => {
  test('combines scope module argument into the captured controller name', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'web'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'web', 'package.json'),
        JSON.stringify({ name: '@demo/web', main: 'router.ex' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'web', 'router.ex'),
        [
          'defmodule MyAppWeb.Router do',
          '  use Phoenix.Router',
          '',
          '  scope "/api", MyAppWeb do',
          '    get "/users", UserController, :index',
          '    scope "/v1", V1 do',
          '      get "/items", ItemController, :index',
          '    end',
          '  end',
          '',
          '  get "/health", PageController, :health',
          'end',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['phoenix'] });
      const api = FrameworkQueryApi.fromStore(root);
      const labels = api.list({ framework: 'phoenix', subtype: 'route' })
        .map((r) => r.label)
        .sort();
      // Outer scope's `MyAppWeb` prefixes UserController.
      // Inner scope's `V1` prefixes ItemController (innermost wins).
      // The bare /health route gets no scope qualification.
      expect(labels).toEqual([
        'GET /api/users → MyAppWeb.UserController.index',
        'GET /api/v1/items → V1.ItemController.index',
        'GET /health → PageController.health',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
