import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { AddMcpServerForm } from './_components/AddMcpServerForm';
import { McpServerList, type McpServer } from './_components/McpServerList';

const MAX_MCP_SERVERS = 5;
const MAX_MCP_TOOLS = 50;

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const db = getSupabaseServiceClient();
  const { data: rows } = await db
    .from('integrations')
    .select('provider, scopes, expires_at, updated_at')
    .eq('user_id', user.id);

  const byProvider = Object.fromEntries((rows ?? []).map((r) => [r.provider, r]));

  const { data: mcpRows } = await db
    .from('user_mcp_servers')
    .select(
      'id, name, url, auth_type, auth_value_encrypted, enabled, trusted, tool_count, last_checked_at, last_error, user_mcp_tools(tool_name, tool_description)',
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  const mcpServers: McpServer[] = (mcpRows ?? []).map((r) => {
    const row = r as Record<string, unknown> & {
      auth_value_encrypted: string | null;
      user_mcp_tools?: Array<{ tool_name: string; tool_description: string | null }>;
    };
    return {
      id: row.id as string,
      name: row.name as string,
      url: row.url as string,
      auth_type: row.auth_type as McpServer['auth_type'],
      enabled: row.enabled as boolean,
      trusted: row.trusted as boolean,
      tool_count: (row.tool_count as number) ?? 0,
      last_checked_at: (row.last_checked_at as string | null) ?? null,
      last_error: (row.last_error as string | null) ?? null,
      authConfigured: !!row.auth_value_encrypted,
      tools: row.user_mcp_tools ?? [],
    };
  });

  const atServerCapacity = mcpServers.length >= MAX_MCP_SERVERS;
  const totalTools = mcpServers.reduce((sum, s) => sum + s.tool_count, 0);
  const atToolCapacity = totalTools >= MAX_MCP_TOOLS;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Integrations</h1>
      {sp.connected && (
        <div className="rounded bg-green-50 text-green-800 px-3 py-2 text-sm">
          Connected {sp.connected}.
        </div>
      )}
      {sp.error && (
        <div className="rounded bg-red-50 text-red-800 px-3 py-2 text-sm">
          Error: {sp.error}
        </div>
      )}

      <section className="rounded-2xl border p-5">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="font-medium">Google Workspace</h2>
            <p className="text-sm text-neutral-500">
              Connect Gmail, Drive, Calendar, Sheets — granted incrementally.
            </p>
          </div>
          {byProvider.google ? (
            <span className="text-xs text-green-700">
              Connected · {(byProvider.google.scopes as string[]).length} scopes
            </span>
          ) : (
            <Link
              href="/api/integrations/google?preset=all"
              className="rounded bg-neutral-900 text-white text-sm px-3 py-1.5"
            >
              Connect
            </Link>
          )}
        </header>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {['gmail', 'drive', 'calendar', 'sheets'].map((p) => (
            <Link
              key={p}
              href={`/api/integrations/google?preset=${p}`}
              className="rounded border px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              + {p}
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border p-5">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="font-medium">HubSpot</h2>
            <p className="text-sm text-neutral-500">
              Read-only access to deals, companies, contacts, activities.
            </p>
          </div>
          {byProvider.hubspot ? (
            <span className="text-xs text-green-700">Connected</span>
          ) : (
            <Link
              href="/api/integrations/hubspot"
              className="rounded bg-neutral-900 text-white text-sm px-3 py-1.5"
            >
              Connect
            </Link>
          )}
        </header>
      </section>

      <section className="rounded-2xl border p-5">
        <header>
          <h2 className="font-medium">External MCP Servers</h2>
          <p className="text-sm text-neutral-500">
            Connect your own Model Context Protocol servers (Notion, Linear, self-hosted). Their
            tools become available to the agent. Max {MAX_MCP_SERVERS} servers, {MAX_MCP_TOOLS}{' '}
            tools total.
          </p>
        </header>

        <McpServerList servers={mcpServers} />

        {atServerCapacity && (
          <p className="mt-4 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20">
            Max {MAX_MCP_SERVERS} servers reached. Delete one to add another.
          </p>
        )}
        {atToolCapacity && (
          <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20">
            50-tool total limit reached. New tools will not be synced until you remove some.
          </p>
        )}

        {!atServerCapacity && (
          <div className="mt-4 border-t pt-4">
            <h3 className="text-sm font-medium">Add a server</h3>
            <AddMcpServerForm disabled={atServerCapacity} />
          </div>
        )}
      </section>
    </div>
  );
}
