import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Importing this for its side effects: createAppKit() registers the
// <appkit-button /> custom element and configures the modal.
import { wagmiConfig } from '@/config/appkit';

import App from './App';
import './index.css';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* reconnectOnMount={false}: extension new-tab pages get a fresh
        document each time, and a previous WalletConnect session's relay
        socket doesn't survive that. Auto-reconnect leaves wagmi stuck in
        `reconnecting` forever. Better to start disconnected and let the
        user reconnect on click. */}
    <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
