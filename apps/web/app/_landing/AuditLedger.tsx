import type { CSSProperties } from 'react';

/**
 * «Todo queda escrito» — la sección enterprise que faltaba: un libro de
 * auditoría que se escribe solo, línea a línea, sobre la misma noche índigo
 * del hero y del cierre. Al lado, en serif, el argumento.
 *
 * CERO JS PROPIO. El panel lleva `data-reveal`; cuando Interactive le pone
 * `.is-in`, cada fila corre su animación de escritura con un delay propio
 * (--i, puesto aquí en el servidor). Sin JS o con reduced-motion no existe
 * `.lp-live` y el libro llega completo y quieto — lo que pide la regla de la
 * casa. Los tonos (aprobado / esperando / BLOQUEADO) son los tokens de
 * estado del sistema, en su versión de noche.
 */

type Tone = 'ok' | 'hold' | 'stop' | 'dim';

interface LedgerRow {
  t: string;
  act: string;
  rest: string;
  tone?: Tone;
}

const ROWS: LedgerRow[] = [
  { t: '09:41:07', act: 'gmail.send_message', rest: 'aprobado por Mateo · enviado', tone: 'ok' },
  { t: '09:41:52', act: 'payments.record', rest: '$2.400.000 · registrado', tone: 'ok' },
  { t: '09:58:30', act: 'gcal.create_event', rest: 'esperando tu firma', tone: 'hold' },
  { t: '10:02:11', act: 'intento fuera de mandato', rest: 'BLOQUEADO', tone: 'stop' },
  { t: '10:02:12', act: 'security.event', rest: 'avisado al administrador', tone: 'dim' },
  { t: '10:14:46', act: 'whatsapp.reply', rest: 'aprobado por Laura · enviado', tone: 'ok' },
];

const rowDelay = (i: number) => ({ '--i': i }) as CSSProperties;

export function AuditLedger() {
  return (
    <section className="lp-section lp-ledger-sec" id="auditoria">
      <div className="lp-wrap">
        <div className="lp-ledger">
          <div className="lp-ledger__copy">
            <div className="lp-head" data-reveal>
              <p className="lp-marker">Todo queda escrito</p>
              <h2 className="lp-h2">
                Cada acción, quién la aprobó <em>y cuándo</em>.
              </h2>
              <p className="lp-lead">
                Los permisos los pones tú. Lo delicado espera tu firma. Y lo que se intente por
                fuera del mandato no corre: queda anotado el intento — que es la mitad que suele
                faltar en un registro.
              </p>
            </div>

            <div className="lp-ledger__points" data-reveal-group>
              <div className="lp-ledger__point">
                <p className="lp-ledger__k lp-data">Aprobaciones</p>
                <p>
                  Nada sale hacia afuera sin un sí. Y se ejecuta el texto exacto que aprobaste: si
                  algo cambió en el camino, no corre.
                </p>
              </div>
              <div className="lp-ledger__point">
                <p className="lp-ledger__k lp-data">Mandatos</p>
                <p>
                  Lo que Cortex puede hacer está escrito, por persona y por integración. Lo que se
                  salga, se bloquea y se anota.
                </p>
              </div>
              <div className="lp-ledger__point">
                <p className="lp-ledger__k lp-data">Auditoría exportable</p>
                <p>
                  Una fila por acción: quién, qué, cuándo, con qué resultado y cuánto tardó. Lista
                  para llevársela a tu auditor.
                </p>
              </div>
            </div>
          </div>

          <div className="lp-ledger__side">
            <div className="lp-ledger__panel" data-reveal>
              <div className="lp-ledger__bar">
                <span aria-hidden className="lp-ledger__pip" />
                <span className="lp-ledger__title lp-data">auditoría · hoy</span>
                <span className="lp-ledger__count lp-data">6 filas</span>
              </div>
              <div className="lp-ledger__scroll">
                <ol className="lp-ledger__rows lp-data">
                  {ROWS.map((r, i) => (
                    <li
                      key={r.t}
                      className={r.tone ? `lp-ledger__row is-${r.tone}` : 'lp-ledger__row'}
                      style={rowDelay(i)}
                    >
                      <span className="lp-ledger__t">{r.t}</span>
                      <span className="lp-ledger__act">{r.act}</span>
                      <span className="lp-ledger__rest">{r.rest}</span>
                    </li>
                  ))}
                </ol>
                <span aria-hidden className="lp-ledger__caret" />
              </div>
            </div>
            <p className="lp-ledger__foot lp-fine" data-reveal>
              Lo mismo que ves en Admin → auditoría, con tus filas de verdad.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
