'use client';

import { Children, type ReactNode, useEffect, useRef } from 'react';

/**
 * La narrativa con scroll de «Cómo funciona».
 *
 * El contenido llega del servidor como children (los pasos y el visual son
 * RSC: este archivo sólo aporta la maquinaria, no el texto — así el JS
 * inicial de `/` no carga con prosa). En escritorio los pasos se recorren en
 * una columna mientras un visual FIJO (sticky) cambia de estado; el estado
 * activo lo decide un IntersectionObserver con una franja central angosta,
 * y viaja como `data-step` en el contenedor — todo lo demás es CSS.
 *
 * Con prefers-reduced-motion o en pantallas angostas NO hay scrolly: el CSS
 * (landing.css) apaga el sticky y muestra los pasos como lista estática de
 * tarjetas, sin depender de este efecto. Quien pidió quietud recibe la lista.
 */
export function ScrollStory({ steps, visual }: { steps: ReactNode; visual: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const els = Array.from(root.querySelectorAll<HTMLElement>('.lp-story__step'));
    if (els.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = els.indexOf(e.target as HTMLElement);
          if (i < 0) continue;
          root.dataset.step = String(i);
          for (let j = 0; j < els.length; j++) {
            els[j]?.classList.toggle('is-active', j === i);
          }
        }
      },
      // La franja central: un paso es «el paso» cuando cruza el medio de la
      // ventana, no cuando asoma por el borde.
      { rootMargin: '-42% 0px -42% 0px', threshold: 0 },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="lp-story" data-step="0">
      <div className="lp-story__steps">
        {Children.map(steps, (step, i) => (
          <div className={i === 0 ? 'lp-story__step is-active' : 'lp-story__step'}>{step}</div>
        ))}
      </div>
      <div className="lp-story__side">{visual}</div>
    </div>
  );
}
