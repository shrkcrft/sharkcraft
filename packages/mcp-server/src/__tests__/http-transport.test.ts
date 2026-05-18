import { describe, expect, test } from 'bun:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { startHttpServer } from '../server/http-transport.ts';

describe('startHttpServer', () => {
  test('binds to a port and answers /healthz', async () => {
    const server = new Server(
      { name: 'sharkcraft-test', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    // Use port 0 → kernel-assigned. We can't read it back through the SDK's
    // transport easily, so probe a known small port that the host should have free.
    // Pin to 4321 to keep the test deterministic. If the port is busy on this
    // machine the test will fail loudly; the CI runner is fresh enough that
    // it's a safe assumption.
    const handle = await startHttpServer({ server, port: 4321 });
    try {
      const res = await fetch('http://localhost:4321/healthz');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; transport: string };
      expect(body.ok).toBe(true);
      expect(body.transport).toBe('streamable-http');
    } finally {
      await handle.close();
    }
  });

  test('returns 404 for unknown paths', async () => {
    const server = new Server(
      { name: 'sharkcraft-test', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    const handle = await startHttpServer({ server, port: 4322 });
    try {
      const res = await fetch('http://localhost:4322/something-else');
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});
