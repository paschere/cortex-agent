/** Tipos públicos del SDK. Reflejan lo que responde el servidor (`runSdkOp`). */

export interface SdkUser {
  id: string;
  name: string;
  role: string;
  attributes: Record<string, string>;
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
