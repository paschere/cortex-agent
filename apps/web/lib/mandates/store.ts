import 'server-only';

/**
 * La ÚNICA puerta de escritura de `mandates` en todo el producto.
 *
 * La migración 0099 la nombra en su cabecera a propósito, con el argumento de la
 * 0064 → 0095 detrás: aquella le añadió una columna obligatoria a
 * `user_memories` sin volver sobre la función que escribía, y el producto estuvo
 * semanas sin poder guardar una memoria mientras la lectura funcionaba
 * perfectamente. Si algún día `mandates` gana una columna obligatoria, este
 * archivo es el único sitio que hay que revisar.
 *
 * Y aquí importa más que en ninguna otra tabla, porque una fila de esta tabla no
 * es un dato: es un PERMISO. Todo lo que decide si Cortex actúa sin preguntar
 * —los patrones, la instantánea, el techo, la caducidad— se resuelve en
 * `grantMandate`, y nadie más escribe.
 */

import { mustReadList } from '@/lib/supabase/read';
import {
  type MandateRiskCeiling,
  NEVER_DELEGATED_FAMILIES,
  listTools,
  mandatePatternMatches,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

export const MANDATES_TABLE = 'mandates';
export const MANDATE_USES_TABLE = 'mandate_uses';

/** Cuánto dura un mandato si nadie dice otra cosa. Renovable. */
export const DEFAULT_MANDATE_DAYS = 90;
export const MAX_MANDATE_DAYS = 365;
export const MAX_PATTERNS = 20;

export interface MandateRow {
  id: string;
  label: string;
  reason: string;
  granted_by: string;
  tool_patterns: string[] | null;
  covered_tool_ids: string[] | null;
  max_risk_level: string;
  amount_ceiling: number | string | null;
  currency: string | null;
  applies_unattended: boolean;
  max_uses_per_day: number | null;
  starts_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
}

const COLUMNS =
  'id, label, reason, granted_by, tool_patterns, covered_tool_ids, max_risk_level, amount_ceiling, currency, applies_unattended, max_uses_per_day, starts_at, expires_at, revoked_at, revoked_by, created_at';

// ---------------------------------------------------------------------------
// La instantánea
// ---------------------------------------------------------------------------

/**
 * Los ids que estos patrones cubren HOY, resueltos contra el registro vivo.
 *
 * Esta función es la diferencia entre capacidad y autonomía. `filterTools` deja
 * que `gmail.*` incluya lo que todavía no existe, y hace bien: un agente que
 * lista familias una a una pierde cada integración nueva hasta que alguien se
 * acuerda. Un mandato no puede permitirse eso — una herramienta desplegada el
 * mes que viene quedaría autodelegada sin que nadie lo hubiera decidido — así
 * que el patrón se guarda pero lo que manda es esta lista, congelada al
 * conceder.
 *
 * Las familias no delegables se caen aquí y no llegan a la fila: si el patrón de
 * alguien las tocaba, la instantánea simplemente no las nombra, y lo que no está
 * en la instantánea no se delega jamás.
 */
export function resolveCoverage(patterns: string[]): string[] {
  const ids = new Set<string>();
  for (const tool of listTools()) {
    const id = tool.id;
    if (id.startsWith('test.')) continue;
    const family = id.slice(0, id.indexOf('.') === -1 ? id.length : id.indexOf('.'));
    if (NEVER_DELEGATED_FAMILIES.includes(family)) continue;
    if (patterns.some((p) => mandatePatternMatches(p, id))) ids.add(id);
  }
  return [...ids].sort();
}

/** Problemas en Colombian Spanish, para enseñarlos junto al formulario. */
export function checkGrant(input: {
  patterns: string[];
  covered: string[];
  amountCeiling: number | null;
  currency: string | null;
}): string[] {
  const problems: string[] = [];

  if (input.patterns.length === 0) {
    problems.push('Un mandato tiene que decir qué herramientas cubre.');
  }
  if (input.patterns.includes('*')) {
    problems.push(
      'No se puede conceder «*». Un mandato tiene que nombrar familias o herramientas concretas: delegar «todo» incluye lo que todavía no existe.',
    );
  }
  for (const p of input.patterns) {
    if (!/^[a-z][a-z0-9_]*(\.\*|\.[a-z0-9_]+)?$/.test(p)) {
      problems.push(`«${p}» no tiene forma de patrón. Usa «gmail.*» o «gmail.send_draft».`);
    }
  }
  if (input.covered.length === 0 && input.patterns.length > 0) {
    problems.push(
      'Ninguna herramienta instalada hoy encaja con esos patrones, o todas las que encajan son de las que nunca se delegan (seguridad, mandatos y herramientas propias de la empresa). Un mandato que no cubre nada no se guarda.',
    );
  }
  if ((input.amountCeiling === null) !== (input.currency === null)) {
    problems.push(
      'El techo de dinero y la moneda van juntos o no van: un techo sin moneda compararía pesos contra dólares.',
    );
  }
  if (input.amountCeiling !== null && input.amountCeiling <= 0) {
    problems.push('El techo de dinero tiene que ser mayor que cero.');
  }
  if (input.currency !== null && !/^[A-Z]{3}$/.test(input.currency)) {
    problems.push('La moneda es un código ISO de tres letras: COP, USD, EUR.');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

export interface GrantInput {
  label: string;
  reason: string;
  toolPatterns: string[];
  maxRiskLevel: MandateRiskCeiling;
  amountCeiling: number | null;
  currency: string | null;
  appliesUnattended: boolean;
  maxUsesPerDay: number | null;
  days: number;
  grantedBy: string;
}

/**
 * El único INSERT. Devuelve la fila creada o lanza con un mensaje en español.
 *
 * `covered_tool_ids` se resuelve AQUÍ y no lo elige el llamante: si la
 * instantánea viniera de fuera, la ruta HTTP podría mandar una lista que los
 * patrones no justifican, y el invariante «lo efectivo es la intersección»
 * dejaría de ser cierto en el único sitio donde importa.
 */
export async function grantMandate(
  db: SupabaseClient,
  input: GrantInput,
): Promise<{ id: string; covered: string[] }> {
  const patterns = [...new Set(input.toolPatterns.map((p) => p.trim()).filter(Boolean))];
  const covered = resolveCoverage(patterns);

  const problems = checkGrant({
    patterns,
    covered,
    amountCeiling: input.amountCeiling,
    currency: input.currency,
  });
  if (problems.length > 0) throw new Error(problems.join(' '));

  const days = Math.min(Math.max(Math.round(input.days), 1), MAX_MANDATE_DAYS);
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

  const { data, error } = await db
    .from(MANDATES_TABLE)
    .insert({
      label: input.label.trim(),
      reason: input.reason.trim(),
      granted_by: input.grantedBy,
      tool_patterns: patterns,
      covered_tool_ids: covered,
      max_risk_level: input.maxRiskLevel,
      amount_ceiling: input.amountCeiling,
      currency: input.currency,
      applies_unattended: input.appliesUnattended,
      max_uses_per_day: input.maxUsesPerDay,
      expires_at: expiresAt,
    })
    .select('id')
    .single();

  if (error) throw new Error(`No se pudo guardar el mandato: ${error.message}`);
  return { id: (data as { id: string }).id, covered };
}

/**
 * El único UPDATE. Revocar es un acto con autor, igual que conceder — la tabla
 * lo exige con un CHECK, y aquí es donde se cumple.
 *
 * Muerde YA: la lectura de mandatos no tiene caché, precisamente para que el
 * botón «revocar» signifique lo que dice en el momento en que se pulsa.
 */
export async function revokeMandate(
  db: SupabaseClient,
  id: string,
  revokedBy: string,
): Promise<void> {
  const { error } = await db
    .from(MANDATES_TABLE)
    .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy })
    .eq('id', id)
    .is('revoked_at', null);
  if (error) throw new Error(`No se pudo revocar el mandato: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export async function listMandates(db: SupabaseClient): Promise<MandateRow[]> {
  return mustReadList<MandateRow>(
    await db.from(MANDATES_TABLE).select(COLUMNS).order('created_at', { ascending: false }),
    'los mandatos de este espacio',
  );
}

export interface UseRow {
  mandate_id: string;
  tool_id: string;
  risk_level: string;
  amount: number | string | null;
  currency: string | null;
  used_at: string;
}

export async function listRecentUses(db: SupabaseClient, sinceIso: string): Promise<UseRow[]> {
  return mustReadList<UseRow>(
    await db
      .from(MANDATE_USES_TABLE)
      .select('mandate_id, tool_id, risk_level, amount, currency, used_at')
      .gte('used_at', sinceIso)
      .order('used_at', { ascending: false })
      .limit(500),
    'el uso reciente de los mandatos',
  );
}

/** El estado en el que está una concesión ahora mismo. */
export type MandateState = 'active' | 'revoked' | 'expired' | 'scheduled';

export function mandateState(row: MandateRow, now = new Date()): MandateState {
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at) <= now) return 'expired';
  if (new Date(row.starts_at) > now) return 'scheduled';
  return 'active';
}

export function daysLeft(row: MandateRow, now = new Date()): number {
  return Math.ceil((new Date(row.expires_at).getTime() - now.getTime()) / 86_400_000);
}
