import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { assertCorporateFounder, listTeamActivity } from '@/lib/team-activity';
import { FileBarChart, MessagesSquare, ShieldCheck, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

function when(value: string): string {
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(new Date(value));
}

export default async function TeamActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ member?: string; type?: string }>;
}) {
  const user = await requireSession();
  try {
    assertCorporateFounder(user);
  } catch {
    notFound();
  }
  const search = await searchParams;
  const type = search.type === 'conversation' || search.type === 'report' ? search.type : null;
  const memberId = /^[0-9a-f-]{36}$/i.test(search.member ?? '') ? search.member : null;
  const snapshot = await listTeamActivity(getOrgScopedClient(user.organization.id), {
    memberId,
    type,
  });

  const filterHref = (next: { type?: string; member?: string }) => {
    const params = new URLSearchParams();
    if (next.type) params.set('type', next.type);
    if (next.member) params.set('member', next.member);
    return `/team/activity${params.size ? `?${params}` : ''}`;
  };

  return (
    <>
      <PageHeader
        title="Actividad del equipo"
        subtitle={`Supervisión de conversaciones e informes dentro de ${user.organization.name}.`}
        icon={<UsersRound className="h-5 w-5" />}
      />

      <div className="mb-5 flex items-start gap-3 rounded-card border border-sky/25 bg-sky-soft px-4 py-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-ink">Supervisión corporativa visible</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            El fundador puede revisar el trabajo realizado en esta empresa. Los espacios personales,
            sus chats y sus informes quedan excluidos. Esta vista no permite escribir ni actuar como
            otra persona.
          </p>
        </div>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Panel className="p-4">
          <p className="field-label">Personas</p>
          <p className="mt-2 text-2xl font-semibold tabular text-ink">{snapshot.members.length}</p>
        </Panel>
        <Panel className="p-4">
          <p className="field-label">Chats recientes</p>
          <p className="mt-2 text-2xl font-semibold tabular text-ink">
            {snapshot.totals.conversations}
          </p>
        </Panel>
        <Panel className="p-4">
          <p className="field-label">Informes recientes</p>
          <p className="mt-2 text-2xl font-semibold tabular text-ink">{snapshot.totals.reports}</p>
        </Panel>
      </div>

      <nav aria-label="Filtros de actividad" className="mb-4 flex flex-wrap gap-2">
        {[
          ['Todo', null],
          ['Conversaciones', 'conversation'],
          ['Informes', 'report'],
        ].map(([label, value]) => (
          <Link
            key={label}
            href={filterHref({ type: value ?? undefined, member: memberId ?? undefined })}
            className={`rounded-pill border px-3 py-1.5 text-xs font-semibold transition-colors ${
              type === value
                ? 'border-primary bg-primary-soft text-primary-ink'
                : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink'
            }`}
          >
            {label}
          </Link>
        ))}
        {snapshot.members.map((member) => (
          <Link
            key={member.id}
            href={filterHref({ type: type ?? undefined, member: member.id })}
            className={`rounded-pill border px-3 py-1.5 text-xs font-semibold transition-colors ${
              memberId === member.id
                ? 'border-ink bg-ink text-surface'
                : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink'
            }`}
          >
            {member.name || member.email}
          </Link>
        ))}
      </nav>

      <Panel className="overflow-hidden">
        {snapshot.items.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-semibold text-ink">No hay actividad con estos filtros</p>
            <p className="mt-1 text-xs text-ink-muted">
              Cuando el equipo converse con Cortex o genere informes, aparecerán aquí.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {snapshot.items.map((item) => (
              <li key={`${item.type}:${item.id}`}>
                <Link
                  href={`/team/activity/${item.type}/${item.id}`}
                  className="group flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2 sm:px-5"
                >
                  <span className="mt-0.5 rounded-control bg-surface-2 p-2 text-ink-muted group-hover:text-primary">
                    {item.type === 'conversation' ? (
                      <MessagesSquare className="h-4 w-4" aria-hidden />
                    ) : (
                      <FileBarChart className="h-4 w-4" aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">
                      {item.title}
                    </span>
                    <span className="mt-1 block text-xs text-ink-muted">
                      {item.member?.name || item.member?.email || 'Generado automáticamente'} ·{' '}
                      {item.summary}
                    </span>
                  </span>
                  <time className="hidden shrink-0 text-micro text-ink-faint sm:block">
                    {when(item.occurredAt)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
