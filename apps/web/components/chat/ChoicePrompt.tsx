'use client';

import type { ChoiceOption } from '@/lib/ask-choice';
import { clsx } from 'clsx';
import { CornerDownLeft, HelpCircle } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';

/**
 * CORTEX TE PREGUNTA, Y EL TURNO SE PARA HASTA QUE DECIDAS.
 *
 * ===========================================================================
 * POR QUÉ NO ES ÁMBAR, QUE ES LA DECISIÓN MÁS IMPORTANTE DEL ARCHIVO
 * ===========================================================================
 * `ConfirmationPrompt` es ámbar porque hay algo parado POR TU CULPA y que va a
 * ocurrir en cuanto digas que sí: un correo que sale, una fila que se escribe.
 * El ámbar dice «esto tiene consecuencias».
 *
 * Aquí no hay ninguna consecuencia. Es una pregunta: no se ejecuta nada al
 * elegir, y elegir mal se arregla escribiendo la siguiente frase. Pintarla del
 * mismo color enseñaría a la gente que ámbar significa «hay un botón», y el día
 * que aparezca el ámbar de verdad —con el payload desplegable y el botón que sí
 * manda el correo— ya lo habrían visto veinte veces. Así que va en el color del
 * producto: indigo, que es lo que `docs/design-system.md` reserva para «lo que
 * Cortex afirma» y para sus acciones. Ver también `looksLikeApproval` en
 * lib/ask-choice.ts, que impide por código que esto se disfrace de aprobación.
 *
 * ===========================================================================
 * ELEGIR MANDA UN MENSAJE TUYO, NO RESUELVE NADA EN SILENCIO
 * ===========================================================================
 * Es la otra diferencia con la confirmación, y es deliberada. Confirmar tiene
 * su propio rastro —una fila en `audit_events` y el resultado real de la
 * llamada— así que puede resolverse dentro de la tarjeta. Una RESPUESTA no
 * tiene rastro en ninguna parte salvo el hilo, y en este producto una
 * conversación tiene que poder releerse dos semanas después y explicarse sola.
 * Una decisión invisible rompe eso: se leería una respuesta que da por sabido
 * algo que nadie dijo nunca.
 *
 * Así que elegir «El lunes» escribe «El lunes» como mensaje de la persona, con
 * su burbuja y su sitio en el hilo, y el turno siguiente arranca solo. Es
 * también lo que hace que la respuesta sea EDITABLE en el sentido que importa:
 * si estaba mal, se dice en el mensaje siguiente, como con cualquier otra cosa.
 *
 * ===========================================================================
 * SIEMPRE HAY UNA SALIDA EN TEXTO LIBRE
 * ===========================================================================
 * Tres botones y ninguno es el que quieres es una trampa. «Ninguna — te digo
 * yo» abre un campo aquí mismo, pegado a la pregunta, y no manda a escribir
 * abajo: el compositor es de propósito general y una frase escrita ahí no se
 * lee como respuesta a nada. Escrita aquí, sí.
 *
 * Y el modelo tiene PROHIBIDO añadir una opción «otra» — lo dice la descripción
 * de la herramienta — precisamente porque esta salida ya existe siempre.
 *
 * ===========================================================================
 * QUÉ PASA AL RECARGAR
 * ===========================================================================
 * Nada nuevo hacía falta. El centinela viaja en `messages.tool_results` y
 * `toToolInvocations` lo reconstruye al reabrir el hilo, igual que el de
 * confirmación. Si la pregunta sigue siendo el último mensaje, la tarjeta
 * vuelve viva; si ya se contestó, hay un mensaje después y `live` es falso, así
 * que se queda como una línea que dice qué se preguntó. No hay estado que
 * guardar ni columna que añadir: la conversación ya lo sabía.
 */
