import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { Card } from '@/components/ui/card';
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
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">MCP Tokens</h1>
      <p className="text-sm text-neutral-500">
        Personal bearer tokens for connecting Claude Desktop (or any MCP client) to your zipdev
        agent. Each token grants access to a specific agent&apos;s tool list.
      </p>

      {/* One-time plaintext banner */}
      {justIssued && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950 dark:border-amber-700 p-4 space-y-2">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            Copy this token NOW — it will not be shown again.
          </p>
          <pre className="rounded bg-white dark:bg-neutral-900 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs font-mono break-all whitespace-pre-wrap">
            {justIssued}
          </pre>
          <p className="text-xs text-amber-700 dark:text-amber-300">
            After navigating away this token is gone from this page. Store it somewhere safe.
          </p>
        </div>
      )}

      {/* Issue new token form */}
      <Card>
        <h2 className="font-medium mb-3">Issue new token</h2>
        <form action={issueToken} className="space-y-3">
          <div>
            <label htmlFor="token-name" className="block text-xs text-neutral-500 mb-1">
              Token name <span className="text-neutral-400">(e.g. &quot;Work laptop&quot;)</span>
            </label>
            <input
              id="token-name"
              name="name"
              required
              maxLength={60}
              placeholder="My Claude Desktop"
              className="w-full rounded-lg border bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-300"
            />
          </div>
          <div>
            <label htmlFor="agent-select" className="block text-xs text-neutral-500 mb-1">
              Agent <span className="text-neutral-400">(optional — leave blank for any agent)</span>
            </label>
            <select
              id="agent-select"
              name="agentId"
              className="w-full rounded-lg border bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-300"
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
      </Card>

      {/* Token list */}
      <Card>
        <h2 className="font-medium mb-3">Your tokens</h2>
        {tokens.length === 0 ? (
          <p className="text-sm text-neutral-500">No tokens yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {tokens.map((t) => (
              <li key={t.id} className="py-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    {t.revoked_at && (
                      <span className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 rounded px-1.5 py-0.5">
                        revoked
                      </span>
                    )}
                    {!t.revoked_at && t.expires_at && new Date(t.expires_at) < new Date() && (
                      <span className="text-xs text-orange-600 bg-orange-50 rounded px-1.5 py-0.5">
                        expired
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-neutral-500 font-mono mt-0.5">
                    {t.prefix}…
                  </div>
                  <div className="text-xs text-neutral-400 mt-1 space-x-3">
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
                    <Button
                      type="submit"
                      variant="outline"
                      className="text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-800 dark:hover:bg-red-950"
                    >
                      Revoke
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
