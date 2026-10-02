import { ArrowRight, Sparkles } from 'lucide-react';
import Link from 'next/link';

/**
 * LA CAJA DE «¿QUÉ RESOLVEMOS HOY?».
 *
 * El Inicio abre con una pregunta y un lugar donde contestarla, no con cifras.
 * Es un formulario GET a /chat: el chat ya recibe `?prompt=` como borrador, así
 * que no hace falta ni una línea de cliente — funciona sin JavaScript y Enter
 * hace lo que uno espera. Las sugerencias son enlaces con la pregunta escrita.
 */

const SUGGESTIONS = [
  'Resúmeme cómo va la semana',
  '¿Qué vence en los próximos 7 días?',
  '¿Quién me debe más de 60 días?',
  'Arma una vista de mis ventas',
];

export function AskCortex() {
  return (
    <div className="flex flex-col gap-3">
      <form
        action="/chat"
        method="get"
        className="flex items-center gap-2 rounded-[1.25rem] border-2 border-primary bg-surface py-2 pl-4 pr-2 shadow-pop focus-within:ring-4 focus-within:ring-primary/15"
      >
        <Sparkles className="h-5 w-5 shrink-0 text-primary" aria-hidden />
        <label htmlFor="ask-cortex" className="sr-only">
          Pídele algo a Cortex
        </label>
        <input
          id="ask-cortex"
          name="prompt"
          type="text"
          autoComplete="off"
          required
          maxLength={4000}
          placeholder="Pregunta o pide algo: «haz una tabla con las guías del Drive»…"
          className="min-w-0 flex-1 border-0 bg-transparent py-2 text-base font-medium text-ink outline-none placeholder:text-ink-faint sm:text-lg"
        />
        <button
          type="submit"
          className="cortex-primary-button inline-flex h-11 shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 text-sm font-bold text-white transition-colors hover:bg-primary-strong"
        >
          <span className="hidden sm:inline">Preguntar</span>
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </form>
      <ul className="flex flex-wrap gap-2" aria-label="Sugerencias">
        {SUGGESTIONS.map((s) => (
          <li key={s}>
            <Link
              href={`/chat?prompt=${encodeURIComponent(s)}`}
              className="inline-flex min-h-9 items-center rounded-pill border border-border bg-surface px-4 py-2 text-sm font-semibold text-ink-muted shadow-card transition-colors hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink"
            >
              {s}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
