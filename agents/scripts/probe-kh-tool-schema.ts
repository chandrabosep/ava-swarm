// Pull the input schema for KeeperHub MCP tools — useful when we're
// guessing at field names like "network: 'ethereum-sepolia'" and need
// to know what's actually accepted.
//
// Run: npx tsx scripts/probe-kh-tool-schema.ts execute_transfer
//      npx tsx scripts/probe-kh-tool-schema.ts execute_contract_call

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

import {
  listKeeperhubTools,
  callKeeperhubTool,
} from '../executor/src/keeperhub-mcp.js';

const NAME = process.argv[2];

async function main() {
  const tools = await listKeeperhubTools();
  if (!NAME) {
    console.log('Available KeeperHub tools:');
    for (const t of tools) {
      console.log(`  - ${t.name}: ${t.description ?? ''}`);
    }
    console.log('\nRun again with: npx tsx scripts/probe-kh-tool-schema.ts <tool-name>');
    return;
  }
  const tool = tools.find((t) => t.name === NAME);
  if (!tool) {
    console.error(`Tool "${NAME}" not found.`);
    process.exit(1);
  }
  console.log(`=== ${tool.name} ===`);
  console.log(`description: ${tool.description ?? '(none)'}`);
  console.log('inputSchema:');
  console.log(JSON.stringify(tool.inputSchema, null, 2));

  // Also try tools_documentation for any extra context.
  console.log('\n=== tools_documentation ===');
  const doc = await callKeeperhubTool('tools_documentation', { tool: NAME }).catch(
    (err) => ({ isError: true, content: [{ type: 'text', text: err.message }] }),
  );
  console.log(JSON.stringify(doc, null, 2).slice(0, 4000));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
