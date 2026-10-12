'use client';

import {
  FILE_KIND_LABEL,
  type FileKind,
  type TaskFile,
  driveUploadPrompt,
  humanSize,
} from '@/lib/background-tasks/files';
import {
  Download,
  ExternalLink,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  Globe,
  HardDriveUpload,
  Image as ImageIcon,
  Presentation,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * «ARCHIVOS DE LA TAREA»: todo lo que se produjo durante una tarea o conversación
 * (informes, presentaciones, descargas del navegador, enlaces a hojas y PDFs que
 * Cortex dejó escritos). La misma lista en la pestaña del panel del chat y en la
 * pantalla de la tarea. De dónde sale cada fila: lib/background-tasks/files.ts.
 *
 * «Guardar en Drive» sólo sale en lo que `gdrive.upload_file` puede leer, y NO sube
 * nada por su cuenta: escribe el pedido en el chat y la subida pide confirmación
 * como siempre. Dentro del chat (`compose`) lo deja en el compositor; fuera abre un
 * chat nuevo con el pedido escrito.
 */

const ICON: Record<FileKind, typeof FileText> = {
  pdf: FileText,
  doc: FileText,
  html: Globe,
  sheet: FileSpreadsheet,
  csv: FileSpreadsheet,
  slides: Presentation,
  image: ImageIcon,
  other: FileIcon,
};

function hour(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Bogota',
  })
    .format(d)
    .replace(/[\u202f\u00a0]/g, ' ');
}

const action =
  'inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3 py-1 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-border motion-reduce:transition-none';

export function FilesList({
  files,
  compose,
}: {
  files: TaskFile[];
  compose?: ((text: string) => void) | null;
}) {
  if (files.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-border px-4 py-6 text-sm text-ink-muted">
        Todavía no hay archivos. Los informes, presentaciones, descargas y hojas que Cortex produzca
        aquí quedan listados para bajarlos.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {files.map((f) => {
        const Icon = ICON[f.kind];
        const open = f.source === 'report' || f.external;
        const driveHref = `/chat?prompt=${encodeURIComponent(driveUploadPrompt(f))}`;
        return (
          <li key={f.id} className="flex flex-wrap items-center gap-3 py-3">
            <span
              aria-hidden
              className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-muted"
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-[11rem] flex-1">
              <span className="block truncate text-sm font-semibold text-ink" title={f.name}>
                {f.name}
              </span>
              <span className="tabular mt-0.5 block text-xs text-ink-faint">
                {FILE_KIND_LABEL[f.kind]}
                {f.sizeBytes !== null ? ` · ${humanSize(f.sizeBytes)}` : ''} · {hour(f.createdAt)}
              </span>
            </span>
            <span className="flex shrink-0 flex-wrap items-center gap-2">
              {f.source === 'report' ? (
                <Link href={f.href} className={action}>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  Abrir
                </Link>
              ) : (
                <a
                  href={f.href}
                  {...(open ? { target: '_blank', rel: 'noreferrer' } : { download: f.name })}
                  className={action}
                >
                  {open ? (
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <Download className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {open ? 'Abrir' : 'Descargar'}
                </a>
              )}
              {f.driveable &&
                (compose ? (
                  <button
                    type="button"
                    className={action}
                    onClick={() => compose(driveUploadPrompt(f))}
                  >
                    <HardDriveUpload className="h-3.5 w-3.5" aria-hidden />
                    Guardar en Drive
                  </button>
                ) : (
                  <Link href={driveHref} className={action}>
                    <HardDriveUpload className="h-3.5 w-3.5" aria-hidden />
                    Guardar en Drive
                  </Link>
                ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** La lista viva: consulta el servidor (y vuelve a consultar mientras la tarea trabaja). */
export function FilesPanel({
  taskId,
  conversationId,
  compose,
  initialFiles,
  refreshMs,
}: {
  taskId?: string;
  conversationId?: string;
  compose?: ((text: string) => void) | null;
  /** Para pantallas de muestra y pruebas: si viene, no se consulta nada. */
  initialFiles?: TaskFile[];
  /** Cada cuánto volver a consultar; sin valor, una sola vez. */
  refreshMs?: number;
}) {
  const [files, setFiles] = useState<TaskFile[] | null>(initialFiles ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (initialFiles) return;
    const qs = taskId
      ? `taskId=${encodeURIComponent(taskId)}`
      : conversationId
        ? `conversationId=${encodeURIComponent(conversationId)}`
        : null;
    if (!qs) {
      setFiles([]);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/tasks/files?${qs}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { files?: TaskFile[] };
        if (alive) {
          setFiles(body.files ?? []);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const timer = refreshMs ? setInterval(() => void load(), refreshMs) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [taskId, conversationId, initialFiles, refreshMs]);

  if (files === null) {
    return (
      <p className="text-sm text-ink-faint">
        {failed ? 'No se pudieron leer los archivos.' : 'Buscando archivos…'}
      </p>
    );
  }
  return (
    <>
      {failed && <p className="mb-2 text-xs text-rose">No se pudo actualizar la lista.</p>}
      <FilesList files={files} {...(compose !== undefined ? { compose } : {})} />
    </>
  );
}
