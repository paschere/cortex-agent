import { getSupabaseServiceClient } from '@/lib/supabase/service';

interface AuditEvent {
  user_id: string;
  tool_id: string;
  status: string;
  created_at: string;
}

interface UserRow {
  id: string;
  email: string;
}

export default async function UsagePage() {
  const sb = getSupabaseServiceClient();

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: events } = await sb
    .from('audit_events')
    .select('user_id, tool_id, status, created_at')
    .gte('created_at', since);

  const rows: AuditEvent[] = (events ?? []) as AuditEvent[];

  // Aggregate by tool_id
  const byTool: Record<string, number> = {};
  // Aggregate by status
  const byStatus: Record<string, number> = {};
  // Aggregate by user_id
  const byUser: Record<string, number> = {};

  for (const e of rows) {
    byTool[e.tool_id] = (byTool[e.tool_id] ?? 0) + 1;
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    byUser[e.user_id] = (byUser[e.user_id] ?? 0) + 1;
  }

  // Fetch emails for users in result
  const userIds = Object.keys(byUser);
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

  const toolEntries = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
  const statusEntries = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
  const userEntries = Object.entries(byUser).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Usage</h1>
        <p className="text-sm text-neutral-500 mt-1">Last 7 days · {rows.length} total events</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* By tool */}
        <div className="rounded-2xl border overflow-hidden">
          <div className="px-4 py-3 border-b bg-neutral-50 dark:bg-neutral-800">
            <h2 className="font-medium text-sm">By tool</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="px-4 py-2 font-medium text-neutral-500 text-xs">Tool</th>
                <th className="px-4 py-2 font-medium text-neutral-500 text-xs">Count</th>
              </tr>
            </thead>
            <tbody>
              {toolEntries.map(([tool, count]) => (
                <tr key={tool} className="border-t hover:bg-neutral-50 dark:hover:bg-neutral-900">
                  <td className="px-4 py-2 font-mono text-xs truncate max-w-[160px]">{tool}</td>
                  <td className="px-4 py-2 text-xs">{count}</td>
                </tr>
              ))}
              {toolEntries.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-4 py-4 text-xs text-neutral-500 text-center">
                    No data
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* By status */}
        <div className="rounded-2xl border overflow-hidden">
          <div className="px-4 py-3 border-b bg-neutral-50 dark:bg-neutral-800">
            <h2 className="font-medium text-sm">By status</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="px-4 py-2 font-medium text-neutral-500 text-xs">Status</th>
                <th className="px-4 py-2 font-medium text-neutral-500 text-xs">Count</th>
              </tr>
            </thead>
            <tbody>
              {statusEntries.map(([status, count]) => (
                <tr key={status} className="border-t hover:bg-neutral-50 dark:hover:bg-neutral-900">
                  <td className="px-4 py-2 text-xs">
                    <span
                      className={
                        status === 'ok'
                          ? 'text-green-700'
                          : status === 'error'
                            ? 'text-red-600'
                            : 'text-neutral-500'
                      }
                    >
                      {status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs">{count}</td>
                </tr>
              ))}
              {statusEntries.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-4 py-4 text-xs text-neutral-500 text-center">
                    No data
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* By user */}
        <div className="rounded-2xl border overflow-hidden">
          <div className="px-4 py-3 border-b bg-neutral-50 dark:bg-neutral-800">
            <h2 className="font-medium text-sm">By user</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="px-4 py-2 font-medium text-neutral-500 text-xs">User</th>
                <th className="px-4 py-2 font-medium text-neutral-500 text-xs">Count</th>
              </tr>
            </thead>
            <tbody>
              {userEntries.map(([userId, count]) => (
                <tr key={userId} className="border-t hover:bg-neutral-50 dark:hover:bg-neutral-900">
                  <td className="px-4 py-2 text-xs truncate max-w-[160px]">
                    {emailMap[userId] ?? userId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-2 text-xs">{count}</td>
                </tr>
              ))}
              {userEntries.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-4 py-4 text-xs text-neutral-500 text-center">
                    No data
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
