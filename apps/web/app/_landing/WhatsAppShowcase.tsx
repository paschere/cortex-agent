'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * «Donde ya trabajas» — Cortex contestando DENTRO de un chat de WhatsApp.
 *
 * El mock es fiel sin ser un disfraz: patrón del fondo hecho en CSS, burbujas
 * verdes del que pregunta con su doble check azul, burbujas claras de Cortex
 * con la procedencia debajo — el chip de cita del producto, dicho en el
 * idioma de un chat. El marco es un teléfono SUGERIDO: vidrio con bordes
 * grandes y un notch sutil, flotando con el tilt de Interactive (el selector
 * `.lp-wa__phone` está en su lista), no un mockup de plástico.
 *
 * LA CONVERSACIÓN SE ESCRIBE SOLA al entrar al viewport, con el mismo patrón
 * de guion de LiveDemo: estado inicial = conversación COMPLETA (es lo que
 * renderiza el servidor y lo que queda sin JS o con reduced-motion), y sólo
 * si hay movimiento permitido el efecto la rebobina y la reproduce una vez —
 * mensaje del usuario, check que se pone azul, «escribiendo…», respuesta.
 * En WhatsApp los mensajes llegan enteros: aquí también.
 */

interface WaMsg {
  from: 'user' | 'cortex';
  text: string;
  cite?: string;
  time: string;
}

const MSGS: WaMsg[] = [
  { from: 'user', text: '¿cuánto le debemos a proveedores este mes?', time: '11:42' },
  {
    from: 'cortex',
    text: '$18.400.000 a cuatro proveedores. El más grande: $9.200.000 a Distribuciones El Roble, vence el viernes 22.',
    cite: '6 facturas · correo de compras',
    time: '11:42',
  },
  { from: 'user', text: '¿y cuáles vencen esta semana?', time: '11:43' },
  {
    from: 'cortex',
    text: 'Dos: El Roble ($9.200.000, viernes) y Empaques Andinos ($2.100.000, jueves). Si quieres, dejo los dos pagos listos — no salen sin tu aprobación.',
    time: '11:43',
  },
];

/**
 * El guion por etapas: qué hay en pantalla en cada momento.
 *   1 llega la pregunta (check gris) · 2 leída (✓✓ azul) + escribiendo…
 *   3 contesta Cortex · 4 segunda pregunta · 5 leída + escribiendo…
 *   6 segunda respuesta (= completo, el estado del servidor)
 */
const FULL = 6;
const STEP_MS = [500, 700, 1500, 1900, 700, 1600];

const shownAt = (stage: number): number => {
  if (stage >= 6) return 4;
  if (stage >= 4) return 3;
  if (stage >= 3) return 2;
  if (stage >= 1) return 1;
  return 0;
};

