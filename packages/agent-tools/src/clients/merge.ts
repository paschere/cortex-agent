import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type ClientRow, fullNit, nameKey, strictNameKey } from './shape';
import { getClient, isUniqueViolation, normalizeTags } from './store';

/**
 * UNIR DOS CLIENTES, Y SEPARAR UN NOMBRE QUE NO ERA.
 *
 * Unir es la decisión más pesada del módulo: después de unir, todo lo de
 * «Coltrans Ltda» queda en la ficha de «Coltrans» y no hay vuelta atrás
 * automática. Por eso:
 *
 *   - NUNCA lo hace el barrido. Sólo una persona, con confirmación (el botón
 *     pide confirmar; la herramienta `clients.merge` también).
 *   - Dos NIT distintos NO se unen. Para la DIAN son dos empresas, y unirlas
 *     mezclaría la cartera de una con la de la otra. La respuesta lo dice.
 *   - El nombre del que se va queda como ALIAS del que se queda, a nombre de
 *     quien unió: lo que siga llegando con ese nombre se aplica solo.
 *
 * Separar es el arreglo de un alias mal aprendido: el nombre se vuelve un
 * cliente propio y se lleva lo que se había vinculado SÓLO por ese nombre.
 */

/** Tablas con columna `client_id` que se mueven tal cual al unir. */
const CLIENT_ID_TABLES = [
  'commitments',
  'payments',
  'payment_reports',
  'document_extractions',
  'accounting_invoices',
  'actions',
  'gmail_thread_ingests',
  'microsoft_mail_ingests',
  'reports',
  'ledger_movements',
  'client_contacts',
  'client_domains',
  'client_aliases',
  'client_notes',
] as const;

export interface MergeResult {
  kept: ClientRow;
  /** Filas movidas por tabla. */
  moved: Record<string, number>;
  /** Vínculos que el otro ya tenía igual y se descartaron por repetidos. */
  duplicateLinks: number;
  aliasesAdded: string[];
}

export class MergeRefusedError extends ValidationError {}

/** ¿Se pueden unir? Null si sí; la frase del porqué si no. */
export function mergeRefusal(
  keep: Pick<ClientRow, 'id' | 'name' | 'tax_id'>,
  merge: Pick<ClientRow, 'id' | 'name' | 'tax_id'>,
): string | null {
  if (keep.id === merge.id) return 'Es el mismo cliente.';
  if (keep.tax_id && merge.tax_id && keep.tax_id !== merge.tax_id) {
    return `No los uno: ${keep.name} tiene NIT ${fullNit(keep.tax_id)} y ${merge.name} tiene NIT ${fullNit(merge.tax_id)}. Para la DIAN son dos empresas distintas, y unirlas mezclaría su cartera. Si uno de los dos NIT está mal, corrígelo primero en su ficha.`;
  }
  return null;
}

/**
 * Une `mergeId` dentro de `keepId`. Todo lo del primero pasa al segundo; el
 * primero desaparece y su nombre queda como alias.
 */
