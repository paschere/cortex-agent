'use client';

import type { Shortcut } from '@/lib/chat-shortcuts';
import { clsx } from 'clsx';
import { CornerDownLeft } from 'lucide-react';

/**
 * LOS CINCO ACCESOS DE ESA PERSONA, ENCIMA DE LA CAJA DE ESCRIBIR.
 *
 * Quién decide qué sale aquí está en `lib/chat-shortcuts.ts` — se aprende del
 * uso, con el mismo criterio (decaimiento y piso mínimo) que ordena el rail, y
 * sin uso todavía son unos pocos por defecto. Este archivo sólo los dibuja.
 *
 * UN CLIC MANDA. No escribe en el compositor: la fila sólo admite frases
 * enteras (`isSendable`), así que no hay nada que completar antes de enviar, y
 * un chip que dejara la frase escrita obligaría a un segundo gesto para la
 * única cosa que se iba a hacer con ella. Lo que sí se retoca antes de mandar
 * son las tarjetas de la pantalla vacía y los seguimientos, que ESCRIBEN — la
 * diferencia es que aquéllas proponen y esto repite.
 *
 * SE ESCONDE EN CUANTO ALGUIEN ESCRIBE. Es la fila para EMPEZAR; sobre un
 * borrador a medias es una distracción encima del sitio donde se está mirando,
 * y además le deja el hueco al menú del `/`, que se abre justo ahí.
 *
 * ESTRECHO. Una sola fila que se desplaza a lo ancho, nunca dos líneas
 * amontonadas: el compositor de un teléfono ya lleva adjuntos, dictado,
 * pantalla, ámbito y agente debajo, y dos filas de chips encima lo convierten
 * en un formulario. Los chips no se encogen (`shrink-0`), así que el que no
 * cabe se ve a medias y se arrastra — que es la señal de que hay más.
 */
export function QuickChips({
  shortcuts,
  onPick,
  disabled,
}: {
  shortcuts: Shortcut[];
  onPick: (phrase: string) => void;
  disabled?: boolean;
}) {
  if (shortcuts.length === 0) return null;

  return (
    <div
      // No es una barra de herramientas: son enlaces a preguntas. `group` para
      // que el signo de «se manda» aparezca en el que está bajo el ratón.
      // biome-ignore lint/a11y/useSemanticElements: `role="group"` con nombre es lo que es — un puñado de botones emparentados. `<fieldset>` es de un formulario y aquí no se rellena nada.
      role="group"
      aria-label="Lo que más preguntas"
      className="scroll-slim mb-2 flex items-center gap-1.5 overflow-x-auto pb-0.5"
    >
      {shortcuts.map((shortcut) => (
        <button
          key={shortcut.id}
          type="button"
          disabled={disabled}
          onClick={() => onPick(shortcut.phrase)}
          title={shortcut.phrase}
          className={clsx(
            'group inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border bg-surface',
            'px-3 py-1.5 text-xs font-medium text-ink-muted shadow-card',
            'transition-colors duration-150 hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            'disabled:opacity-40 motion-reduce:transition-none',
          )}
        >
          {shortcut.label}
          <CornerDownLeft
            className="h-3 w-3 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-60 motion-reduce:transition-none"
            aria-hidden
          />
        </button>
      ))}
    </div>
  );
}
