import { ConnectCortex, CopyButton } from '@/components/connect/ConnectCortex';
import { DirectionPair } from '@/components/connect/DirectionPair';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { getMcpUrl } from '@/lib/mcp-url';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { Cable, KeyRound, ShieldCheck, TriangleAlert } from 'lucide-react';
import { issueToken, revokeToken } from './actions';

export const dynamic = 'force-dynamic';

interface AgentRow {
  id: string;
  name: string;
}

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  created_at: string;
  agent_id: string | null;
  agents: { name: string } | null;
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export default async function ConnectClientPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const justIssued = sp.just_issued ?? null;
  const mcpUrl = await getMcpUrl();

  const sb = getSupabaseServiceClient();

  const [{ data: tokenRows }, { data: agentRows }] = await Promise.all([
    sb
      .from('mcp_tokens')
      .select(
        'id, name, prefix, last_used_at, revoked_at, expires_at, created_at, agent_id, agents(name)',
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    sb.from('agents').select('id, name').order('name'),
  ]);

  const tokens: TokenRow[] = (tokenRows ?? []) as unknown as TokenRow[];
  const agents: AgentRow[] = (agentRows ?? []) as unknown as AgentRow[];
  const liveTokens = tokens.filter((t) => !t.revoked_at).length;

  return (
    <>
      <PageHeader
        title="Connect Claude"
        subtitle="Use Cortex from Claude, Claude Code, ChatGPT or any MCP client — same tools, your permissions, every action audited."
        icon={<Cable className="h-5 w-5" />}
      />

      <DirectionPair active="inbound" />

      <div className="space-y-4">
        {/* Primary path: OAuth. No token involved. */}
        <Panel className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-primary-soft text-primary">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-bold tracking-tight text-ink">
                No token needed — just sign in
              </h2>
              <p className="mt-0.5 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
                Claude, Claude Code and ChatGPT connect over OAuth: you paste the URL below, they
                send you to Google, you approve once. Nothing to copy, nothing to store, and access
                dies with your Cortex account.
              </p>
            </div>
          </div>

          <ConnectCortex url={mcpUrl} />
        </Panel>

        {/* Fallback path: static bearer tokens. */}
        <Panel className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-surface-2 text-ink-muted">
              <KeyRound className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Advanced
              </div>
              <h2 className="mt-0.5 text-[15px] font-bold tracking-tight text-ink">
                Personal access tokens
              </h2>
              <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
                Only for clients that cannot do OAuth — a script, a self-hosted bridge, an older MCP
                client. A token acts as you: whoever holds it gets your tools and your data, until
                you revoke it here.
              </p>
              {liveTokens > 0 && (
                <p className="mt-1 text-[11.5px] text-ink-faint">
                  {liveTokens} active token{liveTokens === 1 ? '' : 's'} on your account.
                </p>
              )}
            </div>
          </div>

          {/* One-time plaintext. It is never rendered again after this response. */}
          {justIssued && (
            <div className="mt-4 rounded-card border border-amber/40 bg-amber-soft p-4">
              <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-amber">
                <TriangleAlert className="h-4 w-4" />
                Copy this token now — it will not be shown again.
              </p>
              <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-amber/30 bg-surface px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">
                  {justIssued}
                </code>
                <CopyButton text={justIssued} label="Copy token" />
              </div>
              <p className="mt-2 text-[11.5px] text-amber">
                Leave this page and the token is gone from here for good — only its hash is stored.
                Keep it somewhere safe.
              </p>
            </div>
          )}

          <div className="mt-4 grid gap-4 border-t border-border pt-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
            {/* Issue */}
            <form action={issueToken} className="space-y-3">
              <div>
                <label
                  htmlFor="token-name"
                  className="mb-1 block text-xs font-medium text-ink-muted"
                >
                  Token name <span className="text-ink-faint">(e.g. &quot;Work laptop&quot;)</span>
                </label>
                <input
                  id="token-name"
                  name="name"
                  required
                  maxLength={60}
                  placeholder="My scripting client"
                  className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
                />
              </div>
              <div>
                <label
                  htmlFor="agent-select"
                  className="mb-1 block text-xs font-medium text-ink-muted"
                >
                  Agent <span className="text-ink-faint">(optional — narrows the tool list)</span>
                </label>
                <select
                  id="agent-select"
                  name="agentId"
                  className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
                >
                  <option value="">— any agent —</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit">Generate token</Button>
            </form>

            {/* List */}
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Your tokens
              </div>
              {tokens.length === 0 ? (
                <p className="mt-3 text-[13px] text-ink-faint">
                  No tokens yet — and most people never need one.
                </p>
              ) : (
                <ul className="mt-1 divide-y divide-border text-[13px]">
                  {tokens.map((t) => (
                    <li key={t.id} className="flex items-start justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-ink">{t.name}</span>
                          {t.revoked_at && (
                            <span className="rounded-pill bg-rose-soft px-2 py-0.5 text-[10.5px] font-bold uppercase text-rose">
                              Revoked
                            </span>
                          )}
                          {!t.revoked_at && t.expires_at && new Date(t.expires_at) < new Date() && (
                            <span className="rounded-pill bg-amber-soft px-2 py-0.5 text-[10.5px] font-bold uppercase text-amber">
                              Expired
                            </span>
                          )}
                        </div>
                        {/* Prefix only — the token itself is stored hashed. */}
                        <div className="mt-0.5 font-mono text-xs text-ink-muted">{t.prefix}…</div>
                        <div className="mt-1 space-x-3 text-xs text-ink-faint">
                          <span>Agent: {t.agents?.name ?? 'any'}</span>
                          <span>Last used: {fmt(t.last_used_at)}</span>
                          <span>Expires: {fmt(t.expires_at)}</span>
                          <span>Created: {fmt(t.created_at)}</span>
                          {t.revoked_at && <span>Revoked: {fmt(t.revoked_at)}</span>}
                        </div>
                      </div>
                      {!t.revoked_at && (
                        <form action={revokeToken} className="shrink-0">
                          <input type="hidden" name="tokenId" value={t.id} />
                          <button
                            type="submit"
                            title="Kills this token immediately, everywhere it is used"
                            className="rounded-pill border border-rose/30 px-3 py-1.5 text-xs font-semibold text-rose transition-colors hover:bg-rose-soft"
                          >
                            Revoke
                          </button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
