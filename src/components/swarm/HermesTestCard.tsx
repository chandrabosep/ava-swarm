// Hermes connectivity smoke test.
//
// One-button card that pings the configured Hermes endpoint with a
// one-token completion. Surfaces latency + sample reply on success,
// or upstream status + error on failure. The actionable outcomes:
//   - HERMES_API_KEY missing on the server (400)
//   - Endpoint unreachable / timeout (502 + AbortError)
//   - Auth rejected (502 + 401/403 from upstream)
//   - All green (200 + sample reply)
//
// Orthogonal to the skill connector: a skill is *what* the LLM can
// do; Hermes config is *which* LLM. Lives in its own card so the user
// can verify provider health without reading skills state.

import { useMutation } from '@tanstack/react-query';

import { Surface } from '@/components/common/Surface';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { testHermes, type HermesTestResult } from '@/lib/agents-api';

export function HermesTestCard() {
  const probe = useMutation<HermesTestResult>({ mutationFn: testHermes });
  const result = probe.data;

  return (
    <Surface variant="raised" className="px-4 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold tracking-tight">Hermes provider</h3>
        {result?.ok && <Badge tone="positive" dot>reachable</Badge>}
        {result && !result.ok && <Badge tone="negative" dot>failed</Badge>}
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          onClick={() => probe.mutate()}
          disabled={probe.isPending}
        >
          {probe.isPending ? 'pinging…' : 'Test Hermes'}
        </Button>
      </div>

      <div className="text-[11px] text-fg-muted leading-relaxed">
        Sends one zero-temp completion to the configured endpoint to
        verify <span className="font-mono">HERMES_API_KEY</span>,{' '}
        <span className="font-mono">HERMES_BASE_URL</span>, and{' '}
        <span className="font-mono">HERMES_MODEL</span> are wired.
      </div>

      {result && (
        <div
          className={[
            'text-[11px] rounded px-2 py-1.5 border',
            result.ok
              ? 'text-positive border-positive/30 bg-positive/5'
              : 'text-negative border-negative/30 bg-negative/10',
          ].join(' ')}
        >
          {result.ok ? (
            <>
              <span className="font-mono">{result.model}</span> replied{' '}
              <span className="font-mono">"{result.sample ?? ''}"</span> in{' '}
              {result.latencyMs}ms.
            </>
          ) : (
            <>
              <span className="font-semibold">
                {result.status ? `${result.status} ` : ''}failed:
              </span>{' '}
              <span className="font-mono">
                {result.error ?? 'unknown error'}
              </span>
              {result.hint && (
                <div className="mt-0.5 text-fg-muted">{result.hint}</div>
              )}
            </>
          )}
        </div>
      )}

      {probe.error && !result && (
        <div className="text-[11px] text-negative">
          {probe.error instanceof Error ? probe.error.message : String(probe.error)}
        </div>
      )}
    </Surface>
  );
}
