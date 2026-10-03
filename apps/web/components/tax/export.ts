import type { TaxObligationView } from './types';

/**
 * El calendario como CSV para el contador o para Excel. Puro y sin
 * dependencias: lo llama el botón «Exportar» en el navegador.
 */

function cell(value: string | null | undefined): string {
  const text = (value ?? '').replace(/\r?\n/g, ' ');
  return /[",;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function obligationsCsv(rows: TaxObligationView[]): string {
  const header = [
    'Fecha',
    'Obligación',
    'Periodo',
    'Formulario',
    'Entidad',
    'Estado',
    'Por confirmar',
    'Nota',
    'Evidencia',
    'Fuente',
  ];
  const lines = rows.map((r) =>
    [
      r.dueDate,
      r.title,
      r.period,
      r.form ?? '',
      r.authority,
      r.statusLabel,
      r.needsConfirmation ? 'Sí' : 'No',
      r.statusNote ?? '',
      r.evidenceHref ?? '',
      r.sourceNote ?? '',
    ]
      .map(cell)
      .join(','),
  );
  // BOM para que Excel abra las tildes bien.
  return `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`;
}
