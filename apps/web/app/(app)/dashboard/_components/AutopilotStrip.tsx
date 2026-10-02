import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { ArrowRight, Plane } from 'lucide-react';
import Link from 'next/link';

/** La franja de Inicio, sin lecturas: la pinta AutopilotCard y la vitrina. */
export function AutopilotStrip({
  enabled,
  ran,
  running,
  done,
  waiting,
  href,
  runHour,
}: {
  enabled: boolean;
  ran: boolean;
  running: boolean;
  done: number;
  waiting: number;
  href: string;
  runHour: number;
}) {
  const h12 = runHour % 12 === 0 ? 12 : runHour % 12;
  const at = `${h12}:00 ${runHour < 12 ? 'a. m.' : 'p. m.'}`;
  const sentence = running
    ? 'estoy haciendo la ronda de hoy…'
    : ran
      ? `hoy hice ${done === 1 ? '1 cosa' : `${done} cosas`}${waiting > 0 ? `, te ${waiting === 1 ? 'espera 1' : `esperan ${waiting}`}` : ' y no te espera nada'}.`
      : enabled
        ? `hoy corro a las ${at}${waiting > 0 ? `; te ${waiting === 1 ? 'espera 1 de antes' : `esperan ${waiting} de antes`}` : ''}.`
        : 'apagado.';
  return (
    <Link
      href={href}
      className={clsx(
        'group mb-4 flex items-center gap-3 rounded-card border bg-surface px-4 py-3 shadow-card transition-colors hover:border-border-strong',
        waiting > 0 ? 'border-amber/30' : 'border-border',
      )}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
        <Plane className="h-4 w-4" aria-hidden />
      </span>
      <p className="min-w-0 flex-1 text-sm text-ink">
        <span className="font-bold">Piloto automático:</span>{' '}
        <span className="text-ink-muted">{sentence}</span>
      </p>
      {waiting > 0 && <span className={chipClass('amber')}>{waiting} por decidir</span>}
      <ArrowRight
        className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  );
}
