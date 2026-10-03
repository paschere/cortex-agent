'use client';

import { BrandScope, ViewBrandProvider } from '@/components/views/blocks/brand';
import type { ViewBrand } from '@/lib/branding/shape';
import type { InvoicePreviewView, SalesActionResult, SalesDetailView } from '@/lib/sales/types';
import { chipClass } from '@/lib/status-chip';
import { formatMoney } from '@cortex/agent-tools/src/sales/totals';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  FileCheck2,
  Loader2,
  Pencil,
  Receipt,
  Send,
  ShoppingCart,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState, useTransition } from 'react';
import { QuoteDocument, longDate } from './QuoteDocument';

/**
 * LA FICHA DE UN DOCUMENTO DE VENTA (migración 0182): el papel como lo ve el
 * cliente, la línea de tiempo del negocio y lo que se puede hacer ahora
 * (mandar, marcar aceptada, convertir en pedido, facturar, anular).
 *
 * Facturar abre la vista previa de lo que se le mandaría a Siigo o Alegra, con
 * lo que impide emitir en español; el botón de emitir es la aprobación de una
 * persona y queda en la auditoría a su nombre. Sin programa conectado, la
 * pantalla lo dice y NO ofrece emitir.
 */

export interface SalesDetailHandlers {
  link: (id: string) => Promise<SalesActionResult<{ url: string }>>;
  send: (id: string, to: string[], message: string | null) => Promise<SalesActionResult>;
  accept: (id: string, name: string) => Promise<SalesActionResult>;
  reject: (id: string, reason: string) => Promise<SalesActionResult>;
  convert: (id: string) => Promise<SalesActionResult<{ id: string }>>;
  cancel: (id: string) => Promise<SalesActionResult>;
  preview: (id: string) => Promise<SalesActionResult<InvoicePreviewView>>;
  emit: (id: string, retryUncertain?: boolean) => Promise<SalesActionResult<{ invoiceId: string }>>;
}

const BTN =
  'inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-45 motion-reduce:transition-none';
const PRIMARY =
  'cortex-primary-button inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-sm font-bold text-white transition-colors duration-150 hover:bg-primary-strong disabled:opacity-45 motion-reduce:transition-none';

const stamp = (iso: string) =>
  new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Bogota',
  }).format(new Date(iso));