/** Los checks de WhatsApp: uno al salir, dos azules al leerse. */
function Checks({ read }: { read: boolean }) {
  return (
    <svg
      viewBox="0 0 18 11"
      className={read ? 'lp-wa__checks is-read' : 'lp-wa__checks'}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M1 5.5 4.2 8.8 10 1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {read && (
        <path
          d="M7.6 5.9 10.2 8.8 16 1.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function WhatsAppShowcase() {
  // El servidor entrega la conversación terminada; con reduced-motion se
  // queda así. La reproducción es un privilegio del que permitió movimiento.
  const [stage, setStage] = useState(FULL);
  const rootRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = rootRef.current;
    if (!el) return;

    setStage(0);
    const timers: number[] = [];

    const play = () => {
      let acc = 0;
      for (let s = 1; s <= FULL; s++) {
        acc += STEP_MS[s - 1] ?? 800;
        timers.push(window.setTimeout(() => setStage(s), acc));
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (startedRef.current) return;
        if (!entries.some((e) => e.isIntersecting)) return;
        startedRef.current = true;
        io.disconnect();
        play();
      },
      { threshold: 0.45 },
    );
    io.observe(el);

    return () => {
      io.disconnect();
      for (const t of timers) window.clearTimeout(t);
    };
  }, []);

  const shown = shownAt(stage);
  const typing = stage === 2 || stage === 5;
  const readUpTo = stage >= 5 ? 3 : stage >= 2 ? 1 : 0; // índice < readUpTo ⇒ leído

  return (
    <section className="lp-section lp-section--tint" id="whatsapp">
      <div className="lp-wrap">
        <div className="lp-wa">
          <div className="lp-wa__copy">
            <div className="lp-head" data-reveal>
              <p className="lp-marker">Donde ya trabajas</p>
              <h2 className="lp-h2">
                En el WhatsApp donde <em>ya vive tu empresa</em>.
              </h2>
              <p className="lp-lead">
                Sin instalar nada ni abrir otra pestaña: escribes al mismo chat de siempre y Cortex
                contesta ahí, con cifras y con su fuente. Entra sólo a los grupos que habilites —
                uno por uno, nunca todos.
              </p>
              <p className="lp-fine lp-wa__fine">
                Y la regla de la casa no cambia por el canal: responderle a un cliente hacia afuera
                pasa antes por tu aprobación.
              </p>
            </div>
          </div>

          <div className="lp-wa__stage" data-reveal ref={rootRef}>
            <div className="lp-wa__phone">
              {/* El borde de luz vive en un span propio: los pseudo-elementos
                  del teléfono los usa la linterna de Interactive (lp-tilt). */}
              <span aria-hidden className="lp-wa__ring" />
              <div className="lp-wa__screen">
                <span aria-hidden className="lp-wa__notch" />
                <div className="lp-wa__status lp-data" aria-hidden>
                  <span>11:43</span>
                  <svg
                    viewBox="0 0 34 10"
                    className="lp-wa__status-ico"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <rect x="0" y="6" width="2" height="4" rx="0.8" fill="currentColor" />
                    <rect x="3.5" y="4" width="2" height="6" rx="0.8" fill="currentColor" />
                    <rect x="7" y="2" width="2" height="8" rx="0.8" fill="currentColor" />
                    <rect x="10.5" y="0" width="2" height="10" rx="0.8" fill="currentColor" />
                    <rect
                      x="17"
                      y="1"
                      width="13"
                      height="8"
                      rx="2.4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.1"
                    />
                    <rect x="19" y="3" width="7" height="4" rx="1" fill="currentColor" />
                    <rect x="31" y="3.4" width="2" height="3.2" rx="1" fill="currentColor" />
                  </svg>
                </div>

                <div className="lp-wa__head">
                  <span aria-hidden className="lp-wa__back">
                    ‹
                  </span>
                  <span className="lp-wa__avatar">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/icon.png" alt="" width={34} height={34} />
                  </span>
                  <span className="lp-wa__id">
                    <span className="lp-wa__name">Cortex</span>
                    <span className="lp-wa__presence">{typing ? 'escribiendo…' : 'en línea'}</span>
                  </span>
                  <span aria-hidden className="lp-wa__dots">
                    ⋮
                  </span>
                </div>

                <div className="lp-wa__chat">
                  <span className="lp-wa__day">hoy</span>

                  {MSGS.slice(0, shown).map((m, i) => (
                    <div
                      key={`${m.time}-${i}`}
                      className={m.from === 'user' ? 'lp-wa__msg lp-wa__msg--out' : 'lp-wa__msg'}
                    >
                      <p className="lp-wa__text">{m.text}</p>
                      {m.cite && <p className="lp-wa__cite lp-data">{m.cite}</p>}
                      <span className="lp-wa__meta lp-data">
                        {m.time}
                        {m.from === 'user' && <Checks read={i < readUpTo} />}
                      </span>
                    </div>
                  ))}

                  {typing && (
                    <div className="lp-wa__msg lp-wa__msg--typing" aria-hidden>
                      <span className="lp-wa__tdot" />
                      <span className="lp-wa__tdot" />
                      <span className="lp-wa__tdot" />
                    </div>
                  )}
                </div>

                <div className="lp-wa__input" aria-hidden>
                  <span className="lp-wa__field">Mensaje</span>
                  <span className="lp-wa__mic">
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        d="M12 3a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Zm-6 8a6 6 0 0 0 12 0M12 17v3.4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
