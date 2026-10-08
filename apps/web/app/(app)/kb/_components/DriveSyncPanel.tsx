'use client';
import { Button } from '@/components/ui/button';
import { IconChip } from '@/components/ui/panel';
import { useQuery } from '@tanstack/react-query';
import { FolderClosed, FolderSearch } from 'lucide-react';
import { useState } from 'react';
import { DriveBrowserModal } from './DriveBrowserModal';
import { ago, plural } from './format';

/**
 * The Drive mouth. Renders bare — the panel chrome and the title belong to
 * `IntakePanel`, which shows this as one of the four ways in rather than as a
 * separate feature further down the page.
 */

interface DriveStatus {
  connected: boolean;
  canWrite: boolean;
  folder: { id: string; name: string | null } | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  gdriveDocCount: number;
  failedCount: number;
  pendingCount: number;
}

async function fetchStatus(spaceId: string): Promise<DriveStatus> {
  const r = await fetch(`/api/kb/drive/status?spaceId=${spaceId}`);
  if (!r.ok) throw new Error('No se pudo consultar la sincronización de Drive.');
  const j = (await r.json()) as Partial<DriveStatus>;
  return {
    connected: j.connected ?? false,
    canWrite: j.canWrite ?? false,
    folder: j.folder ?? null,
    lastSyncedAt: j.lastSyncedAt ?? null,
    lastError: j.lastError ?? null,
    gdriveDocCount: j.gdriveDocCount ?? 0,
    failedCount: j.failedCount ?? 0,
    pendingCount: j.pendingCount ?? 0,
  };
}

export function DriveSyncPanel({ spaceId }: { spaceId: string }) {
  const [open, setOpen] = useState(false);

  const { data, error } = useQuery({
    queryKey: ['drive-sync', spaceId],
    queryFn: () => fetchStatus(spaceId),
    // Poll while a folder is linked but the first sync hasn't landed yet.
    refetchInterval: (query) => {
      const s = query.state.data;
      if (s?.folder && !s.lastSyncedAt) return 30_000;
      return false;
    },
  });

  const connected = data?.connected;
  const folder = data?.folder ?? null;
  const recent = !!data?.lastSyncedAt && Date.now() - Date.parse(data.lastSyncedAt) < 30 * 60_000;
  const synced = !!folder && recent && !data.lastError && !data.failedCount && !data.pendingCount;
  const syncLabel = data?.lastError
    ? `Falló la sincronización: ${data.lastError}`
    : data?.failedCount
      ? `${plural(data.failedCount, 'archivo con error', 'archivos con error')}`
      : data?.pendingCount
        ? `${plural(data.pendingCount, 'archivo procesándose', 'archivos procesándose')}`
        : recent && data?.lastSyncedAt
          ? `Al día ${ago(data.lastSyncedAt)}`
          : data?.lastSyncedAt
            ? `Última revisión ${ago(data.lastSyncedAt)}`
            : 'Esperando la primera sincronización…';

  return (
    <div>
      {error ? (
        <p className="text-xs text-rose">No se pudo consultar la sincronización de Drive.</p>
      ) : !data ? (
        <div className="h-9 w-40 animate-pulse rounded-card bg-surface-2" />
      ) : folder ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 rounded-card border border-border bg-surface-2 px-3 py-2.5">
            <IconChip tone="amber">
              <FolderClosed className="h-4 w-4" />
            </IconChip>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-ink">
                {folder.name ?? folder.id}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-micro text-ink-faint">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${synced ? 'bg-emerald' : data.lastError || data.failedCount ? 'bg-rose' : 'bg-amber'}`}
                />
                <span>{syncLabel}</span>
                <span>&middot;</span>
                <span className="tabular">
                  {plural(data.gdriveDocCount, 'archivo', 'archivos')}
                </span>
              </div>
            </div>
          </div>
          {connected ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => setOpen(true)}>
                Cambiar de carpeta
              </Button>
              <Button variant="ghost" onClick={() => setOpen(true)}>
                Ver Drive
              </Button>
            </div>
          ) : (
            <a
              href="/api/integrations/google?preset=drive"
              className="text-sm font-semibold text-primary hover:underline"
            >
              Conecta tu Google para explorar Drive
            </a>
          )}
        </div>
      ) : !connected ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-xs text-ink-muted">
            Conecta Google Drive y enlaza una carpeta: lo que pongas ahí entra solo.
          </p>
          <a
            href="/api/integrations/google?preset=drive"
            className="inline-flex items-center justify-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-strong"
          >
            <FolderSearch className="h-3.5 w-3.5" />
            Conectar Google Drive
          </a>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="text-xs text-ink-muted">
            Drive está conectado. Trae archivos sueltos o enlaza una carpeta entera.
          </p>
          <Button variant="outline" onClick={() => setOpen(true)}>
            <FolderSearch className="h-3.5 w-3.5" />
            Ver Drive
          </Button>
        </div>
      )}

      <DriveBrowserModal spaceId={spaceId} open={open} onOpenChange={setOpen} />
      {connected ? (
        <div className="mt-3 border-t border-border pt-3 text-xs text-ink-muted">
          {data?.canWrite ? (
            <span>Cortex puede guardar archivos en las carpetas de tu Drive que ya existen.</span>
          ) : (
            <span>
              Cortex solo lee tu Drive.{' '}
              <a
                href="/api/integrations/google?preset=drive_write"
                className="font-semibold text-primary hover:underline"
              >
                Permitir que Cortex guarde archivos en tu Drive
              </a>{' '}
              (por ejemplo, copiar a la carpeta de cada guía los documentos que suben tus
              formularios). Google lo trata como permiso restringido: si tu empresa aún no está
              entre los usuarios de prueba verás un aviso de «app no verificada».
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
