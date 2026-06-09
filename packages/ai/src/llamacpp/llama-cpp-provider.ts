import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import { AbstractAiProvider } from '../ai-provider.ts';
import { AiMessageRole, type IAiMessage, type IAiRequest, type IAiResponse } from '../ai-request.ts';

const DEFAULT_CONTEXT_SIZE = 8192;
const DEFAULT_MAX_TOKENS = 1024;

/**
 * In-process generative provider backed by `node-llama-cpp` (a Node
 * binding for llama.cpp). No HTTP. No daemon. The model is loaded
 * once into process memory and reused across requests.
 *
 * Configuration (env or `IAiProviderConfig`):
 *   - `LLAMACPP_MODEL_PATH`   — absolute or repo-relative path to a
 *                               local `.gguf` file. If unset, the
 *                               provider is `isReady() === false`.
 *   - `LLAMACPP_CONTEXT_SIZE` — context window in tokens (default 8192).
 *   - `LLAMACPP_GPU`          — `auto` (default) | `metal` | `cuda` | `off`.
 *
 * The first `send()` call pays the model-load cost (typically 1–10 s
 * for a 3B Q4 model on Apple Silicon). Subsequent calls reuse
 * the same `LlamaModel` + `LlamaContext`. A fresh `LlamaChatSession`
 * is created per request so context isn't leaked between unrelated
 * tasks.
 *
 * Tests can inject a fake generator via `_overrideForTests` to avoid
 * pulling in the native binding and a 2 GB model file.
 */
export class LlamaCppProvider extends AbstractAiProvider {
  readonly id = 'llamacpp';
  readonly name = 'llama.cpp (in-process)';

  /** Test hook — bypasses the native binding when set. */
  static _overrideForTests:
    | ((request: IAiRequest, modelPath: string) => Promise<IAiResponse>)
    | null = null;

  /**
   * Reads the module-level cache to expose the active model path for
   * tools that need it (mostly the disposer). Returns null when no
   * model has been loaded in this process.
   */
  static activeModelPath(): string | null {
    return sharedLlamaState?.modelPath ?? null;
  }

  isReady(): boolean {
    return resolveModelPath(this.config.model) !== null;
  }

