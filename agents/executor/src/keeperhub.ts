// KeeperHub client.
//
// KeeperHub is the execution & reliability layer — once we hand it a
// signed UserOp (or raw calldata + signing instructions), it handles
// retries, gas optimization, MEV protection, and gives us a job id to
// poll for status. Way nicer than maintaining our own retry loop.
//
// Two surface options per their docs:
//   - HTTP API:  https://docs.keeperhub.com/api
//   - MCP server: https://docs.keeperhub.com/ai-tools
//
// We use the HTTP API here because we're inside a Node service, not an
// LLM tool-calling loop. (PM might use the MCP server later for
// research-style operations.)
//
// Auth: bearer token (the KEEPERHUB_API_KEY env var).

import { env } from '@swarm/shared';

const CHAIN_ID = { mainnet: 1, base: 8453, unichain: 130 } as const;

export type ChainName = keyof typeof CHAIN_ID;

export interface SubmitJobRequest {
  /** Target chain. */
  chain: ChainName;
  /** Address to call (Universal Router for our use). */
  to: `0x${string}`;
  /** Calldata. */
  data: `0x${string}`;
  /** Wei value to attach (string, not bigint, for JSON safety). */
  value: string;
  /**
   * Where to fund the gas from. For us this is the user's Safe address —
   * KeeperHub builds + submits the ERC-4337 UserOp on its behalf.
   */
  smartAccount: `0x${string}`;
  /** Session-key signature over the UserOp hash. */
  signature: `0x${string}`;
  /** Optional metadata — gets stored against the job for audit. */
  metadata?: Record<string, unknown>;
}

export interface JobStatus {
  jobId: string;
  status: 'pending' | 'submitted' | 'mined' | 'failed' | 'replaced';
  txHash?: `0x${string}`;
  blockNumber?: number;
  error?: string;
}

async function kh<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${env.keeperhubBaseUrl()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.keeperhubApiKey()}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`KeeperHub ${path} ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function submitJob(
  req: SubmitJobRequest,
): Promise<{ jobId: string }> {
  return kh<{ jobId: string }>('/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({
      chainId: CHAIN_ID[req.chain],
      smartAccount: req.smartAccount,
      to: req.to,
      data: req.data,
      value: req.value,
      signature: req.signature,
      metadata: req.metadata,
    }),
  });
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  return kh<JobStatus>(`/v1/jobs/${jobId}`);
}

/**
 * Poll until the job reaches a terminal state, or the deadline elapses.
 * Returns the final status; throws on timeout.
 */
export async function waitForJob(
  jobId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<JobStatus> {
  const { timeoutMs = 90_000, pollMs = 2_000 } = opts;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getJobStatus(jobId);
    if (
      status.status === 'mined' ||
      status.status === 'failed' ||
      status.status === 'replaced'
    ) {
      return status;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`KeeperHub job ${jobId} did not finalize within ${timeoutMs}ms`);
}
