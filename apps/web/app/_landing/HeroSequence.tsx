'use client';

import dynamic from 'next/dynamic';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

/**
 * El dueño del pin: la secuencia «el humano toca a la IA → big bang → nace
 * Cortex → el producto», dirigida por el scroll.
 *
 * LA MECÁNICA. Una sección de 350vh cuyo primer hijo es sticky a pantalla
 * completa: el scroll dentro de la sección ES la línea de tiempo. Este
 * componente mide el progreso (0..1), lo escribe en un ref que la escena
 * WebGL (SeqScene) lee cada frame — un número, cero re-layout — y mueve los
 * overlays DOM en el mismo rAF escribiendo estilos directamente (opacidad y
 * transform: compositor, no layout):
 *
 *   0.00–0.30  el titular serif encima, desvaneciéndose al avanzar; la mano
 *              se acerca al núcleo en el canvas.
 *   ~0.30      EL CONTACTO: flash blanco/lavanda + onda de choque (DOM/CSS,
 *              re-disparables), mientras las partículas estallan en el canvas.
 *   0.45–0.75  las partículas convergen en «CORTEX»; debajo aparece el
 *              tagline.
 *   0.75–1.00  entra la ventana viva del producto (LiveDemo) con el copy y
 *              las CTAs: del mito al producto real. Al salir del pin, la
 *              página sigue normal.
 *
 * TRES MODOS, UN SOLO HTML. El servidor renderiza el contenido completo
 * (titular, tagline, copy final, LiveDemo) en flujo normal — ese es el modo
 * `static`: sin JS o con prefers-reduced-motion la página es un hero normal
 * con la conversación del producto terminada y quieta, sin pin ni timeline.
 * Sólo cuando hay JS + movimiento permitido + WebGL, el efecto cambia a
 * `run`: la sección crece a 350vh, los overlays se vuelven capas absolutas y
 * la escena se monta (dynamic import → el GLB y three llegan post-LCP).
 *
 * PERF. El progreso es un número leído en scroll (passive + rAF); el canvas
 * se pausa con visibilitychange y cuando el pin sale del viewport; los
 * overlays cambian por transform/opacity inline — nada que invalide layout.
 */

const SeqScene = dynamic(() => import('./SeqScene'), { ssr: false });

function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext && (probe.getContext('webgl2') || probe.getContext('webgl')),
    );
  } catch {
    return false;
  }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth01 = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

