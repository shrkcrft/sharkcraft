#!/usr/bin/env bun
// check-circular-deps: deterministic package-cycle check for the monorepo.
//
// CLAUDE.md tells every agent to run `bun run check:circular-deps` when a
// change spans multiple packages. This script reads every
// packages/<name>/package.json, builds the `@shrkcrft/*` dependency graph from
// each package's `dependencies`, and fails (exit 1) if that graph contains a
// cycle — the layer order in CLAUDE.md requires it to be a DAG. No AI, no
// network, no new deps: just JSON + a DFS.
//
// Usage:
//   bun run scripts/check-circular-deps.ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface IPkgJson {
  name?: string;
  dependencies?: Record<string, string>;
}

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');

const dirs = readdirSync(PACKAGES_DIR).filter((d) => {
  try {
    return statSync(join(PACKAGES_DIR, d)).isDirectory();
  } catch {
    return false;
  }
});

// First pass: collect every local package name and its declared `@shrkcrft/*`
// runtime dependencies (sorted, for deterministic output).
const localNames = new Set<string>();
const rawDeps = new Map<string, readonly string[]>();
for (const dir of dirs) {
  const pkgPath = join(PACKAGES_DIR, dir, 'package.json');
  if (!existsSync(pkgPath)) continue;
  let pkg: IPkgJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as IPkgJson;
  } catch (err) {
    process.stderr.write(`Failed to parse ${pkgPath}: ${String(err)}\n`);
    process.exit(2);
  }
  if (!pkg.name) continue;
  localNames.add(pkg.name);
  const deps = Object.keys(pkg.dependencies ?? {})
    .filter((d) => d.startsWith('@shrkcrft/'))
    .sort();
  rawDeps.set(pkg.name, deps);
}

// Build the adjacency list, restricting edges to deps that resolve to a local
// package (an external `@shrkcrft/*` cannot participate in a local cycle).
const nodes = [...localNames].sort();
const edges = new Map<string, readonly string[]>();
for (const name of nodes) {
  edges.set(name, (rawDeps.get(name) ?? []).filter((d) => localNames.has(d)));
}

/**
 * DFS with WHITE/GREY/BLACK colouring. A GREY neighbour is a back-edge, i.e. a
 * cycle; the cycle is the current path from that neighbour to here. Cycles are
 * de-duplicated by a rotation-normalised key so the same loop reached from two
 * roots is reported once. Returns each cycle as a node list whose final element
 * repeats the first (e.g. `["a", "b", "a"]`).
 */
function findCycles(
  graphNodes: readonly string[],
  graphEdges: Map<string, readonly string[]>,
): string[][] {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of graphNodes) color.set(n, WHITE);
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const canonical = (cycle: readonly string[]): string => {
    let min = 0;
    for (let i = 1; i < cycle.length; i += 1) {
      if (cycle[i]! < cycle[min]!) min = i;
    }
    return [...cycle.slice(min), ...cycle.slice(0, min)].join('>');
  };

  const visit = (node: string): void => {
    color.set(node, GREY);
    stackIndex.set(node, stack.length);
    stack.push(node);
    for (const next of graphEdges.get(node) ?? []) {
      const c = color.get(next);
      if (c === GREY) {
        const cycle = stack.slice(stackIndex.get(next)!);
        const key = canonical(cycle);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push([...cycle, next]);
        }
      } else if (c === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    stackIndex.delete(node);
    color.set(node, BLACK);
  };

  for (const n of graphNodes) {
    if (color.get(n) === WHITE) visit(n);
  }
  return cycles;
}

const cycles = findCycles(nodes, edges);
if (cycles.length > 0) {
  const label = cycles.length === 1 ? 'dependency' : 'dependencies';
  process.stderr.write(`Found ${cycles.length} circular package ${label}:\n`);
  for (const cycle of cycles) {
    process.stderr.write(`  ${cycle.join(' -> ')}\n`);
  }
  process.stderr.write(
    '\nPackage dependencies must form a DAG (see the layer order in CLAUDE.md).\n',
  );
  process.exit(1);
}

process.stdout.write(`No circular package dependencies (${nodes.length} packages checked).\n`);
process.exit(0);
