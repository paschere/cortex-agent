import type { SupabaseClient } from '@supabase/supabase-js';
import { enabledModules } from '../modules/store';

/**
 * Qué módulos tiene encendidos la empresa, para esconder la ayuda de los que
 * apagó (migración 0186). Es `enabledModules` del store de módulos, que ya cae
 * al estado por defecto si la lectura falla; aquí sólo se protege de que
 * lance: sin saberlo se devuelve `undefined` (sin filtro), porque esconder la
 * ayuda de algo que la empresa sí usa es peor que enseñar un artículo de más.
 */
export async function helpEnabledModules(
  db: SupabaseClient,
): Promise<ReadonlySet<string> | undefined> {
  try {
    return await enabledModules(db);
  } catch {
    return undefined;
  }
}
