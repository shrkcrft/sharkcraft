import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  buildSchemaInventory,
  findSchemaInventoryEntry,
  renderSchemaInventoryMarkdown,
  renderSchemaInventoryText,
} from '@shrkcrft/inspector';
import { ALL_SCHEMAS } from '../schemas/json-schemas.ts';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

export const schemasListCommand: ICommandHandler = {
  name: 'list',
  description: 'List available JSON schemas.',
  usage: 'shrk schemas list [--json]',
  run(args: ParsedArgs): number {
    const names = Object.keys(ALL_SCHEMAS).sort();
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ schemas: names }) + '\n');
      return 0;
    }
    process.stdout.write(header(`JSON schemas (${names.length})`));
    for (const n of names) process.stdout.write(`  ${n}\n`);
    process.stdout.write('\nGet one with: `shrk schemas get <name>`\n');
    process.stdout.write('Write them all with: `shrk schemas write --dir ./schemas`\n');
    return 0;
  },
};

export const schemasGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Print one JSON schema.',
  usage: 'shrk schemas get <name>',
  run(args: ParsedArgs): number {
    const name = args.positional[0];
    if (!name) {
      process.stderr.write('Usage: shrk schemas get <name>\n');
      return 2;
    }
    const schema = ALL_SCHEMAS[name];
    if (!schema) {
      process.stderr.write(
        `Unknown schema "${name}". Available: ${Object.keys(ALL_SCHEMAS).join(', ')}\n`,
      );
      return 1;
    }
    process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
    return 0;
  },
};

export const schemasInventoryCommand: ICommandHandler = {
  name: 'inventory',
  description:
    'Inventory of engine schema ids: known versions, current version, deprecation/back-compat status.',
  usage: 'shrk schemas inventory [<schema-id>] [--format text|markdown|json] [--multi-version-only]',
  run(args: ParsedArgs): number {
    const id = args.positional[0];
    const report = buildSchemaInventory();
    const format = flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'text');
    const multiOnly = flagBool(args, 'multi-version-only');

    if (id) {
      const entry = findSchemaInventoryEntry(id);
      if (!entry) {
        process.stderr.write(
          `Unknown schema id "${id}". Try \`shrk schemas inventory\` to list known ids.\n`,
        );
        return 1;
      }
      if (format === 'json') {
        process.stdout.write(asJson(entry) + '\n');
        return 0;
      }
      process.stdout.write(header(entry.id));
      process.stdout.write(`  current: ${entry.currentVersion}\n`);
      process.stdout.write(`  summary: ${entry.summary}\n`);
      if (entry.emittedBy) process.stdout.write(`  emitted by: ${entry.emittedBy}\n`);
      if (entry.docs) process.stdout.write(`  docs: ${entry.docs}\n`);
      process.stdout.write('  versions:\n');
      for (const v of entry.versions) {
        process.stdout.write(
          `    ${v.version.padEnd(6)} ${v.status}${v.note ? `  — ${v.note}` : ''}\n`,
        );
      }
      return 0;
    }

    const filtered = multiOnly
      ? {
          ...report,
          entries: report.entries.filter((e) => e.versions.length > 1),
        }
      : report;

    if (format === 'json') {
      process.stdout.write(asJson(filtered) + '\n');
      return 0;
    }
    if (format === 'markdown') {
      process.stdout.write(renderSchemaInventoryMarkdown(filtered));
      return 0;
    }
    process.stdout.write(renderSchemaInventoryText(filtered));
    return 0;
  },
};