export async function mergeClients(
  db: SupabaseClient,
  input: { keepId: string; mergeId: string; userId: string },
): Promise<MergeResult> {
  const [keep, merge] = await Promise.all([
    getClient(db, input.keepId),
    getClient(db, input.mergeId),
  ]);
  if (!keep || !merge) throw new NotFoundError('Uno de los dos clientes ya no existe.');
  const refusal = mergeRefusal(keep, merge);
  if (refusal) throw new MergeRefusedError(refusal);

  const moved: Record<string, number> = {};
  const now = new Date().toISOString();

  // 1. Vínculos: uno que el que se queda ya tiene confirmado no se duplica.
  let duplicateLinks = 0;
  const [mine, theirs] = await Promise.all([
    db
      .from('client_links')
      .select('id, entity_kind, entity_key, method, state')
      .eq('client_id', keep.id)
      .limit(20000),
    db
      .from('client_links')
      .select('id, entity_kind, entity_key, method, state')
      .eq('client_id', merge.id)
      .limit(20000),
  ]);
  if (mine.error) throw mine.error;
  if (theirs.error) throw theirs.error;
  type L = { id: string; entity_kind: string; entity_key: string; method: string; state: string };
  const keepRoutes = new Set(
    ((mine.data ?? []) as L[]).map((l) => `${l.entity_kind}\u0000${l.entity_key}\u0000${l.method}`),
  );
  const keepConfirmed = new Set(
    ((mine.data ?? []) as L[])
      .filter((l) => l.state === 'confirmed')
      .map((l) => `${l.entity_kind}\u0000${l.entity_key}`),
  );
  const drop: string[] = [];
  const move: string[] = [];
  for (const l of (theirs.data ?? []) as L[]) {
    const route = `${l.entity_kind}\u0000${l.entity_key}\u0000${l.method}`;
    const entity = `${l.entity_kind}\u0000${l.entity_key}`;
    if (keepRoutes.has(route) || (l.state === 'confirmed' && keepConfirmed.has(entity))) {
      drop.push(l.id);
    } else {
      move.push(l.id);
    }
  }
  for (let i = 0; i < drop.length; i += 200) {
    const del = await db
      .from('client_links')
      .delete()
      .in('id', drop.slice(i, i + 200));
    if (del.error) throw del.error;
  }
  duplicateLinks = drop.length;
  for (let i = 0; i < move.length; i += 200) {
    const up = await db
      .from('client_links')
      .update({ client_id: keep.id })
      .in('id', move.slice(i, i + 200));
    if (up.error) throw up.error;
  }
  moved.client_links = move.length;

  // 2. Un solo contacto principal: si el que se queda ya tiene, el otro deja de serlo.
  const primary = await db
    .from('client_contacts')
    .select('id')
    .eq('client_id', keep.id)
    .eq('is_primary', true)
    .limit(1);
  if (primary.error) throw primary.error;
  if ((primary.data ?? []).length > 0) {
    const demote = await db
      .from('client_contacts')
      .update({ is_primary: false })
      .eq('client_id', merge.id)
      .eq('is_primary', true);
    if (demote.error) throw demote.error;
  }

  // 3. Todo lo que tiene columna client_id. Una tabla que no existe en esta
  //    base (una migración que no se aplicó) se salta; un error de verdad, no.
  for (const table of CLIENT_ID_TABLES) {
    const { data, error } = await db
      .from(table)
      .update({ client_id: keep.id })
      .eq('client_id', merge.id)
      .select('id');
    if (error) {
      if (/does not exist|schema cache/i.test(error.message ?? '')) continue;
      throw error;
    }
    moved[table] = ((data ?? []) as unknown[]).length;
  }

  // 4. El que se va: su NIT y lo que al que se queda le falte.
  const patch: Record<string, unknown> = {};
  for (const col of [
    'legal_name',
    'city',
    'department',
    'address',
    'phone',
    'website',
    'customs_role',
    'payment_terms_days',
    'credit_limit_cop',
    'owner_user_id',
    'since',
  ] as const) {
    if ((keep[col] === null || keep[col] === undefined) && merge[col] != null)
      patch[col] = merge[col];
  }
  const tags = normalizeTags([...(keep.tags ?? []), ...(merge.tags ?? [])]);
  if (tags.length !== (keep.tags ?? []).length) patch.tags = tags;
  const services = [...new Set([...(keep.services ?? []), ...(merge.services ?? [])])];
  if (services.length !== (keep.services ?? []).length) patch.services = services;
  const takeNit = !keep.tax_id && merge.tax_id ? merge.tax_id : null;

  const del = await db.from('clients').delete().eq('id', merge.id);
  if (del.error) throw del.error;
  if (takeNit) patch.tax_id = takeNit;
  if (Object.keys(patch).length > 0) {
    const up = await db.from('clients').update(patch).eq('id', keep.id);
    if (up.error) throw up.error;
  }

  // 5. Su nombre (y su razón social) quedan como alias del que se queda.
  const aliasesAdded: string[] = [];
  for (const alias of [merge.name, merge.legal_name]) {
    if (!alias || strictNameKey(alias) === strictNameKey(keep.name)) continue;
    const ins = await db.from('client_aliases').insert({
      client_id: keep.id,
      alias,
      source: 'merge',
      verified_by: input.userId,
      verified_at: now,
    });
    if (ins.error && !isUniqueViolation(ins.error)) throw ins.error;
    if (!ins.error) aliasesAdded.push(alias);
  }

  // 6. Queda dicho en la ficha, con autor.
  const note = await db.from('client_notes').insert({
    client_id: keep.id,
    body: `Se unió «${merge.name}»${merge.tax_id ? ` (NIT ${fullNit(merge.tax_id)})` : ''} a este cliente.`,
    created_by: input.userId,
  });
  if (note.error && !/does not exist|schema cache/i.test(note.error.message ?? '')) {
    throw note.error;
  }

  const kept = (await getClient(db, keep.id)) ?? keep;
  return { kept, moved, duplicateLinks, aliasesAdded };
}

