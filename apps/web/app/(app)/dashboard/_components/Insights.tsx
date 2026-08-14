'use client';

import { Provenance } from '@/components/ui/provenance';
import type { InsightView } from '@/lib/insights';
import type { Piece } from '@/lib/insights-shape';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, Lightbulb, MessageSquare, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * LO QUE NOTÉ.
 *
 * La tercera mitad del inicio. «Lo que te espera» es deuda de quien mira, «lo
 * que hice» es el trabajo de anoche, y esto es lo único de la pantalla que
 * nadie pidió: una cifra que se movió, con lo que hay detrás y con la pregunta
 * siguiente. Un hallazgo que no lleva a una pregunta es un dato, y este
 * producto no vende un tablero.
 *
 * ===========================================================================
 * EL ORDEN DE LAS TRES PIEZAS ES EL ARGUMENTO
 * ===========================================================================
 *   1. LA FRASE, en español y con las cifras en monoespaciada. Va primero
 *      porque es el hallazgo; el gráfico sólo lo sostiene. Al revés sería un
 *      tablero con un pie de foto.
 *   2. EL GRÁFICO, dibujado en el servidor por el renderizador del informe.
 *      Aquí llega como marcado ya hecho: este componente no dibuja nada.
 *   3. LA PREGUNTA, escrita como la haría una persona. Es la pieza que separa
 *      un hallazgo de un dato. Todavía no es un botón, y el porqué está
 *      argumentado donde se dibuja.
 *
 * ===========================================================================
 * NO SE MUEVE SOLO
 * ===========================================================================
 * La referencia de la que sale esta forma trae autoplay. Aquí no, y no es un
 * olvido: una pantalla de trabajo que cambia de contenido mientras alguien lee
 * una cifra le obliga a perseguirla, y hoy mismo se quitó del fondo del chat un
 * movimiento por exactamente ese motivo. El sistema de diseño lo dice en una
 * línea — el movimiento contesta una pregunta, nunca decora — y «¿qué más
 * había?» es una pregunta que ya contestan dos flechas y un contador.
 *
 * La única animación es `animate-rise`, la misma entrada que usan el resto de
 * los paneles del inicio, atada a la `key` de la tarjeta: cambia de página y la
 * nueva entra igual que entró la primera. No hay una clase `animate-` nueva —
 * `lib/motion-tokens.test.ts` falla con cualquier nombre no declarado, y una
 * animación inexistente no da error: simplemente no hace nada.
 */