  async send(request: IAiRequest): Promise<Result<IAiResponse, AppError>> {
    const modelPath = resolveModelPath(request.model ?? this.config.model);
    if (modelPath === null) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          'LLAMACPP_MODEL_PATH is not set or the file does not exist.',
          {
            suggestion:
              'Set LLAMACPP_MODEL_PATH=/path/to/qwen2.5-coder-3b.gguf in .env, or pass --model <path> on the CLI.',
          },
        ),
      );
    }

    if (LlamaCppProvider._overrideForTests) {
      try {
        const value = await LlamaCppProvider._overrideForTests(request, modelPath);
        return ok(value);
      } catch (e) {
        return err(
          new AppErrorImpl(ERROR_CODES.IO_ERROR, `Test override failed: ${(e as Error).message}`, {
            cause: e,
          }),
        );
      }
    }

    let promptAbort: AbortController | undefined;
    let promptTimer: ReturnType<typeof setTimeout> | undefined;
    let promptTimedOut = false;
    try {
      const tf = (await import('node-llama-cpp')) as typeof import('node-llama-cpp');
      const { LlamaChatSession } = tf;
      const { model, context } = await this.ensureLoaded(modelPath);
      const sequence = (context as { getSequence(): { dispose?: () => void } }).getSequence();
      const session = new LlamaChatSession({
        contextSequence: sequence as never,
        systemPrompt: collectSystemPrompt(request.messages),
      });

      // Prior assistant/user turns get fed into the session in order so
      // the model sees the conversation history. The trailing user turn
      // is what we ask `prompt()` to respond to.
      const turns = nonSystemTurns(request.messages);
      for (let i = 0; i < turns.length - 1; i += 1) {
        const turn = turns[i]!;
        if (turn.role === AiMessageRole.Assistant) {
          // node-llama-cpp 3.x exposes session.addAssistantMessage in some
          // versions; older versions don't. Best effort: skip silently.
          const fn = (session as unknown as { addAssistantMessage?: (s: string) => void }).addAssistantMessage;
          if (typeof fn === 'function') fn.call(session, turn.content);
          continue;
        }
        // For user turns that aren't the trailing one, prime them so the
        // assistant response gets folded back into the context too.
        await session.prompt(turn.content, {
          maxTokens: 1,
          stopOnAbortSignal: true,
        });
      }
      const lastUser = turns[turns.length - 1];
      const userPrompt = lastUser && lastUser.role === AiMessageRole.User ? lastUser.content : '';

      const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
      const wantsJson = !!request.responseFormat;
      // When the caller wants JSON, ask llama.cpp to enforce it at
      // sample time via a grammar. This eliminates a whole class of
      // parse failures (preamble prose, trailing markdown, runaway
      // continuation) that small models routinely produce. Best effort:
      // if the grammar constructor isn't available in this version we
      // fall back to plain prompting + trim.
      let grammar: unknown = undefined;
      if (wantsJson) {
        try {
          const Ctor = (tf as { LlamaJsonSchemaGrammar?: new (llama: unknown, schema: unknown) => unknown; LlamaGrammar?: new (llama: unknown, opts: { grammar: string }) => unknown }).LlamaJsonSchemaGrammar;
          // CRITICAL: pass the *same* Llama instance the model was
          // loaded with. node-llama-cpp rejects mixing grammars from
          // one instance with a session from another ("The
          // LlamaGrammar … was created with a different Llama
          // instance"). Calling getLlama() again would also leak a
          // second native Metal device, which then crashes the
          // process on exit (`ggml_metal_device_free`).
          const sharedLlama = sharedLlamaState?.llama;
          if (Ctor && request.responseFormat?.schema && sharedLlama) {
            grammar = new Ctor(sharedLlama, request.responseFormat.schema);
          }
        } catch {
          grammar = undefined;
        }
      }
      const start = Date.now();
      const onChunk = request.onTokenStream;
      // Per-call wall-clock timeout: abort the decode if it overruns so a
      // slow model can't hang the command. node-llama-cpp honours an
      // AbortSignal when `stopOnAbortSignal` is set.
      const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        promptAbort = new AbortController();
        promptTimer = setTimeout(() => {
          promptTimedOut = true;
          promptAbort?.abort();
        }, timeoutMs);
      }
      const text = await session.prompt(userPrompt, {
        maxTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(wantsJson ? { trimWhitespaceSuffix: true } : {}),
        ...(grammar ? { grammar: grammar as never } : {}),
        ...(promptAbort ? { signal: promptAbort.signal, stopOnAbortSignal: true } : {}),
        ...(onChunk
          ? {
              onTextChunk: (chunk: string) => {
                try {
                  onChunk(chunk);
                } catch {
                  // never let a callback failure break inference
                }
              },
            }
          : {}),
      });
      const elapsedMs = Date.now() - start;
      // Release the LlamaContext sequence so the next send() can take it.
      // Without this we hit "No sequences left" on the second call. The
      // LlamaModel + LlamaContext themselves stay loaded across calls.
      const sessionDisposable = session as unknown as { dispose?: () => void };
      if (typeof sessionDisposable.dispose === 'function') sessionDisposable.dispose();
      const seqDisposable = sequence as { dispose?: () => void };
      if (typeof seqDisposable.dispose === 'function') seqDisposable.dispose();
      return ok({
        content: text,
        model: nodePath.basename(modelPath),
        finishReason: 'stop',
        usage: {
          // node-llama-cpp does not surface input/output token counts in a
          // stable v3 API path; we leave usage undefined and let callers
          // approximate from char count if needed.
        },
        raw: { backend: 'node-llama-cpp', modelPath, elapsedMs },
      });
    } catch (e) {
      if (promptTimedOut) {
        return err(
          new AppErrorImpl(
            ERROR_CODES.TIMEOUT,
            `node-llama-cpp decode exceeded the per-call timeout and was aborted.`,
            {
              suggestion: 'The model is too slow for the budget. Try a smaller model, fewer --enhance-passes, or raise the budget.',
            },
          ),
        );
      }
      return err(
        new AppErrorImpl(
          ERROR_CODES.IO_ERROR,
          `node-llama-cpp call failed: ${(e as Error).message}`,
          {
            cause: e,
            suggestion: 'Verify LLAMACPP_MODEL_PATH points to a valid .gguf file readable by llama.cpp.',
          },
        ),
      );
    } finally {
      if (promptTimer) clearTimeout(promptTimer);
    }
  }

  private async ensureLoaded(modelPath: string): Promise<{ model: unknown; context: unknown }> {
    // Cached at MODULE scope so the disposer can find it on process
    // exit. (Per-instance caching used to live here, but the disposer
    // doesn't know which provider instance to ask.)
    if (sharedLlamaState && sharedLlamaState.modelPath === modelPath) {
      return { model: sharedLlamaState.model, context: sharedLlamaState.context };
    }
    if (sharedLlamaState) {
      // Different model requested — tear down the old one before
      // loading a new one. Best-effort; failures are tolerated.
      await disposeLlamaCppRuntime();
    }
    const { getLlama } = (await import('node-llama-cpp')) as typeof import('node-llama-cpp');
    const llama = await getLlama({
      gpu: resolveGpuChoice(this.config.baseUrl),
    });
    const model = await llama.loadModel({ modelPath });
    const contextSize = Number.isFinite(this.config.timeoutMs)
      ? DEFAULT_CONTEXT_SIZE
      : Number(process.env.LLAMACPP_CONTEXT_SIZE ?? DEFAULT_CONTEXT_SIZE);
    const context = await model.createContext({ contextSize });
    sharedLlamaState = { llama, model, context, modelPath };
    return { model, context };
  }
}

