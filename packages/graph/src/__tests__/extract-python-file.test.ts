import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPythonFile } from '../indexer/extract-python-file.ts';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { fingerprintFile } from '../store/file-fingerprint.ts';
import { GraphQueryApi } from '../query/query-api.ts';

describe('extractPythonFile', () => {
  test('captures def, class, UPPERCASE constants, imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-py-'));
    try {
      const file = join(root, 'sample.py');
      writeFileSync(
        file,
        [
          "# Top-of-file comment.",
          "import os",
          "import json, typing",
          "from collections import defaultdict",
          "from .relative_mod import helper",
          "",
          "API_VERSION = '1.0'",
          "MAX_RETRIES: int = 5",
          "",
          "def greet(name):",
          "    return f'hi {name}'",
          "",
          "async def fetch(url):",
          "    return None",
          "",
          "class User:",
          "    pass",
          "",
          "class Service(BaseService):",
          "    def __init__(self):",
          "        # nested def should NOT be captured",
          "        def inner(): pass",
          "        self.inner = inner",
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      expect(fp.language).toBe('python');
      const ex = extractPythonFile(fp, file);
      const names = ex.symbolNodes.map((s) => s.label).sort();
      expect(names).toEqual(['API_VERSION', 'MAX_RETRIES', 'Service', 'User', 'fetch', 'greet']);
      const specs = ex.rawImportSpecifiers.map((r) => r.specifier).sort();
      expect(specs).toEqual(['.relative_mod', 'collections', 'json', 'os', 'typing']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips def lines that are commented out', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-py-'));
    try {
      const file = join(root, 'sample.py');
      writeFileSync(
        file,
        [
          "# def fake(): pass",
          "def real(): return 1",
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      const ex = extractPythonFile(fp, file);
      expect(ex.symbolNodes.map((s) => s.label)).toEqual(['real']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('tags Python test files', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-py-'));
    try {
      mkdirSync(join(root, 'tests'), { recursive: true });
      const file = join(root, 'tests', 'test_things.py');
      writeFileSync(file, 'def test_one(): pass');
      const fp = fingerprintFile(file, root);
      const ex = extractPythonFile(fp, file);
      expect(ex.fileNode.tags).toContain('python');
      expect(ex.fileNode.tags).toContain('test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('graph index — Python end-to-end', () => {
  test('buildFullIndex picks up .py files and dispatches the Python extractor', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-py-e2e-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['services/*'] }, null, 2),
      );
      mkdirSync(join(root, 'services', 'api'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'app.py' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'app.py'),
        [
          "from fastapi import FastAPI",
          "from .models import User",
          "",
          "app = FastAPI()",
          "",
          "def healthy():",
          "    return True",
          "",
          "class Server:",
          "    pass",
        ].join('\n'),
      );
      writeFileSync(
        join(root, 'services', 'api', 'models.py'),
        [
          "from pydantic import BaseModel",
          "class User(BaseModel):",
          "    name: str",
        ].join('\n'),
      );

      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      const appFile = api.findFile('services/api/app.py');
      expect(appFile).toBeDefined();
      expect(appFile!.data?.['language']).toBe('python');
      const syms = api.symbolsIn(appFile!.id).map((s) => s.label).sort();
      expect(syms).toEqual(['Server', 'healthy']);
      const modelsFile = api.findFile('services/api/models.py');
      expect(modelsFile).toBeDefined();
      const modelSyms = api.symbolsIn(modelsFile!.id).map((s) => s.label);
      expect(modelSyms).toContain('User');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
