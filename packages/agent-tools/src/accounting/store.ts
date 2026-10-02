import { NotFoundError, ValidationError, decryptToken, encryptToken } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAccountingProvider } from './providers';
import {
  ACCOUNTING_ENTITIES,
  type AccountingEntity,
  type AccountingProvider,
  type AccountingProviderId,
  type ProviderRuntime,
  type ProviderSession,
  type ProviderToken,
} from './types';

/**
 * LA CONEXIÓN CON UN PROGRAMA CONTABLE, GUARDADA (migración 0165).
 *
 * LA FORMA DE ESTE ARCHIVO ES LA PROPIEDAD DE SEGURIDAD, igual que en
 * browser/credentials.ts: hay exactamente UNA función que lee `credentials_enc`
 * y `token_enc` —`openAccountingSession`— y lo que devuelve es una sesión lista
 * para hablar con el programa, no la llave. Todas las demás seleccionan
 * `CONNECTION_COLUMNS`, que no las nombra. «¿Puede la llave llegar a una
 * pantalla, a una respuesta o al modelo?» se contesta mirando los selects de
 * este archivo.
 *
 * Cifrado: el mismo AES-256-GCM con `TOKEN_ENCRYPTION_KEY` de los tokens de
 * OAuth (packages/core/src/crypto.ts). Una llave, una historia de rotación.
 */

export const CONNECTION_COLUMNS =
  'id, provider, created_by, account_label, entities, trackers, cursors, interval_minutes, notify, enabled, next_run_at, last_run_at, last_status, last_error, last_counts, created_at, updated_at';

export interface EntityCursor {
  /** Hasta cuándo se trajo (ISO). La próxima corrida pide lo creado o cambiado desde aquí. */
  since?: string;
  /** Último repaso de las facturas recientes (por los abonos). */
  full_at?: string;
  /** Una corrida que se quedó sin tiempo sigue desde aquí. */
  resume?: {
    queries: Array<Record<string, string>>;
    index: number;
    page: number;
    startedAt: string;
    mode: 'initial' | 'sweep' | 'incremental';
  };
}

export interface EntityCounts {
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export interface RunCounts extends Partial<Record<AccountingEntity, EntityCounts>> {
  /** Facturas escritas en la cartera. */
  receivables?: number;
  /** Pagos nuevos en Pagos (no cuenta los que ya estaban). */
  payments_created?: number;
  /** Peticiones al programa en la corrida. */
  requests?: number;
}

export interface AccountingConnectionRow {
  id: string;
  provider: AccountingProviderId;
  created_by: string;
  account_label: string;
  entities: AccountingEntity[];
  trackers: Partial<Record<AccountingEntity, string>>;
  cursors: Partial<Record<AccountingEntity, EntityCursor>>;
  interval_minutes: number;
  notify: boolean;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_status: 'ok' | 'partial' | 'error' | null;
  last_error: string | null;
  last_counts: RunCounts;
  created_at: string;
  updated_at: string;
}

export function requireProvider(id: string): AccountingProvider {
  const provider = getAccountingProvider(id);
  if (!provider)
    throw new ValidationError(
      `Todavía no se puede conectar «${id}». Por ahora: Siigo, Alegra o QuickBooks.`,
    );
  return provider;
}

export function cleanEntities(
  provider: AccountingProvider,
  raw: readonly string[] | undefined,
): AccountingEntity[] {
  const wanted = new Set(raw ?? []);
  const entities = ACCOUNTING_ENTITIES.filter(
    (e) => wanted.has(e) && provider.entities.includes(e),
  );
  if (!entities.length)
    throw new ValidationError(`Elige al menos una cosa para traer de ${provider.name}.`);
  return entities;
}

export function cleanInterval(raw: number | undefined): number {
  const n = Math.round(Number(raw ?? 60));
  if (!Number.isFinite(n) || n < 15 || n > 1440)
    throw new ValidationError('La frecuencia tiene que estar entre 15 minutos y un día.');
  return n;
}

/** La llave tal como la escribió el administrador, validada contra los campos del programa. */
export function cleanCredentials(
  provider: AccountingProvider,
  raw: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of provider.credentialFields) {
    const value = typeof raw[field.key] === 'string' ? (raw[field.key] as string).trim() : '';
    if (value.length < 3 || value.length > 1000)
      throw new ValidationError(`Falta «${field.label}» de ${provider.name}, o no está completo.`);
    out[field.key] = value;
  }
  return out;
}

export async function listAccountingConnections(
  db: SupabaseClient,
): Promise<AccountingConnectionRow[]> {
  const { data, error } = await db
    .from('accounting_connections')
    .select(CONNECTION_COLUMNS)
    .order('created_at', { ascending: true })
    .limit(10);
  if (error) throw error;
  return (data ?? []) as unknown as AccountingConnectionRow[];
}