// ---------------------------------------------------------------------------
// Alias
// ---------------------------------------------------------------------------

export interface AliasRow {
  id: string;
  client_id: string;
  alias: string;
  alias_key: string | null;
  source: 'manual' | 'confirmation' | 'merge' | 'accounting';
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

export const ALIAS_COLUMNS =
  'id, client_id, alias, alias_key, source, verified_by, verified_at, created_at';

export async function listAliases(db: SupabaseClient, clientId?: string): Promise<AliasRow[]> {
  let q = db.from('client_aliases').select(ALIAS_COLUMNS);
  if (clientId) q = q.eq('client_id', clientId);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(2000);
  if (error) throw error;
  return (data ?? []) as AliasRow[];
}

/** Una persona afirma «también se llama así». Se aplica solo desde ahora. */
export async function addAlias(
  db: SupabaseClient,
  input: { clientId: string; alias: string; userId: string },
): Promise<AliasRow> {
  const alias = input.alias.trim();
  if (alias.length < 2) throw new ValidationError('Escribe el otro nombre.');
  const { data, error } = await db
    .from('client_aliases')
    .insert({
      client_id: input.clientId,
      alias: alias.slice(0, 200),
      source: 'manual',
      verified_by: input.userId,
      verified_at: new Date().toISOString(),
    })
    .select(ALIAS_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new ValidationError(
        `«${alias}» ya es otro nombre de un cliente. Un nombre sólo puede ser de uno.`,
      );
    }
    throw error;
  }
  return data as AliasRow;
}

export interface SplitResult {
  client: ClientRow;
  /** Vínculos y movimientos que se fueron con el nombre. */
  movedLinks: number;
  movedLedger: number;
}

/**
 * Separar un alias: «"COLTRANS CARGO" no es Coltrans, es otra empresa».
 *
 * El nombre se vuelve un cliente nuevo (origen `split`) y se lleva lo que
 * llegó a la ficha SÓLO por ese nombre: los vínculos `alias` cuya evidencia es
 * ese nombre y los movimientos del libro vinculados por alias con esa
 * contraparte. Lo que llegó por NIT, dominio o una persona se queda: eso no
 * dependía del alias.
 */
