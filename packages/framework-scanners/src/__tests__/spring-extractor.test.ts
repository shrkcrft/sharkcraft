import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, EdgeKind } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-spring-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['services/*'] }, null, 2),
  );
  return root;
}

describe('spring extractor', () => {
  test('detects @RestController with @RequestMapping base + @GetMapping/@PostMapping routes (Java)', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'api', 'src', 'main', 'java'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'index.java' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'src', 'main', 'java', 'UserController.java'),
        [
          'package com.example.api;',
          '',
          'import org.springframework.web.bind.annotation.*;',
          '',
          '@RestController',
          '@RequestMapping("/users")',
          'public class UserController {',
          '',
          '  @GetMapping',
          '  public List<User> list() { return null; }',
          '',
          '  @GetMapping("/{id}")',
          '  public User byId(@PathVariable Long id) { return null; }',
          '',
          '  @PostMapping',
          '  public User create(@RequestBody UserDto dto) { return null; }',
          '',
          '  @DeleteMapping("/{id}")',
          '  public void delete(@PathVariable Long id) {}',
          '}',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['spring'] });
      expect(r.manifest.countsBySubtype['spring:restcontroller']).toBe(1);
      expect(r.manifest.countsBySubtype['spring:route']).toBe(4);
      const api = FrameworkQueryApi.fromStore(root);
      const routes = api.list({ framework: 'spring', subtype: 'route' });
      const labels = routes.map((r) => r.label).sort();
      expect(labels).toEqual([
        'DELETE /users/{id}',
        'GET /users',
        'GET /users/{id}',
        'POST /users',
      ]);
      const handles = api.edges().filter((e) => e.kind === EdgeKind.HandlesRoute);
      expect(handles.length).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects @Service + @Component beans', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'api', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'src/index.java' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'src', 'UserService.java'),
        [
          'package com.example.api;',
          'import org.springframework.stereotype.Service;',
          '',
          '@Service',
          'public class UserService {',
          '  public void doWork() {}',
          '}',
        ].join('\n'),
      );
      writeFileSync(
        join(root, 'services', 'api', 'src', 'Helper.java'),
        [
          'package com.example.api;',
          'import org.springframework.stereotype.Component;',
          '',
          '@Component',
          'public class Helper {}',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['spring'] });
      const api = FrameworkQueryApi.fromStore(root);
      expect(api.list({ framework: 'spring', subtype: 'service' }).length).toBe(1);
      expect(api.list({ framework: 'spring', subtype: 'component' }).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('handles Kotlin @RestController + @GetMapping', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'api', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'src/HelloController.kt' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'src', 'HelloController.kt'),
        [
          'package com.example.api',
          '',
          'import org.springframework.web.bind.annotation.*',
          '',
          '@RestController',
          '@RequestMapping("/api")',
          'class HelloController {',
          '',
          '  @GetMapping("/hello")',
          '  fun hello(): String = "world"',
          '',
          '  @PutMapping("/echo/{id}")',
          '  fun echo(@PathVariable id: String): String = id',
          '}',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['spring'] });
      expect(r.manifest.countsBySubtype['spring:restcontroller']).toBe(1);
      expect(r.manifest.countsBySubtype['spring:route']).toBe(2);
      const api = FrameworkQueryApi.fromStore(root);
      const labels = api.list({ framework: 'spring', subtype: 'route' }).map((r) => r.label).sort();
      expect(labels).toEqual(['GET /api/hello', 'PUT /api/echo/{id}']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
