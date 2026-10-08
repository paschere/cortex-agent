'use client';

import type { ComputedBlock, ComputedTimelineEntry } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Copy,
  FilePlus2,
  MousePointerClick,
  Pencil,
  Sparkles,
  UserPlus,
  XCircle,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { FileValue } from '../inputs/FileValue';
import { EditableValue, RowActions } from '../view-writes';
import { RichValue } from './RichValue';
import { useRecordNav } from './record-nav';
import { Card, EmptyState, StatusChip, formatWhen, useViewTheme } from './theme';

/**
 * EL DETALLE DE UN REGISTRO: UNA PANTALLA PARA UNA FILA.
 *
 * Cabecera (título, estado, botones), los campos en secciones, la galería de
 * fotos y archivos, las listas de registros relacionados con sus propios
 * botones y, al lado, la línea de tiempo: quién lo creó, qué cambió de qué a
 * qué, aprobaciones, automatizaciones y archivos subidos. Lo calcula
 * `buildDetail` (packages/agent-tools/src/views/record.ts); aquí sólo se pinta.
 *
 * Se abre con `?fila=<id>`: el lienzo (ViewCanvas) pinta SÓLO este bloque
 * cuando hay un registro elegido y lo esconde mientras no. En la vista previa
 * del editor (sin registro) se pinta un esquema: qué va a mostrar y de dónde.
 */

type Detail = Extract<ComputedBlock, { type: 'detail' }>;

const KIND_ICON: Record<ComputedTimelineEntry['kind'], typeof Pencil> = {
  created: UserPlus,
  changed: Pencil,
  approval: CheckCircle2,
  action: MousePointerClick,
  automation: Zap,
  file: FilePlus2,
};

function TimelineItem({ entry, last }: { entry: ComputedTimelineEntry; last: boolean }) {
  const rejected = entry.kind === 'approval' && entry.title === 'Rechazado';
  const failed = entry.kind === 'automation' && entry.ok === false;
  const Icon = rejected || failed ? XCircle : KIND_ICON[entry.kind];
  const tone =
    rejected || failed
      ? 'bg-rose-soft text-rose'
      : entry.kind === 'approval'
        ? 'bg-emerald-soft text-emerald'
        : entry.kind === 'automation'
          ? 'bg-amber-soft text-amber'
          : entry.kind === 'file'
            ? 'bg-sky-soft text-sky'
            : 'bg-primary-soft text-primary';
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {!last && <span aria-hidden className="absolute bottom-0 left-4 top-9 w-px bg-border" />}
      <span className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-pill', tone)}>
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-xs font-semibold leading-snug text-ink">{entry.title}</p>
        <p className="text-micro text-ink-faint">
          {entry.actor ? `${entry.actor} · ` : ''}
          <time dateTime={entry.at} suppressHydrationWarning>
            {formatWhen(entry.at)}
          </time>
        </p>
        {entry.changes && entry.changes.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {entry.changes.map((c) => (
              <li
                key={c.label}
                className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-sm bg-surface-2/70 px-2.5 py-1.5 text-micro"
              >
                <span className="font-semibold text-ink-muted">{c.label}</span>
                <span className="break-all text-ink-faint line-through decoration-ink-faint/60">
                  {c.from}
                </span>
                <ArrowRight className="h-3 w-3 shrink-0 text-ink-faint" aria-hidden />
                <span className="break-all font-semibold text-ink">{c.to}</span>
              </li>
            ))}
          </ul>
        )}
        {entry.files?.map((f) => (
          <p key={f.label} className="mt-1 break-words text-micro text-ink-muted">
            {f.label}: <span className="font-semibold text-ink">{f.names.join(', ')}</span>
          </p>
        ))}
      </div>
    </li>
  );
}

function CopyLink() {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(window.location.href);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          /* Sin portapapeles: la dirección ya está en la barra. */
        }
      }}
      className="view-no-print inline-flex h-8 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-micro font-semibold text-ink-muted transition-colors hover:text-ink"
    >
      <Copy className="h-3.5 w-3.5" aria-hidden />
      {done ? 'Enlace copiado' : 'Copiar enlace'}
    </button>
  );
}

