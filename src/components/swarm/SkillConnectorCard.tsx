// Skill connector — auto-register flow.
//
// Three views:
//
//   • EMPTY  — no skills installed. Show one form: paste SKILL.md (or
//     a URL to one), pick an agent role, hit Install. Server discovers
//     register endpoint, self-registers, persists everything.
//
//   • CLAIM  — one or more skills are pending_claim. Render the claim
//     URL + verification code prominently so the user knows what to do
//     next. Heartbeat poller flips claim_status to `claimed` once
//     verification completes upstream; the UI auto-refreshes via React
//     Query polling.
//
//   • LIVE   — skills are claimed. Render compact list of installed
//     skills with last-heartbeat liveness pill + uninstall button.
//
// What's intentionally absent: any "paste your API key" step. The swarm
// acquires credentials by following the SKILL.md's own register flow —
// the user never types or sees an API key.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Surface } from '@/components/common/Surface';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import {
  installSkill,
  listSkills,
  refreshSkillStatus,
  uninstallSkill,
  type AgentRole,
  type ClaimStatus,
  type InstalledSkillWire,
} from '@/lib/agents-api';

const AGENT_ROLES: AgentRole[] = ['pm', 'alm', 'router', 'executor'];

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}h ago`;
  return `${Math.floor(ms / (24 * 60 * 60_000))}d ago`;
}

function claimBadge(status: ClaimStatus) {
  if (status === 'claimed') return <Badge tone="positive" dot>claimed</Badge>;
  if (status === 'pending_claim')
    return <Badge tone="warning" dot>pending claim</Badge>;
  if (status === 'failed') return <Badge tone="negative" dot>failed</Badge>;
  return <Badge tone="neutral">unknown</Badge>;
}

/** Quick frontmatter peek for the install preview. */
function peekFrontmatter(content: string): {
  name: string | null;
  version: string | null;
  description: string | null;
} {
  const out = {
    name: null as string | null,
    version: null as string | null,
    description: null as string | null,
  };
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

// =====================================================================
// Install form
// =====================================================================

function InstallForm({
  onInstalled,
}: {
  onInstalled: (skill: InstalledSkillWire) => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'paste' | 'url'>('paste');
  const [content, setContent] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [agentRole, setAgentRole] = useState<AgentRole>('pm');

  const peek = useMemo(
    () => (mode === 'paste' && content.length > 0 ? peekFrontmatter(content) : null),
    [mode, content],
  );

  const install = useMutation({
    mutationFn: () =>
      installSkill(
        mode === 'paste'
          ? { content, agentRole }
          : { sourceUrl, agentRole },
      ),
    onSuccess: (skill) => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      setContent('');
      setSourceUrl('');
      onInstalled(skill);
    },
  });

  const canSubmit =
    !install.isPending &&
    (mode === 'paste' ? content.trim().length >= 10 : sourceUrl.trim().length >= 8);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-fg-subtle uppercase tracking-wider">source</span>
        <button
          type="button"
          className={`px-2 py-0.5 rounded border ${
            mode === 'paste'
              ? 'border-accent text-accent bg-accent/5'
              : 'border-border-subtle text-fg-subtle'
          }`}
          onClick={() => setMode('paste')}
        >
          paste markdown
        </button>
        <button
          type="button"
          className={`px-2 py-0.5 rounded border ${
            mode === 'url'
              ? 'border-accent text-accent bg-accent/5'
              : 'border-border-subtle text-fg-subtle'
          }`}
          onClick={() => setMode('url')}
        >
          fetch from URL
        </button>
      </div>

      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-fg-subtle">
          assign to agent role
        </span>
        <div className="mt-1 flex flex-wrap gap-2">
          {AGENT_ROLES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setAgentRole(r)}
              className={`px-2 py-1 text-xs font-mono rounded border ${
                agentRole === r
                  ? 'border-accent text-accent bg-accent/10'
                  : 'border-border-subtle text-fg-muted hover:text-fg'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <span className="mt-1 block text-[11px] text-fg-subtle">
          The skill self-registers under this role&apos;s identity (e.g.{' '}
          <span className="font-mono">DefiSwarm-{agentRole.toUpperCase()}</span>).
        </span>
      </label>

      {mode === 'paste' ? (
        <label className="block">
          <span className="text-[11px] uppercase tracking-wider text-fg-subtle">
            SKILL.md
          </span>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={`---
name: moltbook
version: 1.12.0
description: The social network for AI agents.
---

# Moltbook
...paste the rest of the SKILL.md here...`}
            rows={9}
            spellCheck={false}
            className="mt-1 w-full rounded-md border border-border-subtle bg-bg-raised px-3 py-2 text-xs font-mono placeholder:text-fg-subtle focus:outline-none focus:border-accent resize-y"
          />
        </label>
      ) : (
        <label className="block">
          <span className="text-[11px] uppercase tracking-wider text-fg-subtle">
            SKILL.md URL
          </span>
          <input
            type="url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://www.moltbook.com/skill.md"
            className="mt-1 w-full rounded-md border border-border-subtle bg-bg-raised px-3 py-2 text-sm font-mono placeholder:text-fg-subtle focus:outline-none focus:border-accent"
          />
          <span className="mt-1 block text-[11px] text-fg-subtle">
            Server fetches the markdown over HTTPS, parses it, then self-registers.
          </span>
        </label>
      )}

      {peek && peek.name && (
        <div className="rounded-md border border-border-subtle bg-bg-raised px-3 py-2 text-[11px] flex items-center gap-3 flex-wrap">
          <span className="text-fg-subtle uppercase tracking-wider">detected</span>
          <span className="font-mono text-fg">{peek.name}</span>
          {peek.version && (
            <span className="font-mono text-fg-muted">v{peek.version}</span>
          )}
          {peek.description && (
            <span className="text-fg-muted truncate max-w-[24rem]">
              — {peek.description}
            </span>
          )}
        </div>
      )}

      {install.error && (
        <div className="text-xs text-negative bg-negative/10 border border-negative/30 rounded-md px-3 py-2 break-words">
          {install.error instanceof Error
            ? install.error.message
            : String(install.error)}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          onClick={() => install.mutate()}
          disabled={!canSubmit}
        >
          {install.isPending ? 'registering…' : 'Install + auto-register'}
        </Button>
        <span className="text-[11px] text-fg-subtle">
          The swarm registers itself with the skill — no API key for you to paste.
        </span>
      </div>
    </div>
  );
}

// =====================================================================
// Skill row (claim flow + live)
// =====================================================================

function SkillRow({ skill }: { skill: InstalledSkillWire }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);

  const refresh = useMutation({
    mutationFn: () => refreshSkillStatus(skill.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
  const remove = useMutation({
    mutationFn: () => uninstallSkill(skill.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });

  const isPending = skill.claimStatus === 'pending_claim';
  const isClaimed = skill.claimStatus === 'claimed';

  return (
    <div
      className={[
        'rounded-md border px-3 py-3 space-y-3',
        isClaimed
          ? 'border-positive/30 bg-positive/5'
          : isPending
            ? 'border-warning/30 bg-warning/5'
            : 'border-border-subtle bg-bg-raised',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-base">🪝</span>
        <span className="font-mono text-sm text-fg">{skill.name}</span>
        {skill.version && (
          <span className="font-mono text-[11px] text-fg-muted">
            v{skill.version}
          </span>
        )}
        <Badge tone="neutral">{skill.agentRole}</Badge>
        {claimBadge(skill.claimStatus)}
        <span className="ml-auto text-[10px] text-fg-subtle">
          installed {relativeTime(skill.installedAt) ?? 'recently'}
        </span>
      </div>
      {skill.description && (
        <div className="text-xs text-fg-muted leading-relaxed">
          {skill.description}
        </div>
      )}

      {isPending && skill.claimUrl && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 space-y-2">
          <div className="text-[11px] font-semibold text-warning uppercase tracking-wider">
            action required: claim this agent
          </div>
          <div className="text-xs text-fg leading-relaxed">
            The swarm registered{' '}
            <span className="font-mono">
              {skill.registeredName ?? skill.name}
            </span>{' '}
            with <span className="font-mono">{skill.name}</span>. Visit the
            claim URL to verify ownership on their site.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={skill.claimUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-warning text-bg text-xs font-semibold hover:opacity-90"
            >
              Claim agent →
            </a>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(skill.claimUrl ?? '');
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="text-[11px] text-fg-muted hover:text-fg"
            >
              {copied ? 'copied' : 'copy URL'}
            </button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
            >
              {refresh.isPending ? 'checking…' : 'I claimed it'}
            </Button>
          </div>
          {skill.verificationCode && (
            <div className="text-[11px] text-fg-muted">
              verification code:{' '}
              <span className="font-mono text-fg">
                {skill.verificationCode}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="rounded border border-border-subtle bg-bg-raised px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
            api key
          </div>
          <div className="font-mono text-fg truncate">
            {skill.keyTail ? `••••${skill.keyTail}` : '—'}
          </div>
        </div>
        <div className="rounded border border-border-subtle bg-bg-raised px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
            allowed hosts
          </div>
          <div
            className="font-mono text-fg truncate"
            title={skill.allowedHosts.join(', ')}
          >
            {skill.allowedHosts.length === 0
              ? '—'
              : skill.allowedHosts.length === 1
                ? skill.allowedHosts[0]
                : `${skill.allowedHosts.length} hosts`}
          </div>
        </div>
        <div className="rounded border border-border-subtle bg-bg-raised px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
            last heartbeat
          </div>
          <div className="font-mono text-fg truncate">
            {relativeTime(skill.lastHeartbeatAt) ?? '—'}
          </div>
        </div>
        <div className="rounded border border-border-subtle bg-bg-raised px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
            md size
          </div>
          <div className="font-mono text-fg truncate">
            {(skill.contentLength / 1024).toFixed(1)} KB
          </div>
        </div>
      </div>

      {skill.allowedHosts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {skill.allowedHosts.map((h) => (
            <span
              key={h}
              className="font-mono text-[10px] text-fg bg-bg border border-border-subtle rounded px-1.5 py-0.5"
            >
              {h}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? 'refreshing…' : 'refresh status'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
        >
          uninstall
        </Button>
        {refresh.error && (
          <span className="text-[11px] text-negative">
            {refresh.error instanceof Error
              ? refresh.error.message
              : 'refresh failed'}
          </span>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// Top-level card
// =====================================================================

export function SkillConnectorCard() {
  const skills = useQuery({
    queryKey: ['skills'],
    queryFn: listSkills,
    // While any skill is pending_claim, poll every 5s so the UI flips
    // to "claimed" the moment the heartbeat sweep updates the row.
    refetchInterval: (q) => {
      const data = q.state.data as InstalledSkillWire[] | undefined;
      return data?.some((s) => s.claimStatus === 'pending_claim') ? 5_000 : false;
    },
    refetchOnWindowFocus: true,
  });

  const list = skills.data ?? [];
  const hasPending = list.some((s) => s.claimStatus === 'pending_claim');
  const claimedCount = list.filter((s) => s.claimStatus === 'claimed').length;

  const headerBadge = (() => {
    if (list.length === 0) return <Badge tone="neutral">no skills</Badge>;
    if (hasPending) return <Badge tone="warning" dot>action needed</Badge>;
    if (claimedCount === list.length)
      return (
        <Badge tone="positive" dot>
          {claimedCount} live
        </Badge>
      );
    return <Badge tone="neutral">{list.length} installed</Badge>;
  })();

  return (
    <Surface className="p-5 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight flex items-center gap-2">
            <span aria-hidden className="text-base">
              🪝
            </span>
            Skill connector
          </h2>
          <p className="mt-1 text-xs text-fg-muted leading-relaxed max-w-xl">
            Paste a SKILL.md (or link to one). The swarm self-registers,
            grabs its own API key, and surfaces a claim URL for you to
            verify on the skill&apos;s site. No keys to paste.
          </p>
        </div>
        {headerBadge}
      </div>

      {list.length > 0 && (
        <div className="space-y-3">
          {list.map((s) => (
            <SkillRow key={s.id} skill={s} />
          ))}
        </div>
      )}

      <details
        className="rounded-md border border-border-subtle bg-bg-raised"
        open={list.length === 0}
      >
        <summary className="px-3 py-2 text-xs font-semibold cursor-pointer select-none flex items-center gap-2">
          <span>
            {list.length === 0
              ? 'Install your first skill'
              : 'Install another skill'}
          </span>
          <span className="text-[10px] text-fg-subtle font-normal ml-auto">
            paste markdown · or fetch from URL
          </span>
        </summary>
        <div className="px-3 py-3 border-t border-border-subtle">
          <InstallForm onInstalled={() => skills.refetch()} />
        </div>
      </details>
    </Surface>
  );
}
