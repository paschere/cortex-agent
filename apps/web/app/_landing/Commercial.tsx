import { CortexSignature } from '@/components/ui/cortex-signature';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PAIN_MOCKS } from './PainMocks';
import {
  ACCESS_REQUEST_HREF,
  FAQS,
  INDUSTRIES,
  INTEGRATIONS,
  PAINS,
  PLANS,
  SHOW_PRICES,
  STEPS,
  TRUST,
} from './commercial-content';

/**
 * Los capítulos comerciales de la página pública. Todo es marcado del servidor:
 * ni datos, ni efectos, ni hidratación. El texto vive en commercial-content.ts
 * para que se pueda revisar frase por frase contra el producto.
 */

/** El botón principal, honesto sobre la invitación. Lo usan el héroe y el cierre. */
export function PrimaryActions({ secondary }: { secondary: ReactNode }) {
  return (
    <>
      <div className="cosmos-actions">
        {ACCESS_REQUEST_HREF ? (
          <a href={ACCESS_REQUEST_HREF} className="cosmos-button">
            Pide tu acceso <ArrowUpRight size={18} aria-hidden="true" />
          </a>
        ) : (
          <Link href="/signup" className="cosmos-button">
            Crear mi espacio <ArrowUpRight size={18} aria-hidden="true" />
          </Link>
        )}
        {secondary}
      </div>
      <p className="cosmos-access">
        {ACCESS_REQUEST_HREF ? (
          <>
            ¿Ya tienes tu código de invitación? <Link href="/signup">Crea tu espacio</Link>.
          </>
        ) : (
          'Acceso por invitación: necesitas tu código. Sin tarjeta.'
        )}
      </p>
    </>
  );
}