export function DetailBlock({ block }: { block: Detail }) {
  const nav = useRecordNav();
  const { density } = useViewTheme();

  const back = nav ? (
    <button
      type="button"
      onClick={nav.close}
      className="view-no-print -ml-1 inline-flex h-9 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Volver a la lista
    </button>
  ) : null;

  if (block.state === 'idle')
    return (
      <Card title={block.title} source={block.source}>
        <EmptyState
          icon={<Sparkles className="h-5 w-5" aria-hidden />}
          title="Aquí se abre un registro"
          hint={`Al tocar una fila de ${block.source} aparece su detalle completo: datos, relacionados y línea de tiempo.`}
        />
      </Card>
    );
  if (block.state === 'missing' || !block.header)
    return (
      <div className="space-y-3">
        {back}
        <Card>
          <EmptyState
            title="No encontramos este registro"
            hint="Pudo borrarse, o tu rol no lo ve. Vuelve a la lista y elige otro."
          />
        </Card>
      </div>
    );

  const { header } = block;
  const rowId = block.rowId ?? '';
  const edited = header.updatedAt !== header.createdAt;
  return (
    <div className="space-y-4">
      {back}
      <Card className="relative !h-auto overflow-hidden">
        <span aria-hidden className="view-brand-stripe absolute inset-x-0 top-0 h-1" />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-extrabold leading-tight tracking-tight text-ink">
              {header.title}
            </h2>
            {header.subtitle && <p className="mt-1 text-sm text-ink-muted">{header.subtitle}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {header.status && <StatusChip value={header.status.label} tone={header.status.tone} />}
            <CopyLink />
          </div>
        </div>
        <p className="mt-3 text-micro text-ink-faint">
          Creado{' '}
          <span className="tabular font-mono" suppressHydrationWarning>
            {formatWhen(header.createdAt)}
          </span>
          {edited && (
            <>
              {' '}
              · Actualizado{' '}
              <span className="tabular font-mono" suppressHydrationWarning>
                {formatWhen(header.updatedAt)}
              </span>
            </>
          )}
        </p>
        {block.actions.length > 0 && (
          <div className="mt-4 border-t border-border pt-4">
            <RowActions
              blockId={block.id}
              actions={block.actions}
              rowId={rowId}
              rowLabel={header.title}
            />
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className={clsx('min-w-0', density === 'compact' ? 'space-y-3' : 'space-y-4')}>
          {block.sections.map((section) => (
            <Card key={section.title} title={section.title} className="!h-auto">
              <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                {section.items.map((item) => (
                  <div
                    key={item.key}
                    className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 border-b border-border/60 py-2.5 last:border-b-0 sm:grid-cols-1 sm:gap-0.5"
                  >
                    <dt className="pt-0.5 text-micro font-semibold text-ink-faint sm:pt-0">
                      {item.label}
                    </dt>
                    <dd className="min-w-0 break-words text-sm text-ink">
                      {item.edit ? (
                        <EditableValue
                          blockId={block.id}
                          rowId={rowId}
                          field={item.key}
                          edit={item.edit}
                          raw={item.editRaw ?? null}
                          display={item.value}
                          label={item.label}
                        />
                      ) : (
                        <RichValue kind={item.kind} raw={item.raw} text={item.value} size={48} />
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          ))}

          {block.gallery.length > 0 && (
            <Card title="Fotos y documentos" className="!h-auto">
              <div className="space-y-4">
                {block.gallery.map((g) => (
                  <div key={g.key}>
                    <p className="mb-1.5 text-micro font-semibold text-ink-faint">{g.label}</p>
                    <FileValue value={g.raw} size={96} />
                  </div>
                ))}
              </div>
            </Card>
          )}

          {block.related.map((rel) => (
            <Card
              key={rel.blockKey}
              title={rel.title}
              source={`${rel.total} · ${rel.source}`}
              className="!h-auto"
            >
              {rel.problem ? (
                <p className="text-xs text-ink-muted">{rel.problem}</p>
              ) : rel.rows.length === 0 ? (
                <EmptyState title="Nada relacionado todavía" />
              ) : (
                <ul className="divide-y divide-border/70">
                  {rel.rows.map((r) => (
                    <li
                      key={r.id}
                      className={clsx(
                        'flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2.5',
                        r.alert && 'rounded-sm bg-rose-soft px-2',
                      )}
                    >
                      <div className="grid min-w-0 flex-1 basis-56 grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-[repeat(auto-fit,minmax(6rem,1fr))]">
                        {rel.columns.map((c, i) => (
                          <div key={c.key} className="min-w-0">
                            <p className="text-micro text-ink-faint">{c.label}</p>
                            {i === 0 && rel.opens && nav ? (
                              <button
                                type="button"
                                onClick={() => nav.open(rel.opens as string, r.id)}
                                className="block max-w-full truncate text-left text-xs font-semibold text-primary hover:underline"
                              >
                                {r.cells[i]}
                              </button>
                            ) : (
                              <p className="truncate text-xs font-semibold text-ink">
                                {r.cells[i]}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                      {rel.actions.length > 0 && (
                        <RowActions
                          blockId={rel.blockKey}
                          actions={rel.actions}
                          rowId={r.id}
                          rowLabel={r.cells[0] ?? ''}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {rel.total > rel.rows.length && (
                <p className="mt-2 text-micro text-ink-faint">
                  Se muestran {rel.rows.length} de {rel.total}.
                </p>
              )}
            </Card>
          ))}
        </div>

        {block.timeline && (
          <Card title="Línea de tiempo" className="!h-auto lg:sticky lg:top-4">
            {block.timeline.length === 0 ? (
              <p className="text-xs text-ink-muted">Todavía no hay movimientos.</p>
            ) : (
              <ol aria-label="Línea de tiempo del registro">
                {block.timeline.map((entry, i) => (
                  <TimelineItem
                    key={entry.id}
                    entry={entry}
                    last={i === (block.timeline?.length ?? 0) - 1}
                  />
                ))}
              </ol>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
