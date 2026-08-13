/**
 * Leer los mandatos vigentes y anotar cada uso ANTES de ejecutar.
 *
 * ===========================================================================
 * ESTA MITAD FALLA CERRADO, Y ES LA ÚNICA DEL ARCHIVO DE AL LADO QUE LO HACE
 * ===========================================================================
 * `store.ts` (las políticas) y la mitad de I/O de `evaluate()` fallan ABIERTO, y
 * está bien argumentado allí: si no se puede leer `security_policies` se usan
 * los valores por defecto, y eso solo puede hacer que la capa sea MÁS estricta
 * o igual, nunca menos.
 *
 * AQUÍ LA DIRECCIÓN ES LA CONTRARIA Y NO ES UNA OPCIÓN. Un mandato es lo único
 * en el producto que convierte un `confirm` en un `allow`. Si al leerlos algo
 * falla —la red, una migración sin aplicar, un timeout— y devolviéramos «bueno,
 * sigue adelante», un corte de base de datos sería el camino más corto que
 * existe para que Cortex mande correos a clientes sin preguntarle a nadie.
 *
 * Así que: cualquier fallo devuelve la lista VACÍA, vacío significa que no hay
 * concesión, y sin concesión `applyMandate` deja el `confirm` donde estaba. El
 * coste de fallar cerrado aquí es que alguien tiene que pulsar «confirmar» una
 * vez, que es exactamente lo que pasaba la semana pasada.
 *
 * Si alguna vez lees este archivo pensando en «arreglar» el fallo abierto para
 * que se parezca al de al lado: no. Son dos direcciones distintas a propósito.
 *
 * ===========================================================================
 * POR QUÉ NO HAY CACHÉ, HABIÉNDOLA A DOS ARCHIVOS DE DISTANCIA
 * ===========================================================================
 * `loadPolicy` memoiza 60 s y hace bien. Aquí no, por dos razones:
 *
 *   1. Una revocación tiene que morder YA. Un mandato revocado que sigue
 *      autorizando durante un minuto es la peor cara posible del botón
 *      «revocar»: la persona lo pulsa, ve que se apagó, y no se apagó.
 *   2. `max_uses_per_day` es un presupuesto. Un contador memoizado 60 s deja
 *      pasar una ráfaga entera por encima del tope.
 *
 * Y sale gratis: esta lectura solo ocurre cuando la llamada IBA A PARARSE de
 * todos modos (ver `evaluate`), o sea en el camino que ya iba a costarle un
 * clic a una persona. Una llamada de riesgo bajo no paga ni una consulta.
 */

import { type UUID, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MandateGrant, MandateRiskCeiling } from './mandate.js';

export const MANDATES_TABLE = 'mandates';
export const MANDATE_USES_TABLE = 'mandate_uses';

const MANDATE_COLUMNS =
  'id, label, tool_patterns, covered_tool_ids, max_risk_level, amount_ceiling, currency, applies_unattended, max_uses_per_day';

interface MandateRow {
  id: string;
  label: string | null;
  tool_patterns: string[] | null;
  covered_tool_ids: string[] | null;
  max_risk_level: string;
  amount_ceiling: number | string | null;
  currency: string | null;
  applies_unattended: boolean | null;
  max_uses_per_day: number | null;
}

/** Inicio del día en Bogotá (UTC-5 fijo, sin horario de verano), en ISO. */
export function bogotaDayStart(now: Date): string {
  const shifted = new Date(now.getTime() - 5 * 3_600_000);
  const midnightShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(midnightShifted + 5 * 3_600_000).toISOString();
}

