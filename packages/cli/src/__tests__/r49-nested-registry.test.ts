/**
 * Trie-backed CommandRegistry tests.
 *
 * Locks in the contract for the new N-level dispatch: 1-, 2-, and 3-level
 * commands all resolve through the same `resolve()` method, aliases work
 * at any depth, and the legacy `register` / `registerSubcommand` /
 * `getSub` / `listGroup` / `listGroups` API still behaves as it did
 * before the rewrite.
 */
import { describe, expect, test } from 'bun:test';
import {
  CommandRegistry,
  type ICommandHandler,
} from '../command-registry.ts';

function fakeHandler(name: string): ICommandHandler {
  return {
    name,
    description: `desc-${name}`,
    usage: `shrk ${name}`,
    run: () => 0,
  };
}

describe('CommandRegistry trie', () => {
  test('1-level: register + get + list', () => {
    const r = new CommandRegistry();
    const cmd = fakeHandler('doctor');
    r.register(cmd);
    expect(r.get('doctor')).toBe(cmd);
    expect(r.list()).toContain(cmd);
  });

  test('2-level: registerSubcommand + getSub + listGroup', () => {
    const r = new CommandRegistry();
    const cmd = fakeHandler('list');
    r.registerSubcommand('packs', cmd);
    expect(r.getSub('packs', 'list')).toBe(cmd);
    expect(r.listGroup('packs')).toContain(cmd);
    expect(r.listGroups()).toContain('packs');
  });

  test('3-level: registerAt + getAt + resolve', () => {
    const r = new CommandRegistry();
    const cmd = fakeHandler('status');
    r.registerAt(['pack', 'author', 'status'], cmd);
    expect(r.getAt(['pack', 'author', 'status'])).toBe(cmd);

    const { handler, matchedPath, rest } = r.resolve(['pack', 'author', 'status']);
    expect(handler).toBe(cmd);
    expect(matchedPath).toEqual(['pack', 'author', 'status']);
    expect(rest).toEqual([]);
  });

  test('resolve: greedy descent stops at flags', () => {
    const r = new CommandRegistry();
    const status = fakeHandler('status');
    r.registerAt(['pack', 'author', 'status'], status);

    const { handler, matchedPath, rest } = r.resolve([
      'pack',
      'author',
      'status',
      '--json',
      '--kind',
      'knowledge',
    ]);
    expect(handler).toBe(status);
    expect(matchedPath).toEqual(['pack', 'author', 'status']);
    expect(rest).toEqual(['--json', '--kind', 'knowledge']);
  });

  test('resolve: stops when child not found, returns leftover', () => {
    const r = new CommandRegistry();
    const status = fakeHandler('status');
    r.registerAt(['pack', 'author', 'status'], status);

    const { handler, matchedPath, rest, node } = r.resolve(['pack', 'unknown']);
    expect(handler).toBeUndefined(); // pack has no handler of its own
    expect(matchedPath).toEqual(['pack']);
    expect(rest).toEqual(['unknown']);
    expect(node.children.has('author')).toBe(true);
  });

  test('resolve: empty tokens returns root', () => {
    const r = new CommandRegistry();
    const { handler, matchedPath, rest } = r.resolve([]);
    expect(handler).toBeUndefined();
    expect(matchedPath).toEqual([]);
    expect(rest).toEqual([]);
  });

  test('aliasCommand resolves at the root', () => {
    const r = new CommandRegistry();
    const cmd = fakeHandler('doctor');
    r.register(cmd);
    r.aliasCommand('dr', 'doctor');
    expect(r.get('dr')).toBe(cmd);
    const { handler } = r.resolve(['dr']);
    expect(handler).toBe(cmd);
  });

  test('aliasGroup resolves nested children through the alias', () => {
    const r = new CommandRegistry();
    const list = fakeHandler('list');
    r.registerSubcommand('packs', list);
    r.aliasGroup('pack', 'packs');
    // Note: aliasGroup only aliases the *group name*, so `pack list` works.
    const { handler, matchedPath } = r.resolve(['pack', 'list']);
    expect(handler).toBe(list);
    // matchedPath uses the canonical name
    expect(matchedPath).toEqual(['packs', 'list']);
  });

  test('aliasAt: alias at arbitrary depth', () => {
    const r = new CommandRegistry();
    const status = fakeHandler('status');
    r.registerAt(['pack', 'author', 'status'], status);
    // Make `info` an alias for `status` under `pack author`.
    r.aliasAt(['pack', 'author'], 'info', 'status');
    const { handler, matchedPath } = r.resolve(['pack', 'author', 'info']);
    expect(handler).toBe(status);
    // matchedPath captures the canonical name after alias resolution
    expect(matchedPath).toEqual(['pack', 'author', 'status']);
  });

  test('a node can have both a handler and children (mixed-mode)', () => {
    const r = new CommandRegistry();
    const knowledge = fakeHandler('knowledge');
    const knowledgeAdd = fakeHandler('add');
    r.register(knowledge);
    r.registerSubcommand('knowledge', knowledgeAdd);

    // `shrk knowledge` → run the top-level handler.
    const a = r.resolve(['knowledge']);
    expect(a.handler).toBe(knowledge);

    // `shrk knowledge add` → descend to the verb.
    const b = r.resolve(['knowledge', 'add']);
    expect(b.handler).toBe(knowledgeAdd);
  });

  test('listAll returns every registered handler with its full path', () => {
    const r = new CommandRegistry();
    r.register(fakeHandler('doctor'));
    r.registerSubcommand('packs', fakeHandler('list'));
    r.registerAt(['pack', 'author', 'status'], fakeHandler('status'));

    const all = r.listAll();
    const paths = all.map((e) => e.path.join(' ')).sort();
    expect(paths).toEqual([
      'doctor',
      'pack author status',
      'packs list',
    ]);
  });

  test('listGroups includes nested groups, listSubgroups exposes them', () => {
    const r = new CommandRegistry();
    r.registerAt(['pack', 'author', 'status'], fakeHandler('status'));
    expect(r.listGroups()).toContain('pack');
    expect(r.listSubgroups(['pack'])).toEqual(['author']);
  });
});
