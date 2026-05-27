import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';

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
    </div>
  );
}
