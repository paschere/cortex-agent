import { ConnectCortex, CopyButton } from '@/components/connect/ConnectCortex';
import { DirectionPair } from '@/components/connect/DirectionPair';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { Field } from '@/components/ui/provenance';
import { getMcpUrl } from '@/lib/mcp-url';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { clsx } from 'clsx';
import { Cable, KeyRound, ShieldCheck, TriangleAlert } from 'lucide-react';
import { issueToken, revokeToken } from './actions';

export const dynamic = 'force-dynamic';

const FIELD =
  'w-full rounded-card border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary';

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

/**
 * A token is a document: in force, lapsed, or stamped void. The register shows
 * which, always — an unlabelled row would leave the reader counting dates.
 */
type TokenState = 'active' | 'expired' | 'revoked';

function stateOf(t: TokenRow): TokenState {
  if (t.revoked_at) return 'revoked';
  if (t.expires_at && new Date(t.expires_at) < new Date()) return 'expired';
  return 'active';
}

const STATE: Record<TokenState, { label: string; className: string }> = {
  active: { label: 'In force', className: 'border-emerald/40 bg-emerald-soft text-emerald' },
  expired: { label: 'Expired', className: 'border-amber/40 bg-amber-soft text-amber' },
  revoked: { label: 'Revoked', className: 'border-rose/40 bg-rose-soft text-rose' },
};

function StateTag({ state }: { state: TokenState }) {
  const s = STATE[state];
  return (
    <span
      className={clsx(
        'shrink-0 rounded-card border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]',
        s.className,
      )}
    >
      {s.label}
    </span>
  );
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
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
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
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-surface-2 text-ink-muted">
              <KeyRound className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="field-label">Advanced</div>
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
                  <span className="tabular text-ink-muted">{liveTokens}</span> token
                  {liveTokens === 1 ? '' : 's'} in force on your account.
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
              <div className="flex flex-wrap items-center gap-2 rounded-card border border-amber/30 bg-surface px-3 py-2">
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
                <label htmlFor="token-name" className="field-label mb-1 block">
                  Token name
                </label>
                <input
                  id="token-name"
                  name="name"
                  required
                  maxLength={60}
                  placeholder="Work laptop"
                  className={FIELD}
                />
              </div>
              <div>
                <label htmlFor="agent-select" className="field-label mb-1 block">
                  Agent
                </label>
                <select id="agent-select" name="agentId" className={FIELD}>
                  <option value="">Any agent</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11.5px] text-ink-faint">
                  Pick one to narrow the token to that agent&apos;s tools.
                </p>
              </div>
              <Button type="submit">Generate token</Button>
            </form>

            {/* The register: one row per token, every date and id in mono. */}
            <div>
              <div className="field-label">Your tokens</div>
              {tokens.length === 0 ? (
                <p className="mt-3 max-w-md text-[13px] leading-relaxed text-ink-muted">
                  No tokens issued. Name one on the left and generate it — though most people
                  connect over OAuth above and never need one.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-border border-t border-border">
                  {tokens.map((t) => {
                    const state = stateOf(t);
                    return (
                      <li key={t.id} className="py-3.5">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="text-[13px] font-semibold text-ink">{t.name}</span>
                            <StateTag state={state} />
                            {/* Prefix only — the token itself is stored hashed. */}
                            <span className="tabular text-[12px] text-ink-muted">
                              {t.prefix}…
                            </span>
                          </div>
                          {state !== 'revoked' && (
                            <form action={revokeToken} className="shrink-0">
                              <input type="hidden" name="tokenId" value={t.id} />
                              <Button
                                type="submit"
                                variant="danger"
                                title="Kills this token immediately, everywhere it is used"
                              >
                                Revoke
                              </Button>
                            </form>
                          )}
                        </div>
                        <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
                          <Field label="Agent">
                            <span className="text-[13px]">{t.agents?.name ?? 'Any'}</span>
                          </Field>
                          <Field label="Last used">
                            <span className="text-[13px]">{fmt(t.last_used_at)}</span>
                          </Field>
                          <Field label="Created">
                            <span className="text-[13px]">{fmt(t.created_at)}</span>
                          </Field>
                          <Field label={t.revoked_at ? 'Revoked' : 'Expires'}>
                            <span className="text-[13px]">
                              {fmt(t.revoked_at ?? t.expires_at)}
                            </span>
                          </Field>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
