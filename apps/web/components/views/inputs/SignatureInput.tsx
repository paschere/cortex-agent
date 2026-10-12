'use client';

import { buildEvidence, withEvidence } from '@/lib/capture/evidence';
import { stashBlob } from '@/lib/views/offline-files';
import { isPendingUrl, previewUrl } from '@/lib/views/offline-files';
import { type UploadedFile, parseFileValue } from '@/lib/views/upload-rules';
import { clsx } from 'clsx';
import { Check, Eraser, Loader2, PenLine } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SubmitTarget } from '../ViewCanvas';
import { OfflineUploadError, uploadFile } from './FileInput';

/**
 * LA FIRMA DIBUJADA CON EL DEDO (campo `file` con `accept: 'signature'` y el
 * requisito «firma» de un flujo por estados): un lienzo, «Borrar» y «Usar esta
 * firma». Al confirmar se sube como PNG (con la hora, como evidencia) y el valor
 * del campo queda igual que el de cualquier archivo: {url,name,mime,size,takenAt}.
 * Sin señal, el PNG se guarda en el teléfono (`pending:`) y sube al enviar el
 * registro, igual que una foto.
 *
 * El trazo es suave (curvas entre puntos medios) y no depende de la pantalla:
 * el lienzo tiene un tamaño propio y se escala por CSS, así que la firma sale
 * igual en un teléfono que en una tableta. Siempre papel blanco y tinta oscura,
 * en modo claro y oscuro: una firma sobre fondo transparente se ve mal en un PDF.
 */

export interface SignatureInputProps {
  value: string;
  onChange: (v: string) => void;
  target: SubmitTarget;
  blockId: string;
  field: string;
  disabled?: boolean;
  /** Modo operario: lienzo y botones más grandes. */
  large?: boolean;
}

const W = 640;
const H = 220;

export function SignatureInput({
  value,
  onChange,
  target,
  blockId,
  field,
  disabled,
  large,
}: SignatureInputProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const lastMid = useRef<{ x: number; y: number } | null>(null);
  const drawing = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const saved = parseFileValue(value)[0] ?? null;

  const paint = () => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: el lienzo se prepara una vez, y de nuevo al volver a firmar
  useEffect(() => {
    if (!saved || replacing) paint();
  }, [saved, replacing]);

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * e.currentTarget.width,
      y: ((e.clientY - r.top) / r.height) * e.currentTarget.height,
    };
  };

  function clear() {
    paint();
    setDirty(false);
    setError(null);
  }

  async function save() {
    const c = ref.current;
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
      if (!blob) throw new Error('No se pudo leer la firma.');
      const file = new File([blob], 'firma.png', { type: 'image/png' });
      const evidence = buildEvidence(new Date(), null);
      let done: UploadedFile;
      if (typeof navigator !== 'undefined' && !navigator.onLine && target.kind !== 'preview')
        done = await stashBlob(file, evidence);
      else
        try {
          done = withEvidence(await uploadFile(target, blockId, field, file, () => {}), evidence);
        } catch (e) {
          if (!(e instanceof OfflineUploadError)) throw e;
          done = await stashBlob(file, evidence);
        }
      onChange(JSON.stringify(done));
      setReplacing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la firma.');
    } finally {
      setBusy(false);
    }
  }

  const btn = clsx(
    'view-press inline-flex items-center justify-center gap-1.5 rounded-pill border border-border px-4 font-semibold disabled:opacity-50',
    large ? 'min-h-14 text-base' : 'min-h-11 text-xs',
  );

  if (saved && !replacing) {
    const src = previewUrl(saved.url) ?? (isPendingUrl(saved.url) ? null : saved.url);
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3 rounded-card border border-border bg-white p-2">
          {src ? (
            <img src={src} alt="Firma guardada" className="h-20 max-w-[16rem] object-contain" />
          ) : (
            <span className="text-sm text-slate-600">Firma guardada en el teléfono.</span>
          )}
        </div>
        <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald">
          <Check className="h-4 w-4" aria-hidden />
          {isPendingUrl(saved.url) ? 'Firma lista · se sube al enviar' : 'Firma guardada'}
        </p>
        {!disabled && (
          <button
            type="button"
            className={btn}
            onClick={() => {
              onChange('');
              setReplacing(true);
              setDirty(false);
            }}
          >
            <PenLine className="h-4 w-4" aria-hidden /> Firmar de nuevo
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <canvas
          ref={ref}
          width={W}
          height={H}
          role="img"
          aria-label="Espacio para firmar con el dedo o el mouse"
          className={clsx(
            'w-full touch-none rounded-card border-2 border-dashed border-border-strong bg-white',
            large ? 'h-44' : 'h-36',
            disabled && 'opacity-60',
          )}
          onPointerDown={(e) => {
            if (disabled) return;
            drawing.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = at(e);
            last.current = p;
            lastMid.current = p;
            const ctx = e.currentTarget.getContext('2d');
            // Un toque deja un punto.
            ctx?.beginPath();
            ctx?.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
            ctx?.fill();
            setDirty(true);
          }}
          onPointerMove={(e) => {
            if (!drawing.current || !last.current) return;
            const p = at(e);
            const ctx = e.currentTarget.getContext('2d');
            if (!ctx) return;
            // Curva entre puntos medios: el trazo sale suave aunque el dedo tiemble.
            const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
            const from = lastMid.current ?? last.current;
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
            ctx.stroke();
            lastMid.current = mid;
            last.current = p;
          }}
          onPointerUp={() => {
            drawing.current = false;
            last.current = null;
            lastMid.current = null;
          }}
          onPointerCancel={() => {
            drawing.current = false;
            last.current = null;
          }}
        />
        {!dirty && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center text-sm font-semibold text-slate-400">
            Firma aquí
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={clear} disabled={disabled || !dirty} className={btn}>
          <Eraser className="h-4 w-4" aria-hidden /> Borrar
        </button>
        <button
          type="button"
          disabled={disabled || !dirty || busy}
          onClick={save}
          className={clsx(btn, 'border-transparent bg-primary-soft text-primary-ink')}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Check className="h-4 w-4" aria-hidden />
          )}
          Usar esta firma
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs font-semibold text-rose">
          {error}
        </p>
      )}
    </div>
  );
}