function toNumber(v: number | string | null): number | null {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * El par (techo, moneda) se lee como par o no se lee.
 *
 * La tabla ya lo garantiza con un CHECK, pero una fila mal formada que llegara
 * por cualquier otro camino no puede acabar en «hay techo y no sé de qué
 * moneda»: eso compararía pesos contra dólares. Si el par está roto, la
 * concesión se descarta entera.
 */
function moneyPair(row: MandateRow): { ceiling: number; currency: string } | null | 'broken' {
  const ceiling = toNumber(row.amount_ceiling);
  const currency = row.currency?.trim().toUpperCase() ?? null;
  if (ceiling === null && currency === null) return null;
  if (ceiling === null || !currency || !/^[A-Z]{3}$/.test(currency)) return 'broken';
  return { ceiling, currency };
}

function toGrant(row: MandateRow, usesToday: number): MandateGrant | null {
  const level = row.max_risk_level;
  // `critical` no puede existir como fila (CHECK en la migración 0099). Si
  // llegara igual, se descarta aquí: la regla vive en los dos sitios.
  if (level !== 'low' && level !== 'medium' && level !== 'high') return null;

  const money = moneyPair(row);
  if (money === 'broken') return null;

  const patterns = (row.tool_patterns ?? []).filter((p) => typeof p === 'string' && p !== '*');
  const covered = (row.covered_tool_ids ?? []).filter((p) => typeof p === 'string');
  if (patterns.length === 0 || covered.length === 0) return null;

  return {
    id: row.id,
    label: row.label ?? 'sin nombre',
    toolPatterns: patterns,
    coveredToolIds: covered,
    maxRiskLevel: level as MandateRiskCeiling,
    amountCeiling: money?.ceiling ?? null,
    currency: money?.currency ?? null,
    appliesUnattended: row.applies_unattended === true,
    maxUsesPerDay: row.max_uses_per_day ?? null,
    usesToday,
  };
}

/**
 * Concesiones vigentes que ya nombran esta herramienta en su instantánea.
 *
 * La vigencia se filtra en Postgres (`revoked_at is null`, `starts_at <= ahora`,
 * `expires_at > ahora`) porque una fila caducada no debería ni viajar por la
 * red, y `covered_tool_ids @> {toolId}` porque la intersección con la
 * instantánea es la que manda: un patrón sin instantánea detrás no delega nada.
 *
 * NUNCA lanza. Cualquier problema devuelve `[]`.
 */
export async function loadMandates(
  db: SupabaseClient,
  opts: { toolId: string; now?: Date },
): Promise<MandateGrant[]> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  try {
    const { data, error } = await db
      .from(MANDATES_TABLE)
      .select(MANDATE_COLUMNS)
      .is('revoked_at', null)
      .lte('starts_at', nowIso)
      .gt('expires_at', nowIso)
      .contains('covered_tool_ids', [opts.toolId]);

    if (error) {
      logger.warn({ err: error, toolId: opts.toolId }, 'mandates: lectura fallida, sin concesión');
      return [];
    }

    const rows = (data ?? []) as unknown as MandateRow[];
    if (rows.length === 0) return [];

    // El consumo del día solo se cuenta para las concesiones que tienen
    // presupuesto. Sin presupuesto no hay nada que contar y no se paga la
    // consulta; con él, se paga y no se memoiza (ver la cabecera).
    const budgeted = rows.filter((r) => r.max_uses_per_day !== null).map((r) => r.id);
    const usesToday = new Map<string, number>();
    if (budgeted.length > 0) {
      const { data: uses, error: usesError } = await db
        .from(MANDATE_USES_TABLE)
        .select('mandate_id')
        .in('mandate_id', budgeted)
        .gte('used_at', bogotaDayStart(now));

      // Si no se puede contar el presupuesto, no se puede saber si queda: las
      // concesiones con tope se descartan enteras en vez de suponer que sí.
      if (usesError) {
        logger.warn({ err: usesError }, 'mandates: no se pudo contar el uso del día');
        for (const id of budgeted) usesToday.set(id, Number.POSITIVE_INFINITY);
      } else {
        for (const u of (uses ?? []) as unknown as { mandate_id: string }[]) {
          usesToday.set(u.mandate_id, (usesToday.get(u.mandate_id) ?? 0) + 1);
        }
      }
    }

    return rows
      .map((r) => toGrant(r, usesToday.get(r.id) ?? 0))
      .filter((g): g is MandateGrant => g !== null);
  } catch (err) {
    logger.warn({ err, toolId: opts.toolId }, 'mandates: lectura lanzó, sin concesión');
    return [];
  }
}

export interface MandateUse {
  db: SupabaseClient;
  mandateId: string;
  toolId: string;
  userId: UUID;
  agentId?: UUID;
  surface: string;
  riskLevel: string;
  amount?: number | null;
  currency?: string | null;
  inputDigest: string;
}

/**
 * ANOTA EL USO ANTES DE EJECUTAR. La única función que escribe en
 * `mandate_uses` en todo el producto — la migración 0099 la nombra por eso.
 *
 * El orden es la mitad del diseño. Si se anotara después, una caída a mitad de
 * la ejecución dejaría un correo enviado y ningún rastro de que un mandato lo
 * autorizó, y el presupuesto del día se habría gastado sin constar. Anotando
 * antes, lo peor que pasa es lo contrario: consta un uso de algo que quizá no
 * llegó a ocurrir. Un presupuesto que se equivoca hacia arriba pregunta de más;
 * uno que se equivoca hacia abajo autoriza de más.
 *
 * Devuelve `false` si no se pudo escribir, y el llamante DEBE tratar eso como
 * «no hay delegación» y volver a pedir confirmación. Misma dirección que
 * `loadMandates`: sin rastro no hay autonomía.
 */
export async function recordMandateUse(use: MandateUse): Promise<boolean> {
  try {
    const { error } = await use.db.from(MANDATE_USES_TABLE).insert({
      mandate_id: use.mandateId,
      tool_id: use.toolId,
      user_id: use.userId,
      agent_id: use.agentId ?? null,
      surface: use.surface,
      risk_level: use.riskLevel,
      amount: use.amount ?? null,
      currency: use.currency ?? null,
      input_digest: use.inputDigest,
    });
    if (error) {
      logger.error({ err: error, mandateId: use.mandateId }, 'mandate_uses insert falló');
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, mandateId: use.mandateId }, 'mandate_uses insert lanzó');
    return false;
  }
}
