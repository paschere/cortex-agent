import { CortexSignature } from '@/components/ui/cortex-signature';
import { ArrowDown, ArrowUpRight, AudioLines, Globe2, Paperclip, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { MissionPreview } from './MissionPreview';
import { SpaceHero } from './SpaceHero';

/** Public content stays server-rendered. Only the spatial canvas and examples hydrate. */
export function Landing() {
  return (
    <div className="cosmos">
      <a className="cosmos-skip" href="#contenido">
        Ir al contenido
      </a>
      <header className="cosmos-header cosmos-wrap">
        <Link href="/" className="cosmos-brand" aria-label="Cortex, inicio">
          <CortexSignature />
          <span>Cortex</span>
        </Link>
        <nav aria-label="Navegación principal" className="cosmos-nav">
          <a href="#como-funciona">Cómo funciona</a>
          <a href="#control">Tu control</a>
        </nav>
        <Link className="cosmos-login" href="/login">
          Iniciar sesión <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </header>
      <main id="contenido">
        <section className="cosmos-hero cosmos-wrap" aria-labelledby="cosmos-title">
          <div className="cosmos-hero__copy">
            <p className="cosmos-intro">
              <span /> Inteligencia para dirigir tu empresa
            </p>
            <h1 id="cosmos-title">
              Todo un mundo.
              <br />
              Un solo Cortex.
            </h1>
            <p className="cosmos-lead">
              Tu información, tus procesos y tus decisiones, conectados. Un gerente de IA que te
              ayuda a entender qué pasa y a dar el siguiente paso.
            </p>
            <div className="cosmos-actions">
              <Link href="/signup" className="cosmos-button">
                Crear mi espacio <ArrowUpRight size={18} aria-hidden="true" />
              </Link>
              <a href="#experiencia" className="cosmos-text-link">
                Explorar Cortex <ArrowDown size={16} aria-hidden="true" />
              </a>
            </div>
          </div>
          <SpaceHero />
          <div className="cosmos-hero__foot">
            <span>Hecho para la forma en que trabaja tu empresa.</span>
            <a href="#como-funciona">
              Descubre cómo <ArrowDown size={14} aria-hidden="true" />
            </a>
          </div>
        </section>
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
        <section className="cosmos-work cosmos-wrap" id="como-funciona" aria-labelledby="how-title">
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
        <section className="cosmos-control" id="control" aria-labelledby="control-title">
          <div className="cosmos-wrap cosmos-control__grid">
            <div>
              <ShieldCheck size={28} aria-hidden="true" />
              <h2 id="control-title">
                Más capacidad.
                <br />
                La decisión sigue
                <br />
                siendo tuya.
              </h2>
              <p>
                La confianza se construye viendo qué sabe Cortex, qué propone y qué necesita de ti.
              </p>
            </div>
            <div className="cosmos-rules">
              <article>
                <h3>Fuentes que puedes revisar</h3>
                <p>
                  Consulta el documento o la evidencia detrás de una respuesta. Si falta contexto,
                  completa la información antes de decidir.
                </p>
              </article>
              <article>
                <h3>Acciones con aprobación</h3>
                <p>
                  Revisa las propuestas que requieren tu autorización antes de que se ejecuten. Un
                  borrador preparado no equivale a un envío.
                </p>
              </article>
              <article>
                <h3>Lo personal y lo compartido, claros</h3>
                <p>
                  Decide qué información y perfiles de navegador compartes con tu compañía. Una
                  consulta no tiene por qué convertirse en memoria.
                </p>
              </article>
            </div>
          </div>
        </section>
        <section className="cosmos-faq cosmos-wrap" aria-labelledby="faq-title">
          <h2 id="faq-title">Antes de despegar.</h2>
          <div>
            <details>
              <summary>¿Tengo que cambiar las herramientas de mi empresa?</summary>
              <p>
                Puedes empezar con documentos y consultas, y conectar las integraciones disponibles
                que use tu equipo. Los portales externos se trabajan desde el navegador de Cortex.
              </p>
            </details>
            <details>
              <summary>¿Todo lo que comparto se guarda en el cerebro?</summary>
              <p>
                No. El Feed permite trabajar con información para consulta. Guardar conocimiento
                duradero es una decisión aparte.
              </p>
            </details>
            <details>
              <summary>¿Cortex reemplaza mis decisiones?</summary>
              <p>
                Cortex ayuda a reunir contexto, preparar propuestas y seguir procesos. Tu equipo
                define las responsabilidades y conserva las decisiones y aprobaciones que le
                corresponden.
              </p>
            </details>
            <details>
              <summary>¿Cómo empezamos?</summary>
              <p>
                Crea tu espacio y completa la configuración de tu empresa. Empieza por un proceso
                concreto, añade su información y revisa los resultados con tu equipo.
              </p>
            </details>
          </div>
        </section>
        <section className="cosmos-close cosmos-wrap">
          <CortexSignature className="cosmos-close__mark" />
          <h2>
            Dale un centro
            <br />a todo lo que haces.
          </h2>
          <p>Empieza con tu empresa. Construye su contexto.</p>
          <Link href="/signup" className="cosmos-button">
            Crear mi espacio <ArrowUpRight size={18} aria-hidden="true" />
          </Link>
        </section>
      </main>
      <footer className="cosmos-footer cosmos-wrap">
        <Link href="/" className="cosmos-brand">
          <CortexSignature />
          <span>Cortex</span>
        </Link>
        <p>Contexto para decidir. Capacidad para avanzar.</p>
        <Link href="/login">Iniciar sesión</Link>
      </footer>
    </div>
  );
}
