// Skill connector — Hermes-style.
//
// Three-step install ceremony, modeled on the polish of Moltbook's own
// onboarding (https://www.moltbook.com/skill.md):
//
//   1. PASTE  — drop a SKILL.md into the textarea. We send it to the
//      server, the server parses the YAML frontmatter, and the UI flips
//      to "detected: <name> v<version>".
//   2. KEY    — paste the API key for whatever service the skill targets.
//      Stored server-side, never echoed back (we only see `keyTail`).
//   3. DONE   — installed. The user's Hermes (or a future swarm worker)
//      can now act on the skill using the stored key.
//
// The api_key is service-scoped per the skill's own security guidance:
// it should ONLY ever leave the agents/api server in Authorization
// headers to that service's domain. Never embed it in an LLM prompt.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Surface } from '@/components/common/Surface';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import {
  clearSkill,
  getSkill,
  setSkill,
  testHermes,
  type SkillState,
  type SkillPatch,
  type HermesTestResult,
} from '@/lib/agents-api';

type Phase = 'paste-skill' | 'paste-key' | 'installed';

function phaseFor(s: SkillState | undefined): Phase {
  if (!s) return 'paste-skill';
  if (!s.hasSkill) return 'paste-skill';
  if (!s.hasKey) return 'paste-key';
  return 'installed';
}

function StepDot({ n, label, active, done }: {
  n: number; label: string; active: boolean; done: boolean;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span
        className={[
          'h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-semibold border transition-colors',
          done
            ? 'bg-positive/15 border-positive/40 text-positive'
            : active
              ? 'bg-accent/15 border-accent/50 text-accent'
              : 'bg-bg-raised border-border-subtle text-fg-subtle',
        ].join(' ')}
      >
        {done ? '✓' : n}
      </span>
      <span
        className={[
          'text-xs truncate',
          active || done ? 'text-fg' : 'text-fg-subtle',
        ].join(' ')}
      >
        {label}
      </span>
    </div>
  );
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}h ago`;
  return `${Math.floor(ms / (24 * 60 * 60_000))}d ago`;
}

/** Quickly peek at frontmatter before sending to the server, for instant UI feedback. */
function peekFrontmatter(content: string): {
  name: string | null;
  version: string | null;
  description: string | null;
} {
  const out = { name: null as string | null, version: null as string | null, description: null as string | null };
  const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|version|description)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    let val = kv[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    (out as Record<string, string>)[kv[1]] = val;
  }
  return out;
}

export function SkillConnectorCard() {
  const qc = useQueryClient();

  const skill = useQuery<SkillState>({
    queryKey: ['skill'],
    queryFn: getSkill,
    refetchOnWindowFocus: false,
  });

  const phase = phaseFor(skill.data);

  // ----- step 1: paste skill -----
  const [draftContent, setDraftContent] = useState('');
  const draftPeek = useMemo(
    () => (draftContent.length > 0 ? peekFrontmatter(draftContent) : null),
    [draftContent],
  );

  const installSkill = useMutation({
    mutationFn: (content: string) => setSkill({ content }),
    onSuccess: (next) => {
      qc.setQueryData(['skill'], next);
      setDraftContent('');
    },
  });

  // ----- step 2: paste key -----
  const [draftKey, setDraftKey] = useState('');
  const installKey = useMutation({
    mutationFn: (apiKey: string) => setSkill({ apiKey }),
    onSuccess: (next) => {
      qc.setQueryData(['skill'], next);
      setDraftKey('');
    },
  });

  // ----- step 3 / cleanup -----
  const replaceKey = useMutation({
    mutationFn: (patch: SkillPatch) => setSkill(patch),
    onSuccess: (next) => qc.setQueryData(['skill'], next),
  });
  const wipe = useMutation({
    mutationFn: clearSkill,
    onSuccess: () => {
      setDraftContent('');
      setDraftKey('');
      installSkill.reset();
      installKey.reset();
      void qc.invalidateQueries({ queryKey: ['skill'] });
    },
  });

  // Reset draft state if the underlying state changes from elsewhere.
  useEffect(() => {
    if (phase !== 'paste-skill') setDraftContent('');
    if (phase !== 'paste-key') setDraftKey('');
  }, [phase]);

  // Hermes smoke test — kept as a one-shot mutation so the result lingers
  // in `data` until the user clicks again or unmounts.
  const hermesTest = useMutation<HermesTestResult>({
    mutationFn: testHermes,
  });

  const headerBadge = useMemo(() => {
    if (phase === 'installed') {
      // "installed" is local — the more useful signal is whether the PM
      // is actually consuming the skill. `pmActive` rolls up provider +
      // content + key + ≥1 callable host into a single bool.
      if (skill.data?.pmActive) {
        return <Badge tone="positive" dot>live in PM</Badge>;
      }
      return <Badge tone="warning" dot>installed · idle</Badge>;
    }
    if (phase === 'paste-key')
      return <Badge tone="warning" dot>needs key</Badge>;
    return <Badge tone="neutral">no skill yet</Badge>;
  }, [phase, skill.data?.pmActive]);

  const detectedSummary =
    skill.data?.hasSkill && (skill.data.name || skill.data.version)
      ? `${skill.data.name ?? 'unnamed'}${skill.data.version ? ` v${skill.data.version}` : ''}`
      : null;

  return (
    <Surface className="p-5 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight flex items-center gap-2">
            <span aria-hidden className="text-base">🪝</span>
            Skill connector
          </h2>
          <p className="mt-1 text-xs text-fg-muted leading-relaxed max-w-xl">
            Paste a Hermes-style skill file (e.g.{' '}
            <a
              className="text-accent hover:underline"
              href="https://www.moltbook.com/skill.md"
              target="_blank"
              rel="noreferrer"
            >
              moltbook.com/skill.md
            </a>
            ) and the API key for the service it targets. The swarm stores both
            so your Hermes can act on the skill — keys go to the skill's
            domain only, never to anyone else.
          </p>
        </div>
        {headerBadge}
      </div>

      {/* Step rail */}
      <div className="flex items-center gap-3 sm:gap-6 overflow-x-auto pb-1">
        <StepDot
          n={1}
          label="Paste skill"
          active={phase === 'paste-skill'}
          done={phase !== 'paste-skill'}
        />
        <span className="h-px flex-1 bg-border-subtle min-w-[16px]" />
        <StepDot
          n={2}
          label="Paste API key"
          active={phase === 'paste-key'}
          done={phase === 'installed'}
        />
        <span className="h-px flex-1 bg-border-subtle min-w-[16px]" />
        <StepDot
          n={3}
          label="Installed"
          active={phase === 'installed'}
          done={phase === 'installed'}
        />
      </div>

      {/* ===== STEP 1: paste skill ===== */}
      {phase === 'paste-skill' && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-fg-subtle">
              Skill file (markdown)
            </span>
            <textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              placeholder={`---
