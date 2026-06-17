// Bun test preload — runs once before the test suite (wired via bunfig.toml
// `[test] preload`). Bun automatically loads `.env` into `process.env` at
// startup, so a developer whose `.env` points `LLAMACPP_MODEL_PATH` at a real
// `.gguf` (or `OLLAMA_HOST` at a live daemon) would otherwise have tests load a
// multi-GB model into the test process. On macOS that loads a native Metal
// device, and llama.cpp then aborts inside its static destructor on `exit()`
// (`GGML_ASSERT([rsets->data count] == 0)` in `ggml_metal_device_free`) — see
// node-llama-cpp / ggml PR #17869. That SIGABRT corrupts the runner's exit code
// even when every test passed, which silently breaks `release:preflight`.
//
// Scrubbing the LLM provider/model env here keeps `bun test` hermetic and
// deterministic on any machine, regardless of the developer's local `.env`.
// The engine is local-LLM-optional by design: with no model configured every
// provider degrades gracefully, which is exactly the behaviour the suite
// already asserts. Tests that exercise provider/model behaviour set (and
// restore) their own env explicitly, so clearing the inherited values is safe.
const LLM_ENV_KEYS = [
  'AI_PROVIDER',
  'LLAMACPP_MODEL_PATH',
  'LLAMACPP_CONTEXT_SIZE',
  'LLAMACPP_GPU',
  'OLLAMA_HOST',
  'OLLAMA_PORT',
  'OLLAMA_MODEL',
] as const;

for (const key of LLM_ENV_KEYS) {
  delete process.env[key];
}