export function ChoicePrompt({
  question,
  options,
  live,
  onAnswer,
}: {
  question: string;
  options: readonly ChoiceOption[];
  /**
   * Si esta pregunta sigue esperando. Falso en cuanto hay algo debajo en el
   * hilo — que es exactamente lo que significa haberla contestado.
   */
  live: boolean;
  onAnswer?: (text: string) => void;
}) {
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  // ---- Contestada: una línea, y sigue diciendo qué se preguntó -------------
  if (!live || sent) {
    return (
      <div className="mt-2 flex items-start gap-2 text-xs text-ink-faint">
        <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          Cortex te preguntó: <span className="text-ink-muted">{question}</span>
        </span>
      </div>
    );
  }

  function answer(value: string) {
    const clean = value.trim();
    if (!clean) return;
    setSent(clean);
    onAnswer?.(clean);
  }

  /**
   * Las flechas se mueven entre las opciones, sin robar el tabulador.
   *
   * Son botones de verdad, así que Tab y Enter funcionan sin ayuda; esto sólo
   * añade lo que se espera de un grupo de opciones. Nada se captura a nivel de
   * ventana —los atajos «1, 2, 3» de una terminal serían una trampa aquí,
   * porque debajo hay un compositor con el foco y escribir «2» mandaría una
   * respuesta que nadie quiso dar.
   */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
    const buttons = [
      ...(groupRef.current?.querySelectorAll<HTMLButtonElement>('[data-option]') ?? []),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: el elemento semántico que propone es <fieldset>, y un fieldset fuera de un formulario dice algo que aquí es falso — esto no recoge datos, agrupa opciones.
    <div
      role="group"
      aria-label="Cortex necesita que decidas"
      className="mt-2 overflow-hidden rounded-card border border-primary/20 bg-surface shadow-card"
    >
      {/*
        Lo que anuncia un lector de pantalla cuando la tarjeta aparece.
        `<output>` porque su rol implícito ES `status`, así que la región activa
        no hace falta declararla.

        Va aparte y no sobre la tarjeta entera a propósito: una región activa
        que contiene cinco botones se lee entera y a destiempo. Esto dice que
        hay algo esperando; los botones se leen al llegar a ellos.
      */}
      <output className="sr-only">Cortex está esperando que decidas: {question}</output>

      <div className="flex items-start gap-3 bg-primary-soft px-4 py-3.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-primary/15 text-primary-ink">
          <HelpCircle className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          {/* Nombra el estado del bloque entero, no un valor debajo — por eso
              no es `.field-label`, igual que en ConfirmationPrompt. */}
          <div className="text-micro font-semibold text-primary-ink">Necesito que decidas</div>
          <p className="mt-1 text-sm font-semibold text-ink">{question}</p>
        </div>
      </div>

      <div ref={groupRef} onKeyDown={onKeyDown} className="space-y-1.5 px-3 py-3">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            data-option
            onClick={() => answer(option.label)}
            className="flex w-full items-center gap-3 rounded-sm border border-border bg-surface px-3.5 py-2.5 text-left transition-all duration-150 hover:-translate-y-px hover:border-primary/30 hover:bg-primary-soft motion-reduce:transform-none motion-reduce:transition-none"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">{option.label}</span>
              {option.detail && (
                // Lo que distingue una opción de otra suele ser un NIT, una
                // ciudad o una fecha — evidencia, regla 3 del sistema de
                // diseño, así que va en monoespaciada.
                <span className="tabular mt-0.5 block truncate font-mono text-micro text-ink-faint">
                  {option.detail}
                </span>
              )}
            </span>
            <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
          </button>
        ))}

        {writing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              answer(text);
            }}
            className="flex items-center gap-2 pt-0.5"
          >
            <input
              // biome-ignore lint/a11y/noAutofocus: el campo no existe hasta que la persona lo pide con un clic o con Enter, así que no roba el foco a nadie; aparecer sin él obligaría a un segundo gesto para nada.
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-label="Tu respuesta"
              placeholder="Ninguna de ésas — te digo yo…"
              className="min-w-0 flex-1 rounded-pill border border-border bg-surface-2 px-3.5 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
            />
            <button
              type="submit"
              disabled={text.trim().length === 0}
              className="shrink-0 rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong disabled:opacity-40 disabled:shadow-none motion-reduce:transform-none motion-reduce:transition-none"
            >
              Responder
            </button>
          </form>
        ) : (
          <button
            type="button"
            data-option
            onClick={() => setWriting(true)}
            className={clsx(
              'w-full rounded-sm px-3.5 py-2 text-left text-xs font-medium text-ink-faint',
              'transition-colors duration-150 hover:bg-surface-2 hover:text-ink motion-reduce:transition-none',
            )}
          >
            Ninguna — te digo yo
          </button>
        )}
      </div>
    </div>
  );
}