interface ISharedLlamaState {
  llama: unknown;
  model: unknown;
  context: unknown;
  modelPath: string;
}

let sharedLlamaState: ISharedLlamaState | null = null;

/**
 * Release the loaded llama.cpp model + context so the process can
 * exit cleanly.
 *
 * Without this, the libc++ destructor for the Metal device list
 * aborts on `exit()` with `ggml_metal_device_free` because the
 * device list isn't empty — same shape of teardown crash as the
 * ONNX mutex issue, different native library. Disposing in the
 * order session → context → model → llama lets the destructors
 * run while the JS runtime is still healthy.
 *
 * Safe to call multiple times. Safe to call when no model was
 * loaded. Errors during dispose are swallowed (the alternative is
 * the abort we're trying to prevent).
 */
export async function disposeLlamaCppRuntime(): Promise<boolean> {
  const state = sharedLlamaState;
  sharedLlamaState = null;
  if (!state) return false;
  // Context first — it holds the sequence pool that depends on the model.
  await callMaybeDispose(state.context);
  // Then the model, which depends on the llama runtime.
  await callMaybeDispose(state.model);
  // Finally the Llama instance itself (releases the Metal device).
  await callMaybeDispose(state.llama);
  // libggml/Metal was loaded — even after disposing, this Node version still
  // runs the native static destructor during `exit()` and it can abort with a
  // GGML backtrace. The caller redirects fd 2 to a log file to contain it.
  return true;
}

async function callMaybeDispose(target: unknown): Promise<void> {
  if (!target || typeof target !== 'object') return;
  const maybe = target as { dispose?: () => unknown };
  if (typeof maybe.dispose !== 'function') return;
  try {
    const r = maybe.dispose();
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      await (r as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // ignore
  }
}

function resolveModelPath(explicit: string | undefined): string | null {
  const envPath = process.env.LLAMACPP_MODEL_PATH;
  const candidate = explicit && explicit.length > 0 ? explicit : envPath;
  if (!candidate) return null;
  if (nodePath.isAbsolute(candidate)) {
    return existsSync(candidate) ? candidate : null;
  }
  const fromCwd = nodePath.resolve(process.cwd(), candidate);
  return existsSync(fromCwd) ? fromCwd : null;
}

function resolveGpuChoice(_baseUrl: string | undefined): 'auto' | 'metal' | 'cuda' | false {
  const choice = (process.env.LLAMACPP_GPU ?? 'auto').trim().toLowerCase();
  if (choice === 'metal') return 'metal';
  if (choice === 'cuda') return 'cuda';
  if (choice === 'off' || choice === 'false' || choice === 'no' || choice === 'cpu') return false;
  return 'auto';
}

function collectSystemPrompt(messages: readonly IAiMessage[]): string {
  const parts = messages.filter((m) => m.role === AiMessageRole.System).map((m) => m.content);
  return parts.join('\n\n');
}

function nonSystemTurns(messages: readonly IAiMessage[]): readonly IAiMessage[] {
  return messages.filter((m) => m.role !== AiMessageRole.System);
}
