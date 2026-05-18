import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import { spawn } from 'node:child_process';
import { AbstractAiProvider } from '../ai-provider.ts';
import type { IAiRequest, IAiResponse } from '../ai-request.ts';

/**
 * Optional adapter that shells out to a local `claude` CLI binary.
 * It assumes the binary supports `--print --output-format=text`. If it does not,
 * isReady() returns false and send() returns an actionable error.
 */
export class ClaudeCliAdapter extends AbstractAiProvider {
  readonly id = 'claude-cli';
  readonly name = 'Claude (local CLI)';
  private readonly cliPath: string;

  constructor(cliPath = 'claude') {
    super();
    this.cliPath = cliPath;
  }

  isReady(): boolean {
    // Best-effort. The actual check happens during send().
    return true;
  }

  async send(request: IAiRequest): Promise<Result<IAiResponse, AppError>> {
    const prompt = request.messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n');
    return await new Promise<Result<IAiResponse, AppError>>((resolve) => {
      try {
        const proc = spawn(this.cliPath, ['--print', '--output-format=text'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
        proc.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
        proc.on('error', (e) => {
          resolve(
            err(
              new AppErrorImpl(
                ERROR_CODES.IO_ERROR,
                `Failed to spawn claude CLI at "${this.cliPath}": ${e.message}`,
                { suggestion: 'Install Claude Code or pass a different cliPath', cause: e },
              ),
            ),
          );
        });
        proc.on('close', (code) => {
          if (code === 0) {
            resolve(ok({ content: stdout.trim(), model: 'claude-cli' }));
          } else {
            resolve(
              err(
                new AppErrorImpl(
                  ERROR_CODES.IO_ERROR,
                  `claude CLI exited with ${code}: ${stderr.slice(0, 500)}`,
                ),
              ),
            );
          }
        });
        proc.stdin.end(prompt);
      } catch (e) {
        resolve(
          err(
            new AppErrorImpl(ERROR_CODES.IO_ERROR, `Failed to invoke claude CLI: ${(e as Error).message}`, {
              cause: e,
            }),
          ),
        );
      }
    });
  }
}