export function Pains() {
  return (
    <section className="cosmos-pains cosmos-wrap" id="resuelve" aria-labelledby="pains-title">
      <div className="cosmos-section-head">
        <div>
          <p className="cosmos-eyebrow">Lo que resuelve</p>
          <h2 id="pains-title">
            Lo que te quita el sueño,
            <br />
            resuelto cada mañana.
          </h2>
        </div>
        <p>
          Cortex conoce tu empresa y trabaja sobre lo que ya tienes: tu programa contable, tu
          correo, tus documentos y el extracto del banco.
        </p>
      </div>
      <div className="pain-grid">
        {PAINS.map((pain) => {
          const Visual = PAIN_MOCKS[pain.id];
          return (
            <article key={pain.id} className="pain-card">
              <p className="pain-card__area">{pain.area}</p>
              <h3>{pain.title}</h3>
              <p>{pain.body}</p>
              {Visual ? <Visual /> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function Steps() {
  return (
    <section className="cosmos-steps cosmos-wrap" id="como-funciona" aria-labelledby="steps-title">
      <div className="cosmos-section-head">
        <div>
          <p className="cosmos-eyebrow">Cómo funciona</p>
          <h2 id="steps-title">
            Tres pasos.
            <br />
            Sin proyecto de sistemas.
          </h2>
        </div>
        <p>
          No hay que migrar nada ni cambiar de programa. Cortex se conecta a lo que tu empresa ya
          usa y empieza por un proceso concreto.
        </p>
      </div>
      <ol className="steps">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <span className="steps__node" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
            <span className="steps__note">{step.note}</span>
          </li>
        ))}
      </ol>
      <div className="integrations" aria-labelledby="integrations-title">
        <h3 id="integrations-title">Se conecta con lo que ya usas</h3>
        <dl>
          {INTEGRATIONS.map((group) => (
            <div key={group.group}>
              <dt>{group.group}</dt>
              {group.items.map((item) => (
                <dd key={item}>{item}</dd>
              ))}
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function Industries() {
  return (
    <section className="cosmos-industries cosmos-wrap" id="industrias" aria-labelledby="ind-title">
      <div className="cosmos-section-head">
        <div>
          <p className="cosmos-eyebrow">Para tu industria</p>
          <h2 id="ind-title">
            Cada empresa tiene su caos.
            <br />
            Cortex aprende el tuyo.
          </h2>
        </div>
        <p>
          Algunos ejemplos de lo que las empresas colombianas le encargan. Si tu proceso no está, se
          lo cuentas con tus palabras.
        </p>
      </div>
      <div className="industries">
        {INDUSTRIES.map((industry) => (
          <article key={industry.name}>
            <h3>{industry.name}</h3>
            <ul>
              {industry.examples.map((example) => (
                <li key={example}>{example}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

export function Trust() {
  return (
    <section className="cosmos-control" id="control" aria-labelledby="control-title">
      <div className="cosmos-wrap cosmos-control__grid">
        <div>
          <ShieldCheck size={28} aria-hidden="true" />
          <p className="cosmos-eyebrow">Seguridad y confianza</p>
          <h2 id="control-title">
            Más capacidad.
            <br />
            La decisión sigue
            <br />
            siendo tuya.
          </h2>
          <p>
            La confianza se construye viendo qué sabe Cortex, qué propone y qué necesita de ti. Cada
            respuesta trae la fuente de donde salió.
          </p>
        </div>
        <div className="cosmos-rules">
          {TRUST.map((rule) => (
            <article key={rule.title}>
              <h3>{rule.title}</h3>
              <p>{rule.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Plans() {
  return (
    <section className="cosmos-plans cosmos-wrap" id="planes" aria-labelledby="plans-title">
      <div className="cosmos-section-head">
        <div>
          <p className="cosmos-eyebrow">Planes</p>
          <h2 id="plans-title">
            Un asistente por persona,
            <br />o un gerente para la empresa.
          </h2>
        </div>
        <p>
          Hoy el acceso es por invitación y sin tarjeta. Todavía no cobramos dentro de Cortex: el
          plan se acuerda contigo y lo activamos.
        </p>
      </div>
      <div className="plans">
        {PLANS.map((plan) => (
          <article key={plan.name} className="plan" data-featured={plan.featured || undefined}>
            <h3>{plan.name}</h3>
            <p className="plan__who">{plan.forWhom}</p>
            {SHOW_PRICES && plan.price ? (
              <p className="plan__price">
                <b>{plan.price.amount}</b> {plan.price.per}
              </p>
            ) : (
              <p className="plan__price plan__price--talk">
                {plan.featured ? 'Acuerdo mensual' : 'Precio por persona'}
              </p>
            )}
            <p className="plan__tagline">{plan.tagline}</p>
            <ul>
              {plan.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
              {SHOW_PRICES && plan.quota ? (
                <li>
                  {plan.quota.answers} respuestas y {plan.quota.documents} documentos por persona al
                  mes
                </li>
              ) : null}
            </ul>
            {plan.featured && ACCESS_REQUEST_HREF ? (
              <a href={ACCESS_REQUEST_HREF} className="plan__cta">
                Hablemos <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            ) : (
              <Link href="/signup" className="plan__cta">
                Crear mi espacio <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            )}
          </article>
        ))}
      </div>
      <div className="plans__guards">
        <p>
          <b>Llegar al límite no corta nada.</b> Ninguna conversación se interrumpe: hay un margen
          de cortesía, y los documentos nunca se rechazan.
        </p>
        <p>
          <b>Ves de dónde sale cada peso.</b> El consumo es una lista, no un porcentaje: una fila
          por cada respuesta y cada documento.
        </p>
      </div>
    </section>
  );
}

export function Faq() {
  return (
    <section className="cosmos-faq cosmos-wrap" id="preguntas" aria-labelledby="faq-title">
      <div>
        <h2 id="faq-title">Antes de despegar.</h2>
        <p className="cosmos-faq__lead">Lo que conviene saber antes de empezar.</p>
      </div>
      <div>
        {FAQS.map((item) => (
          <details key={item.q}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function Close() {
  return (
    <section className="cosmos-close cosmos-wrap" aria-labelledby="close-title">
      <CortexSignature className="cosmos-close__mark" />
      <h2 id="close-title">
        Dale un centro
        <br />a todo lo que haces.
      </h2>
      <p>
        Empieza por la cartera, la caja o el proceso que más te pesa. Lo rutinario corre por cuenta
        de Cortex.
      </p>
      <div className="cosmos-close__actions">
        <PrimaryActions
          secondary={
            <a href="#planes" className="cosmos-text-link">
              Ver planes
            </a>
          }
        />
      </div>
    </section>
  );
}
