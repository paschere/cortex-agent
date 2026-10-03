import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import { type QuoteFacts, matchQuoteToOpportunity, quoteStageRule } from './rules';
import { type OpportunityRow, isClosedStage } from './shape';
import { OPP_COLUMNS, loadStages, updateOpportunity } from './store';

/**
 * LO QUE PASA EN VENTAS MUEVE EL EMBUDO (migración 0193).
 *
 * `reconcileQuoteStages` aplica las reglas de crm/rules.ts a las oportunidades
 * atadas a una cotización (y ata sola la cotización nueva de un cliente con UN
 * negocio abierto). Es idempotente: correrla dos veces no deja dos huellas,
 * porque la segunda no encuentra nada que mover.
 *
 * La llaman:
 *   - sales/store.ts → recordSalesEvent, al enviar, aceptar, rechazar o
 *     convertir una cotización (con `quoteId`: sólo esa).
 *   - la pantalla /comercial y el piloto de la mañana (sin `quoteId`): así una
 *     cotización que VENCIÓ —que no deja evento— también mueve su negocio.
 *
 * Nunca lanza hacia Ventas: quien la llama desde allá la envuelve en un try.
 */

interface QuoteRow {
  id: string;
  number: number;
  status: string;
  valid_until: string | null;
  client_id: string | null;
  created_at: string;
}

export interface ReconcileChange {
  opportunityId: string;
  title: string;
  stage: string | null;
  reason: string;
}

export async function reconcileQuoteStages(
  db: SupabaseClient,
  opts: { today?: string; quoteId?: string } = {},
): Promise<ReconcileChange[]> {
  const today = opts.today ?? bogotaToday();
  const { stages } = await loadStages(db);

  // 1. Las oportunidades que importan: las atadas (a esa cotización, o a
  //    cualquiera) y, para atar solas, las abiertas sin cotización.
  let linkedQ = db.from('crm_opportunities').select(OPP_COLUMNS).not('quote_id', 'is', null);
  if (opts.quoteId) linkedQ = linkedQ.eq('quote_id', opts.quoteId);
  const linked = await linkedQ.limit(2000);
  if (linked.error) throw linked.error;
  const opps = (linked.data ?? []) as unknown as OpportunityRow[];

  // 2. Atar sola la cotización nueva de un cliente con un solo negocio abierto.
  const quoteIds = new Set(opps.map((o) => o.quote_id as string));
  if (opts.quoteId && !quoteIds.has(opts.quoteId)) {
    const q = await db
      .from('sales_documents')
      .select('id, number, status, valid_until, client_id, created_at')
      .eq('id', opts.quoteId)
      .eq('kind', 'quote')
      .maybeSingle();
    if (q.error) throw q.error;
    const quote = q.data as QuoteRow | null;
    if (quote?.client_id) {
      const open = await db
        .from('crm_opportunities')
        .select(OPP_COLUMNS)
        .eq('client_id', quote.client_id)
        .is('quote_id', null)
        .is('won_at', null)
        .is('lost_at', null)
        .limit(20);
      if (open.error) throw open.error;
      const candidates = (open.data ?? []) as unknown as OpportunityRow[];
      const match = matchQuoteToOpportunity(
        { clientId: quote.client_id, createdAt: quote.created_at },
        candidates,
        stages,
      );
      const chosen = candidates.find((c) => c.id === match);
      if (chosen) {
        const { error } = await db
          .from('crm_opportunities')
          .update({ quote_id: quote.id })
          .eq('id', chosen.id)
          .is('quote_id', null);
        // Otra oportunidad ya la tenía (índice único): no se ata, no es un error.
        if (!error) {
          opps.push({ ...chosen, quote_id: quote.id });
          quoteIds.add(quote.id);
        }
      }
    }
  }
  if (opps.length === 0) return [];

  // 3. Las cotizaciones y sus pedidos.
  const ids = [...quoteIds];
  const [quotes, orders] = await Promise.all([
    db
      .from('sales_documents')
      .select('id, number, status, valid_until, client_id, created_at')
      .in('id', ids),
    db
      .from('sales_documents')
      .select('id, source_id')
      .eq('kind', 'order')
      .neq('status', 'anulada')
      .in('source_id', ids),
  ]);
  if (quotes.error) throw quotes.error;
  if (orders.error) throw orders.error;
  const orderBy = new Map(
    ((orders.data ?? []) as Array<{ id: string; source_id: string }>).map((o) => [
      o.source_id,
      o.id,
    ]),
  );
  const quoteBy = new Map(((quotes.data ?? []) as QuoteRow[]).map((q) => [q.id, q]));

  // 4. Las reglas.
  const changes: ReconcileChange[] = [];
  for (const opp of opps) {
    const quote = quoteBy.get(opp.quote_id as string);
    if (!quote) continue;
    if (isClosedStage(stages, opp.stage) && opp.order_id) continue;
    const facts: QuoteFacts = {
      id: quote.id,
      label: `COT-${quote.number}`,
      status: quote.status,
      validUntil: quote.valid_until,
      orderId: orderBy.get(quote.id) ?? null,
    };
    const change = quoteStageRule(opp, facts, stages, today);
    if (!change) continue;
    await updateOpportunity(
      db,
      opp.id,
      {
        ...(change.stage ? { stage: change.stage } : {}),
        ...(change.orderId ? { orderId: change.orderId } : {}),
      },
      { userId: null, origin: 'rule', reason: change.reason },
    );
    changes.push({
      opportunityId: opp.id,
      title: opp.title,
      stage: change.stage,
      reason: change.reason,
    });
  }
  return changes;
}
