import type { DraftFigures } from '@cortex/agent-tools';

/**
 * El borrador como CSV para el contador: cada renglón y, debajo, cada
 * documento que lo forma. Puro y sin dependencias de ejecución (sólo tipos de
 * @cortex/agent-tools): lo llama el botón «CSV» en el navegador.
 */

function cell(value: string | number | null | undefined): string {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  const text = (value ?? '').replace(/\r?\n/g, ' ');
  return /[",;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function draftCsv(f: DraftFigures): string {
  const out: string[] = [
    `# ${f.title}`,
    `# ${f.disclaimer}. Periodo ${f.period.from} a ${f.period.to}. ${f.basis}. Tarifas ${f.rulesVersion}.`,
    [
      'Sección',
      'Renglón',
      'Base',
      'Tarifa %',
      'Valor',
      'Por confirmar',
      'Documento',
      'Fecha',
      'Valor del documento',
    ]
      .map(cell)
      .join(','),
  ];
  for (const s of f.sections) {
    for (const l of s.lines) {
      out.push(
        [
          s.label,
          l.label,
          l.base ?? '',
          l.rate ?? '',
          l.amount,
          l.needsConfirmation ? 'Sí' : '',
          l.derived ? (l.formula ?? 'Total') : '',
          '',
          '',
        ]
          .map(cell)
          .join(','),
      );
      for (const src of l.sources)
        out.push(
          ['', '', '', '', '', '', src.label, src.date ?? '', src.amount].map(cell).join(','),
        );
    }
  }
  out.push(
    ['Resultado', f.result.label, '', '', f.result.amount, '', '', '', ''].map(cell).join(','),
  );
  for (const m of f.missing)
    out.push(['Dato que falta', m.message, '', '', '', '', '', '', ''].map(cell).join(','));
  return `﻿${out.join('\r\n')}\r\n`;
}

export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
