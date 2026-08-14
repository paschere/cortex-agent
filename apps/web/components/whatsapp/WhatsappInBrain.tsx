import { Panel } from '@/components/ui/panel';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { ArrowRight, MessageCircle } from 'lucide-react';
import Link from 'next/link';

/**
 * Which WhatsApp groups are feeding Brain Knowledge — READ ONLY, ON PURPOSE.
 *
 * The whole WhatsApp configuration lives in Integrations now, including the
 * choice of groups. There is a real argument for leaving that choice here
 * instead: "qué grupos alimentan el cerebro y a qué espacio van" is a decision
 * about memory, not about connectivity. It lost to a simpler one — a person
 * asking "¿dónde configuro WhatsApp?" must get exactly one answer, and the same
 * switch drawn on two screens is how a setting gets changed in one place and
 * read from the other.
 *
 * What survives here is the part Brain Knowledge genuinely owns: the fact that
 * documents are arriving from a conversation nobody uploaded. It is a statement
 * with a way through to the controls, never a second copy of them.
 */
export async function WhatsappInBrain({ organizationId }: { organizationId: string }) {
  const db = getOrgScopedClient(organizationId);

  const { data: groups } = await db
    .from('whatsapp_groups')
    .select('id, subject, space_id, archive_from, enabled_at')
    .eq('archive_enabled', true)
    .order('enabled_at', { ascending: false })
    .limit(20);

  const rows = (groups ?? []) as Array<{
    id: string;
    subject: string | null;
    space_id: string | null;
    archive_from: string | null;
    enabled_at: string | null;
  }>;
  if (rows.length === 0) return null;

  const spaceIds = [...new Set(rows.map((r) => r.space_id).filter(Boolean) as string[])];
  const names = new Map<string, string>();
  if (spaceIds.length > 0) {
    const { data: spaces } = await db.from('kb_collections').select('id, name').in('id', spaceIds);
    for (const s of spaces ?? []) names.set(s.id as string, s.name as string);
  }

  return (
    <Panel className="mb-5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-emerald-soft text-emerald">
            <MessageCircle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-bold text-ink">
              <span className="tabular">{rows.length}</span>{' '}
              {rows.length === 1 ? 'grupo de WhatsApp está' : 'grupos de WhatsApp están'} entrando
              aquí
            </div>
            <p className="mt-0.5 max-w-xl text-xs leading-snug text-ink-muted">
              Sus conversaciones se guardan como documentos normales, con el nombre de quien
              escribió cada mensaje. Se buscan, se citan y se borran desde el espacio donde caen.
            </p>
          </div>
        </div>
        <Link
          href="/integrations/whatsapp"
          className="inline-flex shrink-0 items-center gap-1 rounded-pill border border-border px-3 py-1.5 text-micro font-semibold text-primary transition-all duration-150 hover:-translate-y-px hover:border-primary/30 hover:shadow-card motion-reduce:transform-none motion-reduce:transition-none"
        >
          Cambiar cuáles
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <ul className="mt-3 grid gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-2">
        {rows.map((g) => (
          <li key={g.id} className="flex items-baseline justify-between gap-3 bg-surface px-3 py-2">
            <span className="truncate text-xs text-ink">
              {g.subject ?? 'Grupo sin nombre'}
            </span>
            <span className="shrink-0 font-mono text-micro text-ink-faint">
              {g.space_id ? (names.get(g.space_id) ?? 'espacio borrado') : 'sin espacio'}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
