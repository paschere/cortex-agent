'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

/**
 * La puerta de entrada al hero cinematográfico — y la que decide cómo corre.
 *
 * La escena (HeroScene) es puro client-side: WebGL, shaders, rAF. Se carga con
 * `next/dynamic({ ssr: false })` y el HTML del hero — el titular, el LCP — no
 * espera ni un byte de three.js: el texto pinta primero y la escena aparece
 * detrás con un fundido cuando su primer frame existe.
 *
 * DECISIONES QUE VIVEN AQUÍ:
 *
 * 1. `prefers-reduced-motion: reduce` → la MISMA composición, congelada. El
 *    canvas se monta, renderiza unos frames con el reloj clavado (la figura,
 *    el núcleo y el río se ven, quietos) y el loop se detiene. Quien pidió
 *    quietud recibe la escena quieta, no un gradiente vacío.
 *
 * 2. Sin WebGL no hay intento: queda el fondo oscuro con sus tintes de luz,
 *    que es el estado de reposo de la misma composición.
 *
 * 3. El momento de respuesta: cuando la entrada del titular termina (la CTA
 *    lleva el delay más largo de `lp-arrive`), el núcleo pulsa una vez y el
 *    destello viaja por el río. Con respaldo por tiempo, porque el dynamic
 *    import compite con esa animación y puede llegar después.
 *
 * 4. El scroll deja el hero atrás con un fade: la opacidad de la escena baja
 *    con el primer viewport de scroll y, cuando ya no se ve, el loop se pausa
 *    (igual que con visibilitychange — una escena que nadie ve no quema
 *    batería).
 */

const HeroScene = dynamic(() => import('./HeroScene'), { ssr: false });

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

export function HeroStage() {
  // null = todavía no se decidió (primer render, también el del servidor).
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pulseSignal, setPulseSignal] = useState(0);
  const pulsed = useRef(false);
  const sceneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
    const decide = () => {
      setEnabled(webglAvailable());
      setFrozen(rm.matches);
    };
    decide();
    rm.addEventListener('change', decide);
    return () => rm.removeEventListener('change', decide);
  }, []);

  // Congelar: con reduced-motion se dejan pasar unos frames (para que la
  // composición quede dibujada) y el loop se apaga del todo.
  useEffect(() => {
    if (!frozen || !ready) return;
    const id = window.setTimeout(() => setPaused(true), 350);
    return () => window.clearTimeout(id);
  }, [frozen, ready]);

  // Pausa: pestaña oculta o hero ya scrolleado fuera de vista.
  const hiddenRef = useRef(false);
  const pastRef = useRef(false);
  useEffect(() => {
    if (frozen) return;
    const apply = () => setPaused(hiddenRef.current || pastRef.current);
    const onVisibility = () => {
      hiddenRef.current = document.hidden;
      apply();
    };
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const h = window.innerHeight || 1;
        const progress = Math.min(1, window.scrollY / h);
        // El fade del hero al quedarse atrás. Inline y sin transición: sigue
        // al scroll sin lag.
        if (sceneRef.current) {
          sceneRef.current.style.opacity = String(Math.max(0, 1 - progress * 1.15));
        }
        pastRef.current = progress >= 1;
        apply();
      });
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [frozen]);

  // El pulso, sincronizado con el final de la entrada del titular.
  useEffect(() => {
    if (!enabled || frozen) return;

    const firePulse = () => {
      if (pulsed.current) return;
      pulsed.current = true;
      setPulseSignal((n) => n + 1);
    };

    const onEnd = (e: AnimationEvent) => {
      if (e.animationName !== 'lp-arrive') return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('.lp-hero__cta')) firePulse();
    };
    document.addEventListener('animationend', onEnd);
    const fallback = window.setTimeout(firePulse, 2000);

    return () => {
      document.removeEventListener('animationend', onEnd);
      window.clearTimeout(fallback);
    };
  }, [enabled, frozen]);

  return (
    <div className={ready ? 'lph-stage lph-stage--on' : 'lph-stage'} aria-hidden="true">
      <div ref={sceneRef} className="lph-stage__scene">
        {enabled ? (
          <HeroScene
            frozen={frozen}
            paused={paused}
            pulseSignal={pulseSignal}
            onReady={() => setReady(true)}
          />
        ) : null}
      </div>
    </div>
  );
}