export function Insights({ insights, gaps }: { insights: InsightView[]; gaps: string[] }) {
  const [at, setAt] = useState(0);
  const total = insights.length;
  const current = insights[Math.min(at, Math.max(total - 1, 0))];

  return (
    <section className="animate-rise mb-4 rounded-card border border-border bg-surface p-4 shadow-card sm:p-5">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold text-ink">Lo que noté</h2>
        </div>

        {total > 1 && (
          <div className="flex items-center gap-1.5">
            <span className="tabular text-micro text-ink-faint" aria-live="polite">
              {at + 1} de {total}
            </span>
            <Pager
              label="Hallazgo anterior"
              disabled={at === 0}
              onClick={() => setAt((i) => Math.max(0, i - 1))}
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            </Pager>
            <Pager
              label="Hallazgo siguiente"
              disabled={at >= total - 1}
              onClick={() => setAt((i) => Math.min(total - 1, i + 1))}
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Pager>
          </div>
        )}
      </header>

      {current ? (
        // La `key` reinicia la entrada en cada página: es la misma respuesta
        // —«esto es nuevo»— que da el resto de la pantalla al cargarse.
        <article key={current.id} className="animate-rise">
          <p className="text-base leading-snug text-ink-muted">
            {/*
              La clave lleva el contenido y no sólo la posición: dentro de una
              frase se repite el tipo («text», «text», «text») pero no el par
              tipo-más-texto, y la lista nunca se reordena — se sustituye
              entera al cambiar de hallazgo, y de eso ya se encarga la `key` del
              `<article>`.
            */}
            {current.sentence.map((piece, i) => (
              <SentencePiece key={`${i}-${piece.t}-${piece.v}`} piece={piece} />
            ))}
          </p>

          {/*
            El gráfico. `rp-doc` no es decorativo: `REPORT_CSS` está acotada a
            esa clase y va enlazada para toda la aplicación desde el layout
            raíz. Sin el envoltorio el SVG sale sin colores ni tipografía.
          */}
          <div className="mt-3 overflow-x-auto">
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: lo produjo `renderChart`, que escapa cada cadena; ver la cabecera de lib/insights.ts. */}
            <div className="rp-doc" dangerouslySetInnerHTML={{ __html: current.chartHtml }} />
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {/*
              LA PREGUNTA SIGUIENTE — y por qué todavía NO es un botón.
              =================================================================
              Es la pieza que convierte un dato en un hallazgo: lo que un
              gerente diría después de enseñarte la cifra. Debería llevar al
              chat con ella ya escrita, y no lo hace, porque hoy no existe la
              forma de abrir una conversación con un borrador puesto: `/chat`
              no lee ningún parámetro y `ChatRoot` no acepta un texto inicial.
              Los accesos que sí escriben en el compositor (`QuickChips`,
              `EmptyState`) viven DENTRO del chat y llaman a un callback.

              Así que se enseña como lo que es —la pregunta— en vez de como un
              botón que promete mandarla y deja al que lo pulsa en un chat
              vacío teniendo que reescribirla. Un control que no hace lo que su
              texto dice es la clase de mentira silenciosa que esta pantalla
              existe para no contar. En cuanto `ChatRoot` acepte un borrador
              inicial, esto es un `<Link>` y nada más cambia.
            */}
            <p className="inline-flex items-center gap-1.5 rounded-pill border border-primary/20 bg-primary-soft px-3 py-1.5 text-xs font-semibold text-primary-ink">
              <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {current.question}
            </p>

            {/*
              El sello. Nunca es opcional en un hallazgo: `readInsights` se
              niega a construir uno sin fuente, hora y aritmética, porque un
              sello vacío devalúa todos los de verdad.
            */}
            <Provenance
              source={current.provenance.source}
              readAt={current.provenance.readAt}
              detail={current.provenance.detail}
            />
          </div>
        </article>
      ) : (
        <Nothing hasGaps={gaps.length > 0} />
      )}

      {gaps.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-border pt-3">
          {gaps.map((gap) => (
            <li key={gap} className="flex items-start gap-2 text-xs text-ink-muted">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" aria-hidden />
              {gap}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Una pieza de la frase.
 *
 * Las cifras van en monoespaciada porque son lo que alguien copia o cita
 * (regla 3), y con el color de la noticia, no el del signo. Las entidades
 * llevan a su ficha cuando existe; cuando no, se dicen y ya. Un enlace que no
 * lleva a ninguna parte gasta la confianza de todos los que sí llevan.
 */
function SentencePiece({ piece }: { piece: Piece }) {
  if (piece.t === 'text') return <>{piece.v}</>;

  if (piece.t === 'figure') {
    return (
      <span
        className={clsx(
          'tabular font-semibold',
          piece.tone === 'emerald' && 'text-emerald',
          piece.tone === 'rose' && 'text-rose',
          piece.tone === 'neutral' && 'text-ink',
        )}
      >
        {piece.v}
      </span>
    );
  }

  if (piece.href) {
    return (
      <Link href={piece.href} className="font-semibold text-primary hover:text-primary-strong">
        {piece.v}
      </Link>
    );
  }
  return <span className="font-semibold text-ink">{piece.v}</span>;
}

function Pager({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded-pill border border-border text-ink-muted transition-all duration-150 hover:-translate-y-px hover:border-primary/30 hover:text-primary disabled:pointer-events-none disabled:opacity-30 motion-reduce:transform-none motion-reduce:transition-none"
    >
      {children}
    </button>
  );
}

/**
 * CERO HALLAZGOS ES UN RESULTADO, NO UN FALLO.
 *
 * Y es el estado normal de un espacio recién abierto: una meta no tiene
 * historia hasta que cierra su primer período después de fijarla, y no hay
 * relleno hacia atrás. Así que esto dice qué hace falta para que aparezca algo
 * y da el control que lo pone — que es lo que el sistema de diseño pide de una
 * pantalla vacía. Un carrusel de ejemplos aquí enseñaría a no creerse el
 * carrusel de verdad el día que lo hubiera.
 */
function Nothing({ hasGaps }: { hasGaps: boolean }) {
  return (
    <div className="py-2">
      <p className="text-sm leading-snug text-ink-muted">
        {hasGaps
          ? 'Todavía no tengo nada que contarte de lo que sí pude mirar.'
          : 'Todavía no tengo nada que contarte. Un hallazgo necesita dos períodos cerrados para compararse, y las metas empiezan a tener historia el primer mes que cierra después de fijarlas.'}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Link
          href="/goals"
          className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors duration-150 hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
        >
          Fijar una meta
        </Link>
        <Link
          href="/kb"
          className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors duration-150 hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
        >
          Subir facturas
        </Link>
      </div>
    </div>
  );
}
