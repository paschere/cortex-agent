import { Panel } from '@/components/ui/panel';
import { CalendarCheck, Clock, Inbox, MessageSquareText, Settings2, Users } from 'lucide-react';
import Link from 'next/link';
import { pillLink, pillPrimary } from './pieces';

/**
 * LA EMPRESA QUE TODAVÍA NO TIENE TRABAJO REGISTRADO: qué va a haber aquí y
 * cómo llenarlo. Nada de tarjetas en cero que parecen gente sin trabajo.
 */
export function EmptyTeam({
  canConfigure,
  settingsHref,
  connectHref,
}: {
  canConfigure: boolean;
  settingsHref: string;
  connectHref: string;
}) {
  const promises = [
    {
      icon: Users,
      text: 'Qué tiene abierto cada persona, qué ya venció y qué cerró en la semana.',
    },
    {
      icon: Clock,
      text: 'Qué tanto se cierra a tiempo y cuánto tarda, contra su propia historia.',
    },
    {
      icon: Inbox,
      text: 'Lo que no tiene responsable, y a quién se le podría pasar con un clic.',
    },
    {
      icon: CalendarCheck,
      text: '«Mi semana» para cada persona: lo suyo, lo que mejoró y lo que la espera.',
    },
  ];
  return (
    <Panel className="overflow-hidden">
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="p-6 sm:p-8">
          <h2 className="text-xl font-extrabold text-ink">El trabajo del equipo, sin ranking</h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-muted">
            Cuando Cortex lea el trabajo de tu equipo —casos de Gerencia, compromisos, una tabla con
            responsable, lo que se anote en el chat— aquí vas a ver cómo va cada quien. Se mide el
            trabajo, nunca el contenido de chats o correos, y cada persona ve todo lo que se mide de
            ella.
          </p>
          <ul className="mt-5 space-y-3">
            {promises.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm text-ink">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="pt-1.5">{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-border bg-surface-2/60 p-6 sm:p-8 lg:border-l lg:border-t-0">
          <h3 className="text-base font-bold text-ink">Conecta el trabajo del equipo</h3>
          <ol className="mt-4 space-y-4">
            {canConfigure && (
              <li>
                <p className="text-sm text-ink-muted">
                  Elige una tabla donde ya llevan el trabajo (guías, pedidos, solicitudes) y di qué
                  campo es el responsable, el estado y la fecha.
                </p>
                <Link href={settingsHref} className={`${pillPrimary} mt-2`}>
                  <Settings2 className="h-3.5 w-3.5" aria-hidden />
                  Conecta el trabajo del equipo
                </Link>
              </li>
            )}
            <li>
              <p className="text-sm text-ink-muted">
                O cuéntaselo a Cortex: mira tus tablas y fuentes, y te propone cómo conectarlas
                antes de cambiar nada.
              </p>
              <Link href={connectHref} className={`${canConfigure ? pillLink : pillPrimary} mt-2`}>
                <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
                Quiero medir el trabajo de mi equipo
              </Link>
            </li>
          </ol>
        </div>
      </div>
    </Panel>
  );
}
