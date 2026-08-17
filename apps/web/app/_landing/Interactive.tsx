'use client';

import { useEffect } from 'react';

/**
 * La landing que reacciona — un solo cerebro para toda la página.
 *
 * Este componente no pinta nada: monta UNA maquinaria de atención y la deja
 * gobernando por clases y variables CSS. Cada reacción contesta la misma
 * pregunta — «esto responde a mí» — y ninguna decora porque sí:
 *
 *   REVELADO. Cada sección y cada tarjeta entra al viewport con un settle
 *   corto y escalonado (IntersectionObserver, una sola vez). El HTML del
 *   servidor llega visible; la clase `lp-live` — que es la que esconde para
 *   poder revelar — sólo se agrega aquí, así que sin JS o con
 *   prefers-reduced-motion la página está entera desde el primer frame.
 *
 *   TILT + LINTERNA. Las tarjetas siguen al cursor con una inclinación de
 *   3–5° y un brillo especular que se mueve; el borde se enciende donde está
 *   la mano. La clase `lp-tilt` también se aplica desde aquí (querySelectorAll
 *   sobre `.lp-card` y `.lp-answer`), por la misma razón: es comportamiento,
 *   no contenido.
 *
 *   MAGNETISMO. Los CTA primarios se desplazan unos píxeles hacia el cursor
 *   cuando está cerca y vuelven con un ease elástico al salir.
 *
 *   GLOW AMBIENTAL. El fondo de las secciones lleva una luz radial que sigue
 *   al cursor con retraso — la habitación nota dónde estás, sin un canvas por
 *   sección.
 *
 * PRESUPUESTO. Un solo `pointermove` global; todo lo que ese evento dispara
 * se calcula dentro de UN requestAnimationFrame que sólo corre mientras hay
 * algo que mover (el glow ambiental se persigue con lerp y el loop se apaga
 * solo cuando llega). Los rects de los botones magnéticos se cachean y se
 * invalidan con scroll/resize. `prefers-reduced-motion` apaga TODO esto de
 * raíz: el efecto entero de este componente es un return temprano.
 */

const REVEAL_STAGGER_MS = 80;
const MAGNET_RADIUS = 110;
const MAGNET_SHIFT = 4;

