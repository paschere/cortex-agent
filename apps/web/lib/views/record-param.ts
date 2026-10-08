/**
 * EL ENLACE PROFUNDO DE UN REGISTRO: `?fila=<id>` (y `&d=<bloque>` si la
 * pantalla tiene varios detalles). Lo escribe el navegador al abrir una fila;
 * el servidor lo lee en la página y en la ruta de datos (`loadRecordContext`)
 * y decide con el scope del rol si esa fila existe para quien mira.
 */

export interface RecordRef {
  rowId: string;
  blockId: string | null;
}

/** La dirección de datos con el registro abierto (o sin él, si no hay). */
export function withRecordParam(dataUrl: string, rec: RecordRef | null, origin: string): string {
  const url = new URL(dataUrl, origin);
  if (rec) {
    url.searchParams.set('fila', rec.rowId);
    if (rec.blockId) url.searchParams.set('d', rec.blockId);
    else url.searchParams.delete('d');
  } else {
    url.searchParams.delete('fila');
    url.searchParams.delete('d');
  }
  return `${url.pathname}${url.search}`;
}

/** Lo que la dirección de la página dice del registro abierto. */
export function recordFromSearch(search: string): RecordRef | null {
  const params = new URLSearchParams(search);
  const rowId = params.get('fila');
  return rowId && /^[0-9a-f-]{36}$/i.test(rowId) ? { rowId, blockId: params.get('d') } : null;
}

/** La dirección de la página con el registro puesto (o quitado). */
export function pageUrlWithRecord(href: string, rec: RecordRef | null): string {
  const url = new URL(href);
  if (rec) {
    url.searchParams.set('fila', rec.rowId);
    if (rec.blockId) url.searchParams.set('d', rec.blockId);
    else url.searchParams.delete('d');
  } else {
    url.searchParams.delete('fila');
    url.searchParams.delete('d');
  }
  return url.toString();
}
