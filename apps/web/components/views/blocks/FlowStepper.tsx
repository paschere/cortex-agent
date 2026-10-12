'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { ArrowRight, Check, Eraser, Loader2, Lock, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SubmitTarget } from '../ViewCanvas';
import { FileInput, uploadFile } from '../inputs/FileInput';
import { useViewWriter } from '../view-writes';
import { formatWhen } from './theme';

/**
 * EL ESTADO DE UN REGISTRO COMO PASOS (flujo por estados).
 *
 * Muestra por dónde va la fila (hechos, actual, por venir) y, debajo, SÓLO los
 * botones de los pasos que el rol de quien mira puede dar. Si el estado al que
 * se entra pide algo (un dato, una foto, una firma, un comentario), el botón
 * abre una hoja corta que lo pide; al confirmar se escribe el estado y lo
 * pedido en una sola edición. El servidor vuelve a juzgar todo: lo de aquí es
 * ayuda, no la regla.
 */

type Detail = Extract<ComputedBlock, { type: 'detail' }>;
export type FlowView = NonNullable<Detail['flow']>;
type Move = FlowView['next'][number];

const PRIMARY =
  'view-press inline-flex min-h-11 items-center justify-center gap-1.5 rounded-pill bg-primary px-4 text-xs font-semibold text-white shadow-card transition-opacity hover:opacity-90 disabled:opacity-50 sm:min-h-9';

export function FlowSteps({ flow, className }: { flow: FlowView; className?: string }) {
  return (
    <ol
      aria-label={`Avance de ${flow.label}`}
      className={clsx('flex flex-wrap items-center gap-x-1 gap-y-2', className)}
    >
      {flow.steps.map((s, i) => (
        <li key={s.state} className="flex shrink-0 items-center gap-1">
          {i > 0 && (
            <span
              aria-hidden
              className={clsx('h-px w-4 sm:w-6', s.status === 'todo' ? 'bg-border' : 'bg-primary')}
            />
          )}
          <span
            aria-current={s.status === 'current' ? 'step' : undefined}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-micro font-semibold',
              s.status === 'current' && 'bg-primary text-white shadow-card',
              s.status === 'done' && 'bg-primary-soft text-primary-ink',
              s.status === 'todo' && 'border border-border bg-surface text-ink-faint',
            )}
          >
            {s.status === 'done' && <Check className="h-3 w-3" aria-hidden />}
            {s.state}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Una firma dibujada con el dedo o el mouse; al terminar se sube como imagen. */
function SignaturePad({
  target,
  blockId,
  field,
  onChange,
}: {
  target: SubmitTarget;
  blockId: string;
  field: string;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111827';
  }, []);

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * e.currentTarget.width,
      y: ((e.clientY - r.top) / r.height) * e.currentTarget.height,
    };
  };

  async function save() {
    const c = ref.current;
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
      if (!blob) throw new Error('No se pudo leer la firma.');
      const file = new File([blob], 'firma.png', { type: 'image/png' });
      const up = await uploadFile(target, blockId, field, file, () => undefined);
      onChange(JSON.stringify(up));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la firma.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <canvas
        ref={ref}
        width={560}
        height={180}
        aria-label="Espacio para firmar"
        className="h-32 w-full touch-none rounded-card border border-dashed border-border-strong bg-white"
        onPointerDown={(e) => {
          drawing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          const ctx = e.currentTarget.getContext('2d');
          const p = at(e);
          ctx?.beginPath();
          ctx?.moveTo(p.x, p.y);
          setSaved(false);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const p = at(e);
          const ctx = e.currentTarget.getContext('2d');
          ctx?.lineTo(p.x, p.y);
          ctx?.stroke();
          setDirty(true);
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const c = ref.current;
            c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
            setDirty(false);
            setSaved(false);
            onChange('');
          }}
          className="view-press inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-border px-3 text-xs font-semibold text-ink-muted sm:min-h-9"
        >
          <Eraser className="h-3.5 w-3.5" aria-hidden /> Borrar
        </button>
        <button
          type="button"
          disabled={!dirty || busy}
          onClick={save}
          className="view-press inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-primary-soft px-3 text-xs font-semibold text-primary-ink disabled:opacity-50 sm:min-h-9"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Check className="h-3.5 w-3.5" aria-hidden />
          )}
          {saved ? 'Firma guardada' : 'Usar esta firma'}
        </button>
      </div>
      {error && <p className="text-micro font-semibold text-rose">{error}</p>}
    </div>
  );
}