export function HeroSequence({
  intro,
  tagline,
  final,
}: {
  /** Titular serif + lead + CTAs — la fase del alcance y el LCP. */
  intro: ReactNode;
  /** La línea bajo el wordmark cuando se forma. */
  tagline: ReactNode;
  /** El hero definitivo: copy + la ventana viva del producto. */
  final: ReactNode;
}) {
  const [run, setRun] = useState(false);
  const [paused, setPaused] = useState(false);
  const [flashN, setFlashN] = useState(0);
  const [sceneReady, setSceneReady] = useState(false);

  const progressRef = useRef(0);
  const rootRef = useRef<HTMLElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);
  const finalRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const cap1Ref = useRef<HTMLParagraphElement>(null);
  const cap2Ref = useRef<HTMLParagraphElement>(null);
  const flashArmed = useRef(true);

  const handleReady = useCallback(() => setSceneReady(true), []);
  const handleFigureReady = useCallback(() => {}, []);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!webglAvailable()) return;
    setRun(true);
  }, []);

  /* --- El scroll es la línea de tiempo ----------------------------------- */
  useEffect(() => {
    if (!run) return;
    const root = rootRef.current;
    if (!root) return;

    let raf = 0;
    const apply = () => {
      raf = 0;
      const rect = root.getBoundingClientRect();
      const span = rect.height - window.innerHeight;
      const p = span > 0 ? clamp01(-rect.top / span) : 0;
      progressRef.current = p;

      // El flash del contacto: se dispara al cruzar 0.30 subiendo y se
      // rearma sólo si el visitante vuelve claramente atrás.
      if (flashArmed.current && p >= 0.3) {
        flashArmed.current = false;
        setFlashN((n) => n + 1);
      } else if (!flashArmed.current && p < 0.26) {
        flashArmed.current = true;
      }

      // Overlays: estilos inline, transform/opacity — compositor puro.
      const intro = introRef.current;
      if (intro) {
        const k = 1 - smooth01(p / 0.2);
        intro.style.opacity = k.toFixed(3);
        intro.style.transform = `translateY(${(-36 * (1 - k)).toFixed(1)}px)`;
        intro.style.visibility = k <= 0.001 ? 'hidden' : 'visible';
      }
      const hint = hintRef.current;
      if (hint) hint.style.opacity = (1 - smooth01(p / 0.08)).toFixed(3);
      // Los micro-textos de fase, estilo cartela: uno por protagonista.
      const cap1 = cap1Ref.current;
      if (cap1) {
        const k = smooth01((p - 0.15) / 0.05) * (1 - smooth01((p - 0.245) / 0.03));
        cap1.style.opacity = k.toFixed(3);
        cap1.style.transform = `translateY(${(8 * (1 - k)).toFixed(1)}px)`;
      }
      const cap2 = cap2Ref.current;
      if (cap2) {
        const k = smooth01((p - 0.275) / 0.025) * (1 - smooth01((p - 0.42) / 0.04));
        cap2.style.opacity = k.toFixed(3);
        cap2.style.transform = `translateY(${(8 * (1 - k)).toFixed(1)}px)`;
      }
      const tag = tagRef.current;
      if (tag) {
        // Aparece cuando el trazo ya cerró — antes competiría con el enjambre.
        const k = smooth01((p - 0.63) / 0.09) * (1 - smooth01((p - 0.8) / 0.07));
        tag.style.opacity = k.toFixed(3);
        tag.style.transform = `translateY(${(14 * (1 - k)).toFixed(1)}px)`;
        tag.style.visibility = k <= 0.001 ? 'hidden' : 'visible';
      }
      const fin = finalRef.current;
      if (fin) {
        const k = smooth01((p - 0.78) / 0.16);
        fin.style.opacity = k.toFixed(3);
        fin.style.transform = `translateY(${(48 * (1 - k)).toFixed(1)}px)`;
        fin.style.visibility = k <= 0.001 ? 'hidden' : 'visible';
        fin.style.pointerEvents = k > 0.6 ? 'auto' : 'none';
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    apply();
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [run]);

  /* --- Pausa: pestaña oculta o pin fuera de vista ------------------------ */
  useEffect(() => {
    if (!run) return;
    const root = rootRef.current;
    if (!root) return;
    let inView = true;
    const decide = () => setPaused(document.hidden || !inView);
    const io = new IntersectionObserver(
      (entries) => {
        inView = entries.some((e) => e.isIntersecting);
        decide();
      },
      { threshold: 0 },
    );
    io.observe(root);
    document.addEventListener('visibilitychange', decide);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', decide);
    };
  }, [run]);

  return (
    <section ref={rootRef} className={run ? 'lp-seq lp-seq--run' : 'lp-seq'}>
      <div className="lp-seq__pin">
        {run && (
          <div
            className={sceneReady ? 'lp-seq__scene lp-seq__scene--on' : 'lp-seq__scene'}
            aria-hidden="true"
          >
            <SeqScene
              paused={paused}
              progressRef={progressRef}
              onReady={handleReady}
              onFigureReady={handleFigureReady}
            />
          </div>
        )}

        {/* El flash y la onda del contacto. `key` reinicia la animación CSS
            si el visitante vuelve atrás y toca otra vez. La onda es un SVG
            con trazo que no escala (vector-effect): el anillo llena la
            pantalla sin engordar, con frente cian y cola rosa. */}
        {run && flashN > 0 && (
          <div key={flashN} className="lp-seq__bang" aria-hidden="true">
            <div className="lp-seq__flash" />
            <svg
              className="lp-seq__wave"
              viewBox="0 0 100 100"
              aria-hidden="true"
              focusable="false"
            >
              <circle
                cx="50"
                cy="50"
                r="47"
                fill="none"
                stroke="rgb(155 226 255 / 0.9)"
                strokeWidth="1.7"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                stroke="rgb(255 178 214 / 0.6)"
                strokeWidth="1.1"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>
        )}

        {/* Las cartelas: micro-texto mono por fase, un protagonista a la vez. */}
        {run && (
          <>
            <p ref={cap1Ref} className="lp-seq__cap" aria-hidden="true">
              tu empresa, en miles de datos sueltos
            </p>
            <p ref={cap2Ref} className="lp-seq__cap" aria-hidden="true">
              hasta que los tocas
            </p>
          </>
        )}

        <div ref={introRef} className="lp-seq__intro">
          {intro}
        </div>

        {/* Siempre aria-hidden: es la misma promesa que ya dice el titular,
            puesta bajo el wordmark cuando se forma. Leerla dos veces no. */}
        <div ref={tagRef} className="lp-seq__tag" aria-hidden="true">
          {tagline}
        </div>

        <div ref={finalRef} className="lp-seq__final">
          {final}
        </div>

        {run && (
          <div ref={hintRef} className="lp-seq__hint" aria-hidden="true">
            <span>desliza</span>
            <span className="lp-seq__hint-line" />
          </div>
        )}
      </div>
    </section>
  );
}
