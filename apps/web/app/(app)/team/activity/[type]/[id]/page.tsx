import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { assertCorporateFounder, readTeamActivity } from '@/lib/team-activity';
import { ArrowLeft, FileBarChart, MessagesSquare, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function TeamActivityDetailPage({
  params,
}: {
  params: Promise<{ type: string; id: string }>;
}) {
  const user = await requireSession();
  try {
    assertCorporateFounder(user);
  } catch {
    notFound();
  }
  const { type, id } = await params;
  if (type !== 'conversation' && type !== 'report') notFound();
  const detail = await readTeamActivity(getOrgScopedClient(user.organization.id), type, id);
  if (!detail) notFound();

  return (
    <>
      <Link
        href="/team/activity"
        className="mb-4 inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Actividad del equipo
      </Link>
      <PageHeader
        title={detail.title}
        subtitle={`${detail.member?.name || detail.member?.email || 'Generado automáticamente'} · ${detail.source}`}
        icon={
          detail.type === 'conversation' ? (
            <MessagesSquare className="h-5 w-5" />
          ) : (
            <FileBarChart className="h-5 w-5" />
          )
        }
      />

      <div className="mb-5 flex items-center gap-2 rounded-control border border-border bg-surface-2 px-3 py-2 text-xs text-ink-muted">
        <ShieldCheck className="h-4 w-4 text-emerald" aria-hidden />
        Lectura de supervisión corporativa. No puedes responder, editar ni actuar como esta persona.
      </div>

      {detail.type === 'conversation' ? (
        <Panel className="overflow-hidden">
          <ol className="divide-y divide-border">
            {detail.messages.map((message) => (
              <li key={message.id} className="px-5 py-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="field-label">
                    {message.role === 'user'
                      ? 'Persona'
                      : message.role === 'assistant'
                        ? 'Cortex'
                        : message.role}
                  </span>
                  <time className="text-micro text-ink-faint">
                    {new Intl.DateTimeFormat('es-CO', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: 'America/Bogota',
                    }).format(new Date(message.created_at))}
                  </time>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-ink">
                  {message.content || 'Mensaje sin contenido textual.'}
                </p>
              </li>
            ))}
          </ol>
        </Panel>
      ) : (
        <Panel className="p-5">
          <dl className="grid gap-5 sm:grid-cols-2">
            <div>
              <dt className="field-label">Periodo</dt>
              <dd className="mt-1 text-sm text-ink">{detail.periodLabel}</dd>
            </div>
            <div>
              <dt className="field-label">Tipo de informe</dt>
              <dd className="mt-1 text-sm text-ink">{detail.source}</dd>
            </div>
            {detail.subtitle && (
              <div className="sm:col-span-2">
                <dt className="field-label">Descripción</dt>
                <dd className="mt-1 text-sm leading-6 text-ink">{detail.subtitle}</dd>
              </div>
            )}
          </dl>
          <Link
            href={`/reports/${detail.id}`}
            className="mt-6 inline-flex rounded-control border border-border-strong px-3 py-2 text-xs font-semibold text-ink hover:bg-surface-2"
          >
            Abrir informe completo
          </Link>
        </Panel>
      )}
    </>
  );
}
