import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, type Query } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';

// Importing this for its side effects: createAppKit() registers the
// <appkit-button /> custom element and configures the modal.
import { wagmiConfig } from '@/config/appkit';

import App from './App';
import './index.css';

const FIVE_MIN = 5 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

// Conservative defaults — Zerion's Demo plan caps at 300 requests/day, so
// we lean hard on the cache. Every query is fresh for 5 minutes (no refetch
// during that window) and the cached payload itself sticks around for a
// day. With persistent storage on top, reloading a new tab inside 5 min
// reads straight from localStorage — zero API calls.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: FIVE_MIN,
      gcTime: ONE_DAY,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: false,
    },
  },
});

const persister = createSyncStoragePersister({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  key: 'defi-swarm-rq-cache',
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* reconnectOnMount={true}: try to restore a previous wallet session on
        every new tab. WalletButton handles the reconnecting state if it
        hangs (clickable Connect override after a few seconds). */}
    <WagmiProvider config={wagmiConfig} reconnectOnMount>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          // Only persist Zerion queries — wagmi/AppKit transient state
          // doesn't need to live in localStorage.
          dehydrateOptions: {
            shouldDehydrateQuery: (query: Query) =>
              query.state.status === 'success' &&
              query.queryKey[0] === 'zerion',
          },
          // Bump this if the persisted cache shape ever changes (e.g.
          // breaking changes to Zerion response types) so old payloads
          // get evicted on first load.
          buster: 'v1',
        }}
      >
        <App />
      </PersistQueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
