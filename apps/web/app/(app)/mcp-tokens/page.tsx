import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { KeyRound, AlertTriangle } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, Eyebrow } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { issueToken, revokeToken } from './actions';

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

export default async function McpTokensPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const justIssued = sp.just_issued ?? null;

  const sb = getSupabaseServiceClient();

  const [{ data: tokenRows }, { data: agentRows }] = await Promise.all([
    sb
      .from('mcp_tokens')
      .select('id, name, prefix, last_used_at, revoked_at, expires_at, created_at, agent_id, agents(name)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    sb.from('agents').select('id, name').order('name'),
  ]);

  const tokens: TokenRow[] = (tokenRows ?? []) as unknown as TokenRow[];
  const agents: AgentRow[] = (agentRows ?? []) as unknown as AgentRow[];

  return (
    <>
      <PageHeader
        title="MCP Tokens"
        subtitle="Personal bearer tokens for connecting Claude Desktop (or any MCP client) to your zipdev agent — each token grants access to a specific agent's tool list"
        icon={<KeyRound className="h-5 w-5" />}
      />

      <div className="space-y-4">
        {/* One-time plaintext banner */}
        {justIssued && (
          <Panel className="border-amber/40 bg-amber-soft p-4">
            <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-amber">
              <AlertTriangle className="h-4 w-4" />
              Copy this token NOW — it will not be shown again.
            </p>
            <pre className="whitespace-pre-wrap break-all rounded-[10px] border border-amber/30 bg-surface px-3 py-2 font-mono text-xs text-ink">
              {justIssued}
            </pre>
            <p className="mt-2 text-[11.5px] text-amber">
              After navigating away this token is gone from this page. Store it somewhere safe.
            </p>
          </Panel>
        )}

        {/* Issue new token form */}
        <Panel className="p-5">
          <Eyebrow>Issue new token</Eyebrow>
          <form action={issueToken} className="mt-3 space-y-3">
            <div>
              <label htmlFor="token-name" className="mb-1 block text-xs font-medium text-ink-muted">
                Token name <span className="text-ink-faint">(e.g. &quot;Work laptop&quot;)</span>
              </label>
              <input
                id="token-name"
                name="name"
                required
                maxLength={60}
                placeholder="My Claude Desktop"
                className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
              />
            </div>
            <div>
              <label htmlFor="agent-select" className="mb-1 block text-xs font-medium text-ink-muted">
                Agent <span className="text-ink-faint">(optional — leave blank for any agent)</span>
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
        </Panel>

        {/* Token list */}
        <Panel className="p-5">
          <Eyebrow>Your tokens</Eyebrow>
          {tokens.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-faint">No tokens yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border text-[13px]">
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
                    <div className="mt-0.5 font-mono text-xs text-ink-muted">{t.prefix}…</div>
                    <div className="mt-1 space-x-3 text-xs text-ink-faint">
                      <span>Agent: {t.agents?.name ?? '—'}</span>
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
        </Panel>
      </div>
    </>
  );
}
