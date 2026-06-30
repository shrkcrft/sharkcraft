import * as nodePath from 'node:path';

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
  /** Captures every occurrence (including repeats) for flags like --var. */
  multiFlags: Map<string, string[]>;
  /** Resolved global cwd (absolute), if --cwd was passed at the top level. */
  globalCwd?: string;
}

export interface ICommandHandler {
  name: string;
  description: string;
  usage: string;
  /**
   * Flags that take NO value (e.g. `json`, `no-enhance`). Listed here so the
   * parser doesn't greedily swallow the following token as the flag's value —
   * `compress --json <file>` / `smart-context --no-enhance "<task>"` keep the
   * token as a positional regardless of argument order (the order an LLM
   * naturally emits). Optional; commands without it parse exactly as before.
   */
  booleanFlags?: ReadonlySet<string>;
  run(args: ParsedArgs): Promise<number> | number;
}

/**
 * Trie node backing the registry. A node can carry a handler (the verb
 * at this path is callable) and/or children (further verbs nested below).
 * Aliases live at the node — `pack.aliases.set('author2', 'author')` makes
 * `shrk pack author2 status` resolve via `pack/author/status`.
 */
interface ICommandTrieNode {
  handler?: ICommandHandler;
  readonly children: Map<string, ICommandTrieNode>;
  readonly aliases: Map<string, string>;
}

function makeTrieNode(): ICommandTrieNode {
  return { children: new Map(), aliases: new Map() };
}

/** Result of a greedy descent through the trie. */
export interface ICommandResolution {
  /** Handler at the deepest matched path (may be undefined if it's a pure group). */
  handler?: ICommandHandler;
  /** The canonical segments that matched (aliases already resolved). */
  matchedPath: string[];
  /** Tokens left over after the descent stopped (passed to the handler). */
  rest: string[];
  /** The trie node where the descent stopped — useful for help/suggestions. */
  node: ICommandTrieNode;
}

/**
 * Trie-backed command registry. Supports N-level dispatch
 * (`shrk pack author status`) while keeping the historical 1- and 2-level
 * API working as degenerate cases.
 *
 * Aliases:
 *   - `aliasCommand(a, c)` — top-level alias (`shrk a` → `shrk c`).
 *   - `aliasGroup(a, c)` — top-level group alias (`shrk a list` → `shrk c list`).
 *   - `aliasAt(path, alias, canonical)` — alias at arbitrary depth.
 */
export class CommandRegistry {
  private readonly root: ICommandTrieNode = makeTrieNode();
  /** Mirrors of the trie root for the legacy listGroupAliases/listCommandAliases API. */
  private readonly groupAliases = new Map<string, string>();
  private readonly commandAliases = new Map<string, string>();

  /** Register a top-level command (`shrk <name>`). */
  register(command: ICommandHandler): void {
    this.registerAt([command.name], command);
  }

  /** Register a 2-level command (`shrk <group> <name>`). */
  registerSubcommand(group: string, command: ICommandHandler): void {
    this.registerAt([group, command.name], command);
  }

  /**
   * Register a command at an arbitrary depth (`shrk a b c <name>`).
   * Path is the full sequence of segments; the LAST segment is the verb
   * (the command name).
   */
  registerAt(path: readonly string[], command: ICommandHandler): void {
    if (path.length === 0) {
      throw new Error('registerAt: path must have at least one segment');
    }
    let node = this.root;
    for (const seg of path) {
      let child = node.children.get(seg);
      if (!child) {
        child = makeTrieNode();
        node.children.set(seg, child);
      }
      node = child;
    }
    node.handler = command;
  }

  /** Legacy: top-level group alias. */
  aliasGroup(alias: string, canonical: string): void {
    this.groupAliases.set(alias, canonical);
    this.root.aliases.set(alias, canonical);
  }

  /** Legacy: top-level command alias. */
  aliasCommand(alias: string, canonical: string): void {
    this.commandAliases.set(alias, canonical);
    this.root.aliases.set(alias, canonical);
  }

