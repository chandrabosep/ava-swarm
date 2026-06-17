// Centralized env access. Throws clear errors at boot if a required var is
// missing, so we don't crash mid-tick with an opaque message.

const required = (name: string): string => {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `[env] ${name} is not set. See agents/.env.example for the full list.`,
    );
  }
  return v;
};

const optional = (name: string, fallback?: string): string | undefined =>
  process.env[name] ?? fallback;

export const env = {
  // DB
  databaseUrl: () => required('DATABASE_URL'),
  directUrl: () => required('DIRECT_URL'),

  // AXL — each agent picks its own slot
  axlEndpoint: (agent: 'pm' | 'alm' | 'router' | 'executor'): string => {
    const map = {
      pm: 'AXL_PM_ENDPOINT',
      alm: 'AXL_ALM_ENDPOINT',
      router: 'AXL_ROUTER_ENDPOINT',
      executor: 'AXL_EXECUTOR_ENDPOINT',
    } as const;
    return required(map[agent]);
  },

  // (Removed) AGENT_PRIVKEY_ENCRYPTION_KEY — used in Model A for per-user
  // privkey encryption. Model B uses a single service keypair per agent
  // (see PM_SERVICE_PRIVKEY etc. and src/keys.ts).

  // Onchain RPCs
  rpc: (chain: 'mainnet' | 'base' | 'unichain'): string =>
    required(`RPC_${chain.toUpperCase()}`),

  // Sponsor APIs
  keeperhubApiKey: () => required('KEEPERHUB_API_KEY'),
  keeperhubBaseUrl: () => optional('KEEPERHUB_BASE_URL', 'https://api.keeperhub.com')!,
  uniswapApiKey: () => required('UNISWAP_API_KEY'),
  uniswapBaseUrl: () =>
    optional('UNISWAP_API_BASE', 'https://trade-api.gateway.uniswap.org/v1')!,
  pimlicoApiKey: () => optional('PIMLICO_API_KEY'),

  // PM / LLM — Kimi (Moonshot AI), OpenAI-compatible chat completions
  kimiApiKey: () => required('KIMI_API_KEY'),
  kimiModel: () => optional('KIMI_MODEL', 'kimi-k2-0905-preview')!,
  kimiBaseUrl: () => optional('KIMI_BASE_URL', 'https://api.moonshot.ai/v1')!,

  // Zerion
  zerionProxyUrl: () => required('ZERION_PROXY_URL'),
};
