import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { Radar } from 'lucide-react';
import { ProspectBoard } from './_components/ProspectBoard';
import type { ContactConfidence, Prospect, SignalStatus } from './_components/types';

export const dynamic = 'force-dynamic';

/**
 * The prospecting list: every company Zippy has caught hiring for a role Zipdev
 * fills. The sweep runs weekly and nothing is ever deleted, so this grows by
 * roughly fifteen rows a week — the whole set is handed to the client, which
 * filters, searches and counts it. That keeps the funnel numbers and the list
 * derived from exactly the same data, which is what makes an optimistic status
 * change look right the instant it is clicked.
 *
 * The cap is a guard for years from now, not a paging story; if it is ever hit
 * the oldest rows drop off and the board says so.
 */
const MAX_ROWS = 500;

interface SignalRow {
  id: string;
  company: string;
  role_title: string;
  url: string;
  source: string;
  summary: string | null;
  region: string | null;
  status: string;
  contact_name: string | null;
  contact_title: string | null;
  contact_path: string | null;
  contact_confidence: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

const STATUSES = new Set<string>(['new', 'qualified', 'rejected', 'contacted']);
const CONFIDENCES = new Set<string>(['found', 'inferred', 'unknown']);

export default async function ProspectsPage() {
  await requireSession();
  const db = getSupabaseServiceClient();

  const { data } = await db
    .from('growth_signals')
    .select(
      'id, company, role_title, url, source, summary, region, status, contact_name, contact_title, contact_path, contact_confidence, created_at, reviewed_at, reviewed_by',
    )
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);

  const rows = (data ?? []) as unknown as SignalRow[];

  // Reviewers resolved in one go — a card says "Qualified by Ana", never an id.
  const reviewerIds = [...new Set(rows.map((r) => r.reviewed_by).filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  if (reviewerIds.length > 0) {
    const { data: users } = await db.from('users').select('id, name, email').in('id', reviewerIds);
    for (const u of users ?? []) {
      const label = (u.name as string | null) ?? (u.email as string);
      // Falling back to the local part of the address keeps it a name, not a
      // mail route: "ana", never "ana@zipdev.com".
      names.set(u.id as string, label.split('@')[0] ?? label);
    }
  }

  const prospects: Prospect[] = rows.map((r) => ({
    id: r.id,
    company: r.company,
    roleTitle: r.role_title,
    url: r.url,
    source: r.source,
    summary: r.summary,
    region: r.region,
    // A status the app does not know how to show would be a row nobody can act
    // on; treating it as new puts it back in front of a human.
    status: (STATUSES.has(r.status) ? r.status : 'new') as SignalStatus,
    contactName: r.contact_name,
    contactTitle: r.contact_title,
    contactPath: r.contact_path,
    contactConfidence: (r.contact_confidence && CONFIDENCES.has(r.contact_confidence)
      ? r.contact_confidence
      : null) as ContactConfidence | null,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    reviewerName: r.reviewed_by ? (names.get(r.reviewed_by) ?? null) : null,
  }));

  return (
    <>
      <PageHeader
        title="Prospects"
        subtitle="Companies Zippy caught hiring for roles Zipdev fills. Keep the good ones, drop the rest — nothing here is ever deleted."
        icon={<Radar className="h-5 w-5" />}
      />
      <ProspectBoard
        prospects={prospects}
        truncated={rows.length >= MAX_ROWS}
        // Resolved on the server so the client bundle never touches the tools
        // package. Without a key the research buttons would only ever fail.
        apolloAvailable={Boolean(process.env.APOLLO_API_KEY)}
      />
    </>
  );
}