name: moltbook
version: 1.12.0
description: The social network for AI agents.
---

# Moltbook
...paste the rest of the SKILL.md here...`}
              rows={10}
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-border-subtle bg-bg-raised px-3 py-2 text-xs font-mono placeholder:text-fg-subtle focus:outline-none focus:border-accent resize-y"
            />
          </label>

          {/* Live frontmatter peek */}
          {draftContent.length > 0 && (
            <div className="rounded-md border border-border-subtle bg-bg-raised px-3 py-2 text-[11px] flex items-center gap-3">
              <span className="text-fg-subtle uppercase tracking-wider">
                detected
              </span>
              {draftPeek?.name ? (
                <>
                  <span className="font-mono text-fg">{draftPeek.name}</span>
                  {draftPeek.version && (
                    <span className="font-mono text-fg-muted">
                      v{draftPeek.version}
                    </span>
                  )}
                  {draftPeek.description && (
                    <span className="text-fg-muted truncate">
                      — {draftPeek.description}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-warning">
                  no YAML frontmatter found — we'll still store it, but won't
                  know the skill's name/version
                </span>
              )}
            </div>
          )}

          {installSkill.error && (
            <div className="text-xs text-negative bg-negative/10 border border-negative/30 rounded-md px-3 py-2">
              {installSkill.error instanceof Error
                ? installSkill.error.message
                : String(installSkill.error)}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              onClick={() => installSkill.mutate(draftContent)}
              disabled={installSkill.isPending || draftContent.trim().length < 10}
            >
              {installSkill.isPending ? 'installing…' : 'Install skill'}
            </Button>
            <span className="text-[11px] text-fg-subtle">
              {draftContent.length.toLocaleString()} chars · stored in Postgres,
              never sent off-server
            </span>
          </div>
        </div>
      )}

      {/* ===== STEP 2: paste API key ===== */}
      {phase === 'paste-key' && skill.data && (
        <div className="space-y-3">
          <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs leading-relaxed">
            <div className="text-fg">
              <span className="font-semibold text-accent">skill installed:</span>{' '}
              <span className="font-mono">
                {skill.data.name ?? 'unnamed'}
              </span>
              {skill.data.version && (
                <span className="font-mono text-fg-muted">
                  {' '}v{skill.data.version}
                </span>
              )}
            </div>
            {skill.data.description && (
              <div className="mt-0.5 text-fg-muted">{skill.data.description}</div>
            )}
          </div>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-fg-subtle">
              API key for {skill.data.name ?? 'this skill'}
            </span>
            <input
              type="password"
              autoComplete="off"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              placeholder={`paste the API key issued by ${skill.data.name ?? 'the service'}`}
              className="mt-1 w-full rounded-md border border-border-subtle bg-bg-raised px-3 py-2 text-sm font-mono placeholder:text-fg-subtle focus:outline-none focus:border-accent"
            />
            <span className="mt-1 block text-[11px] text-fg-subtle">
              ⚠ this key is service-scoped — only ever sent to the skill's
              own domain, never to LLMs or other services.
            </span>
          </label>

          {installKey.error && (
            <div className="text-xs text-negative bg-negative/10 border border-negative/30 rounded-md px-3 py-2">
              {installKey.error instanceof Error
                ? installKey.error.message
                : String(installKey.error)}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              onClick={() => installKey.mutate(draftKey)}
              disabled={installKey.isPending || draftKey.trim().length < 4}
            >
              {installKey.isPending ? 'saving…' : 'Save key'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => wipe.mutate()}
              disabled={wipe.isPending}
            >
              Start over
            </Button>
          </div>
        </div>
      )}

      {/* ===== STEP 3: installed ===== */}
      {phase === 'installed' && skill.data && (
        <div className="space-y-4">
          <div
            className={[
              'rounded-md border px-3 py-2 text-xs leading-relaxed',
              skill.data.pmActive
                ? 'border-positive/30 bg-positive/5'
                : 'border-warning/30 bg-warning/5',
            ].join(' ')}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base">🪝</span>
              <span
                className={[
                  'font-semibold',
                  skill.data.pmActive ? 'text-positive' : 'text-warning',
                ].join(' ')}
              >
                {skill.data.pmActive
                  ? 'live in PM tick.'
                  : 'connector idle.'}
              </span>
              <span className="font-mono text-fg">
                {detectedSummary ?? 'unnamed skill'}
              </span>
              <span className="ml-auto text-[10px] text-fg-subtle">
                installed {relativeTime(skill.data.installedAt) ?? 'recently'}
              </span>
            </div>
            {skill.data.description && (
              <div className="mt-1 text-fg-muted">{skill.data.description}</div>
            )}
            {!skill.data.pmActive && (
              <div className="mt-2 text-[11px] text-fg-muted">
                {skill.data.llmProvider !== 'hermes' ? (
                  <>
                    PM is currently running on{' '}
                    <span className="font-mono">{skill.data.llmProvider}</span>.
                    Set <span className="font-mono">LLM_PROVIDER=hermes</span>{' '}
                    in <span className="font-mono">agents/.env</span> to let
                    PM consume this skill.
                  </>
                ) : skill.data.allowedHosts.length === 0 ? (
                  <>
                    No <span className="font-mono">https://</span> hosts found
                    in the skill markdown — the PM tool loop has nothing to
                    call. Re-paste a skill that mentions its API host(s).
                  </>
                ) : (
                  <>
                    Skill installed but PM hasn't picked it up — try the test
                    button below.
                  </>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              ['skill name', skill.data.name ?? '—'],
              ['version', skill.data.version ?? '—'],
              ['skill size', `${(skill.data.contentLength / 1024).toFixed(1)} KB`],
              [
                'api key',
                skill.data.keyTail ? `••••${skill.data.keyTail}` : '—',
              ],
              [
                'pm provider',
                skill.data.llmProvider === 'hermes'
                  ? `hermes · ${skill.data.hermesModel ?? '?'}`
                  : skill.data.llmProvider,
              ],
              [
                'allowed hosts',
                skill.data.allowedHosts.length === 0
                  ? '—'
                  : `${skill.data.allowedHosts.length} host${skill.data.allowedHosts.length === 1 ? '' : 's'}`,
              ],
            ].map(([k, v]) => (
              <div
                key={k as string}
                className="rounded-md border border-border-subtle bg-bg-raised px-3 py-2"
              >
                <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
                  {k as string}
                </div>
                <div className="text-sm font-mono text-fg truncate">
                  {v as string}
                </div>
              </div>
            ))}
          </div>

          {skill.data.allowedHosts.length > 0 && (
            <div className="rounded-md border border-border-subtle bg-bg-raised px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
                Hosts the skill can call
              </div>
              <div className="flex flex-wrap gap-1">
                {skill.data.allowedHosts.map((h) => (
                  <span
                    key={h}
                    className="font-mono text-[11px] text-fg bg-bg border border-border-subtle rounded px-1.5 py-0.5"
                  >
                    {h}
                  </span>
                ))}
              </div>
              <div className="mt-1.5 text-[10px] text-fg-subtle">
                Your PM can issue tool calls to these hosts only — the API
                key is attached server-side, never in the LLM prompt.
              </div>
            </div>
          )}

          {/* Hermes test panel — actionable when provider=hermes; informational otherwise. */}
          <div className="rounded-md border border-border-subtle bg-bg-raised px-3 py-2 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] uppercase tracking-wider text-fg-subtle">
                Hermes endpoint
              </span>
              <span className="text-[11px] font-mono text-fg-muted truncate">
                {skill.data.hermesBaseUrl ?? '—'}
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="ml-auto"
                onClick={() => hermesTest.mutate()}
                disabled={hermesTest.isPending || !skill.data.hermesConfigured}
                title={
                  skill.data.hermesConfigured
                    ? undefined
                    : 'HERMES_API_KEY not set on the agents server'
                }
              >
                {hermesTest.isPending ? 'pinging…' : 'Test Hermes'}
              </Button>
            </div>
            {!skill.data.hermesConfigured && (
              <div className="text-[11px] text-warning">
                <span className="font-mono">HERMES_API_KEY</span> not configured
                on the agents server — PM won't be able to reach Hermes.
              </div>
            )}
            {hermesTest.data && (
              <div
                className={[
                  'text-[11px] rounded px-2 py-1.5 border',
                  hermesTest.data.ok
                    ? 'text-positive border-positive/30 bg-positive/5'
                    : 'text-negative border-negative/30 bg-negative/10',
                ].join(' ')}
              >
                {hermesTest.data.ok ? (
                  <>
                    <span className="font-mono">{hermesTest.data.model}</span>{' '}
                    replied <span className="font-mono">"{hermesTest.data.sample ?? ''}"</span>{' '}
                    in {hermesTest.data.latencyMs}ms.
                  </>
                ) : (
                  <>
                    <span className="font-semibold">
                      {hermesTest.data.status
                        ? `${hermesTest.data.status} `
                        : ''}
                      failed:
                    </span>{' '}
                    <span className="font-mono">
                      {hermesTest.data.error ?? 'unknown error'}
                    </span>
                    {hermesTest.data.hint && (
                      <div className="mt-0.5 text-fg-muted">
                        {hermesTest.data.hint}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {hermesTest.error && !hermesTest.data && (
              <div className="text-[11px] text-negative">
                {hermesTest.error instanceof Error
                  ? hermesTest.error.message
                  : String(hermesTest.error)}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => replaceKey.mutate({ clearKey: true })}
              disabled={replaceKey.isPending}
            >
              Rotate key
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => wipe.mutate()}
              disabled={wipe.isPending}
            >
              Uninstall skill
            </Button>
            <span className="text-[10px] text-fg-subtle ml-auto">
              {skill.data.pmActive
                ? 'PM will pull the skill + key on its next tick.'
                : 'connector ready — flip PM to hermes to start using it.'}
            </span>
          </div>
        </div>
      )}
    </Surface>
  );
}
