import { z } from 'zod';
import type { TrackerField } from './schema';

/**
 * DE DÓNDE VIENE UNA TABLA (migración 0237).
 *
 * Una tabla que se llena sola —desde Siigo/Alegra/QuickBooks, una hoja de
 * cálculo, una carpeta de Drive— tiene DOS clases de campos:
 *   - los del ORIGEN (`origins[].fields`): los escribe la sincronización; lo
 *     que alguien cambie aquí no llega al programa y la siguiente lectura lo
 *     pisa. Son de sólo lectura para apps, vistas, grilla y chat.
 *   - los PROPIOS: cualquier otro campo (estado de cobro interno, responsable,
 *     notas). La sincronización nunca los toca ni los borra y se editan con los
 *     permisos normales.
 *
 * Una tabla puede tener varios orígenes (la tabla «Guías» la crean los PDFs de
 * una carpeta y el estado del vuelo lo escribe una API): la lista de campos
 * bloqueados es la unión.
 *
 * Todo este archivo es puro: lo usa el servidor (un solo punto de rechazo) y la
 * interfaz (candado, aviso), sin tocar la base.
 */

export const TABLE_ORIGIN_KINDS = ['accounting', 'sheet', 'drive_folder'] as const;
export type TableOriginKind = (typeof TABLE_ORIGIN_KINDS)[number];

export const trackerOriginSchema = z.object({
  kind: z.enum(TABLE_ORIGIN_KINDS),
  /** accounting: siigo | alegra | quickbooks. */
  provider: z.string().max(40).optional(),
  /** «Siigo», «la hoja Vuelos», «la carpeta Guías»: va en las frases. */
  label: z.string().max(200),
  /** Id de la conexión contable / de tracker_syncs / de drive_folder_syncs. */
  ref: z.string().max(80),
  /** Claves de los campos que escribe el origen. */
  fields: z.array(z.string().max(40)).max(200),
  /** ¿El origen agrega filas? (`update_only` no: sólo escribe en las que hay.) */
  creates: z.boolean().default(true),
  /** Escritura de vuelta habilitada por la empresa (hojas): se escribe al origen con confirmación. */
  writeBack: z.boolean().optional(),
});
export type TrackerOrigin = z.infer<typeof trackerOriginSchema>;

/** Lo que sea que traiga la columna `trackers.origins`, como lista válida (nunca lanza). */
export function parseOrigins(raw: unknown): TrackerOrigin[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackerOrigin[] = [];
  for (const item of raw) {
    const parsed = trackerOriginSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

type HasOrigins = { origins?: unknown };

export function originsOf(tracker: HasOrigins | null | undefined): TrackerOrigin[] {
  return tracker ? parseOrigins(tracker.origins) : [];
}

export function isSyncedTable(tracker: HasOrigins | null | undefined): boolean {
  return originsOf(tracker).length > 0;
}

/** El origen que escribe este campo, o null si es propio. */
export function originOfField(
  tracker: HasOrigins | null | undefined,
  fieldKey: string,
): TrackerOrigin | null {
  return originsOf(tracker).find((o) => o.fields.includes(fieldKey)) ?? null;
}

export function lockedFieldKeys(tracker: HasOrigins | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const o of originsOf(tracker)) for (const k of o.fields) keys.add(k);
  return keys;
}

/** Campos propios: los que la empresa agregó encima de la tabla sincronizada. */
export function ownFieldKeys(
  tracker: (HasOrigins & { fields: Array<Pick<TrackerField, 'key'>> }) | null | undefined,
): string[] {
  if (!tracker) return [];
  const locked = lockedFieldKeys(tracker);
  return tracker.fields.map((f) => f.key).filter((k) => !locked.has(k));
}

/**
 * El origen que PROHÍBE filas a mano: sólo los programas contables (escribir va
 * por la bandeja «Por enviar a Siigo»). En hojas y carpetas la empresa también
 * crea filas a mano (formularios de clientes, grilla, chat, apps): esas filas no
 * tienen `external_key`, la sincronización nunca las toca ni las borra, y se
 * editan libremente.
 */
export function creatingOrigin(tracker: HasOrigins | null | undefined): TrackerOrigin | null {
  return originsOf(tracker).find((o) => o.kind === 'accounting') ?? null;
}

/** El origen que bloquea ESTE campo en TODAS las filas (contable); en hojas/carpetas el candado es sólo de las filas con `external_key`. */
export function hardOriginOfField(
  tracker: HasOrigins | null | undefined,
  fieldKey: string,
): TrackerOrigin | null {
  return (
    originsOf(tracker).find((o) => o.kind === 'accounting' && o.fields.includes(fieldKey)) ?? null
  );
}

export function hardLockedFieldKeys(tracker: HasOrigins | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const o of originsOf(tracker))
    if (o.kind === 'accounting') for (const k of o.fields) keys.add(k);
  return keys;
}

const PROVIDER_NAME: Record<string, string> = {
  siigo: 'Siigo',
  alegra: 'Alegra',
  quickbooks: 'QuickBooks',
};

export function originName(o: TrackerOrigin): string {
  if (o.kind === 'accounting') return PROVIDER_NAME[o.provider ?? ''] ?? (o.provider || o.label);
  return o.label;
}

