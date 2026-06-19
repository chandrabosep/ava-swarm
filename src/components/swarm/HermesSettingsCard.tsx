// Hermes / LLM provider settings.
//
// Paste a Nous Portal (or any OpenAI-compatible) API key + an optional
// "skill" — free-form guidance text appended to PM's system prompt — and
// the swarm starts using Hermes for allocation decisions on the next
// PM tick. No env vars, no agent restart.
//
// The server stores the key in plaintext in the swarm_settings row
// (same trust level as agents/.env on the host) and never echoes it back
// in full — GET responses only expose the last 4 chars for recognition.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import {
  getHermesSettings,
  setHermesSettings,
  type HermesSettings,
  type HermesSettingsPatch,
} from '@/lib/agents-api';

const DEFAULT_BASE_URL = 'https://inference-api.nousresearch.com/v1';
const DEFAULT_MODEL = 'Hermes-4-405B';

export function HermesSettingsCard() {
  const qc = useQueryClient();

  const settings = useQuery<HermesSettings>({
    queryKey: ['hermes-settings'],
    queryFn: getHermesSettings,
    refetchOnWindowFocus: false,
  });

  // Local form state — initialized from server state, then user-controlled.
  // We deliberately don't pre-fill the API key field (server doesn't return
  // it) and instead show "•••• <tail>" as placeholder text when one exists.
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [skill, setSkill] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) {
      setEnabled(settings.data.enabled);
      setModel(settings.data.model ?? '');
      setBaseUrl(settings.data.baseUrl ?? '');
      setSkill(settings.data.skill ?? '');
    }
  }, [settings.data]);

  const placeholder = useMemo(() => {
    if (settings.data?.hasKey && settings.data.keyTail) {
      return `•••• saved (ends in ${settings.data.keyTail}) — paste a new key to replace`;
    }
    return 'sk-... or your Nous Portal key';
  }, [settings.data]);

  const save = useMutation({
    mutationFn: async (patch: HermesSettingsPatch) => {
      setError(null);
      return setHermesSettings(patch);
    },
    onSuccess: (next) => {
      // Wipe the API key field after a successful save — the server now
      // has it and we don't want it sitting in DOM state across page loads.
      setApiKey('');
      qc.setQueryData(['hermes-settings'], next);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  const handleSave = () => {
    const patch: HermesSettingsPatch = {
      enabled,
      // Only send the key if the user typed something — empty string means
      // "leave the saved key alone".
      ...(apiKey.length > 0 ? { apiKey } : {}),
      model: model.trim().length > 0 ? model.trim() : null,
      baseUrl: baseUrl.trim().length > 0 ? baseUrl.trim() : null,
      skill: skill.trim().length > 0 ? skill : null,
    };
    save.mutate(patch);
  };

  const handleClearKey = () => {
    save.mutate({ enabled: false, clearKey: true });
  };

  const isActive = settings.data?.enabled && settings.data.hasKey;
  const canEnable = enabled && (settings.data?.hasKey || apiKey.length > 0);

  return (
    <Surface className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Hermes</h2>
          <p className="mt-1 text-xs text-fg-muted leading-relaxed max-w-xl">
            Drop in a Nous Research API key (or any OpenAI-compatible
            Hermes endpoint) and the Portfolio Manager uses Hermes
            instead of Groq on the next tick. Optional skill text is
            appended to PM's system prompt.
          </p>
        </div>
        <Badge tone={isActive ? 'positive' : 'neutral'}>
          {isActive ? 'active' : 'inactive'}
        </Badge>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="text-[11px] uppercase tracking-wider text-fg-subtle">
            API key
          </span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={placeholder}
            className="mt-1 w-full rounded-md border border-border-subtle bg-bg-raised px-3 py-2 text-sm font-mono placeholder:text-fg-subtle focus:outline-none focus:border-accent"
          />
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-fg-subtle">
              Model
            </span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={DEFAULT_MODEL}
              className="mt-1 w-full rounded-md border border-border-subtle bg-bg-raised px-3 py-2 text-sm font-mono placeholder:text-fg-subtle focus:outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-fg-subtle">
              Base URL
            </span>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={DEFAULT_BASE_URL}
              className="mt-1 w-full rounded-md border border-border-subtle bg-bg-raised px-3 py-2 text-sm font-mono placeholder:text-fg-subtle focus:outline-none focus:border-accent"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wider text-fg-subtle">
            Skill (optional)
          </span>
          <textarea
            value={skill}
            onChange={(e) => setSkill(e.target.value)}
            rows={6}
            placeholder={`Free-form guidance appended to PM's system prompt.\nExample:\n  - Lean defensive when 24h ETH move > +8%.\n  - Never let UNI exceed 15% of book.\n  - Cite the rationale field with a 1-line market read.`}
            className="mt-1 w-full rounded-md border border-border-subtle bg-bg-raised px-3 py-2 text-xs font-mono placeholder:text-fg-subtle focus:outline-none focus:border-accent resize-y"
          />
        </label>

        <label className="flex items-center gap-2 select-none">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-border-subtle bg-bg-raised text-accent focus:ring-accent"
          />
          <span className="text-sm text-fg">
            Use Hermes for PM decisions
          </span>
          {enabled && !canEnable && (
            <span className="text-[11px] text-warning ml-2">
              paste a key first
            </span>
          )}
        </label>
      </div>

      {error && (
        <div className="text-xs text-negative bg-negative/10 border border-negative/30 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={save.isPending || (enabled && !canEnable)}
        >
          {save.isPending ? 'saving…' : 'Save'}
        </Button>
        {settings.data?.hasKey && (
          <Button
            variant="ghost"
            onClick={handleClearKey}
            disabled={save.isPending}
          >
            Clear key
          </Button>
        )}
        {settings.data?.updatedAt && (
          <span className="text-[10px] text-fg-subtle ml-auto">
            updated {new Date(settings.data.updatedAt).toLocaleString()}
          </span>
        )}
      </div>
    </Surface>
  );
}
