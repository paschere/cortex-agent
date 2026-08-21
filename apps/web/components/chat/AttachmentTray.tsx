'use client';

import { type SpaceChoice, listWritableSpacesAction } from '@/app/(chat)/chat/actions';
import { clsx } from 'clsx';
import {
  Brain,
  Check,
  FileText,
  Loader2,
  Lock,
  MessageSquare,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';

/**
 * A FILE DROPPED INTO THE CHAT, AND THE QUESTION THAT FOLLOWS IT.
 *
 * ===========================================================================
 * WHY THE QUESTION IS ASKED HERE AND NOW
 * ===========================================================================
 * The file has just been dropped, the person still has in mind why they dropped
 * it, and the two possible answers have very different consequences. That is
 * the only moment the question can be answered well — a setting in preferences
 * would be answered once, months earlier, by someone imagining a different
 * file, and then silently applied to the client contract that must not be
 * shared. So there is no remembered preference and no default: the panel opens
 * with neither option selected and nothing happens until one is chosen.
 *
 * The two are given equal weight visually. Making "guardar en la memoria" the
 * obvious primary would be a nudge toward the irreversible one, and the whole
 * argument (see the route, `import-transcript.ts`, and migration 0068 § 3) is
 * that the irreversible direction is the one that should never be the path of
 * least resistance.
 *
 * ===========================================================================
 * WHY THE SPACE PICKER SITS INSIDE THE "MEMORY" CHOICE
 * ===========================================================================
 * Because "into the memory" is not one destination. It defaults to the
 * person's own notes — the same default `ensurePersonalSpace` gives everything
 * else — and a company-wide space is listed but disabled unless they are an org
 * admin, which is what `assertCanWriteToSpace` enforces server-side. Showing it
 * disabled rather than hiding it answers "can this be shared?" honestly instead
 * of implying the product has no shared memory.
 *
 * ===========================================================================
 * WHY INDEXING STATUS IS ON SCREEN
 * ===========================================================================
 * Reading, chunking and embedding a PDF takes long enough that silence reads as
 * failure. Somebody who chose "guardar" and then heard nothing does not know
 * whether to ask about the document or upload it again. So the row stays, says
 * which stage it is at, and turns into an invitation the moment it is
 * answerable. The wording matches the Brain Knowledge screen because it is the
 * same lifecycle and two vocabularies for one process is how people conclude
 * they are looking at two different things.
 */

const ACCEPT = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/plain': ['.txt'],
  'text/markdown': ['.md'],
} as const;

const MAX_BYTES = 10 * 1024 * 1024;

type Status = 'pending' | 'ingesting' | 'ready' | 'failed';

interface Attachment {
  id: string;
  filename: string;
  disposition: 'memory' | 'turn';
  documentId?: string | null;
  spaceName?: string | null;
  status: Status;
  error?: string | null;
  alreadyThere?: boolean;
  truncated?: boolean;
}

const STAGE: Record<Status, { text: string; dot: string; tone: string }> = {
  ready: { text: 'Ya lo recuerda', dot: 'bg-emerald', tone: 'text-emerald' },
  ingesting: { text: 'Leyendo y troceando…', dot: 'bg-primary', tone: 'text-primary' },
  pending: { text: 'En cola', dot: 'bg-amber', tone: 'text-amber' },
  failed: { text: 'No se pudo leer', dot: 'bg-rose', tone: 'text-rose' },
};

