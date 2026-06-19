import NewTab from '@/pages/NewTab';
import { useAuthSigner } from '@/hooks/useAuthSigner';

export default function App() {
  // Bridge wagmi's signer into the agents-api auth header. Has to live
  // inside WagmiProvider (mounted in main.tsx).
  useAuthSigner();
  return <NewTab />;
}
