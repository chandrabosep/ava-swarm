// Ask KeeperHub for the status of a specific execution. Useful when
// our local logs only show "wrap failed" but we want KH's actual
// error message (wrong network identifier, no funds, reverted tx, etc).
//
// Run: npx tsx scripts/probe-kh-execution.ts <executionId>

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

import { callKeeperhubTool } from '../executor/src/keeperhub-mcp.js';

const ID = process.argv[2];
if (!ID) {
  console.error('Usage: npx tsx scripts/probe-kh-execution.ts <executionId>');
  process.exit(1);
}

async function main() {
  console.log(`Probing execution ${ID}\n`);

  // 1. Direct execution status (the same call our wait loop uses).
  const status = await callKeeperhubTool('get_direct_execution_status', {
    execution_id: ID,
  });
  console.log('=== get_direct_execution_status ===');
  console.log(JSON.stringify(status, null, 2));
  console.log();

  // 2. Execution logs (verbose — KH usually has a multi-step trace).
  const logs = await callKeeperhubTool('get_execution_logs', {
    execution_id: ID,
  }).catch((err) => ({
    isError: true,
    content: [{ type: 'text', text: err.message }],
  }));
  console.log('=== get_execution_logs ===');
  console.log(JSON.stringify(logs, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
