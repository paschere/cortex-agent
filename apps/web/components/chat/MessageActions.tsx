'use client';

import { saveAnswerAsReportAction } from '@/app/(chat)/chat/actions';
import {
  type FeedbackReasonId,
  REASON_CHIPS,
  clearRating,
  loadVotes,
  rememberVote,
  sendRating,
} from '@/lib/feedback-client';
import { clsx } from 'clsx';
import { BookmarkCheck, Check, Copy, Loader2, RotateCw, ThumbsDown, ThumbsUp } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

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
  // 👍/👎: el voto propio, la caja de «¿qué estuvo mal?» y el aviso de lo aprendido.
  const [vote, setVote] = useState<1 | -1 | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState<FeedbackReasonId | null>(null);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [thanks, setThanks] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    void loadVotes(conversationId).then((votes) => {
      const found = votes.get(messageId);
      if (alive && found) setVote(found);
    });
    return () => {
      alive = false;
    };
  }, [conversationId, messageId]);

  async function rate(next: 1 | -1) {
    if (!conversationId) return;
    setError(null);
    setThanks(null);
    // Pulsar el voto activo lo quita (deshacer).
    if (vote === next) {
      setVote(null);
      setAsking(false);
      const out = await clearRating({ conversationId, messageId });
      if (!out.ok) {
        setVote(next);
        setError(out.error);
      } else rememberVote(conversationId, messageId, null);
      return;
    }
    setVote(next);
    if (next === -1) {
      setAsking(true);
    } else {
      setAsking(false);
    }
    const out = await sendRating({ conversationId, messageId, rating: next });
    if (!out.ok) {
      setVote(null);
      setAsking(false);
      setError(out.error);
      return;
    }
    rememberVote(conversationId, messageId, next);
  }

  async function submitReason() {
    if (!conversationId) return;
    setSending(true);
    const out = await sendRating({
      conversationId,
      messageId,
      rating: -1,
      reason,
      comment: comment.trim() || null,
    });
    setSending(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setAsking(false);
    setThanks(
      out.proposed
        ? 'Gracias. Aprendí esto: lo dejé propuesto para la memoria de la empresa.'
        : 'Gracias, lo tendremos en cuenta.',
    );
  }

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
    // El pie de la respuesta: donde termina el carril y donde vive la prueba.
    // `-ml-1.5` mete los botones redondos medio paso a la izquierda para que su
    // TEXTO —no su caja— caiga sobre el mismo margen que la prosa de arriba.
    //
    // LA PROCEDENCIA YA NO VIVE AQUÍ. `BrainSources` se volvió una sección con
    // lista propia que se expande en el flujo y a la que las citas del texto
    // saltan al pulsarlas — necesita hablar con `ChatMarkdown`, y el único que
    // ve a los dos es `MessageBubble`, que es donde ahora se monta, justo
    // encima de esta fila. Aquí quedan solo las ACCIONES, que es lo que esta
    // fila siempre fue.
    <div className="-ml-1.5 mt-2.5 flex flex-wrap items-center gap-0.5">
      <div
        className={clsx(
          'flex flex-wrap items-center gap-0.5 transition-opacity duration-150 motion-reduce:transition-none',
          // Lo que dijo algo —se guardó, o no se pudo— deja de esconderse: un
          // mensaje que sólo se ve mientras el ratón está encima es un mensaje
          // que se pierde justo al apartarlo para leerlo.
          pinned || savedUrl || error || vote || asking || thanks
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
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
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

        {conversationId && (
          <>
            <button
              type="button"
              onClick={() => rate(1)}
              className={clsx(button, vote === 1 && 'bg-emerald-soft text-emerald')}
              aria-label="Buena respuesta"
              aria-pressed={vote === 1}
              title="Buena respuesta"
            >
              <ThumbsUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => rate(-1)}
              className={clsx(button, vote === -1 && 'bg-rose-soft text-rose')}
              aria-label="Mala respuesta"
              aria-pressed={vote === -1}
              title="Mala respuesta"
            >
              <ThumbsDown className="h-3.5 w-3.5" />
            </button>
          </>
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

      {thanks && <p className="ml-1.5 w-full text-micro text-ink-muted">{thanks}</p>}

      {asking && (
        <div className="ml-1.5 mt-1 w-full max-w-md space-y-2 rounded-card border border-border bg-surface p-3">
          <p className="text-xs font-semibold text-ink">¿Qué estuvo mal? (opcional)</p>
          <div className="flex flex-wrap gap-1.5">
            {REASON_CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                onClick={() => setReason(reason === chip.id ? null : chip.id)}
                aria-pressed={reason === chip.id}
                className={clsx(
                  'rounded-pill border px-2.5 py-1 text-micro font-semibold transition-colors duration-150 motion-reduce:transition-none',
                  reason === chip.id
                    ? 'border-primary bg-primary-soft text-primary-ink'
                    : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
                )}
              >
                {chip.label}
              </button>
            ))}
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={1000}
            rows={2}
            placeholder="Cuéntame cuál era lo correcto, así lo aprendo."
            aria-label="Qué estuvo mal"
            className="w-full resize-none rounded-card border border-border bg-canvas px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submitReason}
              disabled={sending}
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3 py-1 text-micro font-semibold text-white disabled:opacity-60"
            >
              {sending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
              Enviar
            </button>
            <button
              type="button"
              onClick={() => setAsking(false)}
              className="text-micro font-semibold text-ink-muted hover:text-ink"
            >
              Ahora no
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
