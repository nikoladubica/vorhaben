#!/usr/bin/env node
// Entry point for the vorhaben MCP server.
//
// Transport is stdio only (v1): the JSON-RPC protocol owns stdout, so ALL logging here goes to
// stderr — never console.log, or we would corrupt the protocol stream.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { VorhabenClient } from './apiClient.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new VorhabenClient(config);
  const server = buildServer(client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`vorhaben MCP server ready (API: ${config.apiUrl})`);
}

main().catch((err: unknown) => {
  console.error('vorhaben MCP server failed to start:', err);
  process.exit(1);
});
