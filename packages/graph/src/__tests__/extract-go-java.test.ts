import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { extractGoFile } from '../indexer/extract-go-file.ts';
import { extractJavaFile } from '../indexer/extract-java-file.ts';
import { fingerprintFile } from '../store/file-fingerprint.ts';
import { GraphQueryApi } from '../query/query-api.ts';

describe('extractGoFile', () => {
  test('captures funcs, type struct/interface/alias, single + block imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-go-'));
    try {
      const file = join(root, 'main.go');
      writeFileSync(
        file,
        [
          'package main',
          '',
          'import "fmt"',
          'import alias "net/http"',
          '',
          'import (',
          '\t"strings"',
          '\tj "encoding/json"',
          '\t// comment',
          ')',
          '',
          'type User struct {',
          '\tName string',
          '}',
          '',
          'type Greeter interface {',
          '\tGreet() string',
          '}',
          '',
          'type ID = string',
          '',
          'func helper() int { return 1 }',
          '',
          'func (u *User) Greet() string { return u.Name }',
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      expect(fp.language).toBe('go');
      const ex = extractGoFile(fp, file);
      const names = ex.symbolNodes.map((s) => s.label).sort();
      // The `Greet` method on `*User` is keyed as `User.Greet`.
      expect(names).toEqual(['Greeter', 'ID', 'User', 'User.Greet', 'helper']);
      const specs = ex.rawImportSpecifiers.map((r) => r.specifier).sort();
      expect(specs).toEqual(['encoding/json', 'fmt', 'net/http', 'strings']);
      const helper = ex.symbolNodes.find((s) => s.label === 'helper')!;
      expect(helper.data?.['isExported']).toBe(false);
      const user = ex.symbolNodes.find((s) => s.label === 'User')!;
      expect(user.data?.['isExported']).toBe(true);
      expect(ex.fileNode.data?.['goPackage']).toBe('main');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('disambiguates same-named methods on different receivers', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-go-recv-'));
    try {
      const file = join(root, 'io.go');
      writeFileSync(
        file,
        [
          'package io', // 1
          '', // 2
          'func (r *Reader) Close() error { return nil }', // 3
          'func (w *Writer) Close() error { return nil }', // 4
          'func Close() error { return nil }', // 5
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      const ex = extractGoFile(fp, file);
      // Three distinct nodes — receiver-scoped ids keep Close/Close/Close apart.
      expect(ex.symbolNodes).toHaveLength(3);
      const byLabel = new Map(ex.symbolNodes.map((s) => [s.label, s]));
      expect([...byLabel.keys()].sort()).toEqual(['Close', 'Reader.Close', 'Writer.Close']);
      expect(byLabel.get('Reader.Close')!.id).toBe(`symbol:${fp.path}#Reader.Close`);
      expect(byLabel.get('Writer.Close')!.id).toBe(`symbol:${fp.path}#Writer.Close`);
      expect(byLabel.get('Close')!.id).toBe(`symbol:${fp.path}#Close`);
      expect(byLabel.get('Reader.Close')!.line).toBe(3);
      expect(byLabel.get('Writer.Close')!.line).toBe(4);
      expect(byLabel.get('Close')!.line).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('tags _test.go files', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-go-test-'));
    try {
      const file = join(root, 'user_test.go');
      writeFileSync(file, 'package main\nfunc TestUser() {}');
      const fp = fingerprintFile(file, root);
      const ex = extractGoFile(fp, file);
      expect(ex.fileNode.tags).toContain('test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('extractJavaFile', () => {
  test('captures class / interface / enum / record', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-java-'));
    try {
      const file = join(root, 'Service.java');
      writeFileSync(
        file,
        [
          'package com.example.demo;',
          '',
          'import java.util.List;',
          'import java.util.Map;',
          'import static java.lang.Math.PI;',
          '',
          '@SuppressWarnings("unused")',
          'public class Service {',
          '    private class Inner {}',
          '}',
          '',
          'final class Helper {}',
          '',
          'public interface IGreeter {',
          '    String greet();',
          '}',
          '',
          'public enum Status { OK, FAIL }',
          '',
          'public record Point(int x, int y) {}',
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      expect(fp.language).toBe('java');
      const ex = extractJavaFile(fp, file);
      const names = ex.symbolNodes.map((s) => s.label).sort();
      expect(names).toEqual(['Helper', 'IGreeter', 'Point', 'Service', 'Status']);
      // Nested `Inner` (indented) is NOT picked up — top-level only.
      expect(names).not.toContain('Inner');
      const specs = ex.rawImportSpecifiers.map((r) => r.specifier).sort();
      expect(specs).toEqual(['java.lang.Math.PI', 'java.util.List', 'java.util.Map']);
      const service = ex.symbolNodes.find((s) => s.label === 'Service')!;
      expect(service.data?.['isExported']).toBe(true);
      const helper = ex.symbolNodes.find((s) => s.label === 'Helper')!;
      expect(helper.data?.['isExported']).toBe(false);
      expect(ex.fileNode.data?.['javaPackage']).toBe('com.example.demo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('tags src/test/** and *Test.java as test', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-java-test-'));
    try {
      mkdirSync(join(root, 'src', 'test', 'java'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'test', 'java', 'ServiceTest.java'),
        'public class ServiceTest {}',
      );
      const fp = fingerprintFile(join(root, 'src', 'test', 'java', 'ServiceTest.java'), root);
      const ex = extractJavaFile(fp, join(root, 'src', 'test', 'java', 'ServiceTest.java'));
      expect(ex.fileNode.tags).toContain('test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('graph dispatcher — Go + Java end-to-end', () => {
  test('buildFullIndex picks up .go and .java alongside .ts files', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-multilang-e2e-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['services/*'] }, null, 2),
      );
      mkdirSync(join(root, 'services', 'api'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'index.ts' }, null, 2),
      );
      writeFileSync(join(root, 'services', 'api', 'index.ts'), 'export const x = 1;');
      writeFileSync(
        join(root, 'services', 'api', 'main.go'),
        'package main\nfunc Run() {}',
      );
      writeFileSync(
        join(root, 'services', 'api', 'Worker.java'),
        'public class Worker {}',
      );
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      const goFile = api.findFile('services/api/main.go');
      expect(goFile).toBeDefined();
      expect(goFile!.data?.['language']).toBe('go');
      expect(api.symbolsIn(goFile!.id).map((s) => s.label)).toContain('Run');
      const javaFile = api.findFile('services/api/Worker.java');
      expect(javaFile).toBeDefined();
      expect(javaFile!.data?.['language']).toBe('java');
      expect(api.symbolsIn(javaFile!.id).map((s) => s.label)).toContain('Worker');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
