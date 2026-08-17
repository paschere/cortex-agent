import type { CSSProperties } from 'react';

/**
 * «Un día con Cortex» — el producto trabajando SOLO, que el resto de la
 * página no cuenta: la línea de tiempo de un martes cualquiera, con la hora
 * de cada cosa en mono, como evidencia.
 *
 * CERO JS PROPIO. Todo el movimiento lo gobierna Interactive.tsx con los
 * data-attrs de la casa: cada evento lleva su `data-reveal` (se enciende al
 * entrar al viewport, con un delay propio para la cascada) y la línea
 * vertical es un SVG cuyo trazo se dibuja por stroke-dashoffset cuando su
 * propio `data-reveal` recibe `.is-in` — la transición vive en landing.css.
 * Sin JS o con prefers-reduced-motion no existe `.lp-live`: la línea llega
 * completa y los eventos visibles desde el primer frame.
 */

interface DayEvent {
  time: string;
  title: string;
  detail: string;
}

const EVENTS: DayEvent[] = [
  {
    time: '7:03',
    title: 'Revisó el Drive',
    detail:
      'Encontró 2 documentos nuevos — un otrosí y una cotización — y los dejó leídos, indexados y listos para preguntar.',
  },
  {
    time: '8:40',
    title: 'Avisó de un vencimiento',
    detail:
      'El SOAT del WGY482 vence en 9 días. La fecha la había confirmado una persona; por eso el aviso salió.',
  },
  {
    time: '9:55',
    title: 'Preparó el briefing de las 10:00',
    detail:
      'Los 3 temas que siguen pendientes del acta anterior, con quién quedó comprometido cada uno.',
  },
  {
    time: '14:20',
    title: 'Persiguió la cartera',
    detail:
      'Le recordó al cliente la factura 4512, que va 12 días tarde. El texto lo aprobaste tú a las 14:17; salió idéntico.',
  },
  {
    time: '17:30',
    title: 'Dejó el resumen del día',
    detail: 'Qué entró, qué se movió y qué queda esperando tu firma para mañana.',
  },
];

const delay = (i: number) => ({ '--rv-d': `${i * 140}ms` }) as CSSProperties;

export function DayTimeline() {
  return (
    <section className="lp-section" id="un-dia">
      <div className="lp-wrap">
        <div className="lp-day">
          <div className="lp-day__head">
            <div className="lp-head" data-reveal>
              <p className="lp-marker">Un día con Cortex</p>
              <h2 className="lp-h2">
                Trabaja igual cuando <em>nadie le está preguntando</em>.
              </h2>
              <p className="lp-lead">
                Esto es un martes cualquiera, con su hora. Lo que Cortex revisa, avisa, prepara y
                persigue por su cuenta — sin que nadie abra un chat.
              </p>
            </div>
          </div>

          <div className="lp-day__rail">
            <div className="lp-day__track">
              {/* La línea que se va dibujando: pathLength=1 para que el dash no
                  dependa de la altura real; el trazo lo anima landing.css. */}
              <svg
                className="lp-day__line"
                data-reveal
                aria-hidden="true"
                viewBox="0 0 2 100"
                preserveAspectRatio="none"
                focusable="false"
              >
                <line x1="1" y1="0" x2="1" y2="100" pathLength="1" />
              </svg>

              <ol className="lp-day__list">
                {EVENTS.map((e, i) => (
                  <li key={e.time} className="lp-day__event" data-reveal style={delay(i)}>
                    <span className="lp-day__time lp-data">{e.time}</span>
                    <span aria-hidden className="lp-day__dot" />
                    <div className="lp-day__body">
                      <p className="lp-day__title">{e.title}</p>
                      <p className="lp-day__detail">{e.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <p className="lp-day__coda" data-reveal style={delay(EVENTS.length)}>
              Nada de esto se lo pediste hoy. <em>Se lo pediste una vez.</em>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
