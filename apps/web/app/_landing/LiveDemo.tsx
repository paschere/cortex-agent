'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * La ventana viva del hero: el producto, usándose solo.
 *
 * Esto reemplaza a la escena de partículas por la única cosa que una landing
 * cara enseña de verdad: el producto. Es una recreación fiel del chat de
 * Cortex — la pregunta como burbuja, los pasos como renglones con su check,
 * la respuesta en prosa y los chips de cita debajo (el mismo lenguaje visual
 * de components/chat: TaskRows, MessageBubble, BrainSources) — dentro de un
 * marco de vidrio con tilt 3D sutil que sigue al cursor.
 *
 * TODO ES GUION. Cero red, cero modelo: tres escenarios escritos a mano con
 * el mismo estándar del copy de industries.ts (preguntas de pyme colombiana
 * en minúscula e impaciente, cifras en pesos, procedencia con documento, día
 * y minuto). La conversación se escribe sola en loop:
 *
 *   teclea la pregunta → shimmer de «pensando» → corren las herramientas en
 *   cascada → la respuesta fluye por palabras → aparecen las citas → pausa
 *   de lectura → siguiente escenario.
 *
 * Los tabs saltan a un escenario y el loop continúa desde ahí. Pasar el
 * cursor por un chip de cita resalta la fila de herramienta de la que salió
 * ese dato — la tesis del producto (cada afirmación tiene fuente) vuelta
 * microinteracción.
 *
 * REDUCED-MOTION / SIN JS. El servidor renderiza el primer escenario COMPLETO
 * y estático — ese es también el estado inicial de React, así que la
 * hidratación no corrige nada. Con prefers-reduced-motion la animación jamás
 * arranca: quedan los tabs funcionales (click cambia el escenario, completo y
 * quieto) y cero tilt. Quien pidió quietud recibe la conversación terminada,
 * no una a medio teclear.
 *
 * PERF. DOM + CSS + timeouts. El guion se pausa cuando la pestaña está
 * oculta o la ventana ya no se ve (IntersectionObserver), y el tilt es un
 * solo pointermove con rAF. Nada de canvas, nada de three.
 */

interface DemoTool {
  /** Qué está consultando, en palabras de persona. */
  name: string;
  /** El argumento —la placa, la cláusula, el minuto— en mono, como evidencia. */
  arg: string;
  /** Duración «medida», como la enseña TaskRows cuando el paso termina. */
  ms: string;
}

interface DemoCite {
  label: string;
  /** Índice de la herramienta de la que salió este dato (hover → resalta). */
  tool: number;
}

interface DemoScenario {
  id: string;
  tab: string;
  /** La etiqueta pequeña de la barra de la ventana. */
  tag: string;
  q: string;
  /** El veredicto, primero y en negrita — así contesta Cortex. */
  lead: string;
  rest: string;
  tools: DemoTool[];
  cites: DemoCite[];
}

/**
 * Los tres escenarios. El primero recicla el caso RUNT/WGY482 que ya vivía en
 * la tarjeta demo; los otros dos siguen sus mismas reglas: nada que el
 * producto no haga, cifras que cuadran, procedencia real.
 */
