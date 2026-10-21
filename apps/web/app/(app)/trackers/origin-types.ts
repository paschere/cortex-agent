import type { OriginStatus, TableOriginKind } from '@cortex/agent-tools/src/trackers/origin';

/** Lo que la pantalla sabe de un origen de una tabla sincronizada (0237). */
export interface TableOriginInfo {
  ref: string;
  kind: TableOriginKind;
  /** «Siigo», «la hoja «Vuelos»». */
  name: string;
  status: OriginStatus;
  enabled: boolean;
  /** Quien mira puede pedir «Actualizar ahora». */
  canRefresh: boolean;
}

export type TableOriginsResult =
  | { ok: true; items: TableOriginInfo[] }
  | { ok: false; error: string };
