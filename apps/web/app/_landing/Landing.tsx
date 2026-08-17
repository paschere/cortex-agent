import { Instrument_Serif } from 'next/font/google';
import Link from 'next/link';
import { Fragment } from 'react';
import { HeroSequence } from './HeroSequence';
import { IndustrySwitch } from './IndustrySwitch';
import { Interactive } from './Interactive';
import { LiveDemo } from './LiveDemo';
import { ScrollStory } from './ScrollStory';

/**
 * La voz de los titulares. Instrument Serif — editorial, con itálicas de
 * verdad para los acentos — contra el canvas oscuro del hero y el claro del
 * resto. La landing gana una tercera voz tipográfica: serif para lo que se
 * AFIRMA, Manrope para lo que se explica, JetBrains Mono para lo que se
 * puede verificar. `next/font` la sirve self-hosted en el build: cero CDN,
 * cero CSP, cero layout shift (fallback métrico automático).
 */
const displaySerif = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  variable: '--lp-font-display',
  display: 'swap',
});

/**
 * The public page.
 *
 * DIRECTION — "an answer and its margin." Cortex's whole claim is that it never
 * asserts anything it cannot attribute, so the page is built the way one of its
 * answers is built: a statement, and beside it the thing the statement came
 * from. The hero is not a headline over a gradient; it is a real reply with its
 * sources opened up, quoted, with the minute of the call. That card is the only
 * place the page raises its voice, and everything around it is kept quiet so it
 * reads as evidence rather than as another marketing panel.
 *
 * The provenance chip does double duty: inside the answer cards it does what it
 * does in the product, and beside a claim the page makes about ITSELF it names
 * the screen where a visitor can go and check. Demonstrating the idea is worth
 * more than describing it.
 *
 * HONESTY. Everything asserted here exists in this repository today. Two things
 * deliberately do not appear as available anywhere on the page: charging per
 * additional person (seats are a cap on the plan, not an incremental charge)
 * and signing in with a corporate directory. Both are named only inside the
 * Enterprise card, and named there as a conversation, with a line that says so.
 * There are no customer names, logos, testimonials or usage figures, because
 * there are none to tell the truth about yet.
 *
 * Server component throughout except the industry picker. Everything is static
 * markup — no data fetching, no third-party request, no remote image.
 */

const CITE = {
  plan: { src: 'En Cortex', at: 'Plan → de dónde sale la cifra' },
  approvals: { src: 'En Cortex', at: 'Aprobaciones' },
  audit: { src: 'En Cortex', at: 'Admin → auditoría' },
  commitments: { src: 'En Cortex', at: 'Compromisos → por confirmar' },
} as const;

function Cite({ src, at }: { src: string; at: string }) {
  return (
    <span className="lp-cite">
      <span className="lp-cite__src">{src}</span>
      <span aria-hidden className="lp-cite__dot">
        ·
      </span>
      <span className="lp-data">{at}</span>
    </span>
  );
}

