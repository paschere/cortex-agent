'use client';

import { ERRAND_TONE, ErrandStatusPill } from '@/app/(app)/errands/_components/status';
import { ERRAND_BOUNDARY_NOTICE, type ErrandState } from '@/lib/errands-shape';
import { chipClass } from '@/lib/status-chip';
import { HelpCircle, Telescope } from 'lucide-react';
import Link from 'next/link';
import type { ResultViewProps } from './registry';

/**
 * «¿EN QUÉ VA LO QUE TE ENCARGUÉ?» — Y, SOBRE TODO, «TE ESTÁ ESPERANDO A TI».
 *
 * ===========================================================================
 * LA PREGUNTA DETENIDA ES LO QUE ESTA TARJETA EXISTE PARA ENSEÑAR
 * ===========================================================================
 * Un encargo trabaja solo durante cuarenta minutos, y a mitad de camino puede
 * pararse a preguntar algo que sólo una persona puede contestar. Mientras nadie
 * conteste, ese encargo NO AVANZA — y una fila gris con un JSON detrás de un
 * chevron es la forma perfecta de que nadie se entere. Por eso la pregunta va en
 * ámbar, arriba, con sus opciones tal cual y con la frase que dice dónde se
 * contesta: aquí mismo, en esta conversación.
 *
 * Ámbar y no rosa, por la razón que `_components/status.tsx` dejó escrita: nada
 * está roto y nada se ha perdido. Preguntar es la conducta que esta función se
 * construyó para producir; pintarla de rojo enseña a leer una pregunta como un
 * fallo, que es justo al revés.
 *
 * ===========================================================================
 * EL RESULTADO SE LEE AQUÍ, NO EN OTRA PANTALLA
 * ===========================================================================
 * Lo que un encargo entregó viene entero en el resultado, así que se enseña
 * entero: mandar a alguien a `/errands` a leer lo que acaba de preguntar es
 * exactamente el viaje que todo este registro existe para ahorrar. Va plegado
 * porque tres entregas abiertas son una pared, y el enlace al detalle sigue ahí
 * para las vueltas, las fuentes y el gasto.
 *
 * ===========================================================================
 * EL LÍMITE, DICHO DONDE SE LEE
 * ===========================================================================
 * `ERRAND_BOUNDARY_NOTICE` es la promesa sobre la que se vende esta función —
 * un encargo busca, compara y propone, y nunca compra ni firma por su cuenta.
 * Se cita literal desde `lib/errands-shape.ts`, que es la copia vigilada de la
 * frase que el motor de verdad hace cumplir; una pantalla que dijera algo más
 * blando que lo que el código impone sería peor que una que no dijera nada.
 */

interface Question {
  question: string;
  why: string;
  options: string[];
}

interface Errand {
  errandId: string;
  kind: string;
  what: string;
  state: string;
  progress: string;
  waitingOnYou: Question | null;
  result: string | null;
}

export function ErrandsStatus({ result }: ResultViewProps) {
  const view = statusOf(result);
  if (!view) return null;

  if (view.errands.length === 0) {
    return (
      <div className="flex items-start gap-2 rounded-card border border-border bg-surface px-4 py-3 text-sm leading-relaxed text-ink-muted shadow-card">
        <Telescope className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        No hay ningún encargo andando ni cerrado hace poco.
      </div>
    );
  }

  // Lo que espera por una persona va primero. El resto conserva el orden que
  // trajo la herramienta, que es el suyo y no una segunda opinión.
  const ordered = [
    ...view.errands.filter((e) => e.waitingOnYou),
    ...view.errands.filter((e) => !e.waitingOnYou),
  ];

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Telescope className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="field-label">Encargos</span>
        <span className="ml-auto text-micro text-ink-faint">{view.summary}</span>
      </div>

      <ul className="divide-y divide-border">
        {ordered.map((e) => (
          <ErrandRow key={e.errandId} errand={e} />
        ))}
      </ul>

      <p className="border-t border-border bg-surface-2 px-4 py-2.5 text-micro leading-relaxed text-ink-faint">
        {ERRAND_BOUNDARY_NOTICE}
      </p>
    </div>
  );
}

