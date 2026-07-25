import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';
import {
  BookOpen,
  Globe,
  Users,
  User,
  FolderOpen,
  FileText,
  Layers,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { BrainSearch } from './_components/BrainSearch';

interface Collection {
  id: string;
  name: string;
  scope: 'global' | 'team' | 'user' | 'conversation';
  scope_id: string | null;
}

interface CollectionWithCount extends Collection {
  docCount: number;
  pendingCount: number;
  errorCount: number;
}

const SCOPE_META: Record<
  string,
  { label: string; icon: typeof Globe; href: (c: Collection) => string }
> = {
  global: { label: 'Global', icon: Globe, href: () => '/kb/global' },
  team: { label: 'Team', icon: Users, href: (c) => `/kb/team/${c.scope_id ?? ''}` },
  user: { label: 'Personal', icon: User, href: () => '/kb/me' },
};

export default async function KbIndex() {
  const user = await requireSession();
  const sb = getSupabaseServiceClient();

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

    const filters = ['scope.eq.global', `and(scope.eq.user,scope_id.eq.${user.id})`];
    if (teamIds.length > 0) {
      filters.push(`and(scope.eq.team,scope_id.in.(${teamIds.join(',')}))`);
    }
    colQuery = colQuery.or(filters.join(','));
  }

  const { data: collections } = await colQuery;
  const cols: Collection[] = (collections ?? []) as Collection[];
  const collectionIds = cols.map((c) => c.id);

  // Per-collection document stats (status matters: pending = ingestion queue,
  // error = needs attention).
  const docCounts: Record<string, { total: number; pending: number; error: number }> = {};
  let totalDocs = 0;
  let totalPending = 0;
  let totalErrors = 0;
  if (collectionIds.length > 0) {
    const { data: docs } = await sb
      .from('kb_documents')
      .select('collection_id, status')
      .in('collection_id', collectionIds);
    for (const d of docs ?? []) {
      const cid = d.collection_id as string;
      const status = d.status as string;
      const entry = (docCounts[cid] ??= { total: 0, pending: 0, error: 0 });
      entry.total += 1;
      totalDocs += 1;
      if (status === 'pending' || status === 'processing') {
        entry.pending += 1;
        totalPending += 1;
      } else if (status === 'error' || status === 'failed') {
        entry.error += 1;
        totalErrors += 1;
      }
    }
  }

  let totalChunks = 0;
  if (collectionIds.length > 0) {
    const { count } = await sb
      .from('kb_chunks')
      .select('id, kb_documents!inner(collection_id)', { count: 'exact', head: true })
      .in('kb_documents.collection_id', collectionIds);
    totalChunks = count ?? 0;
  }

  const withCounts: CollectionWithCount[] = cols.map((c) => ({
    ...c,
    docCount: docCounts[c.id]?.total ?? 0,
    pendingCount: docCounts[c.id]?.pending ?? 0,
    errorCount: docCounts[c.id]?.error ?? 0,
  }));

  const stats = [
    { label: 'Collections', value: cols.length, icon: FolderOpen },
    { label: 'Documents', value: totalDocs, icon: FileText },
    { label: 'Chunks indexed', value: totalChunks, icon: Layers },
  ];

  return (
    <>
      <PageHeader
        title="Knowledge Base"
        subtitle="The Zipdev brain — everything here is searchable by Zippy, in every surface"
        icon={<BookOpen className="h-5 w-5" />}
      />

      <div className="space-y-5">
        <BrainSearch collectionIds={collectionIds} />

        <div className="grid grid-cols-3 gap-3">
          {stats.map((s) => (
            <Panel key={s.label} className="flex items-center gap-3 p-4">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
                <s.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="text-lg font-extrabold leading-tight text-ink">{s.value}</div>
                <div className="truncate text-[11px] text-ink-faint">{s.label}</div>
              </div>
            </Panel>
          ))}
        </div>

        {(totalPending > 0 || totalErrors > 0) && (
          <div className="flex items-start gap-2.5 rounded-card border border-amber/30 bg-amber-soft px-4 py-3 text-[12.5px] text-ink">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
            <span>
              {totalPending > 0 && (
                <>
                  <b>{totalPending}</b> document{totalPending === 1 ? '' : 's'} waiting for
                  ingestion{totalErrors > 0 ? ' · ' : '. '}
                </>
              )}
              {totalErrors > 0 && (
                <>
                  <b>{totalErrors}</b> failed — open the collection to review.
                </>
              )}
              {totalPending > 0 && totalErrors === 0 && (
                <span className="text-ink-muted">
                  {' '}
                  Ingestion runs through Inngest — if this number never drops, the integration
                  isn&apos;t active yet.
                </span>
              )}
            </span>
          </div>
        )}

        {cols.length === 0 ? (
          <Panel className="p-10 text-center text-[13px] text-ink-faint">
            <BookOpen className="mx-auto mb-3 h-8 w-8 text-primary" />
            <p className="mb-1 font-semibold text-ink">The brain is empty</p>
            <p>
              <Link href="/kb/me" className="font-semibold text-primary hover:text-primary-strong">
                Create your first collection
              </Link>{' '}
              and upload documents, sync a Drive folder, or ask Zippy to save knowledge as it works.
            </p>
          </Panel>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {withCounts.map((c) => {
              const meta = SCOPE_META[c.scope] ?? SCOPE_META.user!;
              const Icon = meta.icon;
              return (
                <Link key={c.id} href={meta.href(c)} className="group block">
                  <Panel className="flex h-full flex-col gap-3 p-4 transition-all group-hover:-translate-y-0.5 group-hover:shadow-pop">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13.5px] font-bold text-ink">{c.name}</div>
                        <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-ink-faint">
                          <Icon className="h-3 w-3" />
                          {meta.label}
                        </div>
                      </div>
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
                        <FolderOpen className="h-4 w-4" />
                      </span>
                    </div>
                    <div className="mt-auto flex items-center justify-between border-t border-border pt-2.5 text-[11.5px]">
                      <span className="text-ink-faint">
                        {c.docCount} doc{c.docCount === 1 ? '' : 's'}
                        {c.pendingCount > 0 && (
                          <span className="ml-1.5 text-amber">· {c.pendingCount} pending</span>
                        )}
                        {c.errorCount > 0 && (
                          <span className="ml-1.5 text-rose">· {c.errorCount} failed</span>
                        )}
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                    </div>
                  </Panel>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
