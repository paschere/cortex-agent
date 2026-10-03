import { ExpirationsList } from '@/components/doc-expirations/ExpirationsList';
import { NewExpirationButton } from '@/components/doc-expirations/NewExpiration';
import { ReviewQueue } from '@/components/doc-expirations/ReviewQueue';
import type { Option } from '@/components/doc-expirations/types';
import { PageHeader } from '@/components/ui/page-header';
import { loadTeam } from '@/lib/clients/read';
import {
  KIND_OPTIONS,
  SUBJECT_KIND_OPTIONS,
  type ScreenExpiration,
  buildExpirationsScreen,
} from '@/lib/doc-expirations/grid';
import { requireSession } from '@/lib/session';
import { chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  EXPIRATION_DEFAULT_LEAD_DAYS,
  type ExpirationRow,
  adaptExpiration,
  bogotaToday,
  hydrateExpirations,
  listExpirations,
  listVisibleSpaces,
} from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { CalendarClock } from 'lucide-react';
import Link from 'next/link';
import {
  backfillExpirationsAction,
  confirmExpirationAction,
  discardExpirationAction,
  editExpirationCell,
  linkRenewalAction,
  trackExpirationAction,
} from './actions';

/**
 * DOCUMENTOS QUE VENCEN.
 *
 * El SOAT y la tecnomecánica de cada placa, las pólizas, las licencias, los
 * permisos, las habilitaciones, los certificados y los contratos: con su fecha,
 * la frase del documento que la dice, quién los renueva y cuántos días antes
 * se avisa. Dos pestañas:
 *
 *   «Vencimientos»  lo vigilado, en la grilla compartida, con la evidencia y el
 *                   botón para subir la renovación al abrir cada fila.
 *   «Por revisar»   lo que Cortex leyó y nadie ha confirmado. Hasta el clic no
 *                   se vigila (0184, la misma regla de 0069).
 *
 * La renovación de la matrícula mercantil está en Impuestos (0180).
 */

export const dynamic = 'force-dynamic';

export default async function DocumentExpirationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const tab = q.tab === 'revisar' ? 'revisar' : 'lista';
  const subject = typeof q.sujeto === 'string' ? q.sujeto.slice(0, 80) : undefined;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();

  const [watchedRows, pendingRows, team, spaces] = await Promise.all([
    listExpirations(db, { needsReview: false, includeClosed: true, limit: 500 }),
    listExpirations(db, { needsReview: true, limit: 200 }),
    loadTeam(db).catch(() => []),
    // Sin saber qué espacios ve, no se enseña ninguna cita.
    listVisibleSpaces(db, user.id).catch(() => []),
  ]);
  const visible = new Set(spaces.map((s) => s.id));
  const [watched, pending] = await Promise.all([
    hydrateExpirations(db, watchedRows),
    hydrateExpirations(db, pendingRows),
  ]);
  const adapt = (r: ExpirationRow): ScreenExpiration => ({
    ...adaptExpiration(r, today, visible),
    ownerId: r.owner_user_id,
    spaceId: r.space_id,
  });
  const teamOptions: Option[] = team.map((m) => ({ value: m.id, label: m.name }));
  const screen = buildExpirationsScreen(watched.map(adapt), pending.map(adapt), teamOptions);
  const urgent = watched
    .map(adapt)
    .filter((e) => e.status === 'vencido' || e.status === 'por_vencer').length;

  const tabs = [
    {
      id: 'lista',
      label: 'Vencimientos',
      href: '/documentos-vencen',
      count: urgent,
      tone: 'rose' as const,
    },
    {
      id: 'revisar',
      label: 'Por revisar',
      href: '/documentos-vencen?tab=revisar',
      count: screen.review.length,
      tone: 'amber' as const,
    },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Documentos que vencen"
        subtitle="SOAT, tecnomecánica, pólizas, licencias, permisos y contratos: cuándo vencen, de dónde salió cada fecha y quién los renueva. La renovación de la Cámara de Comercio está en Impuestos."
        icon={<CalendarClock className="h-5 w-5" aria-hidden />}
      />

      <nav
        className="mb-5 flex gap-1 border-b border-border"
        aria-label="Secciones de documentos que vencen"
      >
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            aria-current={tab === t.id ? 'page' : undefined}
            className={clsx(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold transition-colors duration-150 motion-reduce:transition-none',
              tab === t.id
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
            {t.count > 0 && <span className={chipClass(t.tone)}>{t.count}</span>}
          </Link>
        ))}
      </nav>

      {tab === 'revisar' ? (
        <ReviewQueue
          items={screen.review}
          kinds={KIND_OPTIONS}
          team={teamOptions}
          onConfirm={confirmExpirationAction}
          onDiscard={discardExpirationAction}
        />
      ) : (
        <ExpirationsList
          columns={screen.columns}
          rows={screen.rows}
          details={screen.details}
          presets={screen.presets}
          initialSearch={subject}
          pending={screen.review.length}
          reviewHref="/documentos-vencen?tab=revisar"
          handlers={{
            edit: editExpirationCell,
            linkRenewal: linkRenewalAction,
            backfill: backfillExpirationsAction,
          }}
          createSlot={
            <NewExpirationButton
              kinds={KIND_OPTIONS}
              subjectKinds={SUBJECT_KIND_OPTIONS}
              team={teamOptions}
              leadDays={EXPIRATION_DEFAULT_LEAD_DAYS}
              onTrack={trackExpirationAction}
            />
          }
        />
      )}
    </div>
  );
}
