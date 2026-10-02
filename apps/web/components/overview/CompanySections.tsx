import 'server-only';

/**
 * Las dos secciones lentas de la ficha de una empresa propia
 * (/overview/companies/[id]): cómo va su negocio y lo que pasó en ella. Cada
 * una va en su propio Suspense, así que el plan y el equipo —que son conteos
 * baratos— se ven antes, y si una de estas falla la otra sigue.
 *
 * Quién puede verlas lo decidió la página: la empresa llega de
 * `requireFounderContext().owned`, nunca de la URL.
 */

import { DayJournal } from '@/app/(app)/dashboard/_components/DayJournal';
import { Panel } from '@/components/ui/panel';
import { directoryUserId, readCompanyBusiness } from '@/lib/founder-business';
import { companyStatus, pulseHref, rankActionItems } from '@/lib/founder-business-shape';
import type { CompanyHealth } from '@/lib/founder-console';
import { buildConsoleRows } from '@/lib/founder-console-shape';
import { type OwnedCompany, asOwnedWorkspace } from '@/lib/founder-guard';
import { readFounderOverview } from '@/lib/founder-overview';
import { readJournal } from '@/lib/journal';
import type { Journal, JournalLine } from '@/lib/journal-shape';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import { ArrowRight, Gauge, UserPlus } from 'lucide-react';
import { ActNowList, BrandMark, BusinessFacts, StatusChip } from './BusinessPieces';
import { OpenWorkspace } from './OpenWorkspace';

export async function CompanyBusinessSection({
  company,
  email,
  health,
}: {
  company: OwnedCompany;
  email: string;
  health: CompanyHealth;
}) {
  const now = new Date();
  const [business, overview] = await Promise.all([
    readCompanyBusiness(company, email, now),
    readFounderOverview([asOwnedWorkspace(company)], email),
  ]);
  const [row] = buildConsoleRows(overview, { [company.id]: health }, {}, '');
  if (!row) return null;
  const status = companyStatus(row, business, now);
  const items = rankActionItems([{ row, business }], { now, limit: 5, perCompany: 5 });
  const decisions = row.pulse.status === 'ready' ? row.pulse.approvals + row.pulse.actions : null;

  return (
    <Panel className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <BrandMark name={company.name} brand={business.brand} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-extrabold text-ink">Cómo va</h2>
          <p className="text-xs text-ink-muted">
            {status.reasons.length > 0
              ? status.reasons.join(' · ')
              : 'Las cifras de su Inicio, leídas ahora.'}
          </p>
        </div>
        <StatusChip status={status} />
      </div>
      <BusinessFacts business={business} decisions={decisions} now={now} columns="wide" />
      {items.length > 0 && (
        <div className="mt-5">
          <h3 className="field-label mb-2">Dónde actuar</h3>
          <ActNowList items={items} loading={false} showCompany={false} />
        </div>
      )}
      <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
        <OpenWorkspace
          workspaceId={company.id}
          href="/dashboard"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-4 text-xs font-bold text-white transition-colors hover:bg-primary-strong disabled:opacity-60"
        >
          Entrar <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </OpenWorkspace>
        <a
          href={pulseHref(company.id, company.name, business.pulseView)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
        >
          <Gauge className="h-3.5 w-3.5" aria-hidden /> Ver su pulso
        </a>
        <a
          href={workspaceHref(company.id, '/admin/users')}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
        >
          <UserPlus className="h-3.5 w-3.5" aria-hidden /> Invitar
        </a>
      </div>
    </Panel>
  );
}

export function CompanyBusinessSkeleton() {
  return (
    <Panel className="p-5" aria-busy>
      <div className="mb-4 flex items-center gap-3">
        <span className="h-12 w-12 animate-pulse rounded-sm bg-surface-2" />
        <span className="h-5 w-40 animate-pulse rounded-sm bg-surface-2" />
      </div>
      <BusinessFacts business={undefined} decisions={null} now={new Date()} columns="wide" />
    </Panel>
  );
}

/** Los enlaces del parte abren la pantalla de ESTA empresa, no la de la pestaña. */
function scoped(journal: Journal, organizationId: string): Journal {
  const fix = (line: JournalLine): JournalLine => ({
    ...line,
    href: line.href?.startsWith('/') ? workspaceHref(organizationId, line.href) : line.href,
  });
  return {
    ...journal,
    days: journal.days.map((day) => ({ ...day, lines: day.lines.map(fix) })),
    lingering: journal.lingering.map(fix),
  };
}

export async function CompanyRecentActivity({
  company,
  email,
}: {
  company: OwnedCompany;
  email: string;
}) {
  const userId = await directoryUserId(getOrgScopedClient(company.id), email).catch(() => null);
  if (!userId)
    return (
      <Panel className="p-5 text-xs text-ink-muted">
        No se pudo leer lo que pasó en esta empresa. Entra a ella para ver su jornada.
      </Panel>
    );
  const journal = await readJournal(company.id, userId, { isAdmin: true }).catch((err) => {
    console.error('[overview] no se pudo leer la jornada', company.id, err);
    return null;
  });
  if (!journal)
    return (
      <Panel className="p-5 text-xs text-ink-muted">
        No se pudo leer lo que pasó en esta empresa. Entra a ella para ver su jornada.
      </Panel>
    );
  return (
    <DayJournal
      journal={scoped(journal, company.id)}
      limit={8}
      href={workspaceHref(company.id, '/dashboard/jornada')}
    />
  );
}
