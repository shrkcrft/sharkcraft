import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, EdgeKind, extractDartFile, extractSwiftFile, fingerprintFile } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-dart-swift-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['services/*'] }, null, 2),
  );
  return root;
}

describe('dart extractor', () => {
  test('captures class / mixin / enum / typedef / extension / function + imports', () => {
    const root = setup();
    try {
      const file = join(root, 'foo.dart');
      writeFileSync(
        file,
        [
          "import 'package:flutter/material.dart';",
          "import 'package:flutter/widgets.dart' show Widget hide State;",
          "import 'utils/helper.dart' as helper;",
          "export 'package:foo/foo.dart';",
          '',
          'abstract class Greeter { String greet(); }',
          'sealed class Result {}',
          'class User extends Object {}',
          'class _Hidden {}',
          'mixin Loggable {}',
          'enum Status { ok, fail }',
          'typedef IntList = List<int>;',
          'extension StringX on String { String reverse() => ""; }',
          'int compute(int a, int b) { return a + b; }',
          'String greet() => "hi";',
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      expect(fp.language).toBe('dart');
      const ex = extractDartFile(fp, file);
      const names = ex.symbolNodes.map((s) => s.label).sort();
      expect(names).toEqual([
        'Greeter', 'IntList', 'Loggable', 'Result', 'Status', 'StringX', 'User', '_Hidden',
        'compute', 'greet',
      ]);
      const hidden = ex.symbolNodes.find((s) => s.label === '_Hidden')!;
      expect(hidden.data?.['isExported']).toBe(false);
      const user = ex.symbolNodes.find((s) => s.label === 'User')!;
      expect(user.data?.['isExported']).toBe(true);
      const specs = ex.rawImportSpecifiers.map((r) => `${r.kind}:${r.specifier}`).sort();
      expect(specs).toEqual([
        'dart-export:package:foo/foo.dart',
        'dart-import:package:flutter/material.dart',
        'dart-import:package:flutter/widgets.dart',
        'dart-import:utils/helper.dart',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('swift extractor', () => {
  test('captures class / struct / enum / protocol / extension / func + imports', () => {
    const root = setup();
    try {
      const file = join(root, 'Service.swift');
      writeFileSync(
        file,
        [
          'import Foundation',
          'import class UIKit.UIView',
          'import struct CoreData.NSManagedObject',
          '',
          '@objc',
          'public final class UserService {',
          '  func internalMethod() {}',
          '}',
          '',
          'internal class Helper {}',
          'public struct Point { let x: Int; let y: Int }',
          'public enum Severity { case ok, fail }',
          'public protocol Logger {}',
          'public extension String { func reverse() -> String { return "" } }',
          'public typealias UserId = String',
          'public func helper() -> Int { return 1 }',
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      expect(fp.language).toBe('swift');
      const ex = extractSwiftFile(fp, file);
      const names = ex.symbolNodes.map((s) => s.label).sort();
      expect(names).toEqual([
        'Helper', 'Logger', 'Point', 'Severity', 'String', 'UserId', 'UserService', 'helper',
      ]);
      const userService = ex.symbolNodes.find((s) => s.label === 'UserService')!;
      expect(userService.data?.['isExported']).toBe(true);
      const helper = ex.symbolNodes.find((s) => s.label === 'Helper')!;
      expect(helper.data?.['isExported']).toBe(false);
      const specs = ex.rawImportSpecifiers.map((r) => r.specifier).sort();
      expect(specs).toEqual(['CoreData.NSManagedObject', 'Foundation', 'UIKit.UIView']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('flutter framework extractor', () => {
  test('widgets + state + notifier', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'app', 'lib'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'app', 'package.json'),
        JSON.stringify({ name: '@demo/app', main: 'lib/main.dart' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'app', 'lib', 'main.dart'),
        [
          "import 'package:flutter/material.dart';",
          '',
          'class Counter extends StatefulWidget {',
          '  const Counter({super.key});',
          '  @override',
          '  State<Counter> createState() => _CounterState();',
          '}',
          '',
          'class _CounterState extends State<Counter> {',
          '  int n = 0;',
          '}',
          '',
          'class Header extends StatelessWidget {',
          '  const Header({super.key});',
          '}',
          '',
          'class CartStore extends ChangeNotifier {',
          '  int count = 0;',
          '}',
          '',
          'class AnotherStore with ChangeNotifier {',
          '  int items = 0;',
          '}',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['flutter'] });
      expect(r.manifest.countsBySubtype['flutter:widget']).toBe(2);
      expect(r.manifest.countsBySubtype['flutter:state']).toBe(1);
      expect(r.manifest.countsBySubtype['flutter:notifier']).toBe(2);
      const api = FrameworkQueryApi.fromStore(root);
      // State → Widget link (UsesHook edge).
      const hookEdges = api.edges().filter((e) => e.kind === EdgeKind.UsesHook);
      expect(hookEdges.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('laravel route groups', () => {
  test('prefix groups apply to inner routes', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'api', 'routes'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'routes/api.php' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'routes', 'api.php'),
        [
          '<?php',
          "Route::prefix('/api')->group(function () {",
          "  Route::get('/health', [HealthController::class, 'check']);",
          "  Route::prefix('/v1')->group(function () {",
          "    Route::get('/users', [UserController::class, 'index']);",
          "    Route::post('/users', [UserController::class, 'store']);",
          "  });",
          "});",
          "Route::get('/public', [PageController::class, 'home']);",
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['laravel'] });
      const api = FrameworkQueryApi.fromStore(root);
      const labels = api.list({ framework: 'laravel', subtype: 'route' })
        .map((r) => r.label)
        .sort();
      expect(labels).toContain('GET /api/health → HealthController@check');
      expect(labels).toContain('GET /api/v1/users → UserController@index');
      expect(labels).toContain('POST /api/v1/users → UserController@store');
      expect(labels).toContain('GET /public → PageController@home');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
