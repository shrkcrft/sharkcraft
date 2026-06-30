import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { extractRustFile } from '../indexer/extract-rust-file.ts';
import { extractKotlinFile } from '../indexer/extract-kotlin-file.ts';
import { fingerprintFile } from '../store/file-fingerprint.ts';
import { GraphQueryApi } from '../query/query-api.ts';

describe('extractRustFile', () => {
  test('captures fn/struct/trait/type/const, pub visibility, brace-group imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-rust-'));
    try {
      const file = join(root, 'lib.rs');
      writeFileSync(
        file,
        [
          'use std::collections::HashMap;',
          'use std::sync::{Arc, Mutex, mpsc::Sender as Tx};',
          'use crate::config::*;',
          '',
          'pub fn run() {}',
          'fn helper() {}',
          'pub async fn fetch() {}',
          '',
          'pub struct User { name: String }',
          'enum Color { Red, Green, Blue }',
          'pub trait Greet { fn greet(&self); }',
          'pub type UserId = u64;',
          'pub const MAX_RETRIES: u32 = 5;',
          'static GLOBAL: u32 = 0;',
          'pub mod nested { pub fn x() {} }',
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      expect(fp.language).toBe('rust');
      const ex = extractRustFile(fp, file);
      const names = ex.symbolNodes.map((s) => s.label).sort();
      expect(names).toEqual([
        'Color', 'GLOBAL', 'Greet', 'MAX_RETRIES', 'User', 'UserId',
        'fetch', 'helper', 'nested', 'run',
      ]);
      const run = ex.symbolNodes.find((s) => s.label === 'run')!;
      expect(run.data?.['isExported']).toBe(true);
      const helper = ex.symbolNodes.find((s) => s.label === 'helper')!;
      expect(helper.data?.['isExported']).toBe(false);
      const color = ex.symbolNodes.find((s) => s.label === 'Color')!;
      expect(color.data?.['isExported']).toBe(false);
      // Imports: brace groups expanded.
      const specs = ex.rawImportSpecifiers.map((r) => r.specifier).sort();
      expect(specs).toContain('std::collections::HashMap');
      expect(specs).toContain('std::sync::Arc');
      expect(specs).toContain('std::sync::Mutex');
      expect(specs).toContain('std::sync::mpsc::Sender');
      expect(specs).toContain('crate::config::*');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('tags _test.rs as test', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-rust-test-'));
    try {
      const file = join(root, 'parser_test.rs');
      writeFileSync(file, 'fn it_works() {}');
      const fp = fingerprintFile(file, root);
      const ex = extractRustFile(fp, file);
      expect(ex.fileNode.tags).toContain('test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('extractKotlinFile', () => {
  test('captures fun/class/data class/interface/object/enum class/typealias/val/var', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-kt-'));
    try {
      const file = join(root, 'Service.kt');
      writeFileSync(
        file,
        [
          'package com.example.demo',
          '',
          'import com.example.util.Logger',
          'import com.example.util.*',
          'import com.example.util.Helper as H',
          '',
          'fun helper(): Int = 1',
          'inline fun <T> identity(x: T): T = x',
          'suspend fun fetchUser(): String = ""',
          'private fun internalHelper() {}',
          '',
          'class Service',
          'data class Point(val x: Int, val y: Int)',
          'sealed class Result',
          'private class Hidden',
          'interface IGreeter',
          'sealed interface Status',
          'object Settings',
          'enum class Severity { OK, FAIL }',
          'typealias UserId = Long',
          'val APP_NAME: String = "demo"',
          'const val MAX = 10',
          'internal val INTERNAL_FLAG: Boolean = true',
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      expect(fp.language).toBe('kotlin');
      const ex = extractKotlinFile(fp, file);
      const names = ex.symbolNodes.map((s) => s.label).sort();
      expect(names).toEqual([
        'APP_NAME', 'Hidden', 'IGreeter', 'INTERNAL_FLAG', 'MAX', 'Point',
        'Result', 'Service', 'Settings', 'Severity', 'Status', 'UserId',
        'fetchUser', 'helper', 'identity', 'internalHelper',
      ]);
      const helper = ex.symbolNodes.find((s) => s.label === 'helper')!;
      expect(helper.data?.['isExported']).toBe(true);
      const hidden = ex.symbolNodes.find((s) => s.label === 'Hidden')!;
      expect(hidden.data?.['isExported']).toBe(false);
      const internal = ex.symbolNodes.find((s) => s.label === 'INTERNAL_FLAG')!;
      expect(internal.data?.['isExported']).toBe(false);
      // package + imports
      expect(ex.fileNode.data?.['kotlinPackage']).toBe('com.example.demo');
      const specs = ex.rawImportSpecifiers.map((r) => r.specifier).sort();
      expect(specs).toEqual([
        'com.example.util.*',
        'com.example.util.Helper',
        'com.example.util.Logger',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('captures extension functions with dotted / generic receivers', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-kt-ext-'));
    try {
      const file = join(root, 'Extensions.kt');
      writeFileSync(
        file,
        [
          'fun plain(): Int = 1',
          'fun String.reversedWords(): String = ""',
          'fun List<Int>.second(): Int = this[1]',
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      const ex = extractKotlinFile(fp, file);
      const names = ex.symbolNodes.map((s) => s.label).sort();
      // The receiver is dropped; the final identifier is the function name.
      expect(names).toEqual(['plain', 'reversedWords', 'second']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dispatcher — Rust + Kotlin end-to-end', () => {
  test('buildFullIndex picks up .rs and .kt files', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-multi-rk-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['services/*'] }, null, 2),
      );
      mkdirSync(join(root, 'services', 'api'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'main.rs' }, null, 2),
      );
      writeFileSync(join(root, 'services', 'api', 'main.rs'), 'pub fn run() {}');
      writeFileSync(join(root, 'services', 'api', 'Worker.kt'), 'class Worker');
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      const rs = api.findFile('services/api/main.rs')!;
      expect(rs.data?.['language']).toBe('rust');
      expect(api.symbolsIn(rs.id).map((s) => s.label)).toContain('run');
      const kt = api.findFile('services/api/Worker.kt')!;
      expect(kt.data?.['language']).toBe('kotlin');
      expect(api.symbolsIn(kt.id).map((s) => s.label)).toContain('Worker');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
