import { getSupabaseServiceClient } from '@/lib/supabase/service';

interface AuditEvent {
  id: string;
  user_id: string;
  tool_id: string;
  status: string;
  latency_ms: number;
  created_at: string;
}

interface UserRow {
  id: string;
  email: string;
}

export default async function AuditPage() {
  const sb = getSupabaseServiceClient();

  const { data: events } = await sb
    .from('audit_events')
    .select('id, user_id, tool_id, status, latency_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  const rows: AuditEvent[] = (events ?? []) as AuditEvent[];

  // Fetch user emails for unique user_ids in the result set
  const userIds = [...new Set(rows.map((e) => e.user_id))];
  let emailMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: users } = await sb
      .from('users')
      .select('id, email')
      .in('id', userIds);
    emailMap = Object.fromEntries(
      ((users ?? []) as UserRow[]).map((u) => [u.id, u.email]),
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <p className="text-sm text-neutral-500">Last 100 events, most recent first.</p>
      <div className="rounded-2xl border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-neutral-50 dark:bg-neutral-800">
            <tr className="text-left">
              <th className="px-4 py-3 font-medium text-neutral-500">When</th>
              <th className="px-4 py-3 font-medium text-neutral-500">User</th>
              <th className="px-4 py-3 font-medium text-neutral-500">Tool</th>
              <th className="px-4 py-3 font-medium text-neutral-500">Status</th>
              <th className="px-4 py-3 font-medium text-neutral-500">Latency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-t hover:bg-neutral-50 dark:hover:bg-neutral-900">
                <td className="px-4 py-2 text-neutral-500 whitespace-nowrap">
                  {new Date(e.created_at).toLocaleString()}
                </td>
                <td className="px-4 py-2 text-neutral-500">
                  {emailMap[e.user_id] ?? e.user_id.slice(0, 8)}
                </td>
                <td className="px-4 py-2 font-mono">{e.tool_id}</td>
                <td className="px-4 py-2">
                  <span
                    className={
                      e.status === 'ok'
                        ? 'text-green-700'
                        : e.status === 'error'
                          ? 'text-red-600'
                          : 'text-neutral-500'
                    }
                  >
                    {e.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-neutral-500">{e.latency_ms}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="px-4 py-6 text-sm text-neutral-500 text-center">No audit events yet.</p>
        )}
      </div>
    </div>
  );
}
