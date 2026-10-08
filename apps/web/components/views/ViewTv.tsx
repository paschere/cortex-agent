'use client';

import type { ComputedBlock, ComputedView } from '@cortex/agent-tools';
import { tvClock, tvSecondsLeft, tvSlideAt, tvSlides } from '@cortex/agent-tools/src/views/tv';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from './blocks/theme';

/**
 * EL TABLERO TV: UNA PANTALLA DE PARED.
 *
 * `spec.theme.layout: 'tv'`. Texto grande, panel oscuro de alto contraste
 * (las clases `view-tv` de views.css agrandan la escala tipográfica), reloj de
 * Bogotá, y una sección a la vez que rota sola cada `rotateSeconds`. Las
 * secciones y la aritmética de cuál toca salen de `tvSlides` / `tvSlideAt`
 * (probadas sin React): aquí sólo hay un reloj de un segundo que las lee.
 *
 * Se refresca con el resto de la vista (LiveViewCanvas, como mucho cada 30 s)
 * y no escribe nada: nadie toca una pantalla de pared. «Pantalla completa»
 * usa la API del navegador sobre este mismo contenedor; en una TV con un
 * navegador sin ella, el panel igual ocupa casi toda la ventana.
 * Pausar deja la sección actual (para leer algo con calma); las flechas pasan
 * de una en una.
 */

export function TvBoard({
  view,
  renderBlock,
}: {
  view: ComputedView;
  renderBlock: (block: ComputedBlock) => React.ReactNode;
}) {
  const tv = view.theme?.tv ?? { rotateSeconds: 15, clock: true };
  const slides = useMemo(() => tvSlides(view.blocks, view.pages), [view.blocks, view.pages]);
  const root = useRef<HTMLDivElement>(null);
  const start = useRef(Date.now());
  const [now, setNow] = useState(() => new Date());
  const [paused, setPaused] = useState(false);
  // Al pausar o navegar a mano se fija una sección; al reanudar, el reloj sigue desde ahí.
  const [offset, setOffset] = useState(0);
  const [pinned, setPinned] = useState<number | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const elapsed = now.getTime() - start.current;
  const auto =
    (tvSlideAt(slides.length, elapsed, tv.rotateSeconds) + offset) % (slides.length || 1);
  const index = pinned ?? auto;
  const slide = slides[index];
  const left = tvSecondsLeft(elapsed, tv.rotateSeconds);

  const go = useCallback(
    (delta: number) => {
      if (!slides.length) return;
      setPinned((((index + delta) % slides.length) + slides.length) % slides.length);
      setPaused(true);
    },
    [index, slides.length],
  );
  const togglePause = () => {
    if (paused) {
      // Reanuda desde la sección en que quedó.
      if (pinned !== null) {
        const natural = tvSlideAt(slides.length, elapsed, tv.rotateSeconds);
        setOffset((pinned - natural + slides.length) % slides.length);
      }
      setPinned(null);
      setPaused(false);
    } else {
      setPinned(index);
      setPaused(true);
    }
  };
  const toggleFull = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await root.current?.requestFullscreen();
    } catch {
      /* Sin pantalla completa: el panel sigue ocupando la ventana. */
    }
  };

  const clock = tvClock(now);
  const blocks = (slide?.blockIds ?? [])
    .map((id) => view.blocks.find((b) => b.id === id))
    .filter((b): b is ComputedBlock => Boolean(b));
  const metrics = blocks.length > 0 && blocks.every((b) => b.type === 'metric');

  return (
    <div
      ref={root}
      data-view-tv
      className={clsx(
        'view-tv flex flex-col bg-canvas text-ink',
        full ? 'fixed inset-0 z-50 overflow-auto p-6' : 'min-h-[70dvh] rounded-card p-4 sm:p-6',
      )}
    >
      <header className="mb-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-extrabold tracking-tight text-ink">
            {slide?.title ?? 'Tablero'}
          </h2>
          <p className="text-micro text-ink-faint">
            Datos de las{' '}
            <span className="tabular font-mono">
              {new Intl.DateTimeFormat('es-CO', {
                timeZone: 'America/Bogota',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
              }).format(new Date(view.computedAt))}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-4">
          {tv.clock && (
            <div className="text-right leading-tight">
              <p className="tabular font-mono text-xl font-extrabold text-ink">{clock.time}</p>
              <p className="text-micro text-ink-muted first-letter:uppercase">{clock.date}</p>
            </div>
          )}
          <div className="view-no-print flex items-center gap-1">
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Sección anterior"
              className="grid h-10 w-10 place-items-center rounded-pill border border-border text-ink-muted transition-colors hover:text-ink"
            >
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={togglePause}
              aria-label={paused ? 'Reanudar la rotación' : 'Pausar la rotación'}
              aria-pressed={paused}
              className="grid h-10 w-10 place-items-center rounded-pill border border-border text-ink-muted transition-colors hover:text-ink"
            >
              {paused ? (
                <Play className="h-5 w-5" aria-hidden />
              ) : (
                <Pause className="h-5 w-5" aria-hidden />
              )}
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Sección siguiente"
              className="grid h-10 w-10 place-items-center rounded-pill border border-border text-ink-muted transition-colors hover:text-ink"
            >
              <ChevronRight className="h-5 w-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => void toggleFull()}
              aria-label={full ? 'Salir de pantalla completa' : 'Pantalla completa'}
              className="grid h-10 w-10 place-items-center rounded-pill border border-border text-ink-muted transition-colors hover:text-ink"
            >
              {full ? (
                <Minimize2 className="h-5 w-5" aria-hidden />
              ) : (
                <Maximize2 className="h-5 w-5" aria-hidden />
              )}
            </button>
          </div>
        </div>
      </header>

      {slides.length > 1 && (
        <div className="mb-5 flex items-center gap-1.5" aria-hidden>
          {slides.map((s, i) => (
            <span
              key={s.id}
              className="relative h-1.5 flex-1 overflow-hidden rounded-pill bg-surface-2"
            >
              <span
                className={clsx(
                  'absolute inset-y-0 left-0 rounded-pill bg-primary transition-[width] duration-1000 ease-linear',
                  i < index ? 'w-full' : i === index ? '' : 'w-0',
                )}
                style={
                  i === index
                    ? {
                        width: paused
                          ? '100%'
                          : `${Math.round(((tv.rotateSeconds - left + 1) / tv.rotateSeconds) * 100)}%`,
                      }
                    : undefined
                }
              />
            </span>
          ))}
        </div>
      )}

      <div
        key={slide?.id}
        className={clsx(
          'grid flex-1 content-start gap-4 animate-veil',
          metrics ? 'grid-cols-2 xl:grid-cols-4' : 'grid-cols-1',
        )}
      >
        {blocks.length === 0 ? (
          <EmptyState title="Esta pantalla todavía no tiene nada que mostrar" />
        ) : (
          blocks.map((b) => (
            <section key={b.id} className="view-block min-w-0">
              {renderBlock(b)}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