  /** Alias at arbitrary depth. Path is the parent of the alias. */
  aliasAt(parentPath: readonly string[], alias: string, canonical: string): void {
    let node = this.root;
    for (const seg of parentPath) {
      let child = node.children.get(seg);
      if (!child) {
        child = makeTrieNode();
        node.children.set(seg, child);
      }
      node = child;
    }
    node.aliases.set(alias, canonical);
  }

  /** Top-level command lookup. */
  get(name: string): ICommandHandler | undefined {
    const canonical = this.root.aliases.get(name) ?? name;
    return this.root.children.get(canonical)?.handler;
  }

  /** 2-level command lookup. */
  getSub(group: string, name: string): ICommandHandler | undefined {
    const node = this.descend([group]);
    if (!node) return undefined;
    const canonical = node.aliases.get(name) ?? name;
    return node.children.get(canonical)?.handler;
  }

  /** Handler at an arbitrary path (exact match, no descent). */
  getAt(path: readonly string[]): ICommandHandler | undefined {
    const node = this.descend(path);
    return node?.handler;
  }

  resolveGroup(group: string): string {
    return this.root.aliases.get(group) ?? group;
  }

  listGroups(): readonly string[] {
    // Canonical groups at depth 1 (children with their own children) plus
    // every top-level alias. Mirrors the historical behaviour.
    const out: string[] = [];
    for (const [name, node] of this.root.children) {
      if (node.children.size > 0) out.push(name);
    }
    for (const alias of this.root.aliases.keys()) out.push(alias);
    return out;
  }

  listGroup(group: string): readonly ICommandHandler[] {
    const canonical = this.root.aliases.get(group) ?? group;
    const node = this.root.children.get(canonical);
    if (!node) return [];
    // Immediate verbs only (matches the legacy 2-level semantics). Use
    // `listSubgroups(group)` to discover nested groups.
    return [...node.children.values()]
      .map((c) => c.handler)
      .filter((h): h is ICommandHandler => h !== undefined);
  }

  /** Immediate subgroup names of a group (nodes with their own children). */
  listSubgroups(path: readonly string[]): readonly string[] {
    const node = this.descend(path);
    if (!node) return [];
    const out: string[] = [];
    for (const [name, child] of node.children) {
      if (child.children.size > 0) out.push(name);
    }
    return out;
  }

  listGroupAliases(): ReadonlyMap<string, string> {
    return this.groupAliases;
  }

  listCommandAliases(): ReadonlyMap<string, string> {
    return this.commandAliases;
  }

  /** Top-level commands (handlers at depth 1). */
  list(): readonly ICommandHandler[] {
    const out: ICommandHandler[] = [];
    for (const child of this.root.children.values()) {
      if (child.handler) out.push(child.handler);
    }
    return out;
  }

  /** Every handler in the trie with its full path. */
  listAll(): ReadonlyArray<{ readonly path: readonly string[]; readonly handler: ICommandHandler }> {
    const out: Array<{ path: string[]; handler: ICommandHandler }> = [];
    this.collectAll(this.root, [], out);
    return out;
  }

  /**
   * Greedy dispatch resolution. Descends as deep as possible through
   * the trie. Stops when:
   *   1. The next token is a flag (`--foo` / `-f`).
   *   2. The current node has no matching child for the next token.
   *
   * Returns the deepest node's handler, the canonical path that matched,
   * and the remaining tokens (passed to the handler).
   */
  resolve(tokens: readonly string[]): ICommandResolution {
    let node = this.root;
    const matched: string[] = [];
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.startsWith('-')) break;
      const canonical = node.aliases.get(t) ?? t;
      const child = node.children.get(canonical);
      if (!child) break;
      node = child;
      matched.push(canonical);
      i += 1;
    }
    return {
      handler: node.handler,
      matchedPath: matched,
      rest: tokens.slice(i),
      node,
    };
  }

  private descend(path: readonly string[]): ICommandTrieNode | undefined {
    let node: ICommandTrieNode | undefined = this.root;
    for (const seg of path) {
      if (!node) return undefined;
      const canonical = node.aliases.get(seg) ?? seg;
      node = node.children.get(canonical);
    }
    return node;
  }

  private collectAll(
    node: ICommandTrieNode,
    prefix: string[],
    out: Array<{ path: string[]; handler: ICommandHandler }>,
  ): void {
    for (const [name, child] of node.children) {
      const path = [...prefix, name];
      if (child.handler) out.push({ path, handler: child.handler });
      this.collectAll(child, path, out);
    }
  }
}

