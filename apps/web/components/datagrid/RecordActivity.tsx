'use client';

import { loadRecordActivity } from '@/app/(app)/actividad/record-actions';
import type { RecordActivityLine, RecordRef } from '@/lib/activity/record';
import { chipClass } from '@/lib/status-chip';
import { History } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * «ACTIVIDAD» DE UN REGISTRO: quién hizo o aprobó qué sobre él.
 *
 * Se lee al abrir el panel (no por cada fila de la tabla) con el mismo alcance
 * de /actividad: quien administra ve todo, el resto sólo lo hecho con su sesión.
 * Si no hay nada o no se pudo leer, la sección lo dice sin estorbar.
 */

const fmt = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

export function RecordActivity({ recordRef }: { recordRef: RecordRef }) {
  const key = JSON.stringify(recordRef);
  const [state, setState] = useState<
    { key: string; status: 'ok'; lines: RecordActivityLine[] } | { key: string; status: 'err' }
  >();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` resume la referencia.
  useEffect(() => {
    let live = true;
    loadRecordActivity(recordRef)
      .then((res) => {
        if (live)
          setState(res.ok ? { key, status: 'ok', lines: res.lines } : { key, status: 'err' });
      })
      .catch(() => live && setState({ key, status: 'err' }));
    return () => {
      live = false;
    };
  }, [key]);

  const current = state?.key === key ? state : undefined;
  return (
    <section aria-label="Actividad del registro" data-record-activity="">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold text-ink">
        <History className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
        Actividad
        <Link href="/actividad" className="ml-auto text-micro font-semibold text-primary">
          Ver todo
        </Link>
      </h3>
      {!current ? (
        <p className="text-xs text-ink-faint">Buscando quién tocó este registro…</p>
      ) : current.status === 'err' ? (
        <p className="text-xs text-ink-faint">No se pudo leer la actividad ahora.</p>
      ) : current.lines.length === 0 ? (
        <p className="text-xs text-ink-faint">
          Sin movimientos de Cortex sobre este registro en los últimos 4 meses.
        </p>
      ) : (
        <ol className="flex flex-col divide-y divide-border">
          {current.lines.map((l) => (
            <li key={l.id} className="py-2">
              <p className="text-xs text-ink">{l.text}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-muted">
                <span className="font-semibold text-ink">{l.who}</span>
                <span
                  className={chipClass(
                    l.failed
                      ? 'rose'
                      : l.how === 'approved'
                        ? 'amber'
                        : l.how === 'auto'
                          ? 'primary'
                          : 'neutral',
                  )}
                >
                  {l.failed ? 'No salió' : l.decision}
                </span>
                <span className="tabular">{fmt.format(new Date(l.at))}</span>
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