export function SalesDetail({
  view,
  brand,
  handlers,
  initialPanel,
}: {
  view: SalesDetailView;
  brand: ViewBrand;
  handlers: SalesDetailHandlers;
  /** Abrir un panel de entrada (`?facturar=1` o el escaparate). */
  initialPanel?: 'send' | 'invoice';
}) {
  const router = useRouter();
  const { doc } = view;
  const [panel, setPanel] = useState<'none' | 'send' | 'accept' | 'reject' | 'invoice'>(
    initialPanel ?? 'none',
  );
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [link, setLink] = useState(view.publicUrl);

  function run<T>(
    fn: () => Promise<SalesActionResult<T>>,
    after?: (r: SalesActionResult<T>) => void,
  ) {
    setFeedback(null);
    start(async () => {
      const r = await fn();
      setFeedback({ ok: r.ok, text: r.ok ? (r.note ?? 'Listo.') : (r.error ?? 'No se pudo.') });
      if (r.ok) {
        after?.(r);
        router.refresh();
      }
    });
  }

  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 sm:py-8">
      <Link
        href={`/ventas?tipo=${doc.kind === 'quote' ? 'cotizaciones' : doc.kind === 'order' ? 'pedidos' : 'facturas'}`}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Ventas
      </Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-micro font-bold uppercase tracking-[0.14em] text-ink-faint">
            {doc.kindLabel}
          </p>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-extrabold tracking-tight text-ink">
            {doc.number}
            <span className={chipClass(doc.statusTone)}>{doc.statusLabel}</span>
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {doc.clientId ? (
              <Link
                href={`/clients/${doc.clientId}`}
                className="font-semibold text-ink hover:underline"
              >
                {doc.clientName}
              </Link>
            ) : (
              <span className="font-semibold text-ink">{doc.clientName}</span>
            )}{' '}
            · {formatMoney(doc.totals.total, doc.currency)} · {longDate(doc.issueDate)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {doc.can.edit && (
            <Link href={`/ventas/${doc.id}/editar`} className={BTN}>
              <Pencil className="h-4 w-4" aria-hidden />
              Editar
            </Link>
          )}
          <a href={view.pdfUrl} className={BTN} target="_blank" rel="noreferrer">
            <Download className="h-4 w-4" aria-hidden />
            PDF
          </a>
          {doc.can.send && (
            <button
              type="button"
              className={BTN}
              onClick={() => setPanel(panel === 'send' ? 'none' : 'send')}
            >
              <Send className="h-4 w-4" aria-hidden />
              Enviar
            </button>
          )}
          {doc.can.accept && (
            <button
              type="button"
              className={BTN}
              onClick={() => setPanel(panel === 'accept' ? 'none' : 'accept')}
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Marcar aceptada
            </button>
          )}
          {doc.can.convert && (
            <button
              type="button"
              className={BTN}
              disabled={pending}
              onClick={() =>
                run(
                  () => handlers.convert(doc.id),
                  (r) => r.data && router.push(`/ventas/${r.data.id}`),
                )
              }
            >
              <ShoppingCart className="h-4 w-4" aria-hidden />
              Convertir en pedido
            </button>
          )}
          {doc.can.invoice && (
            <button
              type="button"
              className={PRIMARY}
              onClick={() => setPanel(panel === 'invoice' ? 'none' : 'invoice')}
            >
              <Receipt className="h-4 w-4" aria-hidden />
              Facturar
            </button>
          )}
        </div>
      </header>

      {feedback && (
        <p
          aria-live="polite"
          className={clsx(
            'mt-4 rounded-sm px-3 py-2 text-sm',
            feedback.ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
          )}
        >
          {feedback.text}
        </p>
      )}

      {panel === 'send' && (
        <SendPanel
          doc={doc}
          link={link}
          pending={pending}
          onCopy={() =>
            run(
              () => handlers.link(doc.id),
              (r) => {
                if (r.data) {
                  setLink(r.data.url);
                  void navigator.clipboard?.writeText(r.data.url).catch(() => undefined);
                }
              },
            )
          }
          onSend={(to, message) =>
            run(
              () => handlers.send(doc.id, to, message),
              () => setPanel('none'),
            )
          }
        />
      )}
      {panel === 'accept' && (
        <AcceptPanel
          pending={pending}
          defaultName={doc.contactName ?? ''}
          onAccept={(name) =>
            run(
              () => handlers.accept(doc.id, name),
              () => setPanel('none'),
            )
          }
          onReject={(reason) =>
            run(
              () => handlers.reject(doc.id, reason),
              () => setPanel('none'),
            )
          }
        />
      )}
      {panel === 'invoice' && (
        <InvoicePanel docId={doc.id} handlers={handlers} uncertain={doc.emissionUncertain} />
      )}

      {doc.kind === 'invoice' && (doc.providerNumber || doc.providerError) && (
        <section
          className={clsx(
            'mt-4 rounded-card border p-4 text-sm',
            doc.providerError
              ? 'border-rose/30 bg-rose-soft text-rose'
              : 'border-emerald/30 bg-emerald-soft text-emerald',
          )}
        >
          {doc.providerNumber ? (
            <p className="flex flex-wrap items-center gap-2">
              <FileCheck2 className="h-4 w-4" aria-hidden />
              <strong>
                Factura electrónica {doc.providerNumber} en{' '}
                {doc.provider === 'siigo' ? 'Siigo' : 'Alegra'}
              </strong>
              {doc.einvoiceStatus && <span>· DIAN: {doc.einvoiceStatus}</span>}
              {doc.cufe && <span className="break-all text-xs opacity-80">· CUFE {doc.cufe}</span>}
              {doc.providerUrl && (
                <a href={doc.providerUrl} target="_blank" rel="noreferrer" className="underline">
                  Ver en el programa
                </a>
              )}
            </p>
          ) : (
            <p>{doc.providerError}</p>
          )}
        </section>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <ViewBrandProvider brand={brand}>
          <BrandScope>
            <QuoteDocument doc={doc} brand={brand} />
          </BrandScope>
        </ViewBrandProvider>

        <div className="space-y-4">
          {doc.kind === 'quote' && (
            <Card title="Seguimiento">
              <dl className="space-y-1.5 text-sm">
                <Fact
                  label="Enviada"
                  value={
                    doc.sentAt
                      ? `${stamp(doc.sentAt)}${doc.sentTo ? ` a ${doc.sentTo}` : ''}`
                      : 'Todavía no'
                  }
                />
                <Fact
                  label="El cliente la abrió"
                  value={
                    doc.views ? `${doc.views} ${doc.views === 1 ? 'vez' : 'veces'}` : 'Todavía no'
                  }
                />
                {doc.acceptedAt && (
                  <Fact
                    label="Aceptada"
                    value={`${stamp(doc.acceptedAt)}${doc.acceptedBy ? ` por ${doc.acceptedBy}` : ''}`}
                  />
                )}
                {doc.rejectedAt && (
                  <Fact
                    label="Rechazada"
                    value={`${stamp(doc.rejectedAt)}${doc.rejectionReason ? ` — «${doc.rejectionReason}»` : ''}`}
                  />
                )}
              </dl>
            </Card>
          )}
          {view.related.length > 0 && (
            <Card title="Del mismo negocio">
              <ul className="space-y-1.5 text-sm">
                {view.related.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <Link
                      href={`/ventas/${r.id}`}
                      className="font-semibold text-ink hover:underline"
                    >
                      {r.kindLabel} {r.number}
                    </Link>
                    <span className={chipClass(r.statusTone)}>{r.statusLabel}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Línea de tiempo">
            {view.events.length === 0 ? (
              <p className="text-sm text-ink-muted">Sin movimientos todavía.</p>
            ) : (
              <ol className="space-y-3">
                {[...view.events].reverse().map((e) => (
                  <li key={e.id} className="flex gap-3 text-sm">
                    <span
                      aria-hidden
                      className={clsx(
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                        e.tone === 'emerald'
                          ? 'bg-emerald'
                          : e.tone === 'rose'
                            ? 'bg-rose'
                            : e.tone === 'primary'
                              ? 'bg-primary'
                              : e.tone === 'amber'
                                ? 'bg-amber'
                                : 'bg-ink-faint',
                      )}
                    />
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">{e.label}</p>
                      {e.detail && <p className="break-words text-xs text-ink-muted">{e.detail}</p>}
                      <p className="text-micro text-ink-faint">
                        {stamp(e.at)}
                        {e.who ? ` · ${e.who}` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          {doc.can.cancel && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (window.confirm(`¿Anular ${doc.number}? No se puede deshacer.`))
                  run(() => handlers.cancel(doc.id));
              }}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-rose"
            >
              <XCircle className="h-3.5 w-3.5" aria-hidden />
              Anular {doc.kindLabel.toLowerCase()}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-border bg-surface p-4 shadow-card">
      <h2 className="mb-3 text-sm font-bold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right text-ink">{value}</dd>
    </div>
  );
}

function SendPanel({
  doc,
  link,
  pending,
  onCopy,
  onSend,
}: {
  doc: SalesDetailView['doc'];
  link: string | null;
  pending: boolean;
  onCopy: () => void;
  onSend: (to: string[], message: string | null) => void;
}) {
  const [to, setTo] = useState(doc.clientEmail ?? '');
  const [message, setMessage] = useState('');
  const emails = to
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <section className="mt-4 rounded-card border border-primary/25 bg-surface p-4 shadow-card">
      <h2 className="text-sm font-bold text-ink">Mandar la cotización</h2>
      <p className="mt-0.5 text-xs text-ink-muted">
        Sale desde tu Gmail u Outlook con un enlace privado: el cliente la ve con tu marca, baja el
        PDF y la acepta con un clic.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-ink-muted">
          Para
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="compras@cliente.com"
            className="mt-1 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none"
          />
        </label>
        <label className="text-xs font-semibold text-ink-muted">
          Mensaje (opcional)
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Te comparto la cotización que hablamos…"
            className="mt-1 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none"
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || emails.length === 0}
          onClick={() => {
            if (window.confirm(`¿Mandar ${doc.number} a ${emails.join(', ')} desde tu correo?`))
              onSend(emails, message || null);
          }}
          className={PRIMARY}
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Send className="h-4 w-4" aria-hidden />
          )}
          Enviar por correo
        </button>
        <button type="button" disabled={pending} onClick={onCopy} className={BTN}>
          <Copy className="h-4 w-4" aria-hidden />
          Copiar enlace
        </button>
        {link && <span className="break-all text-xs text-ink-faint">{link}</span>}
      </div>
    </section>
  );
}

function AcceptPanel({
  pending,
  defaultName,
  onAccept,
  onReject,
}: {
  pending: boolean;
  defaultName: string;
  onAccept: (name: string) => void;
  onReject: (reason: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [reason, setReason] = useState('');
  return (
    <section className="mt-4 grid gap-4 rounded-card border border-border bg-surface p-4 shadow-card sm:grid-cols-2">
      <div>
        <h2 className="text-sm font-bold text-ink">El cliente la aceptó por otro lado</h2>
        <p className="text-xs text-ink-muted">
          Por WhatsApp, por teléfono… Queda en la línea de tiempo a tu nombre.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Quién la aceptó"
            aria-label="Quién la aceptó"
            className="min-w-0 flex-1 rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none"
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => onAccept(name)}
            className={PRIMARY}
          >
            Aceptada
          </button>
        </div>
      </div>
      <div>
        <h2 className="text-sm font-bold text-ink">Dijo que no</h2>
        <p className="text-xs text-ink-muted">El motivo ayuda a cotizar mejor la próxima.</p>
        <div className="mt-2 flex gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Precio, tiempos, otro proveedor…"
            aria-label="Motivo del rechazo"
            className="min-w-0 flex-1 rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none"
          />
          <button type="button" disabled={pending} onClick={() => onReject(reason)} className={BTN}>
            Rechazada
          </button>
        </div>
      </div>
    </section>
  );
}

function InvoicePanel({
  docId,
  handlers,
  uncertain,
}: {
  docId: string;
  handlers: SalesDetailHandlers;
  uncertain: boolean;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<InvoicePreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [emitting, startEmit] = useTransition();

  // La vista previa se pide al abrir el panel (habla con el programa contable).
  useEffect(() => {
    startLoad(async () => {
      const r = await handlers.preview(docId);
      if (r.ok && r.data) setPreview(r.data);
      else setError(r.error ?? 'No se pudo armar la vista previa.');
    });
  }, [docId, handlers]);

  const s = preview?.summary;
  const blocked = !s || (preview?.problems.length ?? 0) > 0;

  return (
    <section className="mt-4 rounded-card border border-primary/25 bg-surface p-4 shadow-card">
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
        <Receipt className="h-4 w-4 text-primary" aria-hidden />
        Factura electrónica{preview?.providerName ? ` en ${preview.providerName}` : ''}
      </h2>
      {loading && (
        <p className="mt-2 flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Preguntándole al programa contable cómo saldría…
        </p>
      )}
      {error && <p className="mt-2 rounded-sm bg-rose-soft px-3 py-2 text-sm text-rose">{error}</p>}
      {preview?.guidance && (
        <div className="mt-2 rounded-sm bg-amber-soft px-3 py-2 text-sm text-amber">
          <p>{preview.guidance}</p>
          <Link
            href="/integrations#programas-contables"
            className="mt-1 inline-block font-semibold underline"
          >
            Ir a Integraciones
          </Link>
        </div>
      )}
      {s && (
        <div className="mt-3 space-y-3 text-sm">
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <Fact label="Cliente" value={s.customer} />
            <Fact label="Documento" value={s.documentType ?? 'Numeración por defecto'} />
            <Fact label="Fecha" value={s.date} />
            <Fact label="Forma de pago" value={`${s.payment} · vence ${s.dueDate}`} />
            {s.seller && <Fact label="Vendedor" value={s.seller} />}
          </dl>
          <ul className="divide-y divide-border rounded-sm border border-border">
            {s.lines.map((l, i) => (
              <li
                key={`${i}-${l.description}`}
                className="flex flex-wrap justify-between gap-2 px-3 py-2"
              >
                <span className="text-ink">
                  {l.description}{' '}
                  {l.code ? (
                    <span className="text-xs text-ink-faint">[{l.code}]</span>
                  ) : (
                    <span className="text-xs text-rose">[sin producto]</span>
                  )}
                </span>
                <span className="tabular-nums text-ink-muted">
                  {l.quantity} × {formatMoney(l.unitPrice)} · {l.tax} ={' '}
                  <strong className="text-ink">{formatMoney(l.total)}</strong>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-right">
            Base {formatMoney(s.subtotal)} · IVA {formatMoney(s.iva)} ·{' '}
            <strong className="text-base">Total {formatMoney(s.total)}</strong>
          </p>
          {preview?.problems.length ? (
            <div className="rounded-sm bg-rose-soft px-3 py-2 text-rose">
              <p className="font-semibold">Antes de emitir hay que arreglar:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {preview.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {preview?.notes.map((n) => (
            <p key={n} className="text-xs text-ink-muted">
              {n}
            </p>
          ))}
        </div>
      )}
      {result && (
        <p className="mt-3 rounded-sm bg-emerald-soft px-3 py-2 text-sm text-emerald">{result}</p>
      )}
      {s && !result && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={blocked || emitting}
            onClick={() => {
              if (
                !window.confirm(
                  `¿Emitir la factura electrónica por ${formatMoney(s.total)} a ${s.customer} en ${preview?.providerName}? Se envía a la DIAN y no se puede deshacer desde Cortex (se anula con nota crédito).`,
                )
              )
                return;
              setError(null);
              startEmit(async () => {
                const r = await handlers.emit(docId, uncertain);
                if (r.ok) {
                  setResult(r.note ?? 'Factura emitida.');
                  if (r.data) router.push(`/ventas/${r.data.invoiceId}`);
                  router.refresh();
                } else setError(r.error ?? 'No se pudo emitir.');
              });
            }}
            className={PRIMARY}
          >
            {emitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Aprobar y emitir
          </button>
          <span className="text-xs text-ink-muted">
            Tu aprobación queda registrada a tu nombre.
          </span>
        </div>
      )}
    </section>
  );
}
