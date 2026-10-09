import { fetchUserNames } from '@/app/api/admin/_lib/audit-filters';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { loadActivity, loadUndoneIds, loadWeek } from '@/lib/activity/load';
import { parseActivityFilter } from '@/lib/activity/scope';
import {
  type ActivityLine,
  buildTimeline,
  groupByDay,
  weeklyCounts,
  weeklySentence,
} from '@/lib/activity/timeline';
import { ACTIVITY_FILTERS, ACTIVITY_FILTER_LABEL, type ActivityGroup } from '@/lib/activity/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { isCompanyManager } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  CalendarClock,
  FileText,
  History,
  LayoutPanelTop,
  Mail,
  MessageCircle,
  Sparkles,
  Table2,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { UndoButton } from './_components/UndoButton';

export const dynamic = 'force-dynamic';

const ICON: Record<ActivityGroup, typeof Mail> = {
  email: Mail,
  message: MessageCircle,
  rows: Table2,
  calendar: CalendarClock,
  money: Wallet,
  document: FileText,
  view: LayoutPanelTop,
  other: Sparkles,
};

const TZ = 'America/Bogota';
const hour = (iso: string) =>
  new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );

/**
 * LO QUE HIZO CORTEX, EN FRASES.
 *
 * Quien administra la empresa ve todo; cualquier otra persona, sólo lo que se
 * hizo con su sesión (ver `lib/activity/scope.ts`, y la consulta ya viene
 * acotada). «Deshacer» sólo sale cuando la acción es reversible y la auditoría
 * guardó lo necesario (`lib/activity/undo.ts`).
 */
export default async function ActividadPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]?.[0] : (sp[k] as string | undefined));
  const filter = parseActivityFilter(one('filtro'));
  const cursor = one('desde') ?? null;
  const db = getOrgScopedClient(user.organization.id);
  const isManager = user.role === 'org_admin' || (await isCompanyManager(db, user.id));
  const viewer = { id: user.id, isManager };
  const mandateParam = one('permiso');
  const mandateId =
    isManager && mandateParam && /^[0-9a-f-]{36}$/i.test(mandateParam) ? mandateParam : undefined;

  const [page, week] = await Promise.all([
    loadActivity(db, viewer, { filter, cursor, mandateId }),
    loadWeek(db, viewer),
  ]);
  const undone = await loadUndoneIds(
    db,
    page.events.map((e) => e.id),
  );
  const lines = buildTimeline(page.events, { undoneIds: undone });
  const days = groupByDay(lines);
  const names = isManager
    ? await fetchUserNames(
        db,
        lines.map((l) => l.userId),
      )
    : {};
  const summary = weeklySentence(weeklyCounts(week));

  const href = (patch: Record<string, string | null>) => {
    const qs = new URLSearchParams();
    const next = { filtro: filter === 'all' ? null : filter, permiso: mandateId ?? null, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) qs.set(k, v);
    const s = qs.toString();
    return `/actividad${s ? `?${s}` : ''}`;
  };

  return (
    <>
      <PageHeader
        title="Lo que hizo Cortex"
        subtitle={
          isManager
            ? 'Todo lo que hizo en la empresa, en frases. Lo que se puede deshacer trae su botón.'
            : 'Lo que hizo por ti, en frases. Lo que se puede deshacer trae su botón.'
        }
        icon={<History className="h-5 w-5" />}
      />

      <div className="space-y-4">
        <Panel className="p-4">
          <p className="text-sm font-semibold text-ink">{summary}</p>
        </Panel>

        <nav aria-label="Filtrar" className="flex flex-wrap gap-2">
          {ACTIVITY_FILTERS.map((f) => (
            <Link
              key={f}
              href={href({ filtro: f === 'all' ? null : f, desde: null })}
              aria-current={f === filter ? 'page' : undefined}
              className={clsx(
                'inline-flex min-h-9 items-center rounded-pill border px-3.5 text-sm font-semibold transition-colors',
                f === filter
                  ? 'border-primary bg-primary-soft text-primary-ink'
                  : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              {ACTIVITY_FILTER_LABEL[f]}
            </Link>
          ))}
          {mandateId && (
            <Link
              href={href({ permiso: null, desde: null })}
              className="inline-flex min-h-9 items-center rounded-pill border border-border-strong bg-surface px-3.5 text-sm font-semibold text-ink-muted hover:bg-surface-2"
            >
              Solo lo de un permiso · quitar
            </Link>
          )}
        </nav>

        {days.length === 0 ? (
          <Panel className="px-4 py-12 text-center">
            <History className="mx-auto mb-3 h-6 w-6 text-ink-faint" />
            <p className="text-sm font-semibold text-ink">
              {cursor ? 'No hay más movimientos' : 'Todavía no hay nada que mostrar aquí'}
            </p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-muted">
              Cuando Cortex envíe, cree o cambie algo, aparecerá aquí con una frase clara.
            </p>
          </Panel>
        ) : (
          days.map((day) => (
            <section key={day.day} aria-label={day.label}>
              <h2 className="mb-2 px-1 text-micro font-bold uppercase tracking-field text-ink-faint">
                {day.label}
              </h2>
              <Panel className="divide-y divide-border">
                {day.lines.map((line) => (
                  <Line
                    key={line.key}
                    line={line}
                    who={isManager ? names[line.userId] : undefined}
                    me={line.userId === user.id}
                  />
                ))}
              </Panel>
            </section>
          ))
        )}

        {page.nextCursor && (
          <div className="flex justify-center">
            <Link
              href={href({ desde: page.nextCursor })}
              className="inline-flex min-h-10 items-center rounded-pill border border-border-strong bg-surface px-4 text-sm font-semibold text-ink shadow-card hover:bg-surface-2"
            >
              Ver más antiguo
            </Link>
          </div>
        )}
      </div>
    </>
  );
}

const HOW: Record<ActivityLine['how'], string | null> = {
  auto: 'Lo hice solo',
  approved: 'Lo aprobaste',
  direct: null,
};

function Line({ line, who, me }: { line: ActivityLine; who?: string; me: boolean }) {
  const Icon = ICON[line.group];
  const how = HOW[line.how];
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span
        className={clsx(
          'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-pill',
          line.failed ? 'bg-rose-soft text-rose' : 'bg-primary-soft text-primary',
        )}
      >
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={clsx('text-sm text-ink', line.failed && 'text-rose')}>{line.text}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-ink-faint">
          <span className="tabular">{hour(line.at)}</span>
          {who && !me && <span>· {who}</span>}
          {how && <span>· {how}</span>}
        </p>
      </div>
      {line.undoLabel && <UndoButton eventIds={line.eventIds} label={line.undoLabel} />}
    </div>
  );
}