const SCENARIOS: readonly [DemoScenario, ...DemoScenario[]] = [
  {
    id: 'logistica',
    tab: 'Logística',
    tag: 'logística y aduanas',
    q: '¿el WGY482 puede salir mañana?',
    lead: 'El vehículo sí; el conductor asignado no.',
    rest: 'La licencia C2 de quien está programado figura vencida en el RUNT desde el 22 de julio; el SOAT y la RTM del tractocamión están vigentes. Y si lo despachas el viernes, el cliente no recibe sábados: descargaría el lunes.',
    tools: [
      { name: 'Consultando RUNT', arg: 'WGY482', ms: '1,8s' },
      { name: 'Contrato marco', arg: 'cláusula 9', ms: '0,6s' },
      { name: 'Llamada del jueves', arg: 'min 12:04', ms: '0,9s' },
    ],
    cites: [
      { label: 'RUNT · 08 ago 07:41', tool: 0 },
      { label: 'Contrato marco · cláusula 9', tool: 1 },
      { label: 'Llamada · 31 jul · min 12:04', tool: 2 },
    ],
  },
  {
    id: 'cartera',
    tab: 'Cartera',
    tag: 'cartera y facturación',
    q: '¿quién nos debe plata y hace cuánto?',
    lead: 'Tres clientes suman $23.700.000 vencidos.',
    rest: 'El más viejo: la FV-2214 por $6.900.000, con 43 días — el cliente pidió cruzarla contra el anticipo de junio antes de girar. Las otras dos suman $16.800.000 y llevan menos de 15 días. Si quieres, te dejo listo el recordatorio: no sale sin tu aprobación.',
    tools: [
      { name: 'Facturas pendientes', arg: '3 clientes', ms: '1,2s' },
      { name: 'Correo del cliente', arg: '29 jul 16:12', ms: '0,7s' },
      { name: 'Reunión de cierre', arg: 'min 08:41', ms: '0,8s' },
    ],
    cites: [
      { label: 'Factura FV-2214 · 05 jul', tool: 0 },
      { label: 'Correo del cliente · 29 jul', tool: 1 },
      { label: 'Reunión de cierre · min 08:41', tool: 2 },
    ],
  },
  {
    id: 'nomina',
    tab: 'Nómina',
    tag: 'nómina y personal',
    q: '¿cuánto nos cuesta al mes un auxiliar con básico de $1.800.000?',
    lead: 'Cerca de $2.725.000 al mes — un 51% más que el básico.',
    rest: 'Al básico de $1.800.000 se suman $200.000 de auxilio de transporte, $428.000 de prestaciones (prima, cesantías, intereses y vacaciones) y $297.000 de aportes del empleador: pensión, ARL y caja. Te dejo la cifra desglosada para que la confirmes antes de pasarla a la oferta.',
    tools: [
      { name: 'Nómina', arg: 'auxiliar de bodega', ms: '1,1s' },
      { name: 'Aportes del empleador', arg: 'año 2025', ms: '0,5s' },
      { name: 'Auxilio de transporte', arg: '$200.000', ms: '0,4s' },
    ],
    cites: [
      { label: 'Nómina · básico $1.800.000', tool: 0 },
      { label: 'Aportes 2025 · pensión, ARL, caja', tool: 1 },
      { label: 'Auxilio de transporte · $200.000', tool: 2 },
    ],
  },
];

type Phase = 'typing' | 'thinking' | 'tools' | 'answer' | 'cites' | 'rest';

/** Cuánto de la conversación está dibujado. La vista es una función de esto. */
interface View {
  phase: Phase;
  /** Caracteres tecleados de la pregunta. */
  q: number;
  /** Filas de herramienta visibles / ya con check. */
  toolsIn: number;
  toolsDone: number;
  /** Palabras de la respuesta ya en pantalla. */
  words: number;
  /** Chips de cita visibles. */
  cites: number;
}

function fullView(s: DemoScenario): View {
  return {
    phase: 'rest',
    q: s.q.length,
    toolsIn: s.tools.length,
    toolsDone: s.tools.length,
    words: countWords(s),
    cites: s.cites.length,
  };
}

function countWords(s: DemoScenario): number {
  return s.lead.split(' ').length + s.rest.split(' ').length;
}

