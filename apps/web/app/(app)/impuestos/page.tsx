import { TaxHome } from '@/components/tax/TaxHome';
import type { TaxLinks, TaxPerson } from '@/components/tax/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { RUT_PROMPT, buildTaxScreen, nitFromFacts } from '@/lib/tax/screen';
import { workspaceHref } from '@/lib/workspace-context';
import {
  RULE_VERSION_BY_YEAR,
  VERIFIED_DIAN_2026,
  bogotaToday,
  buildTaxCalendar,
  canMarkTaxObligations,
  isCompanyManager,
  listDirectory,
  listTaxObligations,
  loadCompanyFactsContext,
  personLabel,
  readTaxProfile,
  supportedYears,
  syncTaxCalendar,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { markTaxObligationAction, saveTaxProfileAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * IMPUESTOS (0180): el calendario tributario de la empresa. Cualquiera de la
 * empresa lo ve; el perfil lo cambia quien administra o es dueño, y marcar lo
 * hace el responsable de los impuestos o quien administra (lo vuelve a
 * revisar cada acción de servidor).
 *
 * Abrir la pantalla pone el calendario al día si las reglas del año cambiaron
 * de versión (o si todavía no se había generado): la sincronización es
 * idempotente y no toca lo que alguien ya marcó.
 *
 * Parámetro: `?anio=2027`.
 */
export default async function TaxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const thisYear = Number(today.slice(0, 4));
  const years = supportedYears().filter((y) => y >= thisYear - 1 && y <= thisYear + 1);
  const raw = (await searchParams).anio;
  const asked = typeof raw === 'string' ? Number(raw) : Number.NaN;
  const year = years.includes(asked)
    ? asked
    : years.includes(thisYear)
      ? thisYear
      : (years[0] ?? thisYear);

  const [profile, canEdit, directory, facts] = await Promise.all([
    readTaxProfile(db),
    isCompanyManager(db, user.id),
    listDirectory(db).catch(() => []),
    loadCompanyFactsContext(db).catch(() => []),
  ]);

  if (profile) {
    const current = await listTaxObligations(db, { year: thisYear, limit: 1 });
    if (current.length === 0 || current[0]?.ruleVersion !== RULE_VERSION_BY_YEAR[thisYear]) {
      await syncTaxCalendar(db, { userId: user.id, today, profile }).catch((err) =>
        logger.error('tax: no se pudo poner al día el calendario', { err }),
      );
    }
  }

  const [obligations, canMark] = await Promise.all([
    profile ? listTaxObligations(db, { year, limit: 1000 }) : Promise.resolve([]),
    canMarkTaxObligations(db, user.id, profile),
  ]);

  const docIds = [
    ...new Set(obligations.map((o) => o.evidenceDocumentId).filter(Boolean)),
  ] as string[];
  const documentTitles = new Map<string, string>();
  if (docIds.length) {
    const { data, error } = await db.from('kb_documents').select('id, title').in('id', docIds);
    if (!error)
      for (const d of (data ?? []) as Array<{ id: string; title: string }>)
        documentTitles.set(d.id, d.title);
  }

  const people: TaxPerson[] = directory.map((p) => ({ id: p.id, name: personLabel(p) }));
  const href = (path: string) => workspaceHref(user.organization.id, path);
  const engine = profile ? buildTaxCalendar(profile, year) : null;

  const data = buildTaxScreen({
    year,
    years,
    today,
    profile,
    obligations,
    gaps: engine?.gaps ?? [],
    sourceLine:
      year === 2026
        ? `${VERIFIED_DIAN_2026}. ICA: resoluciones de Bogotá y Medellín (por confirmar).`
        : `Las fechas de ${year} están calculadas con la regla del Decreto 2229 de 2023 y los festivos, sin compararlas todavía con el calendario oficial: todas van por confirmar.`,
    canEdit,
    canMark,
    people,
    suggestedNit: profile ? null : nitFromFacts(facts),
    documentTitles,
    href,
  });

  const links: TaxLinks = {
    self: href('/impuestos'),
    rutChat: href(`/chat?prompt=${encodeURIComponent(RUT_PROMPT)}`),
    processes: href('/procesos'),
    finance: href('/finance'),
    commitments: href('/commitments'),
    uploadApi: href('/api/kb/documents'),
  };

  return (
    <TaxHome
      data={data}
      links={links}
      actions={{ saveProfile: saveTaxProfileAction, mark: markTaxObligationAction }}
    />
  );
}
