import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { extractRubyFile } from '../indexer/extract-ruby-file.ts';
import { extractCsharpFile } from '../indexer/extract-csharp-file.ts';
import { fingerprintFile } from '../store/file-fingerprint.ts';
import { GraphQueryApi } from '../query/query-api.ts';

describe('extractRubyFile', () => {
  test('captures class/module/def/const, requires', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-rb-'));
    try {
      const file = join(root, 'user.rb');
      writeFileSync(
        file,
        [
          "require 'json'",
          "require_relative 'helpers'",
          "load 'config.rb'",
          '',
          'module App',
          '  module Inner',
          '    def nested_helper; end',
          '  end',
          '',
          '  class Calculator',
          '    def add(a, b); end',
          '    def subtract(a, b); end',
          '    def multiply(a, b); end',
          '  end',
          'end',
          '',
          'class User < ActiveRecord::Base',
          '  def name; end',
          'end',
          '',
          'class Profile',
          '  def self.find(id); end',
          'end',
          '',
          'def helper',
          '  1',
          'end',
          '',
          'MAX = 5',
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      expect(fp.language).toBe('ruby');
      const ex = extractRubyFile(fp, file);
      const names = ex.symbolNodes.map((s) => s.label).sort();
      // Methods inside class bodies (previously dropped by the column-0
      // guard) are now captured at any indentation.
      expect(names).toEqual([
        'App', 'Calculator', 'Inner', 'MAX', 'Profile', 'User',
        'add', 'find', 'helper', 'multiply', 'name', 'nested_helper', 'subtract',
      ]);
      // Class with 3 methods: the class + all 3 methods.
      expect(names).toEqual(
        expect.arrayContaining(['Calculator', 'add', 'subtract', 'multiply']),
      );
      // Nested module/class methods are captured too.
      expect(names).toContain('Inner');
      expect(names).toContain('nested_helper');
      const specs = ex.rawImportSpecifiers.map((r) => r.specifier).sort();
      expect(specs).toEqual(['config.rb', 'helpers', 'json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('tags _spec.rb / _test.rb / spec/ as test', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-rb-test-'));
    try {
      mkdirSync(join(root, 'spec'), { recursive: true });
      writeFileSync(join(root, 'spec', 'user_spec.rb'), '');
      const fp = fingerprintFile(join(root, 'spec', 'user_spec.rb'), root);
      const ex = extractRubyFile(fp, join(root, 'spec', 'user_spec.rb'));
      expect(ex.fileNode.tags).toContain('test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('extractCsharpFile', () => {
  test('captures class/interface/struct/record/enum/namespace + usings', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-cs-'));
    try {
      const file = join(root, 'Service.cs');
      writeFileSync(
        file,
        [
          'using System;',
          'using System.Collections.Generic;',
          'using static System.Math;',
          'using DictAlias = System.Collections.Generic.Dictionary<string, object>;',
          '',
          'namespace Demo.Services;',
          '',
          '[Serializable]',
          'public class UserService',
          '{',
          '  private class Inner {}',
          '}',
          '',
          'internal class Helper {}',
          '',
          'public interface IRepository {}',
          'public struct Point { public int X; public int Y; }',
          'public readonly struct ImmutablePoint { }',
          'public record User(string Name, int Age);',
          'public record class Customer(string Name);',
          'public record struct PointR(int X, int Y);',
          'public enum Status { Ok, Fail }',
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      expect(fp.language).toBe('csharp');
      const ex = extractCsharpFile(fp, file);
      const names = ex.symbolNodes.map((s) => s.label).sort();
      expect(names).toEqual([
        'Customer', 'Demo.Services', 'Helper', 'IRepository', 'ImmutablePoint',
        'Point', 'PointR', 'Status', 'User', 'UserService',
      ]);
      // `Inner` is nested — must be skipped.
      expect(names).not.toContain('Inner');
      const userService = ex.symbolNodes.find((s) => s.label === 'UserService')!;
      expect(userService.data?.['isExported']).toBe(true);
      const helper = ex.symbolNodes.find((s) => s.label === 'Helper')!;
      expect(helper.data?.['isExported']).toBe(false);
      const specs = ex.rawImportSpecifiers.map((r) => r.specifier).sort();
      expect(specs).toEqual([
        'System',
        'System.Collections.Generic',
        'System.Collections.Generic.Dictionary',
        'System.Math',
      ]);
      expect(ex.fileNode.data?.['csharpNamespace']).toBe('Demo.Services');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dispatcher — Ruby + C# end-to-end', () => {
  test('buildFullIndex picks up .rb and .cs files', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-multi-rc-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['services/*'] }, null, 2),
      );
      mkdirSync(join(root, 'services', 'api'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'app.rb' }, null, 2),
      );
      writeFileSync(join(root, 'services', 'api', 'app.rb'), 'class App\n  def run; end\nend');
      writeFileSync(join(root, 'services', 'api', 'Worker.cs'), 'public class Worker {}');
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      const rb = api.findFile('services/api/app.rb')!;
      expect(rb.data?.['language']).toBe('ruby');
      expect(api.symbolsIn(rb.id).map((s) => s.label)).toContain('App');
      const cs = api.findFile('services/api/Worker.cs')!;
      expect(cs.data?.['language']).toBe('csharp');
      expect(api.symbolsIn(cs.id).map((s) => s.label)).toContain('Worker');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