function addMultiFlag(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key) ?? [];
  arr.push(value);
  map.set(key, arr);
}

export interface ParseArgsOptions {
  /** Global cwd resolved during pre-parse, propagated to the command. */
  globalCwd?: string;
  /** Flags that take no value — they never consume the following token. */
  booleanFlags?: ReadonlySet<string>;
}

export function parseArgs(argv: readonly string[], options: ParseArgsOptions = {}): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const multiFlags = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      let key: string;
      let value: string | boolean;
      if (eq !== -1) {
        key = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      } else {
        key = arg.slice(2);
        const next = argv[i + 1];
        // A known boolean flag never consumes the following token, so
        // flag-first ordering (`--json <file>`, `--no-enhance "<task>"`) keeps
        // the token as a positional instead of swallowing it as the value.
        if (options.booleanFlags?.has(key)) {
          value = true;
        } else if (next !== undefined && !next.startsWith('-')) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
      flags.set(key, value);
      if (typeof value === 'string') addMultiFlag(multiFlags, key, value);
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      flags.set(key, true);
    } else {
      positional.push(arg);
    }
  }
  const out: ParsedArgs = { positional, flags, multiFlags };
  if (options.globalCwd) out.globalCwd = options.globalCwd;
  return out;
}

/**
 * Extracts `--cwd <value>` / `--cwd=<value>` from anywhere in argv. Used as a
 * pre-pass before command dispatch so a user can write `shrk --cwd ./repo doctor`.
 */
export function extractGlobalCwd(argv: readonly string[]): {
  cwd?: string;
  rest: string[];
} {
  const rest: string[] = [];
  let cwd: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    // Honor the POSIX `--` end-of-options separator (as parseArgs does):
    // everything after it is a literal positional, so a `--cwd` there must not
    // be intercepted. Preserve `--` and the remainder verbatim.
    if (t === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (t === '--cwd') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        cwd = next;
        i += 1;
        continue;
      }
      // No value — leave it; command-level parser may complain.
      rest.push(t);
      continue;
    }
    if (t.startsWith('--cwd=')) {
      cwd = t.slice('--cwd='.length);
      continue;
    }
    rest.push(t);
  }
  if (cwd && !nodePath.isAbsolute(cwd)) cwd = nodePath.resolve(process.cwd(), cwd);
  return cwd === undefined ? { rest } : { cwd, rest };
}

/** A request to compress a command's stdout, parsed from the global flags. */
export interface IGlobalCompressDirective {
  /** Force a content type for the compressor (else auto-detect). */
  type?: string;
  /** Query text that biases which lines/matches the compressor keeps. */
  query?: string;
}

/**
 * Extracts the global output-compression flags from anywhere in argv:
 * `--compress` / `--ccr` (synonyms; turn it on) plus optional
 * `--compress-type <t>` and `--compress-query <q>`. Returns the directive (when
 * any was present) and the remaining argv with those flags removed — so the
 * underlying command can be re-run cleanly without them (and never recurses).
 */