function RequirementInput({
  req,
  value,
  onChange,
  target,
  blockId,
}: {
  req: Move['requires'][number];
  value: string;
  onChange: (v: string) => void;
  target: SubmitTarget;
  blockId: string;
}) {
  const box =
    'w-full rounded-card border border-border bg-surface px-3 py-2.5 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/30';
  if (req.kind === 'photo')
    return (
      <FileInput
        value={value}
        onChange={onChange}
        accept="image"
        target={target}
        blockId={blockId}
        field={req.field}
        large
      />
    );
  if (req.kind === 'signature')
    return <SignaturePad target={target} blockId={blockId} field={req.field} onChange={onChange} />;
  if (req.kind === 'comment' || req.type === 'longtext')
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className={box}
        placeholder="Escribe aquí"
      />
    );
  if (req.type === 'select' && req.options?.length)
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={box}>
        <option value="">Elige una opción</option>
        {req.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      type={
        req.type === 'number' || req.type === 'money'
          ? 'number'
          : req.type === 'date'
            ? 'date'
            : 'text'
      }
      className={box}
    />
  );
}

/** La hoja que pide lo que el estado de destino exige, y escribe todo junto. */
function RequirementSheet({
  move,
  flow,
  blockId,
  rowId,
  target,
  onClose,
}: {
  move: Move;
  flow: FlowView;
  blockId: string;
  rowId: string;
  target: SubmitTarget;
  onClose: () => void;
}) {
  const writer = useViewWriter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = move.requires.filter((r) => !r.filled);
  const ready = pending.every((r) => (values[r.field] ?? '').trim() !== '');

  async function go() {
    if (!writer) return;
    setBusy(true);
    setError(null);
    const res = await writer.edit(blockId, rowId, {
      [flow.field]: move.to,
      ...Object.fromEntries(pending.map((r) => [r.field, values[r.field] ?? ''])),
    });
    setBusy(false);
    if (res.ok) onClose();
    else setError(res.error);
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] overflow-y-auto rounded-t-[1.5rem] bg-surface px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 shadow-pop sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[28rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-extrabold tracking-tight text-ink">
                Pasar a «{move.to}»
              </Dialog.Title>
              <p className="mt-0.5 text-xs text-ink-muted">
                Para entrar a este estado hace falta lo siguiente.
              </p>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-pill bg-surface-2 text-ink-muted"
            >
              <X className="h-4 w-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="space-y-4">
            {pending.map((r) => (
              <div key={r.field}>
                <p className="mb-1.5 text-xs font-semibold text-ink">{r.label}</p>
                <RequirementInput
                  req={r}
                  value={values[r.field] ?? ''}
                  onChange={(v) => setValues((cur) => ({ ...cur, [r.field]: v }))}
                  target={target}
                  blockId={blockId}
                />
              </div>
            ))}
          </div>
          {error && (
            <p role="alert" className="mt-3 text-xs font-semibold text-rose">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close className="view-press min-h-11 rounded-pill border border-border px-4 text-xs font-semibold text-ink-muted sm:min-h-9">
              Cancelar
            </Dialog.Close>
            <button type="button" disabled={!ready || busy} onClick={go} className={PRIMARY}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Pasar a {move.to}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Los pasos, los botones del rol y la historia de saltos de UNA fila. */
export function FlowPanel({
  flow,
  blockId,
  rowId,
  target,
}: {
  flow: FlowView;
  blockId: string;
  rowId: string;
  target: SubmitTarget;
}) {
  const writer = useViewWriter();
  const [open, setOpen] = useState<Move | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const moves = flow.next.filter((m) => m.allowed);
  const blocked = flow.next.filter((m) => !m.allowed);

  async function press(m: Move) {
    if (m.requires.some((r) => !r.filled)) return setOpen(m);
    if (!writer) return;
    setBusy(m.to);
    setError(null);
    const res = await writer.edit(blockId, rowId, { [flow.field]: m.to });
    setBusy(null);
    if (!res.ok) setError(res.error);
  }

  return (
    <div className="space-y-3">
      <FlowSteps flow={flow} />
      {flow.writable && writer && (
        <div className="flex flex-wrap items-center gap-2">
          {moves.map((m) => (
            <button
              key={m.to}
              type="button"
              disabled={busy !== null}
              onClick={() => press(m)}
              className={PRIMARY}
            >
              {busy === m.to ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              )}
              Pasar a {m.to}
            </button>
          ))}
          {moves.length === 0 && (
            <p className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
              <Lock className="h-3.5 w-3.5" aria-hidden />
              {blocked.length
                ? `El siguiente paso (${blocked.map((b) => b.to).join(', ')}) lo da otro rol.`
                : 'Este registro ya terminó su recorrido.'}
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs font-semibold text-rose">
          {error}
        </p>
      )}
      {open && (
        <RequirementSheet
          move={open}
          flow={flow}
          blockId={blockId}
          rowId={rowId}
          target={target}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/** Quién movió el registro, de qué a qué y cuándo. */
export function FlowHistory({ history }: { history: NonNullable<Detail['flow']>['history'] }) {
  if (history.length === 0) return null;
  return (
    <ul aria-label="Historial de estados" className="space-y-1.5 border-t border-border pt-3">
      {history.map((h) => (
        <li
          key={`${h.at}-${h.to}`}
          className="flex flex-wrap items-center gap-x-2 text-micro text-ink-muted"
        >
          <span className="font-semibold text-ink">{h.to}</span>
          {h.from && <span className="text-ink-faint">desde {h.from}</span>}
          <span>
            · {h.by ?? 'Alguien'} ·{' '}
            <time dateTime={h.at} suppressHydrationWarning>
              {formatWhen(h.at)}
            </time>
          </span>
        </li>
      ))}
    </ul>
  );
}

type CardsBlockType = Extract<ComputedBlock, { type: 'cards' }>;

/** El avance de una tarjeta: puntos y el siguiente paso (directo si no pide nada; si pide algo, abre la ficha). */
export function CardFlow({
  flow,
  field,
  blockId,
  rowId,
  onOpen,
}: {
  flow: NonNullable<CardsBlockType['cards'][number]['flow']>;
  field: string;
  blockId: string;
  rowId: string;
  onOpen?: () => void;
}) {
  const writer = useViewWriter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = flow.next.find((n) => n.allowed);
  return (
    <div className="relative z-10 mt-3 space-y-2 border-t border-border/70 pt-3">
      <div
        role="img"
        aria-label={`Paso ${Math.max(flow.index, 0) + 1} de ${flow.total}`}
        className="flex items-center gap-1"
      >
        {Array.from({ length: flow.total }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: puntos fijos
            key={i}
            className={clsx(
              'h-1.5 flex-1 rounded-pill',
              i <= flow.index ? 'bg-primary' : 'bg-border',
            )}
          />
        ))}
      </div>
      {move && writer && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (move.needs) return onOpen?.();
            setBusy(true);
            setError(null);
            const res = await writer.edit(blockId, rowId, { [field]: move.to });
            setBusy(false);
            if (!res.ok) setError(res.error);
          }}
          className="view-press inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-primary-soft px-3 text-xs font-semibold text-primary-ink disabled:opacity-50 sm:min-h-9"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          )}
          Pasar a {move.to}
          {move.needs ? '…' : ''}
        </button>
      )}
      {error && <p className="text-micro font-semibold text-rose">{error}</p>}
    </div>
  );
}
