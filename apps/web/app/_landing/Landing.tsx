import { CortexSignature } from '@/components/ui/cortex-signature';
import { ArrowDown, ArrowUpRight, AudioLines, Globe2, Paperclip } from 'lucide-react';
import Link from 'next/link';
import { Close, Faq, Industries, Pains, Plans, PrimaryActions, Steps, Trust } from './Commercial';
import { ConnectionStory } from './ConnectionStory';
import { MissionPreview } from './MissionPreview';
import { ScrollExperience } from './ScrollExperience';
import { SpaceHero } from './SpaceHero';

/**
 * Public content stays server-rendered. Only the spatial canvas and examples hydrate.
 *
 * The journey: the promise (hero), the connection story, what it solves by pain,
 * a live example, how to start, how it learns your way of working, examples by
 * industry, trust, plans, questions and the close. The commercial chapters live
 * in Commercial.tsx and their words in commercial-content.ts.
 */
export function Landing() {
  return (
    <ScrollExperience>
      <a className="cosmos-skip" href="#contenido">
        Ir al contenido
      </a>
      <header className="cosmos-header cosmos-wrap">
        <Link href="/" className="cosmos-brand" aria-label="Cortex, inicio">
          <CortexSignature />
          <span>Cortex</span>
        </Link>
        <nav aria-label="Navegación principal" className="cosmos-nav">
          <a href="#resuelve">Lo que resuelve</a>
          <a href="#como-funciona">Cómo funciona</a>
          <a href="#control">Seguridad</a>
          <a href="#planes">Planes</a>
          <a href="#preguntas">Preguntas</a>
        </nav>
        <Link className="cosmos-login" href="/login">
          Iniciar sesión <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </header>
      <main id="contenido">
        <section className="cosmos-hero cosmos-wrap" aria-labelledby="cosmos-title">
          <div className="cosmos-hero__copy">
            <p className="cosmos-intro">
              <span /> El gerente de IA para empresas en Colombia
            </p>
            <h1 id="cosmos-title">
              Todo un mundo.
              <br />
              Un solo Cortex.
            </h1>
            <p className="cosmos-lead">
              Cortex recuerda todo lo que pasa en tu empresa, cuida la cartera y la caja, y hace lo
              rutinario dentro de los permisos que le das. Tú decides lo importante.
            </p>
            <PrimaryActions
              secondary={
                <a href="#experiencia" className="cosmos-text-link">
                  Mira cómo funciona <ArrowDown size={16} aria-hidden="true" />
                </a>
              }
            />
          </div>
          <SpaceHero />
          <div className="cosmos-hero__foot">
            <span>Se conecta con Siigo, Alegra, QuickBooks, Gmail, Outlook y WhatsApp.</span>
            <a href="#resuelve">
              Descubre cómo <ArrowDown size={14} aria-hidden="true" />
            </a>
          </div>
        </section>
        <ConnectionStory />
        <Pains />
        <section
          className="cosmos-product cosmos-wrap"
          id="experiencia"
          aria-labelledby="experience-title"
        >
          <div className="cosmos-section-head">
            <h2 id="experience-title">
              De mil pendientes
              <br />a una dirección clara.
            </h2>
            <p>
              Pregunta, comparte contexto o enseña un proceso. Cortex reúne las piezas para que
              puedas decidir con información a la mano.
            </p>
          </div>
          <MissionPreview />
        </section>
        <Steps />
        <section className="cosmos-work cosmos-wrap" id="aprende" aria-labelledby="how-title">
          <div className="cosmos-work__intro">
            <span className="cosmos-orbit-mark" aria-hidden="true">
              <CortexSignature />
            </span>
            <h2 id="how-title">
              Tu forma de trabajar.
              <br />
              Su punto de partida.
            </h2>
            <p>
              Cortex se adapta al contexto que le das: desde una consulta puntual hasta un proceso
              que tu equipo necesita repetir.
            </p>
          </div>
          <div className="cosmos-paths">
            <article>
              <Paperclip aria-hidden="true" />
              <div>
                <h3>El contexto entra por cualquier puerta.</h3>
                <p>
                  Documentos, hojas de cálculo, enlaces e integraciones. Usa el Feed para consultar;
                  decide qué vale la pena guardar en el cerebro.
                </p>
                <span>Consulta puntual o conocimiento duradero</span>
              </div>
            </article>
            <article>
              <AudioLines aria-hidden="true" />
              <div>
                <h3>Cuéntalo como se lo contarías a alguien.</h3>
                <p>
                  Escribe o dicta un proceso completo. Cortex propone cómo organizar sus pasos,
                  condiciones y excepciones para que los revises.
                </p>
                <span>De tu explicación a un manual revisable</span>
              </div>
            </article>
            <article>
              <Globe2 aria-hidden="true" />
              <div>
                <h3>Enséñale dentro de su navegador.</h3>
                <p>
                  Abre el portal, recorre las páginas y explica de dónde sale cada dato. Revisa lo
                  aprendido y prueba el trámite antes de confiar en su repetición.
                </p>
                <span>Perfiles personales que tú decides compartir</span>
              </div>
            </article>
          </div>
        </section>
        <Industries />
        <Trust />
        <Plans />
        <Faq />
        <Close />
      </main>
      <footer className="cosmos-footer cosmos-wrap">
        <Link href="/" className="cosmos-brand">
          <CortexSignature />
          <span>Cortex</span>
        </Link>
        <nav aria-label="Enlaces del pie de página" className="cosmos-footer__links">
          <a href="#resuelve">Lo que resuelve</a>
          <a href="#como-funciona">Cómo funciona</a>
          <a href="#control">Seguridad</a>
          <a href="#planes">Planes</a>
          <a href="#preguntas">Preguntas</a>
          <Link href="/signup">Crear mi espacio</Link>
          <Link href="/login">Iniciar sesión</Link>
        </nav>
        <p>Contexto para decidir. Capacidad para avanzar.</p>
      </footer>
    </ScrollExperience>
  );
}
