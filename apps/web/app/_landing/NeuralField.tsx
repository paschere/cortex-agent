'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

/**
 * La puerta de entrada a la escena de fondo — y la que decide si se abre.
 *
 * El organismo de partículas (NeuralScene) es puro client-side: WebGL, shaders,
 * requestAnimationFrame. Nada de eso puede tocar el servidor, así que se carga
 * con `next/dynamic({ ssr: false })` y el HTML de la landing — el LCP, el texto
 * indexable — no espera ni un byte de three.js.
 *
 * TRES DECISIONES VIVEN AQUÍ Y NO EN LA ESCENA:
 *
 * 1. `prefers-reduced-motion: reduce` → el canvas NO se monta. Es la regla dura
 *    del design system: el movimiento existe para contestar preguntas, y quien
 *    pidió quietud recibe quietud, no una animación "suave". El fondo estático
 *    (.lp-field, un gradiente indigo equivalente en reposo) se pinta siempre
 *    debajo, así que sin canvas la página queda terminada, no rota. Si la
 *    preferencia cambia en vivo, el canvas se desmonta en ese momento.
 *
 * 2. Sin WebGL no hay intento: se prueba el contexto una vez y, si falla, queda
 *    el mismo gradiente. Ningún error en consola, ninguna pantalla negra.
 *
 * 3. El momento de respuesta se sincroniza aquí porque aquí se ve el DOM de la
 *    landing: cuando la última pieza del hero termina su entrada (`lp-arrive`
 *    sobre `.lp-hero__cta`, la de mayor delay), la escena pulsa UNA vez. Como
 *    la escena llega por dynamic import y puede montarse después de que esa
 *    animación ya pasó, hay un respaldo por tiempo — el pulso ocurre igual,
 *    nunca dos veces.
 */

const NeuralScene = dynamic(() => import('./NeuralScene'), { ssr: false });

function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (probe.getContext('webgl2') || probe.getContext('webgl')),
    );
  } catch {
    return false;
  }
}

export function NeuralField() {
  // null = todavía no se decidió (primer render, también el del servidor).
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [pulseSignal, setPulseSignal] = useState(0);
  const pulsed = useRef(false);

  useEffect(() => {
    const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
    const decide = () => setEnabled(!rm.matches && webglAvailable());
    decide();
    rm.addEventListener('change', decide);
    return () => rm.removeEventListener('change', decide);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const firePulse = () => {
      if (pulsed.current) return;
      pulsed.current = true;
      setPulseSignal((n) => n + 1);
    };

    // La señal honesta: el `animationend` de la entrada del hero. La CTA lleva
    // el delay más largo (0.15s), así que su final es "el texto ya terminó".
    const onEnd = (e: AnimationEvent) => {
      if (e.animationName !== 'lp-arrive') return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('.lp-hero__cta')) firePulse();
    };
    document.addEventListener('animationend', onEnd);

    // El respaldo: si la escena se montó después de esa animación (el dynamic
    // import compite con 0.7s de entrada), el evento ya pasó y no va a volver.
    const fallback = window.setTimeout(firePulse, 1800);

    return () => {
      document.removeEventListener('animationend', onEnd);
      window.clearTimeout(fallback);
    };
  }, [enabled]);

  return (
    <div className={ready ? 'lp-field lp-field--on' : 'lp-field'} aria-hidden="true">
      {enabled ? (
        <NeuralScene pulseSignal={pulseSignal} onReady={() => setReady(true)} />
      ) : null}
    </div>
  );
}
