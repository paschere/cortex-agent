'use client';

import { clsx } from 'clsx';
import { Check, ChevronDown, Layers, Loader2, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

/**
 * UN GRUPO DE PENDIENTES PARECIDOS: «APROBAR LOS 6» O «REVISAR UNO POR UNO».
 *
 * Seis cobros de cartera redactados el mismo día no son seis decisiones
 * distintas: son una, repetida seis veces, y pedir doce clics es la manera más
 * segura de que se queden esperando hasta vencer. Esta tarjeta los presenta
 * como lo que son —un grupo— sin esconder ninguno:
 *
 *   · arriba, qué hace CADA uno, en una línea (a quién, qué asunto). Aprobar el
 *     lote es aprobar exactamente esa lista, que está a la vista;
 *   · «Aprobar los 6» manda el lote a la ruta de lote, que es un bucle sobre la
 *     misma puerta de cada tarjeta (lib/follow-through/batch.ts): cada uno se
 *     reclama, se audita y se ejecuta por su cuenta;
 *   · «Revisar uno por uno» despliega las tarjetas de siempre (`children`), con
 *     su texto completo, su «ver lo que se va a enviar» y sus botones.
 *
 * Lo que repite algo ya hecho (0168) aparece en la lista marcado y FUERA del
 * lote: eso se aprueba en su tarjeta, a sabiendas.
 *
 * También sirve para descartar en lote (`mode="discard"`) lo que lleva días
 * esperando: la pregunta «¿lo descarto?» con un solo clic.
 *
 * Componente de cliente: no importa valores de @cortex/agent-tools. Todo lo que
 * sabe le llega ya armado del servidor.
 */

export interface ApprovalGroupItem {
  id: string;
  /** Lo que hace, en una línea: «Cobro de cartera a pagos@nexa.co». */
  line: string;
  /** Segunda línea: el asunto, la edad. */
  detail?: string | null;
  /** La huella del texto que se ve (sólo borradores de /actions). */
  contentHash?: string | null;
  /** Fuera del lote: repite algo ya hecho, o no cupo. */
  heldBack?: string | null;
}

interface Props {
  /** Qué cola: decide a qué ruta de lote se manda. */
  queue: 'approvals' | 'actions';
  mode?: 'approve' | 'discard';
  title: string;
  subtitle?: string | null;
  /** «Aprobar los 6», «Descartar los 3». */
  actionLabel: string;
  items: ApprovalGroupItem[];
  /** Las tarjetas de siempre, para revisarlas una por una. */
  children?: ReactNode;
  /** Arrancar desplegado (cuando se llega desde un aviso de «¿lo descarto?»). */
  defaultOpen?: boolean;
}

type Result = { id: string; ok: boolean; message?: string; replayed?: boolean };
type Status = 'idle' | 'running' | 'done' | 'error';

export function ApprovalGroup({
  queue,
  mode = 'approve',
  title,
  subtitle,
  actionLabel,
  items,
  children,
  defaultOpen = false,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [status, setStatus] = useState<Status>('idle');
  const [summary, setSummary] = useState('');
  const [results, setResults] = useState<Map<string, Result>>(new Map());
  const batch = items.filter((i) => !i.heldBack);
  const discard = mode === 'discard';

  async function run() {
    setStatus('running');
    try {
      const body =
        queue === 'approvals'
          ? { ids: batch.map((i) => i.id) }
          : discard
            ? { action: 'dismiss', ids: batch.map((i) => i.id) }
            : {
                action: 'approve',
                items: batch
                  .filter((i) => i.contentHash)
                  .map((i) => ({ id: i.id, contentHash: i.contentHash })),
              };
      const res = await fetch(`/api/${queue}/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        results?: Result[];
        summary?: string;
        error?: string;
      };
      if (!res.ok || !data.results) {
        setSummary(data.error ?? 'No se pudo guardar tu respuesta. No se ejecutó nada.');
        setStatus('error');
        return;
      }
      setResults(new Map(data.results.map((r) => [r.id, r])));
      setSummary(data.summary ?? '');
      setStatus('done');
      router.refresh();
    } catch {
      setSummary('No hubo conexión con Cortex. No se ejecutó nada.');
      setStatus('error');
    }
  }

  const tone = discard ? 'border-border-strong' : 'border-amber/40';

  return (
    <section className={clsx('overflow-hidden rounded-card border bg-surface shadow-card', tone)}>
      <div
        className={clsx(
          'flex items-start gap-3 border-b px-4 py-3',
          discard ? 'border-border bg-surface-2' : 'border-amber/30 bg-amber-soft',
        )}
      >
        {discard ? (
          <Trash2 className="mt-0.5 h-[18px] w-[18px] shrink-0 text-ink-muted" aria-hidden />
        ) : (
          <Layers className="mt-0.5 h-[18px] w-[18px] shrink-0 text-amber" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <span className={clsx('field-label', discard ? 'text-ink-muted' : 'text-amber')}>
            {discard ? 'Llevan días esperando' : 'Se parecen'}
          </span>
          <p className="mt-0.5 text-sm font-semibold text-ink">{title}</p>
          {subtitle && <p className="mt-1 text-xs leading-snug text-ink-muted">{subtitle}</p>}
        </div>
      </div>

      <ul className="divide-y divide-border px-4">
        {items.map((i) => {
          const r = results.get(i.id);
          return (
            <li key={i.id} className="flex items-start gap-2.5 py-2.5">
              <span
                className={clsx(
                  'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full',
                  r
                    ? r.ok
                      ? 'bg-emerald-soft text-emerald'
                      : 'bg-rose-soft text-rose'
                    : 'bg-surface-2',
                )}
                aria-hidden
              >
                {r ? r.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" /> : null}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{i.line}</p>
                {(i.detail || i.heldBack || r?.message || r?.replayed) && (
                  <p className="mt-0.5 text-micro leading-snug text-ink-faint">
                    {[
                      i.detail,
                      i.heldBack ? `Fuera del lote: ${i.heldBack}` : null,
                      r?.replayed ? 'Ya estaba hecho; no se repitió.' : null,
                      r && !r.ok ? r.message : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {status !== 'done' && batch.length > 0 && (
          <button
            type="button"
            onClick={() => void run()}
            disabled={status === 'running'}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-pill px-4 py-1.5 text-sm font-semibold transition-all duration-150 hover:-translate-y-px disabled:opacity-60 disabled:hover:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none',
              discard
                ? 'border border-border-strong bg-surface text-ink hover:bg-surface-2'
                : 'bg-amber text-white hover:brightness-95',
            )}
          >
            {status === 'running' ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : discard ? (
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Check className="h-3.5 w-3.5" aria-hidden />
            )}
            {status === 'running' ? (discard ? 'Descartando…' : 'Aprobando…') : actionLabel}
          </button>
        )}
        {children && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 rounded-pill px-3 py-1.5 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <ChevronDown
              className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
              aria-hidden
            />
            {open
              ? 'Ocultar las tarjetas'
              : discard
                ? 'Revisarlos uno por uno'
                : 'Revisar uno por uno'}
          </button>
        )}
        {summary && (
          <output
            className={clsx(
              'block basis-full text-xs',
              status === 'error' ? 'text-rose' : 'font-semibold text-emerald',
            )}
          >
            {summary}
          </output>
        )}
      </div>

      {open && children && (
        <div className="space-y-3 border-t border-border bg-canvas/40 p-3">{children}</div>
      )}
    </section>
  );
}
