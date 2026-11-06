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

export interface ConfirmOptions {
  confirmLabel?: string;
  /** Pinta el botón principal como acción que no se deshace. */
  danger?: boolean;
}