export async function getAccountingConnection(
  db: SupabaseClient,
  provider: string,
): Promise<AccountingConnectionRow | null> {
  const { data, error } = await db
    .from('accounting_connections')
    .select(CONNECTION_COLUMNS)
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as AccountingConnectionRow | null) ?? null;
}

export async function getAccountingConnectionById(
  db: SupabaseClient,
  id: string,
): Promise<AccountingConnectionRow | null> {
  const { data, error } = await db
    .from('accounting_connections')
    .select(CONNECTION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as AccountingConnectionRow | null) ?? null;
}

/**
 * Guarda (o reemplaza) la conexión de la empresa con un programa. Se llama
 * DESPUÉS de probar la llave. Si cambia la cuenta —otra empresa en el mismo
 * programa— lo traído se vuelve a traer desde cero (`cursors` vacío); las
 * tablas se conservan.
 */
export async function saveAccountingConnection(
  db: SupabaseClient,
  input: {
    provider: string;
    credentials: Record<string, unknown>;
    token?: ProviderToken | null;
    entities: readonly string[];
    intervalMinutes: number;
    notify: boolean;
    userId: string;
  },
): Promise<AccountingConnectionRow> {
  const provider = requireProvider(input.provider);
  const credentials = cleanCredentials(provider, input.credentials);
  const accountLabel = (credentials[provider.accountLabelField] ?? provider.name).slice(0, 200);
  const previous = await getAccountingConnection(db, provider.id);
  const sameAccount = previous?.account_label.toLowerCase() === accountLabel.toLowerCase();
  const now = new Date().toISOString();
  const values = {
    provider: provider.id,
    created_by: input.userId,
    account_label: accountLabel,
    credentials_enc: encryptToken(JSON.stringify(credentials)),
    token_enc: input.token ? encryptToken(input.token.token) : null,
    token_expires_at: input.token ? new Date(input.token.expiresAt).toISOString() : null,
    entities: cleanEntities(provider, input.entities),
    interval_minutes: cleanInterval(input.intervalMinutes),
    notify: input.notify,
    enabled: true,
    next_run_at: now,
    last_error: null,
    updated_at: now,
    ...(sameAccount ? {} : { cursors: {}, last_counts: {}, last_status: null, last_run_at: null }),
  };
  const { data, error } = await db
    .from('accounting_connections')
    .upsert(values, { onConflict: 'organization_id,provider' })
    .select(CONNECTION_COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as AccountingConnectionRow;
}

/** Cambia qué se trae, cada cuánto, si avisa o si está en pausa — sin tocar la llave. */
export async function updateAccountingSettings(
  db: SupabaseClient,
  providerId: string,
  input: {
    entities?: readonly string[];
    intervalMinutes?: number;
    notify?: boolean;
    enabled?: boolean;
  },
): Promise<AccountingConnectionRow> {
  const provider = requireProvider(providerId);
  const current = await getAccountingConnection(db, provider.id);
  if (!current) throw new NotFoundError(`${provider.name} no está conectado.`);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.entities) patch.entities = cleanEntities(provider, input.entities);
  if (input.intervalMinutes !== undefined) {
    const interval = cleanInterval(input.intervalMinutes);
    patch.interval_minutes = interval;
    patch.next_run_at = new Date(Date.now() + interval * 60_000).toISOString();
  }
  if (input.notify !== undefined) patch.notify = input.notify;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  const { data, error } = await db
    .from('accounting_connections')
    .update(patch)
    .eq('id', current.id)
    .select(CONNECTION_COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as AccountingConnectionRow;
}

/** «Sincronizar ahora»: la deja vencida para que la tome la próxima corrida. */
export async function requestAccountingSync(
  db: SupabaseClient,
  providerId: string,
): Promise<AccountingConnectionRow> {
  const name = getAccountingProvider(providerId)?.name ?? providerId;
  const current = await getAccountingConnection(db, providerId);
  if (!current) throw new NotFoundError(`${name} no está conectado.`);
  if (!current.enabled)
    throw new ValidationError(`La sincronización con ${name} está en pausa. Actívala primero.`);
  const { error } = await db
    .from('accounting_connections')
    .update({ next_run_at: new Date().toISOString() })
    .eq('id', current.id);
  if (error) throw error;
  return current;
}

/**
 * Desconectar borra la llave y el registro de la conexión. Las tablas, la
 * cartera y los pagos traídos se quedan: son datos de la empresa.
 */
export async function disconnectAccounting(
  db: SupabaseClient,
  providerId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('accounting_connections')
    .delete()
    .eq('provider', providerId)
    .select('id');
  if (error) throw error;
  return Boolean((data as unknown[] | null)?.length);
}

/**
 * La toma de una corrida: una sola a la vez por conexión. Gana quien mueve
 * `next_run_at` estando vencida; el cron y «Sincronizar ahora» pueden llegar
 * juntos y sólo uno trabaja.
 */
export async function claimAccountingConnection(
  db: SupabaseClient,
  id: string,
  now = new Date(),
): Promise<AccountingConnectionRow | null> {
  const current = await getAccountingConnectionById(db, id);
  if (!current?.enabled) return null;
  const { data, error } = await db
    .from('accounting_connections')
    .update({
      next_run_at: new Date(now.getTime() + current.interval_minutes * 60_000).toISOString(),
    })
    .eq('id', id)
    .lte('next_run_at', now.toISOString())
    .select(CONNECTION_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as AccountingConnectionRow | null) ?? null;
}

export type RunResult =
  | {
      status: 'ok' | 'partial';
      counts: RunCounts;
      cursors: AccountingConnectionRow['cursors'];
      trackers: AccountingConnectionRow['trackers'];
    }
  | {
      status: 'error';
      error: string;
      cursors?: AccountingConnectionRow['cursors'];
      trackers?: AccountingConnectionRow['trackers'];
    };

export async function markAccountingRun(
  db: SupabaseClient,
  conn: Pick<AccountingConnectionRow, 'id' | 'interval_minutes'>,
  result: RunResult,
  now = new Date(),
): Promise<void> {
  const patch: Record<string, unknown> = {
    last_run_at: now.toISOString(),
    last_status: result.status,
    updated_at: now.toISOString(),
    // Una carga a medias sigue enseguida; lo demás, a su intervalo.
    next_run_at: new Date(
      now.getTime() + (result.status === 'partial' ? 0 : conn.interval_minutes * 60_000),
    ).toISOString(),
  };
  if (result.status === 'error') {
    patch.last_error = result.error.slice(0, 500);
    // Lo que alcanzó a avanzar antes del error no se vuelve a pedir.
    if (result.cursors) patch.cursors = result.cursors;
    if (result.trackers) patch.trackers = result.trackers;
  } else {
    patch.last_error = null;
    patch.last_counts = result.counts;
    patch.cursors = result.cursors;
    patch.trackers = result.trackers;
  }
  const { error } = await db.from('accounting_connections').update(patch).eq('id', conn.id);
  if (error) throw error;
}

/**
 * EL ÚNICO SITIO QUE DESCIFRA. Devuelve una sesión con el programa que ya sabe
 * su llave y guarda el token renovado en la conexión; la llave no sale de aquí.
 */
export async function openAccountingSession(
  db: SupabaseClient,
  connectionId: string,
  runtime: Omit<ProviderRuntime, 'tokenStore'> = {},
): Promise<ProviderSession> {
  const { data, error } = await db
    .from('accounting_connections')
    .select('id, provider, credentials_enc, token_enc, token_expires_at')
    .eq('id', connectionId)
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    id: string;
    provider: string;
    credentials_enc: string;
    token_enc: string | null;
    token_expires_at: string | null;
  } | null;
  if (!row) throw new NotFoundError('El programa contable ya no está conectado.');
  const provider = requireProvider(row.provider);
  let credentials: Record<string, string>;
  try {
    credentials = JSON.parse(decryptToken(row.credentials_enc)) as Record<string, string>;
  } catch {
    throw new ValidationError(
      `No se pudo leer la llave de ${provider.name} guardada. Vuelve a conectar desde Integraciones.`,
    );
  }
  return provider.open(credentials, {
    ...runtime,
    tokenStore: {
      load: async () => {
        if (!row.token_enc || !row.token_expires_at) return null;
        try {
          return {
            token: decryptToken(row.token_enc),
            expiresAt: Date.parse(row.token_expires_at),
          };
        } catch {
          return null;
        }
      },
      save: async (token) => {
        const { error: saveError } = await db
          .from('accounting_connections')
          .update({
            token_enc: encryptToken(token.token),
            token_expires_at: new Date(token.expiresAt).toISOString(),
          })
          .eq('id', row.id);
        if (saveError) throw saveError;
      },
      // QuickBooks: el refresh token rota. La llave entera se vuelve a cifrar
      // con el nuevo; si no se puede guardar, el programa no sigue.
      saveCredentials: async (next) => {
        const clean = cleanCredentials(provider, next);
        const { error: saveError } = await db
          .from('accounting_connections')
          .update({ credentials_enc: encryptToken(JSON.stringify(clean)) })
          .eq('id', row.id);
        if (saveError) throw saveError;
      },
    },
  });
}