function Masthead() {
  return (
    <header className="lp-top">
      <div className="lp-wrap lp-top__row">
        <Link href="/" className="lp-mark" aria-label="Cortex, inicio">
          {/* The app icon, served from this origin by Next metadata — the same
              mark as the browser tab. No remote image anywhere on the page. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="" width={24} height={24} />
          <span className="lp-mark__word">Cortex</span>
        </Link>
        <nav className="lp-top__actions" aria-label="Entrar">
          <Link href="/login" className="lp-btn lp-btn--plain">
            Iniciar sesión
          </Link>
          <Link href="/signup" className="lp-btn lp-btn--primary">
            Crear cuenta
          </Link>
        </nav>
      </div>
    </header>
  );
}

/**
 * El hero cinematográfico, ahora una SECUENCIA dirigida por el scroll: el
 * humano de partículas alcanza el núcleo de la IA, lo toca, el contacto es un
 * big bang, del estallido nace el wordmark CORTEX y la secuencia culmina en
 * el producto real — la ventana viva del chat escribiéndose sola. Toda la
 * maquinaria (pin, progreso, WebGL) vive en HeroSequence/SeqScene; este
 * archivo pone SOLO el contenido, que el servidor renderiza completo: sin JS
 * o con reduced-motion no hay pin ni timeline y esto es un hero normal con la
 * conversación terminada. El titular sigue siendo el LCP.
 */
/**
 * El titular, palabra por palabra: el revelado cinético se hace en el
 * servidor (spans con su delay ya puesto), así que no cuesta un byte de JS.
 * El texto es EXACTAMENTE el mismo — los spans no cambian lo que lee un
 * buscador ni un lector de pantalla, y la regla global de reduced-motion
 * colapsa la animación al estado final.
 */
const TITLE_WORDS: Array<{ t: string; em?: boolean }> = [
  { t: 'Un' },
  { t: 'asistente' },
  { t: 'para' },
  { t: 'cada' },
  { t: 'persona' },
  { t: 'de' },
  { t: 'tu' },
  { t: 'empresa,' },
  { t: 'que' },
  { t: 'ya', em: true },
  { t: 'se', em: true },
  { t: 'sabe', em: true },
  { t: 'la', em: true },
  { t: 'empresa.', em: true },
];

/** La fase del alcance: titular serif, lead y CTAs. También el hero entero
 * cuando no hay secuencia (sin JS, reduced-motion, sin WebGL). */
function HeroIntro() {
  return (
    <div className="lp-wrap">
      <div className="lp-hero__copy">
        <p className="lp-marker lp-arrive">Un asistente por persona</p>
        <h1 className="lp-display lp-hero__display mt-4">
          {TITLE_WORDS.map((w, i) => (
            <Fragment key={`${i}-${w.t}`}>
              <span className="lp-wb">
                <span
                  className="lp-w"
                  style={{ animationDelay: `${(0.08 + i * 0.055).toFixed(3)}s` }}
                >
                  {w.em ? <em>{w.t}</em> : w.t}
                </span>
              </span>
              {i === TITLE_WORDS.length - 1 ? null : ' '}
            </Fragment>
          ))}
        </h1>
        <p className="lp-lead lp-hero__lead lp-arrive" style={{ animationDelay: '0.6s' }}>
          No es un chatbot al que hay que explicarle todo. Cortex ya leyó los correos, los
          contratos, las actas de las reuniones y los grupos de WhatsApp que le habilitaste.
          Preguntas en español y contesta diciendo de dónde lo sacó: el documento, el día y, si
          salió de una grabación, el minuto.
        </p>
        {/* Las dos únicas puertas que hay, disponibles desde el primer frame:
            nadie está obligado a ver la película entera para entrar. */}
        <div className="lp-hero__cta lp-arrive" style={{ animationDelay: '0.85s' }}>
          <Link href="/signup" className="lp-btn lp-btn--primary">
            Crear cuenta
          </Link>
          <Link href="/login" className="lp-btn lp-btn--ghost">
            Iniciar sesión
          </Link>
        </div>
      </div>
    </div>
  );
}

/** La culminación de la secuencia: del mito al producto. Copy corto a la
 * izquierda, la ventana viva del chat a la derecha. */
function HeroFinal() {
  return (
    <div className="lp-wrap lp-hero__grid">
      <div className="lp-hero__final-copy">
        {/* La cartela de cierre de la secuencia es el marker del hero final:
            del mito al producto, en cuatro palabras. */}
        <p className="lp-marker">esto es Cortex</p>
        <p className="lp-h2 lp-hero__final-title">
          Preguntas. Contesta. <em>Y dice de dónde lo sacó.</em>
        </p>
        <p className="lp-lead lp-hero__final-lead">
          Tres preguntas reales, contestadas con cifras y con su fuente: el documento, el día y el
          minuto. Pasa el cursor por una cita y mira de qué paso salió.
        </p>
        <div className="lp-hero__cta">
          <Link href="/signup" className="lp-btn lp-btn--primary">
            Crear cuenta
          </Link>
          <Link href="/login" className="lp-btn lp-btn--ghost">
            Iniciar sesión
          </Link>
        </div>
      </div>
      <div className="lp-hero__demo">
        <LiveDemo />
      </div>
    </div>
  );
}

function Hero() {
  return (
    <HeroSequence
      intro={<HeroIntro />}
      tagline={
        <p className="lp-seq__tagline">
          Un asistente para cada persona de tu empresa, <em>que ya se sabe la empresa.</em>
        </p>
      }
      final={<HeroFinal />}
    />
  );
}

/**
 * La cinta de capacidades: la costura entre la escena nocturna y la página
 * clara. Un loop lento en CSS puro — texto, no logos de terceros — que se
 * pausa al pasar el cursor y desaparece como animación con reduced-motion.
 * Todo lo que dice existe en el producto hoy.
 */
const CAPABILITIES = [
  'Lee el correo',
  'Entiende contratos',
  'Recoge las reuniones',
  'Contesta por WhatsApp',
  'Persigue la cartera',
  'Consulta RUNT y SIMIT',
  'Vigila vencimientos',
  'Arma informes con cifras',
  'Cruza el CRM',
  'Prepara tus reuniones',
  'Pide aprobación antes de enviar',
  'Cita la fuente de cada dato',
];

function CapabilityBand() {
  const row = (hidden: boolean) => (
    <ul className="lp-band__row" aria-hidden={hidden || undefined}>
      {CAPABILITIES.map((c) => (
        <li key={c} className="lp-band__item">
          {c}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="lp-band" aria-label="Lo que Cortex hace">
      <div className="lp-band__track">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}

function Objection() {
  return (
    <section className="lp-section lp-section--tint">
      <div className="lp-wrap">
        <div className="lp-head" data-reveal>
          <p className="lp-marker">La objeción</p>
          <h2 className="lp-h2">«Ya usamos ChatGPT»</h2>
          <p className="lp-lead">
            Claro. Y escribe bien. Lo que no sabe es qué le prometiste a tu cliente en marzo, qué
            quedó en el acta de hace tres semanas ni qué dijo el jefe de bodega en la llamada del
            jueves.
          </p>
        </div>

        <div className="lp-versus" data-reveal-group>
          <div className="lp-card lp-card--muted">
            <p className="lp-card__kicker">Un asistente genérico</p>
            <p className="lp-quote lp-quote--said">
              «Con gusto te ayudo. ¿Podrías indicarme los términos que acordaron con el cliente?»
            </p>
            <p className="lp-quote">
              Te devuelve la pregunta, porque no tiene cómo saberlo: nunca vio el contrato, ni el
              acta, ni la grabación. Redactar no era el problema.
            </p>
          </div>

          <div className="lp-card lp-card--mine">
            <p className="lp-card__kicker">Cortex</p>
            <p className="lp-quote lp-quote--said">
              «Los sábados no recibe. Quedó en la cláusula 9 del contrato marco y lo repitió el jefe
              de bodega el 31 de julio, en el minuto 12:04.»
            </p>
            <p className="lp-quote">
              La misma pregunta, contestada. La diferencia no es el modelo: es que uno leyó tu
              empresa y el otro no.
            </p>
          </div>
        </div>

        <div className="lp-cost" data-reveal-group>
          <div className="lp-cost__item">
            <p className="lp-cost__n">Le preguntas al que se acuerda</p>
            <p className="lp-small mt-1.5">
              Casi siempre la misma persona, la que lleva años y tiene la respuesta en la cabeza.
            </p>
          </div>
          <div className="lp-cost__item">
            <p className="lp-cost__n">Y eso cuesta dos veces</p>
            <p className="lp-small mt-1.5">
              El rato del que pregunta y el rato del que responde. Cada vez, todos los días.
            </p>
          </div>
          <div className="lp-cost__item">
            <p className="lp-cost__n">Hasta el día que no está</p>
            <p className="lp-small mt-1.5">
              Sale a vacaciones o se va, y la respuesta se va con ella: quedó en su bandeja, en su
              chat y en su memoria.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Industries() {
  return (
    <section className="lp-section" id="industrias">
      <div className="lp-wrap">
        <div className="lp-head" data-reveal>
          <p className="lp-marker">El mecanismo es uno; los ejemplos son tuyos</p>
          <h2 className="lp-h2">Elige a qué te dedicas</h2>
          <p className="lp-lead">
            Cortex no sabe de logística ni de contabilidad. Sabe de tu empresa: de lo que hay en tus
            correos, tus documentos y tus reuniones. Por eso las preguntas cambian de oficio en
            oficio y la respuesta se arma siempre igual.
          </p>
        </div>

        <div data-reveal>
          <IndustrySwitch />
        </div>
      </div>
    </section>
  );
}

/**
 * Three steps, labelled by WHEN they happen rather than numbered 01/02/03.
 * The order matters less than the cadence: one of them you do once, one you do
 * daily, and one happens whether you are looking or not — which is the actual
 * argument.
 *
 * En escritorio los tres pasos se recorren con scroll mientras un visual fijo
 * (una "ventana" del producto) cambia de estado con cada paso — ScrollStory
 * pone la maquinaria, este archivo pone todo el contenido. En pantallas
 * angostas o con reduced-motion, el CSS lo devuelve a la lista estática de
 * tarjetas de siempre.
 */

/** El visual fijo: tres estados de la misma ventana, uno por paso. */
function StoryVisual() {
  return (
    <div className="lp-story__panel" aria-hidden="true">
      <div className="lp-story__bar">
        <span className="lp-story__pip" />
        <span className="lp-story__who">Cortex</span>
        <span className="lp-story__mode lp-data" />
      </div>
      <div className="lp-story__stage">
        <div className="lp-story__scene lp-story__scene--a">
          <p className="lp-story__label">Fuentes conectadas</p>
          <div className="lp-story__chips">
            <span className="lp-story__chip">Gmail</span>
            <span className="lp-story__chip">Outlook</span>
            <span className="lp-story__chip">Google Drive</span>
            <span className="lp-story__chip">Google Meet</span>
            <span className="lp-story__chip">WhatsApp</span>
            <span className="lp-story__chip">Google Chat</span>
            <span className="lp-story__chip">HubSpot</span>
            <span className="lp-story__chip">Archivos y audios</span>
          </div>
          <p className="lp-story__foot lp-data">Drive cada 10 min · reuniones cada 30</p>
        </div>
        <div className="lp-story__scene lp-story__scene--b">
          <p className="lp-story__q">«¿El cliente recibe entregas los sábados?»</p>
          <p className="lp-story__a">
            Los sábados no recibe: quedó en la <strong>cláusula 9</strong> del contrato marco y lo
            repitió el jefe de bodega en la llamada del jueves.
          </p>
          <p className="lp-story__cite lp-data">Contrato marco · cláusula 9 · 31 jul, min 12:04</p>
        </div>
        <div className="lp-story__scene lp-story__scene--c">
          <p className="lp-story__label lp-story__label--amber">Aviso · 6:00 a. m.</p>
          <p className="lp-story__a">
            La póliza de cumplimiento vence en <strong className="lp-data">21 días</strong>. Nadie
            la ha renovado.
          </p>
          <p className="lp-story__foot">La fecha salió del contrato y la confirmó una persona.</p>
        </div>
      </div>
    </div>
  );
}

function HowItWorks() {
  return (
    <section className="lp-section lp-section--tint" id="como-funciona">
      <div className="lp-wrap">
        <div className="lp-head" data-reveal>
          <p className="lp-marker">Cómo funciona</p>
          <h2 className="lp-h2">
            Se alimenta solo. <em>Nadie tiene que subir nada.</em>
          </h2>
          <p className="lp-lead">
            La memoria de tu empresa ya existe: está repartida entre el correo, Drive, las reuniones
            y los chats. Cortex se conecta a donde ya está y la sigue leyendo.
          </p>
        </div>

        <ScrollStory
          visual={<StoryVisual />}
          steps={[
            <Fragment key="conectar">
              <p className="lp-step__when">Una vez</p>
              <h3 className="lp-h3">Conectas las fuentes</h3>
              <p>
                Google Workspace o Microsoft 365, Drive, las transcripciones de Google Meet y los
                grupos de WhatsApp que decidas habilitar — uno por uno, nunca todos por defecto.
                Toma una tarde y no se repite.
              </p>
              <div className="lp-srcs-row lp-story__pills">
                <span className="lp-pill">Gmail</span>
                <span className="lp-pill">Outlook</span>
                <span className="lp-pill">Google Drive</span>
                <span className="lp-pill">Google Meet</span>
                <span className="lp-pill">WhatsApp</span>
                <span className="lp-pill">Google Chat</span>
                <span className="lp-pill">HubSpot</span>
                <span className="lp-pill">Archivos y audios</span>
              </div>
            </Fragment>,
            <Fragment key="preguntar">
              <p className="lp-step__when">Todos los días</p>
              <h3 className="lp-h3">Preguntas en español</h3>
              <p>
                Desde Cortex, desde Google Chat o desde el mismo grupo de WhatsApp donde ya
                trabajan. Lo nuevo entra por su cuenta: Drive se revisa{' '}
                <span className="lp-data">cada 10 minutos</span> y las reuniones se recogen{' '}
                <span className="lp-data">cada 30</span>, así que preguntar por lo de esta mañana
                funciona.
              </p>
            </Fragment>,
            <Fragment key="avisar">
              <p className="lp-step__when">Sin que preguntes</p>
              <h3 className="lp-h3">Te avisa antes de que algo se venza</h3>
              <p>
                Un contrato, una póliza, una tecnomecánica. Cuando Cortex lee una fecha te la
                propone; cuando la confirmas, queda vigilada. El aviso sale a las{' '}
                <span className="lp-data">6:00 a. m.</span>, hora de Bogotá, con la anticipación que
                ese tipo de vencimiento merece, y si nadie responde vuelve a insistir.
              </p>
            </Fragment>,
          ]}
        />
      </div>
    </section>
  );
}

function Trust() {
  return (
    <section className="lp-section" id="confianza">
      <div className="lp-wrap">
        <div className="lp-head" data-reveal>
          <p className="lp-marker">Por qué se le puede creer</p>
          <h2 className="lp-h2">
            Preferimos una respuesta incómoda a una <em>inventada</em>.
          </h2>
          <p className="lp-lead">
            Un asistente que se equivoca con seguridad es peor que no tener asistente, porque nadie
            vuelve a revisar lo que dice. Estas cuatro reglas son las que hacen que valga la pena
            revisarlo la primera vez y confiar después.
          </p>
        </div>

        <div className="lp-trust" data-reveal-group>
          <div className="lp-card lp-trust__item">
            <h3 className="lp-h3">Cita en vez de afirmar</h3>
            <p>
              Cada respuesta se arma con pedazos de tus propios documentos, y cada pedazo llega
              nombrado: de qué archivo salió, de qué espacio, de qué día y —cuando es una grabación
              o un chat— de qué minuto y de quién.
            </p>
            <div className="lp-trust__demo">
              <p className="lp-data text-sm leading-relaxed">
                Llamada con el jefe de bodega · 31 jul · min 12:04
                <br />
                «Los sábados no hay quien reciba, mejor el lunes a primera hora.»
              </p>
            </div>
          </div>

          <div className="lp-card lp-trust__item">
            <h3 className="lp-h3">Dice «no sé» cuando no está adentro</h3>
            <p>
              Antes de contestar, Cortex mide qué tanto cubre tu archivo la pregunta. Si no
              encuentra nada, lo dice en esas palabras en lugar de rellenar; si encuentra poco,
              contesta y avisa que va con poco. No es un modo que se active: es la instrucción con
              la que trabaja siempre.
            </p>
            <div className="lp-trust__demo">
              <p className="text-sm leading-relaxed">
                «No encuentro nada sobre ese anexo en lo que tengo adentro. No quiero suponerlo: si
                existe, no ha entrado todavía.»
              </p>
            </div>
          </div>

          <div className="lp-card lp-trust__item lp-trust__wide">
            <h3 className="lp-h3">Las fechas se leen, no se calculan</h3>
            <p className="max-w-[62ch]">
              Si un contrato dice «vigencia de doce meses desde el 1 de enero», Cortex no deduce el
              vencimiento. Propone la fecha, muestra la frase exacta de la que salió y espera que
              una persona la confirme; mientras esté sin confirmar no dispara ningún aviso. Es la
              regla más incómoda del producto y la que evita que una fecha inventada acabe en el
              calendario de alguien.
            </p>
            <div className="lp-trust__demo lp-propose">
              <div>
                <p className="lp-propose__date lp-data">Vencimiento propuesto: 31 dic 2025</p>
                <p className="lp-fine mt-1.5">
                  Leído de <span className="lp-data">«Contrato de prestación · cláusula 3»</span>:
                  «vigencia de doce (12) meses contados desde el 1 de enero de 2025.»
                </p>
              </div>
              <div className="lp-propose__acts" aria-hidden>
                <span className="lp-mini lp-mini--go">Confirmar</span>
                <span className="lp-mini">Corregir</span>
              </div>
            </div>
            <p className="lp-fine mt-3">
              <Cite {...CITE.commitments} />
            </p>
          </div>

          <div className="lp-card lp-trust__item lp-trust__wide">
            <h3 className="lp-h3">Nada sale hacia afuera sin tu aprobación</h3>
            <p className="max-w-[62ch]">
              Un correo, una respuesta en WhatsApp, un evento en el calendario: Cortex prepara el
              texto y espera. Y es el texto exacto — lo que se ejecuta se compara contra una huella
              de lo que estaba en pantalla cuando dijiste que sí, y si algo cambió en el camino, no
              corre. Leer no necesita permiso; escribir siempre lo necesita.
            </p>
            <p className="lp-fine mt-3">
              <Cite {...CITE.approvals} />
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Control() {
  return (
    <section className="lp-section lp-section--tint" id="control">
      <div className="lp-wrap">
        <div className="lp-head" data-reveal>
          <p className="lp-marker">Control</p>
          <h2 className="lp-h2">
            Que cada quien tenga asistente no significa que <em>todos vean todo</em>.
          </h2>
          <p className="lp-lead">
            Es la primera pregunta que hace cualquiera que entienda el producto, y tiene que tener
            una respuesta concreta antes que una promesa.
          </p>
        </div>

        <div className="lp-control" data-reveal-group>
          <div className="lp-card lp-control__item">
            <h3 className="lp-h3">Cada persona alcanza lo suyo</h3>
            <p>
              Cuando Cortex entra a tu correo, tu Drive o tu calendario, entra con tu propia cuenta:
              no puede abrir nada que tú no pudieras abrir. Y hay dos archivos distintos — el
              compartido de la empresa y el tuyo. Lo que guardas en el tuyo no lo lee nadie más, ni
              siquiera un administrador.
            </p>
          </div>

          <div className="lp-card lp-control__item">
            <h3 className="lp-h3">Una empresa no ve a otra</h3>
            <p>
              Cada fila del producto lleva el sello de la empresa a la que pertenece, y el cliente
              de base de datos se niega a tocar una tabla que nadie haya clasificado. No es
              disciplina: hay una prueba automática que revisa el código en cada cambio y lo rechaza
              si alguien lo olvidó.
            </p>
          </div>

          <div className="lp-card lp-control__item">
            <h3 className="lp-h3">Queda registro de todo</h3>
            <p>
              Cada cosa que Cortex ejecuta escribe una fila: quién la pidió, qué hizo, cuándo, con
              qué resultado y cuánto tardó. Lo que se rechazó también queda, que es la mitad que
              suele faltar.
            </p>
            <p className="lp-fine mt-3">
              <Cite {...CITE.audit} />
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Priced per person, because that is what is being sold: one assistant each.
 * The rate is the headline and what that person brings with them is the small
 * print underneath — the quota is attached to the head, exactly like the
 * assistant, which is what makes a per-head price explain itself.
 *
 * Empresa is the SAME product at a lower rate. That is said in those words: a
 * volume discount reads as honest and sells better than implying the small plan
 * has been clipped, and clipping it would be a lie anyway.
 *
 * Two things are true today and are said plainly rather than glossed. There is
 * no payment gateway inside the product, and nothing in it adds or charges for
 * one more person on its own — seats are still a ceiling that a human moves.
 * A page whose entire subject is refusing to assert what it cannot support is a
 * strange place to start bluffing.
 */
function Pricing() {
  return (
    <section className="lp-section lp-section--brand" id="planes">
      <div className="lp-wrap">
        <div className="lp-head" data-reveal>
          <p className="lp-marker">Planes</p>
          <h2 className="lp-h2">Se cobra por persona, porque es un asistente por persona.</h2>
          <p className="lp-lead">
            No compras una licencia para el área de sistemas ni una bolsa que alguien se acaba el
            día 12. Cada quien entra con su asistente y con su cupo, y la cuenta del mes se saca
            multiplicando.
          </p>
        </div>

        <div className="lp-plans">
          <div className="lp-plan">
            <p className="lp-plan__name">Gratis</p>
            <p className="lp-plan__rate lp-data">$0</p>
            <p className="lp-plan__per">hasta 3 personas, sin tarjeta</p>
            <ul className="lp-plan__pkg">
              <li className="lp-fine">Cada persona trae al mes</li>
              <li>
                <b className="lp-data">50</b> respuestas
              </li>
              <li>
                <b className="lp-data">15</b> documentos
              </li>
            </ul>
            <div className="lp-plan__foot">
              <Link href="/signup" className="lp-btn lp-btn--ghost">
                Crear cuenta
              </Link>
            </div>
          </div>

          <div className="lp-plan lp-plan--pick">
            <p className="lp-plan__name">Equipo</p>
            <p className="lp-plan__rate lp-data">$30.000</p>
            <p className="lp-plan__per">por persona al mes, desde 5 personas</p>
            <ul className="lp-plan__pkg">
              <li className="lp-fine">Cada persona trae al mes</li>
              <li>
                <b className="lp-data">150</b> respuestas
              </li>
              <li>
                <b className="lp-data">70</b> documentos
              </li>
            </ul>
            <p className="lp-plan__math lp-data">
              15 personas × $30.000 = <b>$450.000</b> al mes
            </p>
            <div className="lp-plan__foot">
              <Link href="/signup" className="lp-btn lp-btn--primary">
                Empezar
              </Link>
            </div>
          </div>

          <div className="lp-plan">
            <p className="lp-plan__name">Empresa</p>
            <p className="lp-plan__rate lp-data">$24.000</p>
            <p className="lp-plan__per">por persona al mes, desde 25 personas</p>
            <ul className="lp-plan__pkg">
              <li className="lp-fine">Cada persona trae al mes</li>
              <li>
                <b className="lp-data">250</b> respuestas
              </li>
              <li>
                <b className="lp-data">150</b> documentos
              </li>
            </ul>
            <p className="lp-plan__math lp-data">
              30 personas × $24.000 = <b>$720.000</b> al mes
            </p>
            <div className="lp-plan__foot">
              <Link href="/signup" className="lp-btn lp-btn--ghost">
                Empezar
              </Link>
            </div>
          </div>

          <div className="lp-plan">
            <p className="lp-plan__name">Enterprise</p>
            <p className="lp-plan__rate">Hablemos</p>
            <p className="lp-plan__per">sin tope de personas, volumen acordado</p>
            <ul className="lp-plan__pkg">
              <li className="lp-fine">Se pacta contigo</li>
              <li>Ingreso con el directorio corporativo</li>
              <li>Región de datos por contrato</li>
              <li>Acuerdo de nivel de servicio</li>
              <li>Factura electrónica y pago anual</li>
            </ul>
            <div className="lp-plan__foot">
              <Link href="/signup" className="lp-btn lp-btn--ghost">
                Hablemos
              </Link>
            </div>
          </div>
        </div>

        <div className="lp-card mt-5">
          <h3 className="lp-h3">Empresa es el mismo producto, más barato por persona</h3>
          <p className="lp-small mt-2 max-w-[70ch]">
            No hay una versión capada abajo: el plan de $30.000 trae exactamente las mismas reglas,
            las mismas fuentes y las mismas citas que el de $24.000. Lo único que cambia con el
            tamaño es la tarifa — <span className="lp-data">$24.000 en vez de $30.000</span> cuando
            son más de 25 personas — y cuánto trae cada quien al mes.
          </p>
        </div>

        <p className="lp-fine mt-5 max-w-[74ch]">
          Precios en pesos colombianos, al mes. Los cupos se cuentan juntos para tu empresa; lo que
          cambia con cada persona que entra es cuánto suma al total. Enterprise es una conversación,
          no una casilla: el ingreso con el directorio corporativo y la región de datos se pactan en
          el contrato y hoy no están en el producto. Y todavía no cobramos dentro de Cortex —
          acordamos contigo cuántas personas entran y lo activamos; el producto no suma ni cobra una
          persona más por su cuenta.
        </p>

        <div className="lp-guards">
          <div className="lp-card">
            <h3 className="lp-h3">Puedes ver de dónde sale cada peso</h3>
            <p className="lp-small mt-2">
              El consumo no es un porcentaje: es una lista. Una fila por cada respuesta y por cada
              documento, con su fecha y el nombre de la conversación o del archivo que la produjo.
              Ni créditos ni tokens que haya que traducir a nada — se cuentan las dos cosas que
              alguien dice en voz alta: cuántas veces contestó y cuánto tiene adentro.
            </p>
            <p className="lp-fine mt-3">
              <Cite {...CITE.plan} />
            </p>
          </div>

          <div className="lp-card">
            <h3 className="lp-h3">Llegar al límite no corta nada</h3>
            <p className="lp-small mt-2">
              Nunca se interrumpe una conversación: la decisión se toma antes de empezar una
              respuesta, jamás a mitad de la que estás leyendo. Al pasar el límite hay un margen de
              cortesía; después dejamos de empezar respuestas nuevas, y eso es todo lo que se
              detiene. Los documentos no se rechazan nunca: siguen entrando, quedan legibles y se
              buscan por palabra, y sólo esperan turno para indexarse. Cuando hay espacio se indexan
              solos, sin volver a subirlos.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * El cierre rima con el hero: la página empieza de noche y termina de noche.
 * Mismo índigo profundo, mismo grano, misma luz lavanda — pero sin repetir el
 * organismo de partículas: aquí la luz es un gradiente quieto y lo que manda
 * es la CTA grande. El footer vive dentro de la misma noche, en columnas.
 */
function Close() {
  return (
    <section className="lp-night">
      <div className="lp-wrap lp-close" data-reveal>
        <p className="lp-marker">Empieza hoy</p>
        <h2 className="lp-h2 lp-night__title">
          El primer día <em>ya contesta</em>.
        </h2>
        <p className="lp-lead mt-4">
          No hay que entrenar nada ni escribir instrucciones. Conectas las fuentes por la mañana y
          en la tarde alguien de tu equipo le pregunta algo que hasta hoy sólo sabía otra persona —
          y recibe la respuesta con la frase, el documento y el día de los que salió.
        </p>
        <div className="lp-close__cta">
          <Link href="/signup" className="lp-btn lp-btn--primary">
            Crear cuenta
          </Link>
          <Link href="/login" className="lp-btn lp-btn--ghost">
            Ya tengo cuenta
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="lp-foot">
      <div className="lp-wrap lp-foot__grid">
        <div className="lp-foot__brand">
          <span className="lp-mark">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.png" alt="" width={24} height={24} />
            <span className="lp-mark__word">Cortex</span>
          </span>
          <p className="lp-foot__line">
            Un asistente para cada persona de tu empresa, que dice de dónde salió cada respuesta.
          </p>
        </div>
        <nav className="lp-foot__col" aria-label="Producto">
          <p className="lp-foot__h">Producto</p>
          <a href="#como-funciona">Cómo funciona</a>
          <a href="#industrias">Para tu oficio</a>
          <a href="#confianza">Por qué creerle</a>
          <a href="#control">Control y permisos</a>
        </nav>
        <nav className="lp-foot__col" aria-label="Cuenta">
          <p className="lp-foot__h">Cuenta</p>
          <Link href="/login">Iniciar sesión</Link>
          <Link href="/signup">Crear cuenta</Link>
        </nav>
      </div>
      <div className="lp-wrap lp-foot__base">
        <p className="lp-fine">Cortex · Hecho en Colombia</p>
      </div>
    </footer>
  );
}

export function Landing() {
  return (
    <div className={`lp ${displaySerif.variable}`}>
      {/* El cerebro de las reacciones del resto de la página: revelado por
          scroll, tilt de tarjetas, botones magnéticos, glow ambiental. No
          pinta nada y con reduced-motion no hace nada. */}
      <Interactive />
      <Masthead />
      <main>
        {/* La secuencia: alcance → contacto/big bang → nace CORTEX → el
            producto (la ventana viva). Ver HeroSequence para la maquinaria. */}
        <Hero />
        <div className="lp-after">
          <CapabilityBand />
          <Objection />
          <Industries />
          <HowItWorks />
          <Trust />
          <Control />
          {/*
          LOS PRECIOS ESTÁN EN PAUSA, NO BORRADOS.

          La sección `Pricing` sigue entera unas líneas más abajo — las tarifas,
          los cupos y la letra pequeña sobre que todavía no se cobra dentro del
          producto. Sólo se dejó de mostrar, y volver a ponerla es descomentar
          esta línea.

          Se quitó porque anunciar una tarifa obliga a sostenerla, y hoy no hay
          pasarela de pago dentro de Cortex: lo que hay es una conversación. Una
          página que promete «$30.000 por persona» y una puerta que sólo sabe
          crear una cuenta gratis son dos cosas que no encajan, y la que sobra
          es la promesa. Mientras tanto la página pide lo único que sí puede
          cumplir: entrar o abrir una cuenta.
        */}
          {/* <Pricing /> */}
          <Close />
        </div>
      </main>
      <Footer />
    </div>
  );
}
