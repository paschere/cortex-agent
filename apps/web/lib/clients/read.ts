import 'server-only';
import { ENTITY_KIND_LABEL, METHOD_LABEL, METHOD_SENTENCE } from '@/lib/clients-shape';
import {
  type LinkEntityKind,
  type LinkMethod,
  accountingCustomersMissing,
  duplicatePairs,
  groupProposals,
  listAliases,
  listClients,
  loadClientIndex,
  unlinkedCounterparties,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AccountingConflictView,
  BacklogView,
  DuplicateView,
  Piece,
  ProposalGroupView,
  TeamMember,
} from './types';
import { dayLabel } from './view360';

/**
 * LO QUE LAS PÁGINAS DE CLIENTES LEEN APARTE DE LA LISTA Y LA FICHA: el equipo
 * (para «responsable») y la cola de «Por confirmar». Cada parte, si falla,
 * queda en «sin dato» sin tumbar la página.
 */

async function settle<T>(work: () => Promise<T>, error: string): Promise<Piece<T>> {
  try {
    return { ok: true, data: await work() };
  } catch {
    return { ok: false, error };
  }
}

/** La gente del espacio, para elegir responsable. */
export async function loadTeam(db: SupabaseClient): Promise<TeamMember[]> {
  const { data, error } = await db.from('users').select('id, name, email').limit(500);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; name: string | null; email: string }>)
    .map((u) => ({ id: u.id, name: u.name?.trim() || u.email }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

const SYSTEM_LABEL: Record<string, string> = {
  siigo: 'Siigo',
  alegra: 'Alegra',
  quickbooks: 'QuickBooks',
};

/** Las evidencias que son un NOMBRE: confirmarlas puede enseñarle el nombre a Cortex. */
const NAME_METHODS = new Set<LinkMethod>(['name_exact', 'name_partial']);

export interface ReviewQueue {
  groups: Piece<ProposalGroupView[]>;
  duplicates: Piece<DuplicateView[]>;
  backlog: Piece<BacklogView[]>;
  conflicts: Piece<AccountingConflictView[]>;
  total: number;
}

/** La pestaña «Por confirmar»: propuestas agrupadas, posibles duplicados y lo suelto. */
export async function loadReviewQueue(db: SupabaseClient): Promise<ReviewQueue> {
  const [groups, duplicates, backlog, conflicts] = await Promise.all([
    settle(async () => {
      const { data, error } = await db
        .from('client_links')
        .select(
          'id, client_id, entity_kind, entity_id, entity_ref, method, evidence, label, occurred_at, created_at',
        )
        .eq('state', 'suggested')
        .order('created_at', { ascending: false })
        .limit(3000);
      if (error) throw error;
      const rows = (data ?? []) as Parameters<typeof groupProposals>[0];
      const ids = [...new Set(rows.map((r) => r.client_id))];
      const names = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 100) {
        const read = await db
          .from('clients')
          .select('id, name')
          .in('id', ids.slice(i, i + 100));
        if (read.error) throw read.error;
        for (const c of (read.data ?? []) as Array<{ id: string; name: string }>)
          names.set(c.id, c.name);
      }
      return groupProposals(rows, names).map(
        (g): ProposalGroupView => ({
          key: g.key,
          ids: g.ids,
          clientId: g.clientId,
          clientName: g.clientName,
          kindLabel: ENTITY_KIND_LABEL[g.kind as LinkEntityKind] ?? g.kind,
          methodLabel: METHOD_LABEL[g.method as LinkMethod] ?? g.method,
          why: METHOD_SENTENCE[g.method as LinkMethod] ?? '',
          evidence: g.evidence,
          count: g.ids.length,
          samples: g.samples.map((s) => ({
            label: s.label,
            date: s.occurredAt ? dayLabel(s.occurredAt) : null,
          })),
          rivals: g.rivals,
          canLearnAlias:
            NAME_METHODS.has(g.method as LinkMethod) &&
            (g.kind === 'ledger_movement' ||
              g.kind === 'invoice' ||
              g.kind === 'extraction' ||
              g.kind === 'commitment') &&
            g.evidence.length >= 3 &&
            g.evidence.length <= 120,
        }),
      );
    }, 'No pude leer las propuestas.'),
    settle(async () => {
      const [clients, aliases] = await Promise.all([
        listClients(db, { limit: 2000 }),
        listAliases(db).catch(() => []),
      ]);
      return duplicatePairs(clients, aliases);
    }, 'No pude buscar clientes repetidos.'),
    settle(async () => {
      const [rows, clients] = await Promise.all([
        unlinkedCounterparties(db, 12),
        listClients(db, { limit: 2000 }),
      ]);
      const byId = new Map(clients.map((c) => [c.id, c.name]));
      return rows.map((b) => ({
        counterparty: b.counterparty,
        count: b.count,
        candidates: b.candidates
          .filter((cand) => byId.has(cand.clientId))
          .map((cand) => ({
            id: cand.clientId,
            name: byId.get(cand.clientId) as string,
            why: cand.method === 'tax_id' ? `coincide el ${cand.evidence}` : 'coincide el nombre',
          })),
      }));
    }, 'No pude leer las contrapartes sin cliente.'),
    settle(async () => {
      const index = await loadClientIndex(db);
      const { conflicts } = await accountingCustomersMissing(db, index);
      return conflicts.slice(0, 40).map((c) => ({
        name: c.name,
        nit: c.taxId,
        system: SYSTEM_LABEL[c.system] ?? c.system,
      }));
    }, 'No pude revisar los clientes del programa contable.'),
  ]);
  const total =
    (groups.ok ? groups.data.reduce((s, g) => s + g.count, 0) : 0) +
    (duplicates.ok ? duplicates.data.length : 0) +
    (backlog.ok ? backlog.data.length : 0) +
    (conflicts.ok ? conflicts.data.length : 0);
  return { groups, duplicates, backlog, conflicts, total };
}
