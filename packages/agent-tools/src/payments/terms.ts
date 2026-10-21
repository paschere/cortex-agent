import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * EL PLAZO DE PAGO POR DEFECTO DE LA EMPRESA (0238).
 *
 * Con él se cuentan las facturas que no traen plazo propio (Siigo guarda «vence
 * el mismo día» cuando nadie lo escribió) ni lo tiene su cliente. Sin fila, 30.
 */
export const DEFAULT_PAYMENT_TERMS_DAYS = 30;
export const PAYMENT_TERM_PRESETS = [30, 60, 90] as const;

export function validTermDays(n: unknown): number | null {
  const v = typeof n === 'string' ? Number(n) : n;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 365 ? v : null;
}

export async function readDefaultTermDays(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from('finance_settings')
    .select('default_payment_terms_days')
    .maybeSingle();
  // Sin la tabla (migración pendiente) o sin fila: el valor por defecto, no un error en pantalla.
  if (error) return DEFAULT_PAYMENT_TERMS_DAYS;
  return validTermDays(data?.default_payment_terms_days) ?? DEFAULT_PAYMENT_TERMS_DAYS;
}

export async function saveDefaultTermDays(
  db: SupabaseClient,
  days: number,
  userId: string,
): Promise<number> {
  const v = validTermDays(days);
  if (v === null) throw new ValidationError('El plazo debe ser un número de días entre 1 y 365.');
  const { error } = await db
    .from('finance_settings')
    .upsert(
      { default_payment_terms_days: v, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: 'organization_id' },
    );
  if (error) throw new Error(`No se pudo guardar el plazo: ${error.message}`);
  return v;
}
