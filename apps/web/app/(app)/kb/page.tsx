import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';

interface Collection {
  id: string;
  name: string;
  scope: 'global' | 'team' | 'user' | 'conversation';
  scope_id: string | null;
}

interface CollectionWithCount extends Collection {
  docCount: number;
}

export default async function KbIndex() {
  const user = await requireSession();
  const sb = getSupabaseServiceClient();

  // Fetch collections visible to this user
  let colQuery = sb
    .from('kb_collections')
    .select('id, name, scope, scope_id')
    .order('created_at', { ascending: false });

  if (user.role !== 'org_admin') {
    const { data: memberships } = await sb
      .from('team_members')
      .select('team_id')
      .eq('user_id', user.id);
    const teamIds = (memberships ?? []).map((m) => m.team_id as string);

    const filters = [
      'scope.eq.global',
      `and(scope.eq.user,scope_id.eq.${user.id})`,
    ];
    if (teamIds.length > 0) {
      filters.push(
        `and(scope.eq.team,scope_id.in.(${teamIds.join(',')}))`,
      );
    }
    colQuery = colQuery.or(filters.join(','));
  }

  const { data: collections } = await colQuery;
  const cols: Collection[] = (collections ?? []) as Collection[];

  // Fetch doc counts for all visible collections
  const collectionIds = cols.map((c) => c.id);
  let docCounts: Record<string, number> = {};
  if (collectionIds.length > 0) {
    const { data: docs } = await sb
      .from('kb_documents')
      .select('collection_id')
      .in('collection_id', collectionIds);
    for (const d of docs ?? []) {
      const cid = d.collection_id as string;
      docCounts[cid] = (docCounts[cid] ?? 0) + 1;
    }
  }

  const withCounts: CollectionWithCount[] = cols.map((c) => ({
    ...c,
    docCount: docCounts[c.id] ?? 0,
  }));

  const grouped: Record<string, CollectionWithCount[]> = {
    global: [],
    team: [],
    user: [],
  };
  for (const c of withCounts) {
    if (c.scope in grouped) {
      grouped[c.scope]!.push(c);
    }
  }

  const sectionMeta: Record<string, { label: string; href: (c: CollectionWithCount) => string }> = {
    global: {
      label: 'Global Collections',
      href: () => '/kb/global',
    },
    team: {
      label: 'Team Collections',
      href: (c) => `/kb/team/${c.scope_id ?? ''}`,
    },
    user: {
      label: 'My Collections',
      href: () => '/kb/me',
    },
  };

  const sections = Object.entries(grouped).filter(([, list]) => list.length > 0);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Knowledge Base</h1>
        <div className="flex gap-2">
          <Link
            href="/kb/me"
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
          >
            My KB
          </Link>
          {user.role === 'org_admin' && (
            <Link
              href="/kb/global"
              className="rounded-lg bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 px-3 py-1.5 text-sm hover:opacity-90 transition"
            >
              Global KB
            </Link>
          )}
        </div>
      </div>

      {sections.length === 0 && (
        <div className="rounded-2xl border p-8 text-center text-sm text-neutral-500">
          No collections yet.{' '}
          <Link href="/kb/me" className="underline">
            Create your first collection.
          </Link>
        </div>
      )}

      {sections.map(([scope, list]) => {
        const meta = sectionMeta[scope]!;
        return (
          <section key={scope}>
            <h2 className="text-sm font-medium text-neutral-500 uppercase tracking-wider mb-3">
              {meta.label}
            </h2>
            <div className="rounded-2xl border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 dark:bg-neutral-800">
                  <tr className="text-left">
                    <th className="px-4 py-3 font-medium text-neutral-500">
                      Collection
                    </th>
                    <th className="px-4 py-3 font-medium text-neutral-500">
                      Documents
                    </th>
                    <th className="px-4 py-3 font-medium text-neutral-500" />
                  </tr>
                </thead>
                <tbody>
                  {list.map((c) => (
                    <tr
                      key={c.id}
                      className="border-t hover:bg-neutral-50 dark:hover:bg-neutral-900"
                    >
                      <td className="px-4 py-3 font-medium">{c.name}</td>
                      <td className="px-4 py-3 text-neutral-500">
                        {c.docCount} doc{c.docCount !== 1 ? 's' : ''}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={meta.href(c)}
                          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