export function extractGlobalCompress(argv: readonly string[]): {
  directive?: IGlobalCompressDirective;
  rest: string[];
} {
  const rest: string[] = [];
  let active = false;
  let type: string | undefined;
  let query: string | undefined;
  const valued = (token: string, flag: string, set: (v: string) => void, i: number): boolean => {
    if (token === flag) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        set(next);
        return true; // caller skips next
      }
      return false;
    }
    return false;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    // Honor the POSIX `--` end-of-options separator exactly as parseArgs does:
    // everything after it is a literal positional, so a compress-flag-shaped
    // token there must NOT be intercepted (and the next token must not be
    // swallowed as a value). Preserve `--` and the remainder verbatim for the
    // child to re-parse.
    if (t === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (t === '--compress' || t === '--ccr') {
      active = true;
      continue;
    }
    if (t.startsWith('--compress-type=')) {
      type = t.slice('--compress-type='.length);
      active = true;
      continue;
    }
    if (t.startsWith('--compress-query=')) {
      query = t.slice('--compress-query='.length);
      active = true;
      continue;
    }
    if (t === '--compress-type') {
      if (valued(t, '--compress-type', (v) => (type = v), i)) {
        active = true;
        i += 1;
        continue;
      }
      active = true;
      continue;
    }
    if (t === '--compress-query') {
      if (valued(t, '--compress-query', (v) => (query = v), i)) {
        active = true;
        i += 1;
        continue;
      }
      active = true;
      continue;
    }
    rest.push(t);
  }
  if (!active) return { rest };
  const directive: IGlobalCompressDirective = {};
  if (type !== undefined) directive.type = type;
  if (query !== undefined) directive.query = query;
  return { directive, rest };
}

/**
 * Returns the absolute cwd for the current command:
 * 1. Command-level --cwd flag (if passed after the command)
 * 2. Global --cwd (extracted at the top level)
 * 3. process.cwd()
 */
export function resolveCwd(args: ParsedArgs): string {
  const flag = args.flags.get('cwd');
  if (typeof flag === 'string') return nodePath.resolve(flag);
  if (args.globalCwd) return args.globalCwd;
  return process.cwd();
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  const v = args.flags.get(name);
  return v === true || v === 'true';
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const v = args.flags.get(name);
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a `--limit`/`--depth`-style flag as a positive integer, falling back to
 * `fallback` when the flag is absent OR malformed (non-numeric, NaN, <= 0,
 * non-integer). Guards the `Number(flagString(...))` footgun where a
 * fat-fingered `--limit abc` becomes NaN and silently yields empty-or-unbounded
 * results (`[].slice(0, NaN) === []`, `x >= NaN === false`). Use everywhere a
 * count/cap is read from a flag.
 */
export function flagPositiveInt(args: ParsedArgs, name: string, fallback: number): number {
  const v = args.flags.get(name);
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Canonical multi-value flag parser.
 *
 * Accepts every form the CLI has historically used:
 *
 *   --tag a --tag b           → ['a','b']
 *   --tag a,b                 → ['a','b']
 *   --tag "a, b, c"           → ['a','b','c']
 *   --tag=a --tag=b           → ['a','b']
 *   (mixed)                   → flattened, trimmed, empties dropped.
 *
 * Replaces the older `flagStringList` (comma-only) and the one-off
 * `multiValues()` helpers that accreted across commands.
 */
export interface IFlagListOptions {
  /** Remove duplicates while preserving first occurrence. Default false. */
  dedupe?: boolean;
  /** Allowlist — values outside this set are filtered out silently. */
  allow?: readonly string[];
  /**
   * Controls comma splitting:
   *
   *   - `'always'` (default) — every occurrence is comma-split.
   *   - `'never'` — keep each occurrence verbatim (use when a single value
   *     may legitimately contain commas, e.g. structured refs).
   *   - `'auto'` — comma-split when the flag was passed once; keep
   *     occurrences verbatim when passed multiple times. Useful for
   *     `--reference "kind:value"` shapes.
   */
  split?: 'always' | 'never' | 'auto';
}

export function flagList(
  args: ParsedArgs,
  name: string,
  options: IFlagListOptions = {},
): string[] {
  const split = options.split ?? 'always';
  const raw = args.multiFlags.get(name) ?? [];

  let entries: string[];
  if (split === 'never' || (split === 'auto' && raw.length > 1)) {
    entries = raw.map((v) => v.trim()).filter(Boolean);
  } else {
    entries = raw.flatMap((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  if (options.allow && options.allow.length) {
    const allow = new Set(options.allow);
    entries = entries.filter((v) => allow.has(v));
  }

  if (options.dedupe) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of entries) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }

  return entries;
}

export function flagVars(args: ParsedArgs): Record<string, string> {
  const out: Record<string, string> = {};
  const list = args.multiFlags.get('var') ?? [];
  for (const item of list) {
    const eq = item.indexOf('=');
    if (eq !== -1) out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}