export const schemasWriteCommand: ICommandHandler = {
  name: 'write',
  description: 'Write all JSON schemas to <dir>. Prefer `schemas emit --write --out <dir>` for preview-first emission.',
  usage: 'shrk schemas write --dir <output-dir>',
  run(args: ParsedArgs): number {
    const dir = flagString(args, 'dir');
    if (!dir) {
      process.stderr.write('Usage: shrk schemas write --dir <output-dir>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const absolute = dir.startsWith('/') ? dir : join(cwd, dir);
    if (!existsSync(absolute)) mkdirSync(absolute, { recursive: true });
    const written: string[] = [];
    for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
      const filename = `${name}.schema.json`;
      const target = join(absolute, filename);
      writeFileSync(target, JSON.stringify(schema, null, 2) + '\n', 'utf8');
      written.push(target);
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ written }) + '\n');
      return 0;
    }
    process.stdout.write(`Wrote ${written.length} schemas:\n`);
    for (const w of written) process.stdout.write(`  ${w}\n`);
    return 0;
  },
};

/**
 * On-disk schema emission with preview-first / drift-check semantics.
 *
 * Default: dry-run preview lists files that would change.
 * `--write`: writes every schema as `<name>.schema.json` plus an
 *            `INDEX.md` enumerating the set.
 * `--check`: exits non-zero if `<out>` is missing files, has extra
 *            files, or any file differs from the in-memory schema.
 *            Used by `release:preflight`.
 *
 * `--out` defaults to `docs/schemas/` so agents can grep `docs/` for
 * schema ids.
 */

export const SCHEMAS_EMIT_SCHEMA = 'sharkcraft.schemas-emit/v1';

interface IEmitDiffEntry {
  file: string;
  status: 'unchanged' | 'changed' | 'missing-on-disk' | 'unexpected-on-disk';
}

function computeEmitPlan(absOut: string): {
  expected: Record<string, string>;
  diffs: IEmitDiffEntry[];
} {
  const expected: Record<string, string> = {};
  for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
    expected[`${name}.schema.json`] = JSON.stringify(schema, null, 2) + '\n';
  }
  expected['INDEX.md'] = renderSchemasIndexMarkdown(Object.keys(ALL_SCHEMAS));

  const diffs: IEmitDiffEntry[] = [];
  const onDisk: string[] = existsSync(absOut)
    ? readdirSync(absOut).filter((f) => f.endsWith('.schema.json') || f === 'INDEX.md')
    : [];
  const expectedSet = new Set(Object.keys(expected));
  for (const [file, content] of Object.entries(expected)) {
    const abs = join(absOut, file);
    if (!existsSync(abs)) {
      diffs.push({ file, status: 'missing-on-disk' });
      continue;
    }
    const existing = readFileSync(abs, 'utf8');
    diffs.push({ file, status: existing === content ? 'unchanged' : 'changed' });
  }
  for (const file of onDisk) {
    if (!expectedSet.has(file)) {
      diffs.push({ file, status: 'unexpected-on-disk' });
    }
  }
  return { expected, diffs };
}

function renderSchemasIndexMarkdown(names: readonly string[]): string {
  const sorted = [...names].sort();
  const lines: string[] = [];
  lines.push('# JSON schemas');
  lines.push('');
  lines.push(
    'This directory is auto-generated by `shrk schemas emit --write`. Do not edit by hand.',
  );
  lines.push('');
  lines.push(`Total: **${sorted.length}** schemas.`);
  lines.push('');
  lines.push('| Schema | File | Source command |');
  lines.push('| ------ | ---- | -------------- |');
  for (const name of sorted) {
    lines.push(`| \`${name}\` | [\`${name}.schema.json\`](${name}.schema.json) | \`shrk schemas get ${name}\` |`);
  }
  lines.push('');
  lines.push('## Re-emit');
  lines.push('');
  lines.push('```bash');
  lines.push('shrk schemas emit --write');
  lines.push('```');
  lines.push('');
  lines.push(
    '`release:preflight` runs `shrk schemas emit --check` and fails when this directory drifts from the in-memory registry.',
  );
  lines.push('');
  return lines.join('\n');
}

