import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';

export interface StartHttpServerOptions {
  /** McpServer (NOT yet connected). */
  server: McpServer;
  /** Bind host. Default 'localhost'. */
  host?: string;
  /** Bind port. Default 4000. */
  port?: number;
  /** Path that accepts MCP traffic. Default '/mcp'. */
  path?: string;
  /**
   * Stateful by default — the transport generates a session id and clients
   * must echo it. Set false for stateless mode.
   */
  stateful?: boolean;
  /** stderr logger. */
  log?: (line: string) => void;
}

export interface HttpServerHandle {
  url: string;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<HttpServerHandle> {
  const host = options.host ?? 'localhost';
  const port = options.port ?? 4000;
  const path = options.path ?? '/mcp';
  const stateful = options.stateful ?? true;
  const log = options.log ?? (() => undefined);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: stateful ? () => randomUUID() : undefined,
  });
  await options.server.connect(transport);

  const http: HttpServer = createServer(async (req, res) => {
    if (!req.url) {
      writeJson(res, 400, { error: 'missing url' });
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      writeJson(res, 200, { ok: true, transport: 'streamable-http', stateful });
      return;
    }
    const url = new URL(req.url, `http://${host}:${port}`);
    if (url.pathname !== path) {
      writeJson(res, 404, { error: `not found: ${url.pathname}` });
      return;
    }
    try {
      const parsedBody = req.method === 'POST' ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, parsedBody);
    } catch (e) {
      log(`[mcp:http] handleRequest threw: ${(e as Error).message}`);
      if (!res.headersSent) {
        writeJson(res, 500, { error: (e as Error).message });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve) => http.listen(port, host, resolve));
  log(`[mcp:http] listening on http://${host}:${port}${path} (stateful=${stateful})`);

  return {
    url: `http://${host}:${port}${path}`,
    close: async () => {
      await transport.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        http.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
