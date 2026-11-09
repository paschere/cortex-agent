/** Tipos públicos del SDK. Reflejan lo que responde el servidor (`runSdkOp`). */

export interface SdkUser {
  id: string;
  name: string;
  role: string;
  attributes: Record<string, string>;
  /** Referencia de la persona, con el mismo formato que `SdkPerson.ref` («m:…» o «u:…»). */
  ref: string;
}

/** Una persona a quien se le puede asignar algo (`cortex.people.list`). */
export interface SdkPerson {
  ref: string;
  name: string;
  roleKey: string;
  roleName: string;
  onShift: boolean;
}

export interface SdkField {
  key: string;
  label: string;
  type: string;
  options?: string[];
}

export interface SdkTable {
  /** Id o nombre con el que se pide la tabla en `tables.query(...)`. */
  id: string;
  name: string;
  fields: SdkField[];
}

export interface SdkRow {
  id: string;
  label: string;
  values: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface QueryOptions {
  /** Igualdad por campo: `{ estado: 'abierta' }`. */
  where?: Record<string, unknown>;
  search?: string;
  order?: { field: string; dir?: 'asc' | 'desc' };
  /** Máximo 500. */
  limit?: number;
  offset?: number;
}

export interface SdkLocation {
  userId: string;
  name: string;
  lat: number;
  lng: number;
  accuracy?: number | null;
  at: string;
}

export interface SdkGeofence {
  id: string;
  name: string;
  [key: string]: unknown;
}

/** Un botón de flujo de una tabla que el rol puede correr (`tables.listActions`). */
export interface SdkAction {
  key: string;
  label: string;
}

export interface ActionResult {
  message: string;
  /** La fila como quedó, si el rol todavía la ve. */
  row?: SdkRow;
}

export interface UploadOptions {
  table: string;
  id: string;
  /** El campo de tipo archivo de la fila al que se agrega. */
  field: string;
  /** Nombre con que se guarda; por omisión el del archivo. */
  name?: string;
  /** Sin señal se guarda en el teléfono (el blob incluido) y se sube al volver; contesta `Queued`. */
  offline?: boolean;
}

export interface UploadResult {
  url: string;
  name: string;
  /** Los valores de la fila después de agregar el archivo. */
  values: Record<string, unknown>;
}

export interface PickOptions {
  /** Atributo `accept` del selector: `image/*`, `application/pdf`… */
  accept?: string;
  /** Abre la cámara en vez de la galería (celulares). */
  capture?: 'environment' | 'user';
  multiple?: boolean;
}

export interface ScanOptions {
  kind?: 'manifiesto' | 'guia' | 'general';
  /** Devolver también los renglones (por omisión sí en `manifiesto`). */
  rows?: boolean;
}

export type ScanValue = string | number;

export interface ScanResult {
  fields: Record<string, ScanValue>;
  rows: Record<string, ScanValue>[];
  text?: string;
}

export interface SdkPosition {
  lat: number;
  lng: number;
  accuracy: number;
  /** El nombre de la zona de la app donde está, o null. */
  zone: string | null;
  /** true/false según las zonas de la app; null si la app no tiene zonas. */
  inside: boolean | null;
}

export interface PrintOptions {
  /** Título del documento (el nombre que propone «guardar como PDF»). */
  title?: string;
}

export interface ConfirmOptions {
  confirmLabel?: string;
  /** Pinta el botón principal como acción que no se deshace. */
  danger?: boolean;
}

// ---------------------------------------------------------------------------
// Canal en vivo, cola sin señal
// ---------------------------------------------------------------------------

/** Estado del canal en vivo de la app: `live` conectado, `reconnecting` reintentando, `off` sin canal (se sondea). */
export type LiveStatus = 'live' | 'reconnecting' | 'off';

/** Aviso de que algo cambió en una tabla (el nombre es el mismo con el que se pidió). */
export interface LiveEvent {
  table: string;
  at: string;
}

/** Opciones de las escrituras que pueden esperar a que vuelva la señal. */
export interface WriteOptions {
  /**
   * Sin red (o con un fallo de red/5xx) el marco guarda la operación en el teléfono y contesta
   * `{ queued: true, localId }`; sale sola, en orden, al volver la señal.
   */
  offline?: boolean;
}

/** Lo que devuelve una escritura `offline` que quedó en la cola. */
export interface Queued {
  queued: true;
  /** Id local de la operación. Sirve como `id` de filas creadas sin señal y para `outbox.discard`. */
  localId: string;
  /** Referencia local (`local:<localId>`): se puede usar como valor o como `id` en operaciones encoladas después. */
  ref: string;
}

/** Lo que una escritura devuelve según se pida `offline` o no. */
export type MaybeQueued<T, O extends WriteOptions | undefined> = O extends { offline: true }
  ? T | Queued
  : T;

export interface OutboxItem {
  id: string;
  /** La operación: `tables.insert`, `tables.update`, `tables.action`, `files.upload`. */
  op: string;
  table: string;
  label: string;
  /** `pending` por enviar · `retrying` falló y se reintenta · `rejected` el servidor dijo que no (espera a la persona). */
  state: 'pending' | 'retrying' | 'rejected';
  attempts: number;
  createdAt: number;
  error?: string;
}

export interface OutboxState {
  items: OutboxItem[];
  /** Los que saldrán solos. */
  pending: number;
  /** Los rechazados. */
  failed: number;
  /** El teléfono tiene señal. */
  online: boolean;
}

export interface LiveOptions {
  /** Cuando cambia la tabla se vuelve a leer (con rebote de ~300 ms). */
  live?: boolean;
  /** Sondeo explícito en ms; con `live` solo se usa si el canal no está conectado. */
  refreshMs?: number;
}
