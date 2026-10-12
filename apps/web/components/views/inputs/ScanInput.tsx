'use client';

import { playFeedback } from '@/lib/capture/feedback';
import {
  type ScanEntry,
  type ScanStatus,
  joinScanLines,
  registerScan,
  scanLines,
} from '@/lib/capture/scan';
import { clsx } from 'clsx';
import { AlertTriangle, Check, Flashlight, Plus, ScanLine, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Campo de texto con «Escanear»: abre la cámara trasera y lee códigos de barras
 * y QR (guías, lotes, series, placas con código). Usa `BarcodeDetector` nativo
 * (Chrome/Android) y, donde no existe (Safari iOS, Firefox), @zxing/browser
 * cargado con import() sólo cuando alguien aprieta Escanear: no pesa en el
 * bundle del formulario. Cada lectura suena y vibra (distinto si es nueva o
 * repetida; ver lib/capture/feedback.ts). El campo sigue siendo escribible a
 * mano, y el diálogo también deja escribir un código.
 *
 * Tres modos:
 *   - un código (por defecto): al leer, escribe el valor y se cierra solo;
 *   - texto largo (`multiline`): cada lectura se AGREGA como una línea nueva;
 *   - continuo (`continuous`, sólo texto largo): la cámara sigue abierta, cada
 *     código suma a una lista con contador, los repetidos se avisan (suena
 *     distinto y se marcan) y «Listo» los pone todos en el campo, uno por línea.
 * Qué cuenta como el mismo código, cuándo se ignora un rebote de la cámara y
 * cómo se limpia lo leído está en lib/capture/scan.ts (probado).
 */

export interface ScanInputProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Modo operario: 56 px. */
  large?: boolean;
  placeholder?: string;
  /** Para que el formulario lo ate a su etiqueta, su error y su validación. */
  id?: string;
  onBlur?: () => void;
  invalid?: boolean;
  describedBy?: string;
  /** Estilo del input del formulario; sin él, el propio. */
  inputClassName?: string;
  /** La cámara sigue abierta y suma cada código. */
  continuous?: boolean;
  /** El campo es un texto largo: un código por línea. */
  multiline?: boolean;
}

