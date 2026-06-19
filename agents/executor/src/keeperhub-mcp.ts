// KeeperHub MCP client.
//
// KeeperHub exposes its execution surface over MCP (Model Context
// Protocol) at https://app.keeperhub.com/mcp — agents connect as MCP
// clients and call tools (submit-execution, get-status, etc.) instead
// of hitting a REST API.
//
// We initialize one shared client at module load and reuse it across
// every Executor invocation. Auth: bearer token in the HTTP transport
// init.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { env } from '@swarm/shared';

let clientPromise: Promise<Client> | null = null;

export async function keeperhubClient(): Promise<Client> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    // The REST base URL is `https://app.keeperhub.com/api` but the MCP
    // endpoint sits at the host root `/mcp`. Override with
    // KEEPERHUB_MCP_URL if a different host is needed.
    const mcpUrl =
      process.env.KEEPERHUB_MCP_URL ??
      'https://app.keeperhub.com/mcp';
    const url = new URL(mcpUrl);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          authorization: `Bearer ${env.keeperhubApiKey()}`,
        },
      },
    });
    const client = new Client(
      { name: 'defi-swarm-executor', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  })();
  return clientPromise;
}

/**
 * One-shot helper: list the tools KeeperHub's MCP exposes. Useful at
 * boot to confirm we're talking to the right server and to record the
 * exact tool name we'll call for execution.
 */
export async function listKeeperhubTools(): Promise<
  Array<{ name: string; description?: string }>
> {
  const c = await keeperhubClient();
  const res = await c.listTools();
  return res.tools.map((t) => ({ name: t.name, description: t.description }));
}

export async function callKeeperhubTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const c = await keeperhubClient();
  const res = await c.callTool({ name, arguments: args });
  return res;
}