function ErrandRow({ errand: e }: { errand: Errand }) {
  const state = e.state in ERRAND_TONE ? (e.state as ErrandState) : null;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {state ? (
          <ErrandStatusPill state={state} />
        ) : (
          <span className={chipClass('neutral')}>{e.state}</span>
        )}
        <span className="text-micro font-semibold uppercase tracking-field text-ink-faint">
          {e.kind}
        </span>
        <Link
          href={`/errands/${e.errandId}`}
          className="ml-auto text-micro font-medium text-ink-faint transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
        >
          Ver el detalle
        </Link>
      </div>

      <p className="mt-1.5 text-sm font-semibold leading-snug text-ink">{e.what}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{e.progress}</p>

      {e.waitingOnYou && <Waiting question={e.waitingOnYou} />}

      {e.result && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-ink-muted transition-colors duration-150 hover:text-ink motion-reduce:transition-none">
            Lo que entregó
          </summary>
          <p className="scroll-slim mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-surface-2 px-3 py-2 text-xs leading-relaxed text-ink-muted">
            {e.result}
          </p>
        </details>
      )}
    </li>
  );
}

function Waiting({ question }: { question: Question }) {
  return (
    <div className="mt-2 rounded-sm border border-amber/25 bg-amber-soft px-3 py-2">
      <p className="flex items-start gap-1.5 text-xs font-semibold leading-snug text-amber">
        <HelpCircle className="mt-[2px] h-3.5 w-3.5 shrink-0" aria-hidden />
        {question.question}
      </p>
      {question.why && <p className="mt-1 text-micro leading-relaxed text-amber">{question.why}</p>}
      {question.options.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {question.options.map((option) => (
            <li key={option} className={chipClass('amber')}>
              {option}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-micro text-ink-muted">
        Contéstame aquí mismo y sigue desde donde iba: no pierde nada de lo que llevaba.
      </p>
    </div>
  );
}

/**
 * Lo que llega cruzó un stream y, en una conversación reabierta, una fila de la
 * base. Una fila sin `errandId` se cae: el enlace al detalle y la respuesta que
 * lo desatasca se dirigen por ese id, y una tarjeta que apunte a ninguna parte
 * es peor que ninguna tarjeta.
 */
function statusOf(result: unknown): { errands: Errand[]; summary: string } | null {
  if (!result || typeof result !== 'object' || '__error' in result) return null;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.errands)) return null;

  const errands = r.errands.flatMap((row): Errand[] => {
    if (!row || typeof row !== 'object') return [];
    const e = row as Record<string, unknown>;
    if (typeof e.errandId !== 'string' || typeof e.what !== 'string') return [];
    const waiting = e.waitingOnYou;
    return [
      {
        errandId: e.errandId,
        kind: typeof e.kind === 'string' ? e.kind : 'Encargo',
        what: e.what,
        state: typeof e.state === 'string' ? e.state : 'queued',
        progress: typeof e.progress === 'string' ? e.progress : '',
        waitingOnYou:
          waiting &&
          typeof waiting === 'object' &&
          typeof (waiting as Question).question === 'string'
            ? {
                question: (waiting as Question).question,
                why: typeof (waiting as Question).why === 'string' ? (waiting as Question).why : '',
                options: Array.isArray((waiting as Question).options)
                  ? (waiting as Question).options.filter((o): o is string => typeof o === 'string')
                  : [],
              }
            : null,
        result: typeof e.result === 'string' && e.result.trim() ? e.result : null,
      },
    ];
  });

  return {
    errands,
    summary: typeof r.summary === 'string' ? r.summary : '',
  };
}