interface Detector {
  detect: (src: CanvasImageSource) => Promise<{ rawValue: string; format?: string }[]>;
}
type DetectorCtor = {
  new (opts?: { formats: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
};

function cameraError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'No hay permiso para usar la cámara. Actívalo en los ajustes del navegador o escribe el código.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No encontré una cámara en este dispositivo. Escribe el código.';
  return 'No pude abrir la cámara. Escribe el código.';
}

export function ScanInput({
  value,
  onChange,
  disabled,
  large,
  placeholder,
  id,
  onBlur,
  invalid,
  describedBy,
  inputClassName,
  continuous = false,
  multiline = false,
}: ScanInputProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null); // null = sin linterna
  const [session, setSession] = useState<ScanEntry[]>([]);
  const [last, setLast] = useState<{ code: string; status: ScanStatus } | null>(null);
  const [manual, setManual] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  // La cámara lee cada 150 ms: el ciclo necesita siempre lo último, sin reabrir la cámara.
  const live = useRef({ value, session, continuous, multiline, onChange });
  live.current = { value, session, continuous, multiline, onChange };

  const close = useCallback(() => setOpen(false), []);

  /** Pone en el campo lo leído: una línea más (texto largo) o el código solo. */
  const apply = useCallback((codes: string[]) => {
    const { value: current, multiline: multi, onChange: change } = live.current;
    if (!codes.length) return;
    change(multi ? joinScanLines([...scanLines(current), ...codes]) : (codes[0] as string));
  }, []);

  const onCode = useCallback(
    (raw: string, format?: string) => {
      const { session: list, continuous: cont, multiline: multi, value: current } = live.current;
      const res = registerScan(list, raw, Date.now(), {
        format,
        existing: multi ? scanLines(current) : [],
      });
      if (res.status === 'invalid' || res.status === 'ignored') return;
      playFeedback(res.status === 'duplicate' ? 'duplicate' : 'ok');
      live.current.session = res.list;
      setSession(res.list);
      setLast({ code: res.code as string, status: res.status });
      if (!cont) {
        apply([res.code as string]);
        close();
      }
    },
    [apply, close],
  );

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let controls: { stop: () => void } | null = null;
    let raf = 0;
    setError(null);
    setTorch(null);
    setSession([]);
    live.current.session = [];
    setLast(null);
    setManual('');

    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('sin cámara');
        const Native = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
        const constraints = { video: { facingMode: { ideal: 'environment' } }, audio: false };
        const video = videoRef.current;
        if (!video) return;

        if (Native) {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (stopped) return;
          video.srcObject = stream;
          await video.play().catch(() => {});
          const track = stream.getVideoTracks()[0] ?? null;
          trackRef.current = track;
          const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
          if (caps?.torch) setTorch(false);
          const detector = new Native();
          const tick = async () => {
            if (stopped) return;
            try {
              if (video.readyState >= 2) {
                const found = await detector.detect(video);
                for (const f of found) onCode(f.rawValue, f.format);
              }
            } catch {}
            if (!stopped) raf = window.setTimeout(tick, 150) as unknown as number;
          };
          void tick();
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          if (stopped) return;
          const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 150 });
          controls = await reader.decodeFromConstraints(constraints, video, (result) => {
            if (result && !stopped) onCode(result.getText());
          });
          if (stopped) controls.stop();
          const s = video.srcObject as MediaStream | null;
          trackRef.current = s?.getVideoTracks()[0] ?? null;
          const caps = trackRef.current?.getCapabilities?.() as { torch?: boolean } | undefined;
          if (caps?.torch) setTorch(false);
        }
      } catch (e) {
        if (!stopped) setError(cameraError(e));
      }
    })();

    return () => {
      stopped = true;
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(raf);
      controls?.stop();
      for (const t of stream?.getTracks() ?? []) t.stop();
      const s = videoRef.current?.srcObject as MediaStream | null;
      for (const t of s?.getTracks() ?? []) t.stop();
      trackRef.current = null;
      openerRef.current?.focus();
    };
  }, [open, onCode]);

  async function toggleTorch() {
    const next = !torch;
    try {
      await trackRef.current?.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorch(next);
    } catch {
      setTorch(null);
    }
  }

  function finishContinuous() {
    apply(live.current.session.map((e) => e.code));
    close();
  }

  function removeAt(at: number) {
    const next = live.current.session.filter((_, i) => i !== at);
    live.current.session = next;
    setSession(next);
  }

  const inputCls = inputClassName
    ? clsx(inputClassName, 'min-w-0 flex-1 tabular font-mono')
    : clsx(
        'min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-ink outline-none focus:border-primary',
        large ? 'min-h-14 text-lg' : 'min-h-11 text-sm',
      );
  const repeats = session.filter((e) => e.duplicate).length;

  return (
    <>
      <div className={clsx('flex gap-2', multiline && 'flex-col sm:flex-row sm:items-start')}>
        {multiline ? (
          <textarea
            id={id}
            data-scan="true"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            placeholder={placeholder ?? 'Un código por línea'}
            rows={4}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className={clsx(inputCls, 'h-auto min-h-[7rem] py-2.5 leading-6')}
          />
        ) : (
          <input
            id={id}
            data-scan="true"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            placeholder={placeholder}
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className={inputCls}
          />
        )}
        <button
          ref={openerRef}
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled}
          className={clsx(
            'inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border-2 border-primary/40 bg-primary/5 px-4 font-bold text-primary hover:bg-primary/10 disabled:opacity-50',
            large ? 'min-h-14 text-base' : 'min-h-11 text-sm',
          )}
        >
          <ScanLine className="h-5 w-5" aria-hidden />
          {continuous ? 'Escanear varios' : 'Escanear'}
        </button>
      </div>
      {multiline && value.trim() && (
        <p className="mt-1 text-micro text-ink-faint">
          {scanLines(value).length} {scanLines(value).length === 1 ? 'código' : 'códigos'}
        </p>
      )}

      {open && (
        // biome-ignore lint/a11y/useSemanticElements: diálogo a pantalla completa propio
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Escanear código de barras o QR"
          className="fixed inset-0 z-50 flex flex-col bg-black"
        >
          <div className="relative min-h-0 flex-1">
            <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 h-40 w-[80%] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border-2 border-white/80"
              aria-hidden
            />
            {continuous && (
              <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
                <span className="rounded-pill bg-white px-3 py-1 text-sm font-bold text-black tabular">
                  {session.length} {session.length === 1 ? 'leído' : 'leídos'}
                </span>
                {repeats > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-pill bg-amber px-3 py-1 text-xs font-bold text-black">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                    {repeats} {repeats === 1 ? 'repetido' : 'repetidos'}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex max-h-[55dvh] flex-col gap-3 overflow-y-auto bg-black p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <output aria-live="polite" className="block text-center text-sm text-white">
              {error ??
                (last ? (
                  <span
                    className={clsx(
                      'inline-flex max-w-full items-center gap-2 rounded-pill px-3 py-1.5 font-bold',
                      last.status === 'duplicate'
                        ? 'bg-amber text-black'
                        : 'bg-emerald-400 text-black',
                    )}
                  >
                    {last.status === 'duplicate' ? (
                      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                    ) : (
                      <Check className="h-4 w-4 shrink-0" aria-hidden />
                    )}
                    <span className="truncate font-mono">{last.code}</span>
                    {last.status === 'duplicate' && <span>· ya estaba</span>}
                  </span>
                ) : (
                  'Apunta la cámara al código de barras o QR.'
                ))}
            </output>

            {continuous && session.length > 0 && (
              <ul className="max-h-40 space-y-1 overflow-y-auto" aria-label="Códigos leídos">
                {session
                  .map((e, i) => ({ e, i }))
                  .reverse()
                  .map(({ e, i }) => (
                    <li
                      key={`${e.code}-${e.at}`}
                      className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 text-sm text-white"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">{e.code}</span>
                      {e.duplicate && (
                        <span className="rounded-pill bg-amber px-2 text-micro font-bold text-black">
                          repetido
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeAt(i)}
                        aria-label={`Quitar ${e.code}`}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-white/80 hover:bg-white/15"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    </li>
                  ))}
              </ul>
            )}

            {continuous && (
              <form
                className="flex gap-2"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (manual.trim()) onCode(manual);
                  setManual('');
                }}
              >
                <input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="O escribe un código"
                  aria-label="Escribir un código a mano"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="min-h-12 min-w-0 flex-1 rounded-xl border border-white/30 bg-transparent px-3 font-mono text-base text-white placeholder:text-white/50"
                />
                <button
                  type="submit"
                  disabled={!manual.trim()}
                  className="inline-flex min-h-12 items-center gap-1.5 rounded-xl border-2 border-white/40 px-4 text-base font-bold text-white disabled:opacity-40"
                >
                  <Plus className="h-5 w-5" aria-hidden /> Agregar
                </button>
              </form>
            )}

            <div className="flex gap-3">
              {torch !== null && (
                <button
                  type="button"
                  onClick={toggleTorch}
                  aria-pressed={torch}
                  className="inline-flex min-h-14 flex-1 items-center justify-center gap-2 rounded-xl border-2 border-white/40 text-base font-bold text-white aria-pressed:bg-white aria-pressed:text-black"
                >
                  <Flashlight className="h-5 w-5" aria-hidden />
                  Linterna
                </button>
              )}
              {continuous ? (
                <>
                  <button
                    type="button"
                    onClick={close}
                    className="inline-flex min-h-14 flex-1 items-center justify-center gap-2 rounded-xl border-2 border-white/40 text-base font-bold text-white"
                  >
                    <X className="h-5 w-5" aria-hidden />
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={finishContinuous}
                    className="inline-flex min-h-14 flex-[1.4] items-center justify-center gap-2 rounded-xl bg-white text-base font-bold text-black"
                  >
                    <Check className="h-5 w-5" aria-hidden />
                    Listo{session.length ? ` (${session.length})` : ''}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={close}
                  className="inline-flex min-h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-white text-base font-bold text-black"
                >
                  <X className="h-5 w-5" aria-hidden />
                  Cerrar
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