/** Dónde se cambia el dato: lo que sigue a «cámbialo en…». */
function whereToChange(o: TrackerOrigin): string {
  if (o.kind === 'accounting') {
    const name = originName(o);
    return o.provider === 'siigo' ? `${name} o con la bandeja «Por enviar a Siigo»` : `${name}`;
  }
  if (o.kind === 'sheet')
    return o.writeBack ? `${o.label} (o pídele a Cortex que lo escriba en la hoja)` : o.label;
  return `el documento de ${o.label}`;
}

/** «Este dato viene de Siigo: cámbialo en Siigo o con la bandeja «Por enviar a Siigo»». */
export function fieldLockedMessage(o: TrackerOrigin, labels: string[] = []): string {
  const what =
    labels.length === 0
      ? 'Este dato viene'
      : labels.length === 1
        ? `«${labels[0]}» viene`
        : `${labels.map((l) => `«${l}»`).join(', ')} vienen`;
  return `${what} de ${originName(o)}: cámbialo en ${whereToChange(o)}.`;
}

export function rowCreateBlockedMessage(o: TrackerOrigin): string {
  if (o.kind === 'accounting')
    return `Esta tabla se llena sola desde ${originName(o)}: las filas no se agregan a mano. ${
      o.provider === 'siigo'
        ? 'Para crear facturas, recibos o clientes usa la bandeja «Por enviar a Siigo».'
        : `Se crean en ${originName(o)} y llegan en la siguiente sincronización.`
    }`;
  if (o.kind === 'sheet')
    return `Esta tabla se llena sola desde ${o.label}: agrega la fila en la hoja y llega en la siguiente sincronización.`;
  return `Esta tabla se llena sola desde ${o.label}: las filas llegan con los archivos nuevos de la carpeta.`;
}

/** Une un origen a la lista: reemplaza el que tenga el mismo tipo y ref. */
export function mergeOrigin(current: TrackerOrigin[], next: TrackerOrigin): TrackerOrigin[] {
  const others = current.filter((o) => !(o.kind === next.kind && o.ref === next.ref));
  const prev = current.find((o) => o.kind === next.kind && o.ref === next.ref);
  return [...others, { ...next, writeBack: next.writeBack ?? prev?.writeBack }];
}

// ---------------------------------------------------------------------------
// Frescura
// ---------------------------------------------------------------------------

export interface OriginStatus {
  /** Última lectura terminada (ISO) o null si nunca. */
  lastSyncAt: string | null;
  state: 'ok' | 'error' | 'never';
  error?: string | null;
  /** Hay una sincronización pedida o corriendo ahora. */
  running?: boolean;
}

/** «hace 3 min», «hace 2 h», «hace 4 días»; el reloj entra por parámetro. */
export function agoLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'sin leer todavía';
  const ms = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
}

/** «Viene de Siigo · actualizado hace 3 min» (o «· no se pudo actualizar»), con el nombre ya dicho. */
export function freshnessText(
  name: string,
  status: OriginStatus | null,
  now: number = Date.now(),
): string {
  const head = `Viene de ${name}`;
  if (!status || status.state === 'never' || !status.lastSyncAt) {
    return status?.running ? `${head} · actualizando…` : `${head} · sin leer todavía`;
  }
  const when = agoLabel(status.lastSyncAt, now);
  if (status.running) return `${head} · actualizando…`;
  if (status.state === 'error') return `${head} · no se pudo actualizar (última vez ${when})`;
  return `${head} · actualizado ${when}`;
}

export function freshnessSentence(
  origin: TrackerOrigin,
  status: OriginStatus | null,
  now: number = Date.now(),
): string {
  return freshnessText(originName(origin), status, now);
}

/** Mínimo entre «Actualizar ahora» de una misma conexión. */
export const REFRESH_MIN_INTERVAL_MS = 60_000;

/** ¿Ya se puede volver a pedir? Devuelve los segundos que faltan (0 = ya). */
export function refreshWaitSeconds(
  lastRequestedAt: string | null | undefined,
  now: number = Date.now(),
): number {
  if (!lastRequestedAt) return 0;
  const left = REFRESH_MIN_INTERVAL_MS - (now - new Date(lastRequestedAt).getTime());
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * Lo que Cortex tiene que saber de las tablas que vienen de una integración
 * (descripciones de trackers.*, views.* y apps.*). Una sola redacción.
 */
export const SYNCED_TABLES_NOTE =
  'TABLES THAT COME FROM AN INTEGRATION (trackers.list marks them «viene de …»). Accounting-program tables (Siigo/Alegra/QuickBooks, e.g. siigo_facturas): every field the program writes is READ-ONLY and rows are never added by hand — the server rejects it naming where to change it (for Siigo, the «Por enviar a Siigo» tray); never build forms, editable columns or buttons over those fields or tables. Tables filled from a Google Sheet or a Drive folder: the rows the source brought (they have an external key) are read-only in the fields the source writes, but rows created by hand (forms, grid, chat, apps) can be created and edited freely and the sync never touches or deletes them. On any of them you CAN add the company OWN fields on top with trackers.define (e.g. «estado de cobro interno», «responsable», «notas»: the sync never touches them) and edit those in views, apps and chat; read and chart everything. For a Google Sheet with write-back enabled use trackers.write_back_sheet (the person confirms each change). Every block over such a table shows «Viene de … · actualizado hace N min» with an «Actualizar ahora» button; from chat use accounting.sync_now (programs) or trackers.retry_sync (sheets/folders).';
