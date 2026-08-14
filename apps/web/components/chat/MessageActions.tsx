'use client';

import { saveAnswerAsReportAction } from '@/app/(chat)/chat/actions';
import { clsx } from 'clsx';
import { BookmarkCheck, Check, Copy, Loader2, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * LO QUE SE HACE CON UNA RESPUESTA: COPIARLA, REHACERLA, CONSERVARLA.
 *
 * ===========================================================================
 * TRES, Y SÓLO LA ÚLTIMA LAS ENSEÑA SIN PEDIRLO
 * ===========================================================================
 * Una fila de botones bajo cada mensaje de un hilo de treinta es una pared, que
 * es literalmente la tesis de `TaskRows.tsx`. Así que la respuesta viva las
 * lleva a la vista —es sobre la que se está actuando— y las anteriores sólo
 * aparecen al pasar el ratón o al llegar tabulando (`focus-within`, para que no
 * sean invisibles a quien no usa ratón). Rehacer, además, sólo existe en la
 * última: rehacer una respuesta de en medio reescribiría la cola del hilo.
 *
 * ===========================================================================
 * LAS DOS QUE SE DESCARTARON, CON SU RAZÓN
 * ===========================================================================
 * PROGRAMARLO COMO RUTINA. Lo que se programa no es la respuesta, es la
 *   PREGUNTA — y está un renglón más arriba, con `/rutina` a una tecla de
 *   distancia («Todos los lunes a las 8 de la mañana, …») y su pantalla en
 *   /schedule. Un botón aquí tendría que decidir por su cuenta qué día, a qué
 *   hora y a quién se entrega, o abrir un formulario, y un formulario colgado
 *   de cada respuesta del hilo no es una acción, es una pantalla escondida.
 *   Poner una rutina real en marcha con un clic y sin elegir nada es la clase
 *   de cosa que se descubre tres lunes después.
 *
 * MANDÁRSELO A ALGUIEN. Ésta no es que sobre, es que va en contra de lo que el
 *   producto defiende. Una cifra que sale de aquí tiene que salir CON SU
 *   FUENTE: por eso el menú de selección ofrece «copiar con la fuente» y no
 *   «copiar», y por eso cada respuesta trae de dónde salió. Un botón de enviar
 *   pegado a una respuesta invita a reenviarle a un cliente un párrafo que
 *   nadie revisó, que es exactamente el artefacto que Cortex existe para dejar
 *   de producir. Redactar un correo sigue estando, dicho en voz alta y con su
 *   cola de aprobación detrás: «redáctame un correo para…».
 *
 * Y CONSERVAR SÍ ENTRA, porque es lo único de las tres que deja algo detrás:
 * una fila que se abre, se cita y se comparte cuando la conversación ya se
 * perdió de vista. Ver `saveAnswerAsReportAction` para por qué es una
 * fotografía y no un marcador.
 */

const button =
  'inline-flex items-center gap-1.5 rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none';

export function MessageActions({
  text,
  question,
  conversationId,
  messageId,
  onRegenerate,
  /** La respuesta viva. Las de más arriba se esconden hasta que se las busca. */
  pinned,
}: {
  text: string;
  question?: string;
  conversationId?: string;
  messageId: string;
  onRegenerate?: () => void;
  pinned?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const result = await saveAnswerAsReportAction({
      messageId,
      answer: text,
      ...(conversationId ? { conversationId } : {}),
      ...(question ? { question } : {}),
    });
    setSaving(false);
    if (!result.ok || !result.url) {
      setError(result.error ?? 'No se pudo guardar el informe.');
      return;
    }
    setSavedUrl(result.url);
  }

  return (
    <div
      className={clsx(
        'mt-1 flex flex-wrap items-center gap-0.5 transition-opacity duration-150 motion-reduce:transition-none',
        // Lo que dijo algo —se guardó, o no se pudo— deja de esconderse: un
        // mensaje que sólo se ve mientras el ratón está encima es un mensaje
        // que se pierde justo al apartarlo para leerlo.
        pinned || savedUrl || error
          ? 'opacity-100'
          : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
      )}
    >
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
        className={button}
        aria-label="Copiar mensaje"
        title="Copiar mensaje"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald" /> : <Copy className="h-3.5 w-3.5" />}
      </button>

      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          className={button}
          aria-label="Volver a generar la respuesta"
          title="Volver a generar la respuesta"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
      )}

      {savedUrl ? (
        // Guardada, el botón se convierte en la puerta. Ofrecer «guardar» otra
        // vez invitaría a un segundo informe idéntico — y aunque el servidor lo
        // impide, un botón que parece hacer algo y no lo hace es peor.
        <Link
          href={savedUrl}
          className="inline-flex items-center gap-1.5 rounded-pill bg-emerald-soft px-2.5 py-1 text-micro font-semibold text-emerald transition-colors duration-150 hover:bg-emerald/15 motion-reduce:transition-none"
        >
          <BookmarkCheck className="h-3.5 w-3.5" aria-hidden />
          Guardado — abrir informe
        </Link>
      ) : (
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className={button}
          aria-label="Conservar esta respuesta como informe"
          title="Conservar como informe"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <BookmarkCheck className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      {error && (
        <span role="alert" className="ml-1 text-micro text-rose">
          {error}
        </span>
      )}
    </div>
  );
}
