import { type GridRow, dig } from '@/lib/result-grid';
import { toolDisplayName } from '@/lib/tool-labels';

/**
 * LO QUE CORTEX ARMÓ, Y CÓMO SE ABRE AL LADO.
 *
 * Un resultado estructurado del turno (tabla, gráfico, informe, propuesta) se
 * dibuja en línea como siempre; además puede abrirse a tamaño completo en el
 * panel derecho del chat. Este módulo decide, sin tocar React, QUÉ resultados
 * pueden abrirse, con qué título y —si es una tabla— qué filas se llevan a un
 * CSV. Es puro para poder probarlo.
 */

export type ArtifactKind = 'table' | 'chart' | 'report' | 'proposal' | 'summary';

export interface ArtifactCsv {
  headers: string[];
  rows: string[][];
}

export interface ArtifactMeta {
  title: string;
  kind: ArtifactKind;
  csv?: ArtifactCsv;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Una celda en texto plano: lo que se vería en la tabla, sin formato de moneda. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(csvCell).join('; ');
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * CSV con BOM y saltos CRLF: es lo que Excel abre bien con tildes y eñes sin
 * pasar por el asistente de importación.
 */
export function toCsv(csv: ArtifactCsv): string {
  const esc = (cell: string) => (/[",\r\n;]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
  const lines = [csv.headers, ...csv.rows].map((row) => row.map(esc).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Nombre de archivo seguro y legible a partir del título. */
export function csvFileName(title: string): string {
  const base = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${base || 'cortex'}.csv`;
}

/** Resultados `rich` que merecen panel. Los vivos (navegador, llamada) y los de decidir no. */
const PANELABLE: ReadonlySet<string> = new Set([
  'trackers_query',
  'trackers_list',
  'reports_chart',
  'reports_generate',
  'reports_open',
  'sales_draft_proposal',
  'payments_receivables',
  'clients_overview',
  'clients_directory',
  'commitments_due_soon',
  'goals_list',
  'inbox_overview',
]);

function trackerCsv(result: unknown): ArtifactCsv | undefined {
  const tracker = field(result, 'tracker');
  const rows = field(result, 'rows');
  const fields = field(tracker, 'fields');
  if (!Array.isArray(fields) || !Array.isArray(rows)) return undefined;
  const cols = fields.flatMap((f) => {
    const key = text(field(f, 'key'));
    return key ? [{ key, label: text(field(f, 'label')) ?? key }] : [];
  });
  if (cols.length === 0) return undefined;
  return {
    headers: cols.map((c) => c.label),
    rows: rows.map((row) => cols.map((c) => csvCell(field(field(row, 'values'), c.key)))),
  };
}

export interface DeclaredSpec {
  rows: string;
  columns: { key: string; label: string }[];
}

/** Una tabla declarada (registry.TABLE): las columnas de la especificación, las filas del resultado. */
export function declaredCsv(spec: DeclaredSpec, result: unknown): ArtifactCsv | undefined {
  const raw = field(result, spec.rows);
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return {
    headers: spec.columns.map((c) => c.label),
    rows: raw.map((row) => spec.columns.map((c) => csvCell(dig(row as GridRow, c.key)))),
  };
}

/**
 * Qué se puede abrir al lado y cómo se llama. `null` = se queda sólo en línea.
 * `spec` viene sólo de las tablas declaradas.
 */
export function artifactMeta(
  toolName: string,
  result: unknown,
  spec?: DeclaredSpec,
): ArtifactMeta | null {
  const key = toolName.replaceAll('.', '_');
  if (spec) {
    const csv = declaredCsv(spec, result);
    return { title: toolDisplayName(toolName), kind: 'table', ...(csv ? { csv } : {}) };
  }
  if (!PANELABLE.has(key)) return null;
  switch (key) {
    case 'trackers_query': {
      const csv = trackerCsv(result);
      return {
        title: text(field(field(result, 'tracker'), 'name')) ?? 'Tabla',
        kind: 'table',
        ...(csv ? { csv } : {}),
      };
    }
    case 'reports_chart':
      return { title: text(field(result, 'heading')) ?? 'Gráfico', kind: 'chart' };
    case 'reports_generate':
    case 'reports_open':
      return {
        title: text(field(field(result, 'report'), 'title')) ?? 'Informe',
        kind: 'report',
      };
    case 'sales_draft_proposal': {
      const company = text(field(field(result, 'company'), 'name'));
      return { title: company ? `Propuesta para ${company}` : 'Propuesta', kind: 'proposal' };
    }
    default:
      return { title: toolDisplayName(toolName), kind: 'summary' };
  }
}

/** El texto que se deja en el chat para guardar el resultado como vista. */
export function saveAsViewPrompt(title: string): string {
  return `Guarda esto como vista: «${title}»`;
}

export function askMorePrompt(title: string): string {
  return `Sobre «${title}»: `;
}