export function Interactive() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const root = document.querySelector('.lp');
    if (!(root instanceof HTMLElement)) return;
    root.classList.add('lp-live');

    const cleanups: Array<() => void> = [];

    /* --- Revelado por scroll, una sola vez ------------------------------ */
    const revealed = new Set<HTMLElement>();
    const collect = (): HTMLElement[] => {
      const els: HTMLElement[] = [];
      for (const el of root.querySelectorAll<HTMLElement>('[data-reveal]')) els.push(el);
      for (const group of root.querySelectorAll<HTMLElement>('[data-reveal-group]')) {
        let i = 0;
        for (const child of group.children) {
          if (!(child instanceof HTMLElement)) continue;
          child.setAttribute('data-reveal', '');
          child.style.setProperty('--rv-d', `${i * REVEAL_STAGGER_MS}ms`);
          els.push(child);
          i += 1;
        }
      }
      return els;
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          el.classList.add('is-in');
          revealed.add(el);
          io.unobserve(el);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    for (const el of collect()) io.observe(el);
    cleanups.push(() => io.disconnect());

    /* --- Tarjetas interactivas (tilt + linterna) ------------------------ */
    for (const card of root.querySelectorAll<HTMLElement>(
      '.lp-card, .lp-answer, .lp-cost__item, .lp-story__panel, .lp-wa__phone, .lp-ledger__panel',
    )) {
      card.classList.add('lp-tilt');
    }

    let tiltEl: HTMLElement | null = null;
    const clearTilt = () => {
      if (!tiltEl) return;
      tiltEl.classList.remove('is-tilt');
      tiltEl.style.removeProperty('--rx');
      tiltEl.style.removeProperty('--ry');
      tiltEl = null;
    };
    const onOver = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>('.lp-tilt') : null;
      if (target === tiltEl) return;
      clearTilt();
      if (target) {
        tiltEl = target;
        target.classList.add('is-tilt');
      }
    };
    root.addEventListener('pointerover', onOver, { passive: true });
    cleanups.push(() => root.removeEventListener('pointerover', onOver));

    /* --- Botones magnéticos --------------------------------------------- */
    const magnets = Array.from(root.querySelectorAll<HTMLElement>('.lp-btn--primary'));
    let magnetRects: Array<{ el: HTMLElement; cx: number; cy: number }> | null = null;
    const invalidateRects = () => {
      magnetRects = null;
    };
    window.addEventListener('scroll', invalidateRects, { passive: true });
    window.addEventListener('resize', invalidateRects, { passive: true });
    cleanups.push(() => {
      window.removeEventListener('scroll', invalidateRects);
      window.removeEventListener('resize', invalidateRects);
    });

    /* --- El frame: todo el trabajo del puntero pasa por aquí ------------ */
    const after = root.querySelector<HTMLElement>('.lp-after');
    let px = -1e4;
    let py = -1e4;
    let ambX = 0;
    let ambY = -1e4;
    let raf = 0;

    const frame = () => {
      raf = 0;
      let settled = true;

      // Tilt + brillo especular + linterna del elemento bajo el cursor.
      if (tiltEl) {
        const r = tiltEl.getBoundingClientRect();
        if (r.width > 0) {
          const nx = (px - r.left) / r.width - 0.5;
          const ny = (py - r.top) / r.height - 0.5;
          const max = r.width > 560 ? 3 : 5; // tarjetas anchas se inclinan menos
          tiltEl.style.setProperty('--ry', `${(nx * max * 2).toFixed(2)}deg`);
          tiltEl.style.setProperty('--rx', `${(-ny * max * 2).toFixed(2)}deg`);
          tiltEl.style.setProperty('--lx', `${(((px - r.left) / r.width) * 100).toFixed(1)}%`);
          tiltEl.style.setProperty('--ly', `${(((py - r.top) / r.height) * 100).toFixed(1)}%`);
        }
      }

      // Magnetismo de los CTA.
      if (!magnetRects) {
        magnetRects = magnets.map((el) => {
          const r = el.getBoundingClientRect();
          return { el, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        });
      }
      for (const m of magnetRects) {
        const dx = px - m.cx;
        const dy = py - m.cy;
        const d = Math.hypot(dx, dy);
        if (d < MAGNET_RADIUS) {
          const pull = (1 - d / MAGNET_RADIUS) * MAGNET_SHIFT;
          m.el.classList.add('is-near');
          m.el.style.setProperty('--mx', `${((dx / (d || 1)) * pull).toFixed(2)}px`);
          m.el.style.setProperty('--my', `${((dy / (d || 1)) * pull).toFixed(2)}px`);
        } else if (m.el.classList.contains('is-near')) {
          m.el.classList.remove('is-near');
          m.el.style.removeProperty('--mx');
          m.el.style.removeProperty('--my');
        }
      }

      // Glow ambiental: persigue al cursor con retraso dentro de .lp-after.
      if (after) {
        const ar = after.getBoundingClientRect();
        const tx = px - ar.left;
        const ty = py - ar.top;
        ambX += (tx - ambX) * 0.08;
        ambY += (ty - ambY) * 0.08;
        if (Math.abs(tx - ambX) > 0.5 || Math.abs(ty - ambY) > 0.5) settled = false;
        after.style.setProperty('--amb-x', `${ambX.toFixed(1)}px`);
        after.style.setProperty('--amb-y', `${ambY.toFixed(1)}px`);
      }

      // El loop sólo sigue vivo mientras algo se está moviendo solo.
      if (!settled) raf = requestAnimationFrame(frame);
    };

    const onMove = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      if (ambY < -1e3 && after) {
        // Primer movimiento: el glow nace donde está la mano, no cruza la página.
        const ar = after.getBoundingClientRect();
        ambX = px - ar.left;
        ambY = py - ar.top;
      }
      if (!raf) raf = requestAnimationFrame(frame);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    cleanups.push(() => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    });

    return () => {
      for (const fn of cleanups) fn();
      clearTilt();
      root.classList.remove('lp-live');
    };
  }, []);

  return null;
}
