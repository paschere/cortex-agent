import 'server-only';
import { loadTeam } from '@/lib/clients/read';
import {
  type CrmAnalytics,
  type CrmBoard,
  type CrmChurnAssessment,
  type NpsResponseRow,
  type NpsSurveyRow,
  assessCrmClientRisk,
  crmAtRiskList,
  listCrmStoredRisk,
  listNpsResponses,
  listNpsSurveys,
  loadCrmAnalytics,
  loadCrmBoard,
  reconcileCrmQuoteStages,
  saveCrmRisk,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CrmTab } from './shape';

/**
 * LAS LECTURAS DE /comercial (0193). Con el handle de la empresa. El tablero
 * se lee siempre (las cifras de arriba lo usan); el riesgo, el análisis y las
 * encuestas sólo en su pestaña, porque leen dos años de facturas o todas las
 * cotizaciones. Lo que falla se nombra en `missing`.
 */

export interface CrmPageData {
  board: CrmBoard;
  team: Array<{ id: string; name: string }>;
  quoteLabels: Map<string, string>;
  clients: Map<string, string>;
  risk: { list: CrmChurnAssessment[]; owners: Map<string, string | null>; count: number | null };
  analytics: CrmAnalytics | null;
  surveys: NpsSurveyRow[];
  responses: NpsResponseRow[];
  missing: string[];
}

export async function loadCrmPage(
  db: SupabaseClient,
  opts: { today: string; tab: CrmTab },
): Promise<CrmPageData> {
  const missing: string[] = [];
  // Una cotización que venció anoche no deja evento: la pantalla pone el
  // embudo al día antes de pintarlo (idempotente).
  await reconcileCrmQuoteStages(db, { today: opts.today }).catch(() => {
    missing.push('la sincronización con Ventas');
    return [];
  });
  const [board, team, stored] = await Promise.all([
    loadCrmBoard(db, { today: opts.today }),
    loadTeam(db).catch(() => []),
    listCrmStoredRisk(db).catch(() => null),
  ]);

  const quoteIds = board.opportunities.map((o) => o.quote_id).filter(Boolean) as string[];
  const clientIds = [...new Set(board.tasks.map((t) => t.client_id).filter(Boolean) as string[])];
  const [quotes, clientRows] = await Promise.all([
    quoteIds.length
      ? db.from('sales_documents').select('id, number').in('id', quoteIds.slice(0, 1000))
      : Promise.resolve({ data: [], error: null }),
    clientIds.length
      ? db.from('clients').select('id, name').in('id', clientIds.slice(0, 1000))
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (quotes.error) missing.push('los números de las cotizaciones');
  if (clientRows.error) missing.push('los nombres de los clientes de las tareas');
  const quoteLabels = new Map(
    ((quotes.data ?? []) as Array<{ id: string; number: number }>).map((q) => [
      q.id,
      `COT-${q.number}`,
    ]),
  );
  const clients = new Map(
    ((clientRows.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );

  let risk: CrmPageData['risk'] = {
    list: [],
    owners: new Map(),
    count: stored ? stored.filter((r) => r.level !== 'bajo').length : null,
  };
  if (opts.tab === 'riesgo') {
    try {
      const read = await assessCrmClientRisk(db, { today: opts.today });
      missing.push(...read.missing);
      const list = crmAtRiskList(read.assessments);
      risk = { list, owners: read.owners, count: list.length };
      // Lo que se ve aquí también queda guardado (sin marcarlo como contado:
      // eso es del piloto).
      await saveCrmRisk(
        db,
        read.assessments
          .filter((a) => a.level !== 'bajo')
          .map((a) => ({
            clientId: a.clientId,
            level: a.level,
            score: a.score,
            evidence: a.signals.map((s) => s.evidence),
            action: a.action,
          })),
      ).catch(() => undefined);
    } catch {
      missing.push('el riesgo de los clientes');
    }
  }

  let analytics: CrmAnalytics | null = null;
  if (opts.tab === 'analisis') {
    analytics = await loadCrmAnalytics(db, { today: opts.today }).catch(() => {
      missing.push('el análisis comercial');
      return null;
    });
  }

  let surveys: NpsSurveyRow[] = [];
  let responses: NpsResponseRow[] = [];
  if (opts.tab === 'encuestas') {
    const [s, r] = await Promise.all([
      listNpsSurveys(db, { limit: 300 }).catch(() => null),
      listNpsResponses(db, { limit: 1000 }).catch(() => null),
    ]);
    if (!s || !r) missing.push('las encuestas');
    surveys = s ?? [];
    responses = r ?? [];
  }

  return { board, team, quoteLabels, clients, risk, analytics, surveys, responses, missing };
}
