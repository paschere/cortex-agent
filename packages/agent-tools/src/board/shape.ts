/**
 * EL INFORME PARA SOCIOS: SU FORMA (0191).
 *
 * Un informe es una lista de secciones fijas (las que un socio espera leer
 * cada mes, en el mismo orden) y las cifras de las que salen. El resumen de
 * cinco líneas lo escribe el modelo SÓLO con esas cifras (lo revisa el mismo
 * verificador del pulso, views/pulse.ts `checkGrounding`); si inventa un
 * número dos veces, el resumen lo arma una plantilla.
 */

export const BOARD_SECTIONS = [
  'resumen',
  'resultados',
  'caja',
  'cartera',
  'indicadores',
  'hitos',
  'riesgos',
  'proximos',
] as const;
export type BoardSectionKey = (typeof BOARD_SECTIONS)[number];

export const BOARD_SECTION_TITLE: Record<BoardSectionKey, string> = {
  resumen: 'Resumen en cinco líneas',
  resultados: 'Resultados contra presupuesto y año anterior',
  caja: 'Caja y proyección',
  cartera: 'Cartera y cuentas por pagar',
  indicadores: 'Indicadores',
  hitos: 'Hitos y decisiones del mes',
  riesgos: 'Riesgos',
  proximos: 'Próximos pasos',
};

export interface BoardTable {
  columns: string[];
  rows: string[][];
  /** Columnas numéricas (alineadas a la derecha). */
  numeric?: number[];
}

export interface BoardSection {
  key: BoardSectionKey;
  title: string;
  lines: string[];
  table?: BoardTable | null;
}

/** Una cifra del informe: la misma forma que una cifra del pulso. */
export interface BoardFact {
  key: string;
  label: string;
  value: number | null;
  display: string;
}

export interface BoardContent {
  version: 1;
  period: string;
  periodLabel: string;
  company: string;
  generatedAt: string;
  summary: string[];
  summarySource: 'modelo' | 'plantilla';
  sections: BoardSection[];
  facts: BoardFact[];
  /** Lo que no se pudo leer (y por eso falta en el informe). */
  gaps: string[];
}

export type BoardVisibility = 'privado' | 'enlace' | 'contrasena';
export type BoardStatus = 'borrador' | 'enviado';

export interface BoardReport {
  id: string;
  period: string;
  status: BoardStatus;
  title: string;
  content: BoardContent;
  markdown: string;
  fallback: boolean;
  generatedAt: string;
  generatedBy: string | null;
  visibility: BoardVisibility;
  shareToken: string | null;
  shareExpiresAt: string | null;
  shareViews: number;
  sentAt: string | null;
  sentTo: string[];
  updatedAt: string;
}

export interface BoardSettings {
  enabled: boolean;
  dayOfMonth: number;
  hour: number;
  recipients: string[];
  jobId: string | null;
  updatedAt: string | null;
}

export const DEFAULT_BOARD_SETTINGS: BoardSettings = {
  enabled: false,
  dayOfMonth: 5,
  hour: 7,
  recipients: [],
  jobId: null,
  updatedAt: null,
};

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** «2026-09» → «septiembre de 2026». */
export function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return `${MONTHS[m - 1] ?? ''} de ${y}`;
}

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** El mes que se informa por defecto: el anterior al de hoy. */
export function defaultPeriod(today: string): string {
  const [y, m] = today.slice(0, 7).split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** El informe entero como texto (para el chat, el correo y la copia). */
export function boardMarkdown(c: BoardContent): string {
  const out: string[] = [`# Informe para socios — ${c.periodLabel}`, `${c.company}`, ''];
  for (const s of c.sections) {
    out.push(`## ${s.title}`);
    if (s.key === 'resumen') for (const l of c.summary) out.push(`- ${l}`);
    else for (const l of s.lines) out.push(l.startsWith('|') ? l : `- ${l}`);
    if (s.table) {
      out.push('', `| ${s.table.columns.join(' | ')} |`);
      out.push(
        `|${s.table.columns.map((_, i) => (s.table?.numeric?.includes(i) ? '---:' : '---')).join('|')}|`,
      );
      for (const r of s.table.rows) out.push(`| ${r.join(' | ')} |`);
    }
    out.push('');
  }
  if (c.gaps.length) out.push(`_No se pudo leer: ${c.gaps.join(', ')}._`);
  return out.join('\n').slice(0, 59_000);
}
