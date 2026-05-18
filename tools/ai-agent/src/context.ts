import { LIMITS } from './config/limits.ts';
import { AgentError, ErrorCategory } from './errors.ts';

export interface IRepoContext {
  shrkTaskOutput: string;
}

export interface ICollectContextOptions {
  spawn?: typeof Bun.spawn;
  cwd?: string;
}

export async function collectContext(
  title: string,
  options: ICollectContextOptions = {},
): Promise<IRepoContext> {
  const spawnFn = options.spawn ?? Bun.spawn;
  const cwd = options.cwd ?? process.cwd();

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = spawnFn(['bun', 'run', 'packages/cli/src/main.ts', 'task', title], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    throw new AgentError(
      ErrorCategory.ContextCollectionFailed,
      `failed to spawn shrk task: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // process may already be exiting
    }
  }, LIMITS.shrkTaskTimeoutMs);

  let stdout = '';
  let stderr = '';
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (exitCode !== 0) {
    throw new AgentError(
      ErrorCategory.ContextCollectionFailed,
      `shrk task exited ${exitCode}: ${stderr.slice(0, 500)}`,
    );
  }

  const trimmed =
    stdout.length > LIMITS.maxShrkContextBytes
      ? stdout.slice(0, LIMITS.maxShrkContextBytes) + '\n…[truncated]'
      : stdout;

  return { shrkTaskOutput: trimmed };
}
