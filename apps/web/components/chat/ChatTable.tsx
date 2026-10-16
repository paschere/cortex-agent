'use client';

import {
  type HastNode,
  type TableModel,
  analyzeTable,
  tableToCsv,
  tableToTsv,
} from '@/lib/chat-table';
import { clsx } from 'clsx';
import { Check, Copy, Download } from 'lucide-react';
import {
  type ComponentPropsWithoutRef,
  createContext,
  useContext,
  useMemo,
  useState,
} from 'react';

/**
 * UNA TABLA DEL CHAT QUE SE LEE COMO UN REPORTE.
 *
 * Encabezado pequeño y tenue, celdas con aire, cifras alineadas a la derecha
 * con dígitos de ancho fijo, una barra fina detrás de cada cifra para comparar
 * filas de un vistazo, el total separado y en negrita, y arriba a la derecha
 * copiar (pega en Excel/Sheets) y descargar CSV. Una tabla ancha se desplaza en
 * su caja; la página no se mueve.
 */

const TableContext = createContext<TableModel | null>(null);

type WithNode<T extends 'table' | 'thead' | 'tr' | 'th' | 'td'> = ComponentPropsWithoutRef<T> & {
  node?: unknown;
};

export function ChatTable({ children, node }: WithNode<'table'>) {
  const model = useMemo(() => analyzeTable(node as HastNode | undefined), [node]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tableToTsv(model));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // sin portapapeles: el botón no confirma
    }
  };
  const download = () => {
    const blob = new Blob([`﻿${tableToCsv(model)}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(model.headers[0] || 'tabla').toLowerCase().replace(/[^\p{L}\d]+/gu, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const rows = model.rows.length;

  return (
    <TableContext.Provider value={model}>
      <figure className="not-prose group/table my-4 max-w-[46rem] overflow-hidden rounded-card border border-border bg-surface shadow-card">
        <div className="scroll-slim max-w-full overflow-x-auto">
          <table className="w-full border-collapse text-sm tabular-nums">{children}</table>
        </div>
        <figcaption className="flex items-center gap-2 border-t border-border bg-surface-2/60 px-3 py-1.5 text-micro text-ink-faint">
          <span className="flex-1">
            {rows} {rows === 1 ? 'fila' : 'filas'}
          </span>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-label="Copiar la tabla para pegarla en Excel o Sheets"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copiada' : 'Copiar'}
          </button>
          <button
            type="button"
            onClick={download}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-label="Descargar la tabla como CSV"
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </button>
        </figcaption>
      </figure>
    </TableContext.Provider>
  );
}

export function ChatThead({ children }: WithNode<'thead'>) {
  return <thead className="bg-surface-2/70">{children}</thead>;
}

export function ChatTr({ children, node }: WithNode<'tr'>) {
  const model = useContext(TableContext);
  const total = !!model && model.totalRows.has(node as HastNode);
  return (
    <tr
      className={clsx(
        'border-b border-border last:border-b-0',
        total
          ? 'border-t-2 border-t-border-strong bg-surface-2/50 font-semibold text-ink'
          : 'transition-colors hover:bg-surface-2/40',
      )}
    >
      {children}
    </tr>
  );
}

export function ChatTh({ children, node, style }: WithNode<'th'>) {
  const model = useContext(TableContext);
  const col = model?.headCells.get(node as HastNode) ?? -1;
  const numeric = !!model && model.numericCols.has(col);
  return (
    <th
      style={style}
      className={clsx(
        'whitespace-nowrap px-3.5 py-2 text-micro font-semibold uppercase tracking-wide text-ink-faint',
        numeric ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

export function ChatTd({ children, node, style }: WithNode<'td'>) {
  const model = useContext(TableContext);
  const info = model?.cells.get(node as HastNode);
  const col = info?.col ?? -1;
  const numeric = !!model && model.numericCols.has(col);
  const share = info?.share ?? null;
  const negative = typeof info?.value === 'number' && info.value < 0;
  return (
    <td
      style={style}
      className={clsx(
        'relative px-3.5 pb-3 pt-2 align-top',
        col === 0 ? 'text-ink' : 'text-ink-muted',
        numeric && 'whitespace-nowrap text-right font-medium text-ink',
        negative && 'text-rose',
        !numeric && (info?.long ? 'min-w-[12rem] max-w-[22rem]' : 'whitespace-nowrap'),
      )}
    >
      {share !== null && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1.5 right-3.5 h-[3px] rounded-full bg-primary/35"
          style={{ width: `calc((100% - 1.75rem) * ${Math.max(share, 0.02).toFixed(3)})` }}
        />
      )}
      <span className="relative">{children}</span>
    </td>
  );
}
