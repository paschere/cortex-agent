import { Panel } from '@/components/ui/panel';
import type { Journal, JournalKind, JournalLine } from '@/lib/journal-shape';
import { clsx } from 'clsx';
import {
  ArrowRight,
  BrainCog,
  CalendarClock,
  Clock3,
  Globe,
  Hourglass,
  Mailbox,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Telescope,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';

/**
 * «LO QUE HICE», AL LADO DE «LO QUE TE ESPERA».
 *
 * Las dos columnas son el producto entero dicho en un renglón: a la izquierda
 * la deuda de quien mira, a la derecha el trabajo de Cortex. Hasta ahora sólo
 * existía la izquierda, y esa asimetría es exactamente por qué un gerente se
 * leía como un repartidor de tareas.
 *
 * LA LÍNEA ES EL DATO, NO LA DECORACIÓN. Cada renglón es una hora y una frase
 * en primera persona; no hay tarjetas, ni cifras grandes, ni gráficos. Un parte
 * de trabajo se lee como una lista de lo que uno hizo, porque eso es lo que es.
 *
 * EL ICONO NO ES UN ADORNO: dice de qué clase de trabajo se trata, que es lo
 * único que la frase no lleva encima y lo que permite recorrer la columna con
 * la vista sin leerla entera.
 *
 * Ninguna de estas frases se compone aquí. Todas vienen ya escritas de
 * `journal-shape.ts`, que es donde están las reglas y donde se prueban.
 */

const ICON: Record<JournalKind, React.ComponentType<{ className?: string }>> = {
  commitments: CalendarClock,
  drafts: Mailbox,
  sent: Send,
  mandate: ShieldCheck,
  flow: Globe,
  errand: Telescope,
  routine: RefreshCw,
  memory: Sparkles,
  learning: BrainCog,
  lingering: Hourglass,
};

const DOT: Record<string, string> = {
  neutral: 'text-ink-faint',
  primary: 'text-primary',
  emerald: 'text-emerald',
  amber: 'text-amber',
  rose: 'text-rose',
};

export function DayJournal({
  journal,
  /** Cuántas líneas caben antes de mandar a la jornada completa. */
  limit = 7,
  href = '/dashboard/jornada',
}: {
  journal: Journal;
  limit?: number;
  href?: string;
}) {
  // Lo más reciente primero, atravesando los días: la columna es un vistazo, y
  // un vistazo empieza por lo último que pasó. La jornada completa sí conserva
  // la separación por día, que es donde esa separación significa algo.
  const flat = journal.days.flatMap((d) => d.lines.map((line) => ({ line, day: d.label })));
  const shown = flat.slice(0, limit);
  const hidden = flat.length - shown.length;

  return (
    <Panel className="animate-rise flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="field-label">Lo que hice</div>
        <Link
          href={href}
          className="group inline-flex items-center gap-1 text-micro font-semibold text-primary hover:text-primary-strong"
        >
          La jornada completa
          <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
      <div className="rule-double" />

      <p
        className={clsx(
          'px-4 pt-3 text-sm font-semibold leading-snug',
          journal.total > 0 ? 'text-ink' : 'text-ink-muted',
        )}
      >
        {journal.headline}
      </p>

      {shown.length > 0 ? (
        <ol className="mt-1 flex-1 px-2 pb-1 pt-1">
          {shown.map(({ line, day }, i) => (
            <JournalRow
              key={line.id}
              line={line}
              // La etiqueta del día sólo aparece cuando cambia. Repetir «Hoy»
              // siete veces gasta la única señal que separa anoche de esta
              // mañana.
              day={i === 0 || day !== shown[i - 1]?.day ? day : null}
            />
          ))}
        </ol>
      ) : (
        // El vacío promete lo que Cortex DEJARÍA aquí, exactamente como hacen
        // las colas vacías del índice de al lado (`QUEUE_EMPTY`). No es relleno:
        // es la única forma de que una columna en blanco signifique algo.
        <JournalQuiet>
          Aquí queda lo que hago solo: reviso los vencimientos a las 6:00, dejo correos redactados a
          las 6:30 y anoto de madrugada lo que aprendo de cómo trabajas.
        </JournalQuiet>
      )}

      {hidden > 0 && (
        <div className="px-4 pb-2">
          <Link href={href} className="text-micro font-semibold text-primary hover:underline">
            y {hidden} más de anoche y hoy
          </Link>
        </div>
      )}

      {journal.lingering.length > 0 && (
        <div className="mt-auto border-t border-border px-4 py-2.5">
          <div className="field-label mb-1.5">Y sigue sin moverse</div>
          <ul className="space-y-1">
            {journal.lingering.map((line) => (
              <li key={line.id} className="flex items-start gap-2 text-xs leading-snug">
                <Hourglass className="mt-[3px] h-3.5 w-3.5 shrink-0 text-amber" />
                <span className="text-ink-muted">{line.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <JournalGaps gaps={journal.gaps} />
    </Panel>
  );
}

/**
 * Un renglón: la hora, el icono de la clase y la frase.
 *
 * La hora va en cifras tabulares y a la izquierda de todo porque la columna se
 * lee de arriba abajo buscando «¿a qué hora?», no «¿qué clase?».
 */
export function JournalRow({ line, day }: { line: JournalLine; day: string | null }) {
  const Icon = ICON[line.kind];
  const body = (
    <div className="flex items-start gap-2.5">
      <span className="tabular mt-[1px] w-[38px] shrink-0 text-micro font-semibold text-ink-faint">
        {line.clock}
      </span>
      <Icon className={clsx('mt-[2px] h-3.5 w-3.5 shrink-0', DOT[line.tone] ?? DOT.neutral)} />
      <span
        className={clsx(
          'min-w-0 flex-1 text-xs leading-snug',
          line.attention ? 'font-medium text-ink' : 'text-ink-muted',
        )}
      >
        {line.text}
      </span>
    </div>
  );

  return (
    <li>
      {day && (
        <div className="px-2 pb-1 pt-2 text-micro font-bold uppercase tracking-wider text-ink-faint first:pt-0">
          {day}
        </div>
      )}
      {line.href ? (
        <Link
          href={line.href}
          className="block rounded-sm px-2 py-1.5 transition-colors hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
        >
          {body}
        </Link>
      ) : (
        <div className="px-2 py-1.5">{body}</div>
      )}
    </li>
  );
}

/**
 * Lo que no se pudo leer, dicho con nombre.
 *
 * Una clase de actividad caída se OMITE y SE ANUNCIA. La alternativa —dibujar
 * la columna como si esa clase no hubiera tenido trabajo— es la mentira exacta
 * que `lib/supabase/read.ts` existe para no volver a contar: una pantalla vacía
 * y una rota se ven igual y significan lo contrario.
 */
export function JournalGaps({ gaps }: { gaps: string[] }) {
  if (gaps.length === 0) return null;
  return (
    <div className="mt-auto border-t border-border px-4 py-2.5">
      <ul className="space-y-1">
        {gaps.map((gap) => (
          <li key={gap} className="flex items-start gap-1.5 text-micro leading-snug text-rose">
            <TriangleAlert className="mt-[2px] h-3.5 w-3.5 shrink-0" />
            <span>{gap}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** El reloj vacío que se dibuja cuando de verdad no hubo nada. */
export function JournalQuiet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-6 text-xs text-ink-muted">
      <Clock3 className="h-4 w-4 shrink-0 text-ink-faint" />
      <span>{children}</span>
    </div>
  );
}
