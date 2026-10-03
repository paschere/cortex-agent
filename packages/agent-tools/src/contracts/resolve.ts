import type { SupabaseClient } from '@supabase/supabase-js';
import { foldText } from './text';

/**
 * De un nombre dicho en el chat a un registro: un cliente, un proveedor, una
 * persona del equipo. Nunca se elige entre dos: si el nombre es ambiguo o no
 * existe, vuelve null y quien llama lo dice («no encontré a …»).
 */

function key(text: string | null | undefined): string {
  return foldText(text ?? '').replace(/[^a-z0-9]+/g, '');
}

export async function findClientByName(
  db: SupabaseClient,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const k = key(name);
  if (k.length < 3) return null;
  const { data, error } = await db
    .from('clients')
    .select('id, name, legal_name, tax_id')
    .limit(2000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    name: string;
    legal_name: string | null;
    tax_id: string | null;
  }>;
  const exact = rows.filter(
    (c) =>
      key(c.name) === k ||
      key(c.legal_name) === k ||
      (c.tax_id && c.tax_id === name.replace(/\D/g, '')),
  );
  if (exact.length === 1)
    return {
      id: (exact[0] as (typeof rows)[number]).id,
      name: (exact[0] as (typeof rows)[number]).name,
    };
  if (exact.length > 1) return null;
  const partial = rows.filter((c) => key(c.name).includes(k) || key(c.legal_name).includes(k));
  return partial.length === 1
    ? {
        id: (partial[0] as (typeof rows)[number]).id,
        name: (partial[0] as (typeof rows)[number]).name,
      }
    : null;
}

export async function findSupplierByName(
  db: SupabaseClient,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const k = key(name);
  if (k.length < 3) return null;
  const { data, error } = await db.from('suppliers').select('id, name, nit').limit(2000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; name: string; nit: string | null }>;
  const exact = rows.filter(
    (s) => key(s.name) === k || (s.nit && s.nit === name.replace(/\D/g, '')),
  );
  if (exact.length === 1)
    return {
      id: (exact[0] as (typeof rows)[number]).id,
      name: (exact[0] as (typeof rows)[number]).name,
    };
  if (exact.length > 1) return null;
  const partial = rows.filter((s) => key(s.name).includes(k));
  return partial.length === 1
    ? {
        id: (partial[0] as (typeof rows)[number]).id,
        name: (partial[0] as (typeof rows)[number]).name,
      }
    : null;
}

export async function findUserByEmail(db: SupabaseClient, email: string): Promise<string | null> {
  const { data, error } = await db
    .from('users')
    .select('id')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}