export function AttachmentTray({
  conversationId,
  onAsk,
  onPickerReady,
  children,
}: {
  conversationId: string;
  onAsk: (question: string) => void;
  /**
   * Hands the file dialog back to the composer so the paperclip can open it.
   *
   * The button does not get its own `<input type="file">`: a second one would
   * need its own copy of the accepted types, the 10 MB ceiling and the
   * rejection messages, and the day somebody edits one of the two the composer
   * would start accepting a file the tray then refuses. One dropzone, two ways
   * in — dragging and the button — and exactly one set of rules.
   */
  onPickerReady?: (open: () => void) => void;
  /**
   * EL COMPOSITOR ENTERO, DENTRO DE LA ZONA DE SOLTAR.
   *
   * Antes esto dibujaba una franja punteada permanente encima de la caja de
   * escribir —«Suelta un archivo y decides si entra a la memoria (PDF, DOCX,
   * TXT, MD — máx. 10 MB)»— en TODAS las conversaciones y todo el rato. Era una
   * instrucción que no cambia nunca ocupando una fila entera del sitio con menos
   * espacio de la pantalla, justo encima de lo único que se mira. Y era la pieza
   * que más ruido metía en la queja de que el compositor no tiene jerarquía: un
   * recuadro discontinuo a lo ancho pesa más que el botón de enviar.
   *
   * La zona de soltar no desaparece: se hace MÁS GRANDE. Ahora envuelve el
   * compositor completo, que es donde una persona iba a soltar el archivo de
   * todos modos, y sólo se dibuja cuando hay algo colgando del cursor. Las dos
   * puertas siguen siendo una sola regla —el clip abre el mismo diálogo, ver
   * `onPickerReady`— y los formatos y el tope se cuentan cuando importan: al
   * arrastrar, y en el error si se rechaza.
   */
  children?: React.ReactNode;
}) {
  const [pending, setPending] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [spaces, setSpaces] = useState<SpaceChoice[]>([]);
  const [spaceId, setSpaceId] = useState<string>('');
  const panelRef = useRef<HTMLDivElement>(null);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: ACCEPT,
    maxSize: MAX_BYTES,
    multiple: false,
    // La zona envuelve el compositor entero, así que un clic aquí es un clic en
    // la caja de escribir y una tecla es una tecla escribiendo. Abrir el
    // diálogo de archivos es trabajo del clip, que ya lo tiene por
    // `onPickerReady`. Van en las OPCIONES del hook y no en `getRootProps`:
    // ahí dentro son props desconocidas y react-dropzone las escupe al DOM,
    // que es exactamente el aviso de React que apareció en la consola la
    // primera vez que se escribieron en el sitio equivocado.
    noClick: true,
    noKeyboard: true,
    // Nothing is uploaded on drop. The bytes sit in the browser until the
    // person says where they go — an upload that happened first and asked
    // afterwards would already have made the decision it is asking about.
    onDrop: (files) => {
      const file = files[0];
      if (!file) return;
      setError(null);
      setPending(file);
    },
    onDropRejected: (rejections) => {
      const reason = rejections[0]?.errors[0]?.code;
      setError(
        reason === 'file-too-large'
          ? 'El archivo pasa de 10 MB.'
          : 'Por ahora Cortex lee PDF, DOCX, TXT y MD desde el chat.',
      );
    },
  });

  // Handed over once, wrapped, and never re-handed. `open` is a fresh closure on
  // some renders, and passing it straight up would be a setState in an effect
  // whose dependency changes on the render that setState caused.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    onPickerReady?.(() => openRef.current());
  }, [onPickerReady]);

  // Loaded only once a file is waiting: nobody needs the space list until there
  // is something to file, and it is one query we can simply not make.
  useEffect(() => {
    if (!pending || spaces.length > 0) return;
    void listWritableSpacesAction().then(setSpaces);
  }, [pending, spaces.length]);

  useEffect(() => {
    if (pending) panelRef.current?.focus();
  }, [pending]);

  const refresh = useCallback(async () => {
    const res = await fetch(
      `/api/chat/attachments?conversationId=${encodeURIComponent(conversationId)}`,
    );
    if (!res.ok) return;
    const data = (await res.json()) as { attachments: Attachment[] };
    setAttachments(data.attachments ?? []);
  }, [conversationId]);

  // Poll only while something is still being read, and stop the moment nothing
  // is — the same rule the Brain Knowledge list uses.
  useEffect(() => {
    const working = attachments.some((a) => a.status === 'pending' || a.status === 'ingesting');
    if (!working) return;
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [attachments, refresh]);

  async function send(disposition: 'memory' | 'turn') {
    if (!pending) return;
    setBusy(true);
    setError(null);

    const form = new FormData();
    form.append('file', pending);
    form.append('conversationId', conversationId);
    form.append('disposition', disposition);
    if (disposition === 'memory' && spaceId) form.append('spaceId', spaceId);

    try {
      const res = await fetch('/api/chat/attachments', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? 'No se pudo adjuntar el archivo.');
        return;
      }
      setAttachments((prev) => [...prev, data.attachment as Attachment]);
      setPending(null);
    } catch {
      setError('No se pudo adjuntar el archivo.');
    } finally {
      setBusy(false);
    }
  }

  const tray = (
    <div className={clsx('space-y-1.5', (attachments.length > 0 || pending || error) && 'mb-2')}>
      {attachments.map((a) => (
        <AttachmentRow key={a.id} attachment={a} onAsk={onAsk} />
      ))}

      {pending ? (
        <div
          ref={panelRef}
          tabIndex={-1}
          className="animate-rise rounded-card border border-primary/25 bg-surface p-3 shadow-card outline-none"
        >
          <div className="flex items-start gap-2.5">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">{pending.name}</p>
              <p className="mt-0.5 text-xs leading-snug text-ink-muted">
                ¿Lo guardo en la memoria de la empresa, o lo uso sólo para esta conversación?
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPending(null)}
              aria-label="Descartar el archivo"
              className="rounded-full p-1 text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink motion-reduce:transition-none"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {/* Memory */}
            <div className="flex flex-col rounded-sm border border-border bg-surface-2 p-2.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                <Brain className="h-3.5 w-3.5 text-primary" aria-hidden />
                Guardar en la memoria
              </div>
              <p className="mt-1 text-micro leading-snug text-ink-faint">
                Queda indexado y citable en las respuestas, también en las de otros si el espacio es
                de la empresa.
              </p>

              <label className="field-label mt-2.5" htmlFor="att-space">
                Espacio
              </label>
              <select
                id="att-space"
                value={spaceId}
                onChange={(e) => setSpaceId(e.target.value)}
                className="mt-1 w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-xs text-ink outline-none focus:border-primary/40"
              >
                <option value="">Tus propias notas</option>
                {spaces
                  .filter((s) => !(s.kind === 'personal' && s.writable))
                  .map((s) => (
                    <option key={s.id} value={s.id} disabled={!s.writable}>
                      {s.name}
                      {s.kind === 'global' ? ' · toda la empresa' : ''}
                      {s.writable ? '' : ' (sólo un admin puede)'}
                    </option>
                  ))}
              </select>

              <button
                type="button"
                disabled={busy}
                onClick={() => void send('memory')}
                className="mt-2.5 inline-flex items-center justify-center gap-1.5 rounded-pill bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-pop transition-colors duration-150 hover:bg-primary-strong disabled:opacity-40 motion-reduce:transition-none"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                Guardar
              </button>
            </div>

            {/* This turn only */}
            <div className="flex flex-col rounded-sm border border-border bg-surface-2 p-2.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                <MessageSquare className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
                Sólo esta conversación
              </div>
              <p className="mt-1 text-micro leading-snug text-ink-faint">
                Cortex lo lee para responderte aquí. No se indexa, no lo ve nadie más y se borra a
                la semana.
              </p>
              <div className="mt-auto pt-2.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void send('turn')}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink transition-colors duration-150 hover:border-border-strong hover:bg-surface-2 disabled:opacity-40 motion-reduce:transition-none"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                  Usar sólo aquí
                </button>
              </div>
            </div>
          </div>

          {error && (
            <p role="alert" className="mt-2 text-xs text-rose">
              {error}
            </p>
          )}
        </div>
      ) : (
        // Un rechazo SÍ ocupa sitio: es lo único que esta zona tiene que decir
        // por su cuenta, y decirlo callado sería dejar a alguien mirando un
        // compositor que se tragó su PDF sin explicar por qué.
        error && (
          <p role="alert" className="text-xs text-rose">
            {error}
          </p>
        )
      )}
    </div>
  );

  return (
    <div {...getRootProps({ className: 'relative' })}>
      <input {...getInputProps()} />
      {tray}
      {children}
      {isDragActive && (
        // El único momento en que esto se dibuja. Cubre el compositor entero
        // con la señal y con las reglas —formatos y tope— justo cuando son
        // relevantes, en vez de recordarlas todo el día.
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-card border-2 border-dashed border-primary bg-primary-soft/95 px-4 text-center">
          <div>
            <p className="text-sm font-semibold text-primary-ink">Suéltalo aquí</p>
            <p className="mt-0.5 text-micro text-primary-ink/70">
              Luego decides si entra a la memoria — PDF, DOCX, TXT o MD, hasta 10 MB.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function AttachmentRow({
  attachment,
  onAsk,
}: {
  attachment: Attachment;
  onAsk: (question: string) => void;
}) {
  const stage = STAGE[attachment.status] ?? STAGE.pending;
  const ephemeral = attachment.disposition === 'turn';

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card border border-border bg-surface px-3 py-2 text-xs shadow-card">
      {ephemeral ? (
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
      ) : (
        <Brain className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      )}
      <span className="min-w-0 max-w-[16rem] truncate font-medium text-ink">
        {attachment.filename}
      </span>

      {ephemeral ? (
        <span className="inline-flex items-center gap-1 text-ink-faint">
          <Lock className="h-3 w-3" aria-hidden />
          sólo aquí
          {attachment.truncated && ' · leído en parte'}
        </span>
      ) : (
        <span className={clsx('inline-flex items-center gap-1.5', stage.tone)} aria-live="polite">
          <span className={clsx('h-1.5 w-1.5 rounded-full', stage.dot)} aria-hidden />
          {attachment.alreadyThere && attachment.status === 'ready'
            ? 'Ya estaba en la memoria'
            : stage.text}
          {attachment.spaceName && <span className="text-ink-faint">· {attachment.spaceName}</span>}
        </span>
      )}

      {attachment.status === 'failed' && attachment.error && (
        <span className="inline-flex items-center gap-1 text-rose">
          <TriangleAlert className="h-3 w-3" aria-hidden />
          {attachment.error}
        </span>
      )}

      {attachment.status === 'ready' && (
        <button
          type="button"
          onClick={() => onAsk(`Sobre "${attachment.filename}": `)}
          className="ml-auto inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-micro font-medium text-primary-ink transition-colors duration-150 hover:bg-primary-soft motion-reduce:transition-none"
        >
          <Check className="h-3 w-3" aria-hidden />
          Preguntar por él
        </button>
      )}
    </div>
  );
}