export async function splitAlias(
  db: SupabaseClient,
  input: { aliasId: string; userId: string },
): Promise<SplitResult> {
  const { data: found, error } = await db
    .from('client_aliases')
    .select(ALIAS_COLUMNS)
    .eq('id', input.aliasId)
    .maybeSingle();
  if (error) throw error;
  const alias = found as AliasRow | null;
  if (!alias) throw new NotFoundError('Ese nombre ya no está.');
  const from = await getClient(db, alias.client_id);
  if (!from) throw new NotFoundError('El cliente de ese nombre ya no existe.');

  const del = await db.from('client_aliases').delete().eq('id', alias.id);
  if (del.error) throw del.error;

  const created = await db
    .from('clients')
    .insert({
      name: alias.alias.slice(0, 160),
      status: 'active',
      source: 'split',
      source_detail: `Separado de ${from.name}`.slice(0, 200),
      created_by: input.userId,
    })
    .select('id')
    .single();
  if (created.error) {
    if (isUniqueViolation(created.error)) {
      throw new ValidationError(
        `Ya hay un cliente llamado «${alias.alias}». Úsalo en vez de separar.`,
      );
    }
    throw created.error;
  }
  const newId = (created.data as { id: string }).id;
  const key = nameKey(alias.alias);

  // Los vínculos que dependían sólo de este nombre.
  const links = await db
    .from('client_links')
    .select('id, evidence')
    .eq('client_id', from.id)
    .eq('method', 'alias')
    .limit(5000);
  if (links.error) throw links.error;
  const linkIds = ((links.data ?? []) as Array<{ id: string; evidence: string | null }>)
    .filter((l) => nameKey(l.evidence ?? '') === key)
    .map((l) => l.id);
  for (let i = 0; i < linkIds.length; i += 200) {
    const up = await db
      .from('client_links')
      .update({ client_id: newId })
      .in('id', linkIds.slice(i, i + 200));
    if (up.error) throw up.error;
  }

  const ledger = await db
    .from('ledger_movements')
    .select('id, counterparty_name')
    .eq('client_id', from.id)
    .eq('client_matched_by', 'alias')
    .limit(5000);
  let movedLedger = 0;
  if (!ledger.error) {
    const ids = ((ledger.data ?? []) as Array<{ id: string; counterparty_name: string | null }>)
      .filter((m) => nameKey(m.counterparty_name ?? '') === key)
      .map((m) => m.id);
    for (let i = 0; i < ids.length; i += 200) {
      const up = await db
        .from('ledger_movements')
        .update({ client_id: newId })
        .in('id', ids.slice(i, i + 200));
      if (up.error) throw up.error;
    }
    movedLedger = ids.length;
  }

  const client = await getClient(db, newId);
  if (!client) throw new NotFoundError('No se pudo leer el cliente nuevo.');
  return { client, movedLinks: linkIds.length, movedLedger };
}

// ---------------------------------------------------------------------------
// Posibles duplicados (para «Por confirmar»)
// ---------------------------------------------------------------------------

export interface DuplicatePair {
  keep: { id: string; name: string; nit: string | null };
  merge: { id: string; name: string; nit: string | null };
  /** Por qué parecen el mismo: «se escriben igual», «uno es alias del otro». */
  why: string;
}

/**
 * Parejas de clientes que parecen la misma empresa: el nombre se pliega igual
 * (sin tildes, sin S.A.S.) o el nombre de uno es alias del otro. Nunca dos con
 * NIT distinto. Se PROPONEN; unir lo decide una persona.
 *
 * Se queda el que tiene NIT, y si los dos o ninguno, el más antiguo.
 */
export function duplicatePairs(
  clients: Array<Pick<ClientRow, 'id' | 'name' | 'legal_name' | 'tax_id' | 'created_at'>>,
  aliases: Array<Pick<AliasRow, 'client_id' | 'alias'>> = [],
): DuplicatePair[] {
  const byKey = new Map<string, typeof clients>();
  for (const c of clients) {
    const key = nameKey(c.name);
    if (key.length < 3) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  const byId = new Map(clients.map((c) => [c.id, c]));
  const pairs: DuplicatePair[] = [];
  const seen = new Set<string>();
  const add = (a: (typeof clients)[number], b: (typeof clients)[number], why: string) => {
    const id = [a.id, b.id].sort().join('|');
    if (seen.has(id) || a.id === b.id) return;
    if (a.tax_id && b.tax_id && a.tax_id !== b.tax_id) return;
    seen.add(id);
    const [keep, merge] =
      (a.tax_id && !b.tax_id) || (!!a.tax_id === !!b.tax_id && a.created_at <= b.created_at)
        ? [a, b]
        : [b, a];
    pairs.push({
      keep: { id: keep.id, name: keep.name, nit: fullNit(keep.tax_id) },
      merge: { id: merge.id, name: merge.name, nit: fullNit(merge.tax_id) },
      why,
    });
  };
  for (const group of byKey.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        add(
          group[i] as (typeof clients)[number],
          group[j] as (typeof clients)[number],
          'Se escriben igual sin tildes ni S.A.S.',
        );
      }
    }
  }
  for (const a of aliases) {
    const owner = byId.get(a.client_id);
    if (!owner) continue;
    for (const other of byKey.get(nameKey(a.alias)) ?? []) {
      if (other.id !== owner.id)
        add(owner, other, `«${a.alias}» ya es otro nombre de ${owner.name}`);
    }
  }
  return pairs;
}
