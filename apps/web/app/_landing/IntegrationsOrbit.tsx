'use client';

import { type CSSProperties, type FocusEvent, type PointerEvent, useState } from 'react';

/**
 * «Conectado a todo lo tuyo» — las integraciones reales orbitando la marca,
 * con hilos de luz que pulsan HACIA el centro. Eco pequeño del lenguaje del
 * hero, pero sin canvas: DOM + CSS puros.
 *
 * LA GEOMETRÍA. Dos anillos concéntricos que rotan a velocidades distintas
 * (el exterior en sentido contrario); cada nodo se planta con
 * `rotate(--a) translateY(-r)` y su chip contra-rota con un keyframe que lee
 * la misma variable, así el NOMBRE — texto en mono, nada de logos de
 * terceros — queda siempre derecho. El hilo es un div de 1px con un
 * degradado repetido cuyo background-position viaja hacia el centro: el
 * pulso, sin SVG y sin JS por frame.
 *
 * INTERACCIÓN. Hover o foco sobre la órbita la pausa (animation-play-state,
 * en CSS); el nodo activo se enciende junto con su hilo, y su micro-copy
 * aparece en la leyenda de abajo (aria-live) — un tooltip que no hay que
 * perseguir en un elemento que gira. DOS listeners delegados en el
 * contenedor, no uno por chip. En pantallas angostas la órbita se compacta a
 * una grilla de chips (CSS, mismo DOM). Con reduced-motion la regla global
 * congela rotación y pulso: constelación quieta, todo legible.
 */

interface OrbitNode {
  name: string;
  tip: string;
}

/** Anillo interior: los canales de todos los días. */
const RING_A: OrbitNode[] = [
  { name: 'Gmail', tip: 'Lee y redacta; enviar espera tu aprobación.' },
  { name: 'Google Drive', tip: 'Se revisa cada 10 minutos; lo nuevo entra solo.' },
  { name: 'WhatsApp', tip: 'Contesta en los grupos que habilites, nunca en todos.' },
  { name: 'Calendar', tip: 'Prepara el briefing antes de cada reunión.' },
  { name: 'Outlook', tip: 'El correo de Microsoft 365, leído igual que Gmail.' },
];

/** Anillo exterior: las herramientas del oficio. */
const RING_B: OrbitNode[] = [
  { name: 'HubSpot', tip: 'Cruza contactos, negocios y actividad del CRM.' },
  { name: 'Linear', tip: 'Crea y consulta issues sin salir del chat.' },
  { name: 'GitHub', tip: 'Actividad de repos, PRs e issues, con cifras.' },
  { name: 'Slack', tip: 'Publica donde el equipo ya conversa.' },
  { name: 'RUNT', tip: 'SOAT, RTM y licencias, por placa.' },
  { name: 'SIMIT', tip: 'Comparendos y multas, al día.' },
];

const DEFAULT_TIP = '11 fuentes hoy — pasa por una para ver qué hace.';

function nodeStyle(i: number, count: number, offset: number): CSSProperties {
  return { '--a': `${offset + (360 / count) * i}deg` } as CSSProperties;
}

function Ring({
  nodes,
  variant,
  offset,
}: { nodes: OrbitNode[]; variant: 'a' | 'b'; offset: number }) {
  return (
    <div className={`lp-orbit__ring lp-orbit__ring--${variant}`}>
      {nodes.map((n, i) => (
        <div key={n.name} className="lp-orbit__node" style={nodeStyle(i, nodes.length, offset)}>
          <span aria-hidden className="lp-orbit__thread" />
          <button type="button" className="lp-orbit__chip" data-tip={n.tip} title={n.tip}>
            {n.name}
          </button>
        </div>
      ))}
    </div>
  );
}

export function IntegrationsOrbit() {
  const [tip, setTip] = useState<string | null>(null);

  const pick = (target: EventTarget | null) => {
    const chip = target instanceof Element ? target.closest<HTMLElement>('.lp-orbit__chip') : null;
    setTip(chip?.dataset.tip ?? null);
  };

  const onOver = (e: PointerEvent) => pick(e.target);
  const onFocus = (e: FocusEvent) => pick(e.target);

  return (
    <section className="lp-section" id="integraciones">
      <div className="lp-wrap">
        <div className="lp-head" data-reveal>
          <p className="lp-marker">Conectado a todo lo tuyo</p>
          <h2 className="lp-h2">
            Una sola memoria, <em>conectada a donde ya está todo</em>.
          </h2>
          <p className="lp-lead">
            Once fuentes hoy, del correo al RUNT. Cada una entra con los permisos de quien la
            conecta, y cada dato que sale de ellas llega con su cita. No hay que subir nada: Cortex
            va a donde ya está.
          </p>
        </div>

        <div className="lp-orbit-wrap" data-reveal>
          <div
            className="lp-orbit"
            onPointerOver={onOver}
            onPointerLeave={() => setTip(null)}
            onFocusCapture={onFocus}
            onBlurCapture={() => setTip(null)}
          >
            <div className="lp-orbit__core" aria-hidden>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon.png" alt="" width={30} height={30} />
              <span className="lp-orbit__word">CORTEX</span>
            </div>
            <Ring nodes={RING_A} variant="a" offset={-90} />
            <Ring nodes={RING_B} variant="b" offset={-60} />
          </div>
          <p className="lp-orbit__caption lp-data" aria-live="polite">
            {tip ?? DEFAULT_TIP}
          </p>
        </div>
      </div>
    </section>
  );
}
