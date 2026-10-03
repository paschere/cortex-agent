'use client';

import { ConnectCatalog } from '@/components/sources/ConnectCatalog';
import { ConnectedSources, type SourceSyncActions } from '@/components/sources/ConnectedSources';
import { PageHeader } from '@/components/ui/page-header';
import type { CatalogGroup } from '@/lib/sources/catalog';
import type { ConnectedSource } from '@/lib/sources/overview';
import { ChevronDown, Plug } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Las acciones de mentira: tardan un poco y contestan como las de verdad. */
const ACTIONS: SourceSyncActions = {
  syncSource: async () => {
    await wait(700);
    return { ok: true, note: 'Sincronizando. En unos minutos ves lo nuevo en la tabla.' };
  },
  syncAccounting: async () => {
    await wait(700);
    return { ok: true, note: 'Sincronizando. Las tablas se actualizan en unos minutos.' };
  },
  refreshFeedSource: async () => {
    await wait(700);
    return { ok: false, error: 'El ERP sigue sin responder. Intenta de nuevo en unos minutos.' };
  },
};

export function FuentesShowcase({
  dark,
  sources,
  unread,
  catalog,
  googleConnected,
  accounting,
}: {
  dark: boolean;
  sources: ConnectedSource[];
  unread: string[];
  catalog: CatalogGroup[];
  googleConnected: boolean;
  accounting: ReactNode;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
        <PageHeader
          title="Datos y conexiones"
          subtitle="De dónde saca Cortex lo que sabe de Transportes Andinos. Lo que no esté conectado, no lo ve."
          icon={<Plug className="h-5 w-5" />}
          actions={
            <>
              <span className="inline-flex min-h-10 items-center rounded-pill bg-primary px-5 py-2 text-sm font-bold text-white">
                ¿Qué conecto primero?
              </span>
              <span className="inline-flex min-h-10 items-center rounded-pill border border-border-strong bg-surface px-5 py-2 text-sm font-bold text-ink">
                Reglas sobre tus datos
              </span>
            </>
          }
        />
        <ConnectedSources sources={sources} unread={unread} actions={ACTIONS} workspaceId={null} />
        <ConnectCatalog
          groups={catalog}
          workspaceId={null}
          googleConnected={googleConnected}
          slots={{ accounting }}
        />
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-ink">Avanzado</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Para quien administra o para equipos técnicos. Nada de esto hace falta para empezar.
            </p>
          </div>
          {[
            ['Diagnóstico de lectura', '2 por atender · 9 comprobaciones'],
            ['Servicios que activa el equipo de Cortex', '3 de 5 activos'],
            ['Servidores MCP', '1 conectado · 6 herramientas'],
            ['Hacia dónde van los datos', 'Lo que entra a Cortex y lo que sale'],
          ].map(([title, hint]) => (
            <div
              key={title}
              className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 shadow-card"
            >
              <span>
                <span className="text-sm font-extrabold text-ink">{title}</span>
                <span className="tabular ml-2 text-xs text-ink-faint">{hint}</span>
              </span>
              <ChevronDown className="h-4 w-4 text-ink-faint" aria-hidden />
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
