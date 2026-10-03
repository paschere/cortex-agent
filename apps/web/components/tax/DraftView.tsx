'use client';

import {
  ActionNote,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from '@/components/finance/pieces';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import type { DraftLine, DraftSourceRef } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Download,
  FileText,
  Paperclip,
} from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { TaxTabs } from './TaxTabs';
import { downloadText, draftCsv } from './draft-export';
import type { TaxDraftActions, TaxDraftScreen, TaxUpload } from './types';

/**
 * /impuestos/borrador/[obligación] (0197): el borrador de una declaración,
 * agrupado (bases, tarifas, impuesto, descontables, retenciones, saldo), con
 * el detalle de qué documentos forman cada cifra, lo que falta y los estados
 * que pone una persona: revisado por el contador, presentado (con el
 * formulario como evidencia) o anulado. Cortex no presenta nada.
 */

const cop = (n: number) => `$ ${Math.round(n).toLocaleString('es-CO')}`;
const pctText = (n: number) => `${String(Math.round(n * 1000) / 1000).replace('.', ',')} %`;

const SOURCE_KIND: Record<DraftSourceRef['kind'], string> = {
  venta: 'Factura de venta',
  nota_credito_venta: 'Nota crédito de venta',
  compra: 'Factura de proveedor',
  nota_credito_compra: 'Nota crédito de proveedor',
  contable: 'Programa contable',
  libro: 'Movimiento del libro',
  nomina: 'Nómina',
  estados: 'Estado de resultados',
};

async function uploadTo(api: string, file: File) {
  const body = new FormData();
  body.set('file', file);
  try {
    const res = await fetch(api, { method: 'POST', body });
    const json = (await res.json().catch(() => ({}))) as {
      document?: { id?: string };
      error?: string;
    };
    if (!res.ok || !json.document?.id)
      return {
        ok: false,
        note: json.error ? `No pude subirlo: ${json.error}` : 'No pude subirlo.',
      };
    return { ok: true, documentId: json.document.id, note: 'Subido al Cerebro.' };
  } catch {
    return { ok: false, note: 'No pude subirlo. Revisa la conexión e intenta de nuevo.' };
  }
}