/** Check pequeño, dibujado inline — el mismo gesto del Check de TaskRows. */
function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" className="lpd-check" aria-hidden="true" focusable="false">
      <path
        d="M2.2 6.6 4.9 9.2 9.8 3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LiveDemo() {
  // run.n distingue «mismo escenario, otra pasada»: cada click y cada vuelta
  // del loop reinician el guion aunque el índice se repita.
  const [run, setRun] = useState({ si: 0, n: 0 });
  const scenario = SCENARIOS[run.si % SCENARIOS.length] ?? SCENARIOS[0];

  // El estado inicial es el primer escenario TERMINADO: es lo que renderiza
  // el servidor (SEO, no-JS, LCP) y lo que se queda con reduced-motion.
  const [view, setView] = useState<View>(() => fullView(SCENARIOS[0]));
  const [hotTool, setHotTool] = useState<number | null>(null);

  const reducedRef = useRef(false);
  const visibleRef = useRef(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  /* --- El guion ---------------------------------------------------------- */
  useEffect(() => {
    const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedRef.current = rm.matches;

    const s = SCENARIOS[run.si % SCENARIOS.length] ?? SCENARIOS[0];

    if (rm.matches) {
      // Quietud: el escenario pedido, completo, sin teclear nada.
      setView(fullView(s));
      return;
    }

    let alive = true;
    let timer = 0;
    const rawSleep = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, ms);
      });
    // Antes de cada paso: si la pestaña está oculta o la ventana ya no se ve,
    // el guion espera. Una conversación que nadie mira no gasta nada.
    const sleep = async (ms: number) => {
      await rawSleep(ms);
      while (alive && (document.hidden || !visibleRef.current)) await rawSleep(400);
    };

    const totalWords = countWords(s);

    (async () => {
      setView({ phase: 'typing', q: 0, toolsIn: 0, toolsDone: 0, words: 0, cites: 0 });
      await sleep(600);
      for (let i = 1; i <= s.q.length; i++) {
        if (!alive) return;
        setView((v) => ({ ...v, q: i }));
        await sleep(34);
      }
      await sleep(320);
      if (!alive) return;
      setView((v) => ({ ...v, phase: 'thinking' }));
      await sleep(1050);

      if (!alive) return;
      setView((v) => ({ ...v, phase: 'tools' }));
      for (let t = 0; t < s.tools.length; t++) {
        if (!alive) return;
        setView((v) => ({ ...v, toolsIn: t + 1 }));
        await sleep(520);
        if (!alive) return;
        setView((v) => ({ ...v, toolsDone: t + 1 }));
        await sleep(240);
      }
      await sleep(260);

      if (!alive) return;
      setView((v) => ({ ...v, phase: 'answer' }));
      for (let w = 1; w <= totalWords; w++) {
        if (!alive) return;
        setView((v) => ({ ...v, words: w }));
        await sleep(46);
      }
      await sleep(240);

      if (!alive) return;
      setView((v) => ({ ...v, phase: 'cites' }));
      for (let c = 1; c <= s.cites.length; c++) {
        if (!alive) return;
        setView((v) => ({ ...v, cites: c }));
        await sleep(170);
      }

      if (!alive) return;
      setView((v) => ({ ...v, phase: 'rest' }));
      // La pausa de lectura, y a la siguiente escena.
      await sleep(4200);
      if (!alive) return;
      setRun((r) => ({ si: (r.si + 1) % SCENARIOS.length, n: r.n + 1 }));
    })();

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [run]);

  /* --- Pausa cuando la ventana no se ve ---------------------------------- */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        visibleRef.current = entries.some((e) => e.isIntersecting);
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* --- Tilt 3D sutil (el patrón de Interactive, local) -------------------- */
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.matchMedia('(pointer: coarse)').matches) return;
    const box = rootRef.current;
    const frame = frameRef.current;
    if (!box || !frame) return;

    let raf = 0;
    let px = 0;
    let py = 0;
    const apply = () => {
      raf = 0;
      const r = box.getBoundingClientRect();
      if (r.width === 0) return;
      const nx = (px - r.left) / r.width - 0.5;
      const ny = (py - r.top) / r.height - 0.5;
      frame.style.setProperty('--ty', `${(nx * 5).toFixed(2)}deg`);
      frame.style.setProperty('--tx', `${(-ny * 5).toFixed(2)}deg`);
    };
    const onMove = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      frame.classList.add('is-tilt');
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onLeave = () => {
      frame.classList.remove('is-tilt');
      frame.style.removeProperty('--tx');
      frame.style.removeProperty('--ty');
    };
    box.addEventListener('pointermove', onMove, { passive: true });
    box.addEventListener('pointerleave', onLeave, { passive: true });
    return () => {
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerleave', onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /* --- La vista, derivada del guion --------------------------------------- */
  const leadWords = scenario.lead.split(' ');
  const restWords = scenario.rest.split(' ');
  const leadShown = leadWords.slice(0, Math.min(view.words, leadWords.length)).join(' ');
  const restShown = restWords.slice(0, Math.max(0, view.words - leadWords.length)).join(' ');
  const typedQ = scenario.q.slice(0, view.q);
  const answering = view.words > 0 && view.phase === 'answer';

  return (
    <div className="lpd" ref={rootRef}>
      <div className="lpd-tabs" role="tablist" aria-label="Escenarios de ejemplo">
        {SCENARIOS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={i === run.si % SCENARIOS.length}
            className="lpd-tab"
            onClick={() => setRun((r) => ({ si: i, n: r.n + 1 }))}
          >
            {s.tab}
          </button>
        ))}
      </div>

      <div className="lpd-frame" ref={frameRef}>
        <div className="lpd-win">
          <div className="lpd-bar">
            <span aria-hidden className="lpd-pip" />
            <span className="lpd-who">Cortex</span>
            <span className="lpd-tag lp-data">{scenario.tag}</span>
          </div>

          <div className="lpd-body">
            {view.q > 0 && (
              <div className="lpd-q">
                {typedQ}
                {view.phase === 'typing' && <span aria-hidden className="lpd-caret" />}
              </div>
            )}

            {view.phase === 'thinking' && (
              <p className="lpd-think">
                <span className="lpd-think__label">Pensando…</span>
              </p>
            )}

            {view.toolsIn > 0 && (
              <ul className="lpd-tools">
                {scenario.tools.slice(0, view.toolsIn).map((t, i) => {
                  const done = i < view.toolsDone;
                  return (
                    <li key={t.name} className={hotTool === i ? 'lpd-tool is-hot' : 'lpd-tool'}>
                      <span aria-hidden className="lpd-tool__icon">
                        {done ? <CheckIcon /> : <span className="lpd-spin" />}
                      </span>
                      <span className="lpd-tool__name">{t.name}</span>
                      <span className="lpd-tool__arg lp-data">{t.arg}</span>
                      {done && <span className="lpd-tool__ms lp-data">{t.ms}</span>}
                    </li>
                  );
                })}
              </ul>
            )}

            {view.words > 0 && (
              <p className="lpd-a">
                <strong>{leadShown}</strong>
                {restShown && ' '}
                {restShown}
                {answering && <span aria-hidden className="lpd-caret lpd-caret--a" />}
              </p>
            )}

            {view.cites > 0 && (
              <div className="lpd-cites">
                <p className="lpd-cites__label">De dónde salió</p>
                <div className="lpd-cites__row">
                  {scenario.cites.slice(0, view.cites).map((c) => (
                    <button
                      key={c.label}
                      type="button"
                      className="lpd-cite"
                      onMouseEnter={() => setHotTool(c.tool)}
                      onMouseLeave={() => setHotTool(null)}
                      onFocus={() => setHotTool(c.tool)}
                      onBlur={() => setHotTool(null)}
                    >
                      <span className="lpd-cite__src">{c.label.split(' · ')[0]}</span>
                      <span aria-hidden className="lpd-cite__dot">
                        ·
                      </span>
                      <span className="lp-data">{c.label.split(' · ').slice(1).join(' · ')}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
