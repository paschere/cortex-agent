'use client';

import { withFilterParam } from '@/lib/views/filter-param';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Download, FileSpreadsheet, Loader2, Printer } from 'lucide-react';
import { useState } from 'react';

/**
 * «EXPORTAR»: Excel y PDF, dentro de la app y en el enlace compartido.
 *
 * Excel baja de /api/views/<id>/export o /api/views/public/export (la misma
 * ruta de datos con `/export`), con los filtros que se están mirando (`?f=`):
 * el servidor lo calcula con las mismas puertas que la pantalla. PDF es la
 * impresión del navegador con la hoja de estilos de impresión (views.css):
 * el título del documento lleva el nombre de la vista y la fecha, que es lo
 * que Chrome y Safari ponen de nombre al archivo y en el encabezado.
 */

const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' });

export function ExportMenu({
  dataUrl,
  filterParam,
  title,
  excel: canExcel = true,
}: {
  /** La ruta de datos de la vista; de ella sale la de exportar. Null: sólo PDF. */
  dataUrl: string | null;
  /** Lo elegido en la barra de filtros, ya codificado. */
  filterParam: string;
  title: string;
  /** Falso: oculta la opción de Excel (el rol no exporta). */
  excel?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const excel = async () => {
    if (!dataUrl) return;
    setBusy(true);
    setError(null);
    try {
      const base = dataUrl.replace(/\/data(\?|$)/, '/export$1');
      const res = await fetch(withFilterParam(base, filterParam, window.location.origin), {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'No se pudo exportar.');
        return;
      }
      const blob = await res.blob();
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
        'vista.xlsx';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('No se pudo exportar. Revisa tu conexión.');
    } finally {
      setBusy(false);
    }
  };

  const pdf = () => {
    const previous = document.title;
    document.title = `${title} — ${DAY.format(new Date())}`;
    const restore = () => {
      document.title = previous;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
  };

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          title="Exportar a Excel o PDF"
          className="inline-flex h-8 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-micro font-semibold text-ink-muted shadow-card transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Download className="h-3.5 w-3.5" aria-hidden />
          )}
          Exportar
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            align="end"
            sideOffset={6}
            className="view-no-print z-50 min-w-[12rem] rounded-card border border-border bg-surface p-1 text-xs shadow-pop"
          >
            {dataUrl && canExcel && (
              <Menu.Item
                onSelect={() => void excel()}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 font-medium text-ink outline-none data-[highlighted]:bg-surface-2"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden /> Excel (.xlsx)
              </Menu.Item>
            )}
            <Menu.Item
              onSelect={pdf}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 font-medium text-ink outline-none data-[highlighted]:bg-surface-2"
            >
              <Printer className="h-3.5 w-3.5" aria-hidden /> PDF (imprimir)
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {error && (
        <span role="alert" className="text-micro font-medium text-rose">
          {error}
        </span>
      )}
    </>
  );
}
