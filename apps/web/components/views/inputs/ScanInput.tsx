'use client';

import { clsx } from 'clsx';
import { Flashlight, ScanLine, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Campo de texto con «Escanear»: abre la cámara trasera y lee códigos de barras
 * y QR (guías, lotes, series, placas con código). Usa `BarcodeDetector` nativo
 * (Chrome/Android) y, donde no existe (Safari iOS, Firefox), @zxing/browser
 * cargado con import() sólo cuando alguien aprieta Escanear: no pesa en el
 * bundle del formulario. Al leer, vibra, escribe el valor y se cierra solo.
 * Escape cierra; el campo sigue siendo escribible a mano.
 */

export interface ScanInputProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Modo operario: 56 px. */
  large?: boolean;
  placeholder?: string;
}

interface Detector {
  detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]>;
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

export function ScanInput({ value, onChange, disabled, large, placeholder }: ScanInputProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null); // null = sin linterna
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const finish = useCallback(
    (code: string) => {
      navigator.vibrate?.(60);
      onChange(code);
      setOpen(false);
    },
    [onChange],
  );

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let controls: { stop: () => void } | null = null;
    let raf = 0;
    setError(null);
    setTorch(null);

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
                const code = found[0]?.rawValue;
                if (code) return finish(code);
              }
            } catch {}
            raf = window.setTimeout(tick, 150) as unknown as number;
          };
          void tick();
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          if (stopped) return;
          const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 150 });
          controls = await reader.decodeFromConstraints(constraints, video, (result) => {
            if (result && !stopped) finish(result.getText());
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
  }, [open, finish]);

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

  return (
    <>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className={clsx(
            'min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-ink outline-none focus:border-primary',
            large ? 'min-h-14 text-lg' : 'min-h-11 text-sm',
          )}
        />
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
          Escanear
        </button>
      </div>

      {open && (
        // biome-ignore lint/a11y/useSemanticElements: diálogo a pantalla completa propio
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Escanear código de barras o QR"
          className="fixed inset-0 z-50 flex flex-col bg-black"
        >
          <div className="relative flex-1">
            <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 h-40 w-[80%] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border-2 border-white/80"
              aria-hidden
            />
          </div>
          <div className="flex flex-col gap-3 bg-black p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <output aria-live="polite" className="block text-center text-sm text-white">
              {error ?? 'Apunta la cámara al código de barras o QR.'}
            </output>
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
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex min-h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-white text-base font-bold text-black"
              >
                <X className="h-5 w-5" aria-hidden />
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
