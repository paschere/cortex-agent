import { AppWindow, Asterisk, BellOff, Eye, VideoOff } from 'lucide-react';

/**
 * Qué se captura y qué no, antes de pedir la pestaña.
 *
 * ---------------------------------------------------------------------------
 * ONE PROMISE, TWO FEATURES
 * ---------------------------------------------------------------------------
 * Cortex asks for somebody's tab in two places — to learn a trámite, and to
 * look at what they are seeing while they ask about it — and a person should
 * not have to learn two different promises from the same product. So the three
 * claims, their order and their headings are fixed here and the same on both
 * screens: only the tab you pick, nothing is kept, passwords are not
 * transcribed. Only the sentence under each heading changes, because the two
 * features do genuinely different things with the pixels and a claim that
 * describes the wrong one is not reassurance, it is a lie with good manners.
 *
 * Three cells rather than three bullets: the same three facts as a list read as
 * terms and conditions, and the one that people actually need — nothing is
 * kept — was buried in the middle of a four-line paragraph. Hairlines come from
 * the gap showing the border colour through, so they stay correct when the grid
 * reflows to one column on a phone.
 *
 * It goes ABOVE the button, every time the panel opens. After the browser's own
 * share prompt has appeared is too late to read anything, and a contract shown
 * once and filed away is a contract nobody has read.
 */

/**
 * ---------------------------------------------------------------------------
 * Y UNA TERCERA, QUE ES UNA PROMESA MÁS GRANDE
 * ---------------------------------------------------------------------------
 * `alert` es la vigilancia continua: Cortex mira solo, sin que nadie pregunte, y
 * avisa si ve algo. Comparte permiso con `watch` y no comparte promesa, así que
 * NO reutiliza sus tres celdas. La diferencia es la única que le importa a
 * alguien decidiendo: en `watch` la persona sabe exactamente cuándo la miraron,
 * porque fue cuando ella preguntó. Aquí no. Repetir «miro un cuadro cuando
 * preguntas» en esta pantalla sería el peor tipo de mentira: la que es verdad en
 * otra parte.
 *
 * Por eso las tres celdas cambian de contenido y una cambia de tema. La segunda
 * ya no habla de que no se guarda nada —eso también es cierto y sigue dicho— si
 * no de CADA CUÁNTO mira, que es lo que la persona se está preguntando. Y la
 * tercera deja de hablar sólo de claves para hablar de cómo se apaga, porque en
 * una función que mira sola, la salida es parte del trato.
 */
export type CaptureKind = 'teach' | 'watch' | 'alert';

const CELLS: Record<CaptureKind, { icon: typeof AppWindow; title: string; body: string }[]> = {
  teach: [
    {
      icon: AppWindow,
      title: 'Sólo la pestaña que elijas',
      body: 'Nada de tus otras ventanas, ni del escritorio, ni del correo que tengas abierto.',
    },
    {
      icon: VideoOff,
      title: 'No se guarda video',
      body: 'Sólo quedan los fotogramas donde la imagen cambió, y se borran al extraer el trámite.',
    },
    {
      icon: Asterisk,
      title: 'Las claves no se transcriben',
      body: 'Se ven como puntos y no las leo. Si vas a escribir algo que no debe quedar, pausa.',
    },
  ],
  watch: [
    {
      icon: AppWindow,
      title: 'Sólo la pestaña que elijas',
      body: 'Nada de tus otras ventanas, ni del escritorio, ni del correo que tengas abierto.',
    },
    {
      icon: VideoOff,
      title: 'No se guarda la imagen',
      body: 'Miro un cuadro cuando preguntas, respondo y se borra. En la conversación queda escrito que miré y a qué hora, y nada más.',
    },
    {
      icon: Asterisk,
      title: 'Las claves no se transcriben',
      body: 'Se ven como puntos y no las leo. Y entre pregunta y pregunta no miro nada: si vas a hacer algo que no debo ver, hazlo y ya.',
    },
  ],
  alert: [
    {
      icon: AppWindow,
      title: 'Sólo la pestaña que elijas',
      body: 'Nada de tus otras ventanas, ni del escritorio, ni del correo que tengas abierto.',
    },
    {
      icon: Eye,
      title: 'Miro cuando la pantalla cambia',
      body: 'No cada segundo: comparo la imagen aquí en tu navegador y sólo miro de verdad cuando cambió algo. Verás cuántas veces llevo y cuánto va costando.',
    },
    {
      icon: BellOff,
      title: 'Hablo poco y paras de un clic',
      body: 'Sólo abro la boca por un error, un vencimiento o un campo mal puesto; si no hay nada, no digo nada. La franja de arriba queda encendida mientras miro, con el botón para apagarme.',
    },
  ],
};

export function CaptureContract({ kind }: { kind: CaptureKind }) {
  return (
    <div className="mt-5 grid gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3">
      {CELLS[kind].map((cell) => (
        <div key={cell.title} className="bg-surface-2 p-3.5">
          <div className="flex items-center gap-1.5">
            <cell.icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
            <p className="text-[12.5px] font-semibold text-ink">{cell.title}</p>
          </div>
          <p className="mt-1 text-[11.5px] leading-snug text-ink-muted">{cell.body}</p>
        </div>
      ))}
    </div>
  );
}
