// Wire the tool definitions into an MCP Server over the low-level request-handler API.
//
// We use the low-level Server (not the higher-level McpServer helper) on purpose: it lets us
// declare each tool's inputSchema as plain JSON Schema, so the workspace needs no schema library
// and @modelcontextprotocol/sdk stays the single new dependency (ticket 17 constraint).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { VorhabenClient } from './apiClient.js';
import { ApiError } from './apiClient.js';
import { tools } from './tools.js';

/** Turn any thrown error into a message the model can act on (esp. a 422 field map). */
function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    return `API error ${err.status} on ${err.method} ${err.path}: ${JSON.stringify(err.body)}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function buildServer(client: VorhabenClient): Server {
  const server = new Server(
    { name: 'vorhaben', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t): Tool => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Tool['inputSchema'],
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
      };
    }

    try {
      const result = await tool.handler(client, request.params.arguments ?? {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text' as const, text: formatError(err) }] };
    }
  });

  return server;
}
