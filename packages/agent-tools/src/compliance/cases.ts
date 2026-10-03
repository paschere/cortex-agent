/**
 * EL NÚMERO DE UN PROCESO JUDICIAL.
 *
 * La Rama Judicial identifica cada proceso con un número único de radicación
 * de 23 dígitos. Por convención se lee así (de izquierda a derecha):
 *
 *   departamento (2) · municipio (3) · corporación o entidad (2) ·
 *   especialidad (2) · despacho (3) · año (4) · consecutivo (5) · recurso (2)
 *
 * Aquí sólo se exige lo que no se puede discutir — 23 dígitos y un año
 * creíble — y se descompone para mostrarlo; el despacho y la ciudad los
 * escribe la persona (o los trae la consulta), no se deducen del número.
 */

export interface ParsedRadicado {
  digits: string;
  departamento: string;
  municipio: string;
  entidad: string;
  especialidad: string;
  despacho: string;
  year: number;
  consecutivo: string;
  recurso: string;
  /** «05001-31-03-001-2024-00123-00», para leerlo. */
  pretty: string;
}

export function normalizeRadicado(text: string | null | undefined): string {
  return (text ?? '').replace(/\D+/g, '');
}

export function parseRadicado(
  text: string,
  thisYear = new Date().getUTCFullYear(),
): ParsedRadicado | null {
  const d = normalizeRadicado(text);
  if (d.length !== 23) return null;
  const year = Number(d.slice(12, 16));
  if (year < 1990 || year > thisYear + 1) return null;
  const parts = {
    departamento: d.slice(0, 2),
    municipio: d.slice(2, 5),
    entidad: d.slice(5, 7),
    especialidad: d.slice(7, 9),
    despacho: d.slice(9, 12),
    consecutivo: d.slice(16, 21),
    recurso: d.slice(21, 23),
  };
  return {
    digits: d,
    ...parts,
    year,
    pretty: `${parts.departamento}${parts.municipio}-${parts.entidad}-${parts.especialidad}-${parts.despacho}-${year}-${parts.consecutivo}-${parts.recurso}`,
  };
}

/** La petición para el chat: consultar un proceso con el trámite aprendido. */
export function ramaJudicialPrompt(radicado: string | null, title: string): string {
  const which = radicado ? `el proceso con radicado ${radicado}` : `el proceso «${title}»`;
  return `Consulta ${which} en la Consulta de Procesos de la Rama Judicial. Si ya tengo un trámite aprendido para eso, úsalo (browser.list_flows); si no, ábrela en el navegador de Cortex y enséñame el trámite una vez para dejarlo aprendido. Si el portal pide CAPTCHA, lo resuelvo yo en la pestaña en vivo: tú no lo intentes. Tráeme la última actuación con su fecha y si hay una próxima audiencia o diligencia, y propónme actualizar el proceso con compliance.case_update.`;
}