export function DraftView({
  data,
  actions,
  upload,
}: {
  data: TaxDraftScreen;
  actions: TaxDraftActions;
  upload?: TaxUpload;
}) {
  const f = data.figures;
  const doUpload: TaxUpload = upload ?? ((file) => uploadTo(data.hrefs.upload, file));
  const toConfirm = f.sections.flatMap((s) => s.lines).filter((l) => l.needsConfirmation).length;
  const status = data.saved?.status ?? null;

  return (
    <>
      <PageHeader
        title={f.title}
        subtitle={`${f.disclaimer}. Cortex arma las cifras con tus datos; presentar y pagar lo hace tu contador.`}
        icon={<FileText className="h-5 w-5" />}
        actions={
          <>
            <Link href={data.hrefs.back} className={pillLink}>
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              Calendario
            </Link>
            <button
              type="button"
              className={pillLink}
              onClick={() => downloadText(`borrador-${f.kind}-${f.period.from}.csv`, draftCsv(f))}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              CSV
            </button>
            <a href={data.hrefs.pdf} target="_blank" rel="noreferrer" className={pillLink}>
              <Download className="h-3.5 w-3.5" aria-hidden />
              PDF
            </a>
          </>
        }
      />
      <TaxTabs active="calendario" links={data.hrefs.tabs} />

      <div
        role="note"
        className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-amber/30 bg-amber-soft px-4 py-3 text-sm text-ink"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber" aria-hidden />
        <strong className="font-extrabold">{f.disclaimer}</strong>
        <span className="text-ink-muted">
          Periodo {f.period.label} · {f.basis}
          {data.obligation.form ? ` · formulario de referencia ${data.obligation.form}` : ''}. Sin
          números de renglón: el contador lleva cada cifra a su casilla.
        </span>
      </div>

      <Panel className="mb-6 grid gap-px overflow-hidden bg-border p-0 sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-surface px-5 py-4 sm:px-6">
          <p className="field-label text-ink-faint">{f.result.label}</p>
          <p
            className={clsx(
              'stat-num tabular mt-1 font-mono text-2xl font-extrabold',
              f.result.direction === 'favor' ? 'text-emerald' : 'text-ink',
            )}
          >
            {cop(Math.abs(f.result.amount))}
          </p>
        </div>
        <div className="bg-surface px-5 py-4 sm:px-6">
          <p className="field-label text-ink-faint">Vence</p>
          <p className="mt-1 text-base font-extrabold text-ink">{data.obligation.dueLabel}</p>
          <p className="mt-0.5 flex flex-wrap gap-1.5">
            <span className={statusPill(data.obligation.tone)}>{data.obligation.whenText}</span>
            {data.obligation.needsConfirmation && (
              <span className={statusPill('amber')}>Fecha por confirmar</span>
            )}
          </p>
        </div>
        <div className="bg-surface px-5 py-4 sm:px-6">
          <p className="field-label text-ink-faint">Datos que faltan</p>
          <p
            className={clsx(
              'stat-num tabular mt-1 font-mono text-2xl font-extrabold',
              f.missing.length ? 'text-amber' : 'text-ink',
            )}
          >
            {f.missing.length}
          </p>
        </div>
        <div className="bg-surface px-5 py-4 sm:px-6">
          <p className="field-label text-ink-faint">Estado</p>
          <p className="mt-1">
            <span
              className={statusPill(
                status === 'presentado' ? 'emerald' : status === 'revisado' ? 'primary' : 'amber',
              )}
            >
              {data.saved?.statusLabel ?? 'Borrador sin guardar'}
            </span>
          </p>
          <p className="mt-1 text-micro text-ink-muted">
            {toConfirm
              ? `${toConfirm} cifra${toConfirm === 1 ? '' : 's'} por confirmar`
              : 'Sin tarifas por confirmar'}
          </p>
        </div>
      </Panel>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
        <div className="min-w-0 space-y-6">
          {f.sections.map((s) => (
            <Panel key={s.key} className="min-w-0 p-0">
              <h2 className="border-b border-border px-5 py-3 text-base font-extrabold text-ink sm:px-6">
                {s.label}
              </h2>
              <ul className="divide-y divide-border">
                {s.lines.map((l) => (
                  <LineRow key={l.key} line={l} sourceHref={data.sourceHref} />
                ))}
              </ul>
            </Panel>
          ))}
          <Panel className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-4 sm:px-6">
            <h2 className="text-lg font-extrabold text-ink">{f.result.label}</h2>
            <p className="tabular font-mono text-2xl font-extrabold text-ink">
              {cop(Math.abs(f.result.amount))}
            </p>
          </Panel>
        </div>

        <div className="space-y-6">
          <StatusPanel data={data} actions={actions} upload={doUpload} />

          {f.missing.length > 0 && (
            <Panel className="p-5 sm:p-6">
              <h2 className="flex items-center gap-2 text-base font-extrabold text-ink">
                <AlertTriangle className="h-4 w-4 text-amber" aria-hidden />
                Datos que faltan
              </h2>
              <ul className="mt-3 space-y-3 text-sm text-ink">
                {f.missing.map((m) => (
                  <li key={m.code}>
                    <p>{m.message}</p>
                    {m.refs.length > 0 && (
                      <details className="mt-1 text-xs text-ink-muted">
                        <summary className="cursor-pointer font-semibold text-primary-ink">
                          Ver{' '}
                          {m.refs.length === 1 ? 'el documento' : `los ${m.refs.length} documentos`}
                        </summary>
                        <ul className="mt-1 space-y-0.5">
                          {m.refs.slice(0, 40).map((r) => (
                            <li key={`${r.kind}-${r.id}`} className="flex justify-between gap-3">
                              <span className="min-w-0 truncate">
                                {r.date ? `${r.date} · ` : ''}
                                {r.label}
                              </span>
                              <span className="tabular shrink-0 font-mono">{cop(r.amount)}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {f.notes.length > 0 && (
            <Panel className="p-5 sm:p-6">
              <h2 className="text-base font-extrabold text-ink">Notas para el contador</h2>
              <ul className="mt-2 space-y-2 text-xs text-ink-muted">
                {f.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <p className="mt-3 text-micro text-ink-faint">
                Tarifas: {f.rulesVersion}. Armado el {f.builtAt.slice(0, 10)}.
              </p>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

function LineRow({ line, sourceHref }: { line: DraftLine; sourceHref: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const canOpen = line.sources.length > 0;
  return (
    <li className={clsx(line.derived && 'bg-surface-2/60')}>
      <button
        type="button"
        className="flex w-full items-start gap-3 px-5 py-3 text-left sm:px-6 disabled:cursor-default"
        onClick={() => setOpen((v) => !v)}
        disabled={!canOpen}
        aria-expanded={canOpen ? open : undefined}
      >
        <ChevronRight
          className={clsx(
            'mt-0.5 h-4 w-4 shrink-0 text-ink-faint transition-transform',
            open && 'rotate-90',
            !canOpen && 'invisible',
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span
            className={clsx(
              'block text-sm text-ink',
              line.derived ? 'font-extrabold' : 'font-semibold',
            )}
          >
            {line.label}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-muted">
            {line.base != null && !line.derived && <span>Base {cop(line.base)}</span>}
            {line.rate != null && <span>Tarifa {pctText(line.rate)}</span>}
            {canOpen && (
              <span>
                {line.sources.length} documento{line.sources.length === 1 ? '' : 's'}
              </span>
            )}
            {line.derived && line.formula && <span>{line.formula}</span>}
            {line.needsConfirmation && <span className={statusPill('amber')}>Por confirmar</span>}
          </span>
          {line.note && <span className="mt-1 block text-micro text-ink-muted">{line.note}</span>}
        </span>
        <span className="tabular shrink-0 font-mono text-sm font-bold text-ink">
          {cop(line.amount)}
        </span>
      </button>
      {open && canOpen && (
        <div className="border-t border-border bg-surface-2/40 px-5 py-2 sm:px-6">
          <table className="w-full text-xs">
            <caption className="sr-only">Documentos de «{line.label}»</caption>
            <thead>
              <tr className="text-left text-ink-faint">
                <th className="py-1 font-semibold">Documento</th>
                <th className="hidden py-1 font-semibold sm:table-cell">Tipo</th>
                <th className="py-1 font-semibold">Fecha</th>
                <th className="py-1 text-right font-semibold">Valor</th>
              </tr>
            </thead>
            <tbody>
              {line.sources.map((s) => {
                const href = s.path ? sourceHref[s.path] : undefined;
                return (
                  <tr key={`${s.kind}-${s.id}`} className="border-t border-border/60">
                    <td className="max-w-0 truncate py-1.5 pr-2 text-ink">
                      {href ? (
                        <Link
                          href={href}
                          className="font-semibold text-primary-ink hover:underline"
                        >
                          {s.label}
                        </Link>
                      ) : (
                        s.label
                      )}
                    </td>
                    <td className="hidden py-1.5 pr-2 text-ink-muted sm:table-cell">
                      {SOURCE_KIND[s.kind]}
                    </td>
                    <td className="tabular py-1.5 pr-2 font-mono text-ink-muted">
                      {s.date ?? '—'}
                    </td>
                    <td
                      className={clsx(
                        'tabular py-1.5 text-right font-mono',
                        s.amount < 0 ? 'text-rose' : 'text-ink',
                      )}
                    >
                      {cop(s.amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-bold text-ink">
                <td className="py-1.5" colSpan={2}>
                  Suma
                </td>
                <td className="hidden sm:table-cell" />
                <td className="tabular py-1.5 text-right font-mono">{cop(line.amount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </li>
  );
}

function StatusPanel({
  data,
  actions,
  upload,
}: {
  data: TaxDraftScreen;
  actions: TaxDraftActions;
  upload: TaxUpload;
}) {
  const [noteText, setNoteText] = useState(data.saved?.notes ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [pending, start] = useTransition();
  const status = data.saved?.status ?? null;
  const run = (fn: () => Promise<{ ok: boolean; note: string }>) => {
    setNote(null);
    start(async () => {
      const r = await fn();
      setNote({ ok: r.ok, text: r.note });
    });
  };

  return (
    <Panel className="p-5 sm:p-6">
      <h2 className="text-base font-extrabold text-ink">Revisión y presentación</h2>
      <ol className="mt-3 space-y-2 text-sm">
        <Step done={status !== null} label="Borrador guardado" />
        <Step
          done={status === 'revisado' || status === 'presentado'}
          label={data.saved?.reviewedLabel ?? 'Revisado por el contador'}
        />
        <Step
          done={status === 'presentado'}
          label={
            data.saved?.presentedLabel ?? 'Presentado (lo marca una persona, con el formulario)'
          }
        />
      </ol>
      {data.saved?.evidenceHref && (
        <a
          href={data.saved.evidenceHref}
          target={data.saved.evidenceHref.startsWith('http') ? '_blank' : undefined}
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary-ink hover:underline"
        >
          <Paperclip className="h-3.5 w-3.5" aria-hidden />
          Formulario presentado
        </a>
      )}
      {!data.live && (
        <p className="mt-3 rounded-sm bg-surface-2 px-3 py-2 text-xs text-ink-muted">
          Estas son las cifras congeladas cuando el contador lo revisó. Si los datos cambiaron,
          anúlalo y arma uno nuevo.
        </p>
      )}

      {data.canAct && status !== 'presentado' && status !== 'anulado' && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <label className="block">
            <span className="field-label text-ink-faint">Nota para el contador</span>
            <textarea
              className={`${fieldClass} mt-1 min-h-16`}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              maxLength={2000}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {(status === null || status === 'borrador') && (
              <>
                <button
                  type="button"
                  className={pillLink}
                  disabled={pending}
                  onClick={() => run(() => actions.save(noteText.trim() || null))}
                >
                  Guardar borrador
                </button>
                <button
                  type="button"
                  className={pillPrimary}
                  disabled={pending}
                  onClick={() =>
                    run(() => actions.review(noteText.trim() || null, data.figures.result.amount))
                  }
                >
                  Marcar revisado por el contador
                </button>
              </>
            )}
            {!presenting && (
              <button
                type="button"
                className={status === 'revisado' ? pillPrimary : pillLink}
                disabled={pending}
                onClick={() => setPresenting(true)}
              >
                Marcar presentado
              </button>
            )}
            {status !== null && (
              <button
                type="button"
                className={clsx(pillLink, 'text-rose')}
                disabled={pending}
                onClick={() => {
                  if (
                    window.confirm(
                      '¿Anular este borrador? Queda en el historial y se puede armar otro.',
                    )
                  )
                    run(() => actions.annul(noteText.trim() || null));
                }}
              >
                Anular
              </button>
            )}
          </div>
          {presenting && (
            <form
              className="space-y-3 rounded-sm border border-border bg-surface-2/60 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  let evidenceDocumentId: string | null = null;
                  if (file) {
                    const up = await upload(file);
                    if (!up.ok || !up.documentId) return { ok: false, note: up.note };
                    evidenceDocumentId = up.documentId;
                  }
                  const r = await actions.present({
                    evidenceDocumentId,
                    evidenceUrl: url.trim() || null,
                    note: noteText.trim() || null,
                  });
                  if (r.ok) setPresenting(false);
                  return r;
                });
              }}
            >
              <p className="text-xs text-ink-muted">
                Sólo si ya se presentó por fuera (portal de la DIAN o el programa contable). Adjunta
                el formulario presentado: la obligación del calendario queda como presentada.
              </p>
              <label className="block">
                <span className="field-label text-ink-faint">
                  Formulario presentado (PDF al Cerebro)
                </span>
                <input
                  type="file"
                  accept="application/pdf"
                  className="mt-1 block w-full text-xs text-ink-muted file:mr-3 file:rounded-pill file:border-0 file:bg-primary-soft file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary-ink"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <label className="block">
                <span className="field-label text-ink-faint">o el enlace del recibo</span>
                <input
                  className={`${fieldClass} mt-1`}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://"
                  inputMode="url"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  className={pillPrimary}
                  disabled={pending || (!file && !url.trim())}
                >
                  {pending ? 'Guardando…' : 'Guardar como presentado'}
                </button>
                <button
                  type="button"
                  className={pillLink}
                  onClick={() => setPresenting(false)}
                  disabled={pending}
                >
                  Cancelar
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      {!data.canAct && (
        <p className="mt-4 text-xs text-ink-muted">
          Lo marca quien responde por los impuestos o quien administra la empresa.
        </p>
      )}
      <div className="mt-3">
        <ActionNote note={note} />
      </div>
    </Panel>
  );
}

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={clsx(
          'grid h-5 w-5 shrink-0 place-items-center rounded-full border text-micro font-bold',
          done ? 'border-emerald bg-emerald text-white' : 'border-border text-ink-faint',
        )}
      >
        {done ? '✓' : ''}
      </span>
      <span className={done ? 'text-ink' : 'text-ink-muted'}>{label}</span>
    </li>
  );
}