export const schemasEmitCommand: ICommandHandler = {
  name: 'emit',
  description:
    'Emit every JSON schema to disk (default docs/schemas/) with an INDEX.md. Preview-first — pass --write to apply, --check to fail on drift.',
  usage:
    'shrk schemas emit [--out <dir>] [--write|--check] [--json]',
  run(args: ParsedArgs): number {
    const cwd = resolveCwd(args);
    const out = flagString(args, 'out') ?? 'docs/schemas';
    const absOut = out.startsWith('/') ? out : join(cwd, out);
    const wantJson = flagBool(args, 'json');
    const doWrite = flagBool(args, 'write');
    const doCheck = flagBool(args, 'check');

    if (doWrite && doCheck) {
      process.stderr.write('--write and --check are mutually exclusive.\n');
      return 2;
    }

    const { expected, diffs } = computeEmitPlan(absOut);
    const drifted = diffs.filter((d) => d.status !== 'unchanged');

    if (doCheck) {
      if (wantJson) {
        process.stdout.write(
          asJson({
            schema: SCHEMAS_EMIT_SCHEMA,
            mode: 'check',
            out: relative(cwd, absOut),
            drifted: drifted.length,
            diffs,
          }) + '\n',
        );
      } else {
        process.stdout.write(header(`schemas emit --check (${relative(cwd, absOut)})`));
        process.stdout.write(`  expected:   ${Object.keys(expected).length} files\n`);
        process.stdout.write(`  drifted:    ${drifted.length}\n\n`);
        if (drifted.length > 0) {
          for (const d of drifted) process.stdout.write(`  • ${d.status.padEnd(22)} ${d.file}\n`);
          process.stdout.write('\nRun `shrk schemas emit --write` to refresh.\n');
        } else {
          process.stdout.write('docs/schemas/ matches the in-memory registry.\n');
        }
      }
      return drifted.length === 0 ? 0 : 1;
    }

    if (doWrite) {
      mkdirSync(absOut, { recursive: true });
      for (const [file, content] of Object.entries(expected)) {
        writeFileSync(join(absOut, file), content, 'utf8');
      }
      // Sweep unexpected files (e.g. a removed schema) so the directory
      // mirrors the registry exactly.
      for (const d of diffs) {
        if (d.status === 'unexpected-on-disk') {
          // Don't delete by default — log instead, so the human can decide.
          // Preserves the safety contract (no destructive ops without
          // explicit user intent).
        }
      }
      if (wantJson) {
        process.stdout.write(
          asJson({
            schema: SCHEMAS_EMIT_SCHEMA,
            mode: 'write',
            out: relative(cwd, absOut),
            written: Object.keys(expected),
            unexpected: diffs.filter((d) => d.status === 'unexpected-on-disk').map((d) => d.file),
          }) + '\n',
        );
      } else {
        process.stdout.write(header(`schemas emit --write (${relative(cwd, absOut)})`));
        process.stdout.write(`  wrote:      ${Object.keys(expected).length} files\n`);
        const unexpected = diffs.filter((d) => d.status === 'unexpected-on-disk');
        if (unexpected.length > 0) {
          process.stdout.write(`  unexpected: ${unexpected.length} (left in place)\n`);
          for (const d of unexpected) process.stdout.write(`    • ${d.file}\n`);
          process.stdout.write(
            '  → remove unexpected files manually if they came from a deleted schema.\n',
          );
        }
      }
      return 0;
    }

    // Default: preview.
    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: SCHEMAS_EMIT_SCHEMA,
          mode: 'preview',
          out: relative(cwd, absOut),
          expected: Object.keys(expected),
          drifted: drifted.length,
          diffs,
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`schemas emit preview (${relative(cwd, absOut)})`));
    process.stdout.write(`  expected:   ${Object.keys(expected).length} files\n`);
    process.stdout.write(`  drifted:    ${drifted.length}\n`);
    if (drifted.length > 0) {
      process.stdout.write('\n  diffs:\n');
      for (const d of drifted.slice(0, 20)) {
        process.stdout.write(`    • ${d.status.padEnd(22)} ${d.file}\n`);
      }
      if (drifted.length > 20) {
        process.stdout.write(`    … and ${drifted.length - 20} more\n`);
      }
    }
    process.stdout.write('\n(preview only — pass --write to apply, --check to fail on drift)\n');
    return 0;
  },
};
