'use client';

import { undoActivity } from '@/app/(app)/actividad/actions';
import { applyEdits, describeEdits, editableFields } from '@/lib/confirmation-edit';
import { confirmationFollowUp, confirmationReason } from '@/lib/confirmation-notes';
import {
  type ConfirmationPreview,
  type PreviewContext,
  buildPreview,
  headlineFor,
} from '@/lib/confirmation-preview';
import { REVERSIBILITY_LABEL, reversibilityOf } from '@/lib/reversibility';
import { riskOfTool } from '@/lib/risk';
import { chipClass } from '@/lib/status-chip';
import { confirmationSummary } from '@/lib/tool-labels';
import { clsx } from 'clsx';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Loader2,
  MessageSquareX,
  Pencil,
  RotateCcw,
  ShieldAlert,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { useChatCompose } from './ChatCompose';
import { resolveView } from './results/registry';

/** Lo que una tarjeta cuenta al grupo cuando se resuelve (ver ConfirmationGroup). */
export interface GroupOutcome {
  status: 'allowed' | 'cancelled';
  toolId: string;
  summary: string;
  result?: unknown;
  reason?: string;
}

/** La mano que el grupo usa para aprobar una tarjeta por la misma ruta de siempre. */
export interface CardHandle {
  /** Aprueba esta tarjeta (CAS en el servidor). true = quedó hecha. */
  approve: () => Promise<boolean>;
  /** Pendiente, sin error y sin edición a medias: entra en «Aprobar las N». */
  ready: () => boolean;
}

export interface ConfirmationPromptProps {
  conversationId: string;
  toolId: string;
  input: unknown;
  toolCallId?: string;
  onConfirmed?: () => void;
  /** El canal de ChoicePrompt, para una tarjeta que habla por la persona. */
  onSay?: (text: string) => void;
  /**
   * Cortex sigue en este turno. La propuesta sólo existe en el servidor cuando
   * el turno termina y se guarda; aprobar antes daba «No hay una propuesta
   * pendiente que coincida». Se espera con el botón apagado y se explica.
   */
  waiting?: boolean;
  /** «Por qué lo propongo»: lo que Cortex dijo en el mensaje, si dijo algo. */
  why?: string;
  /**
   * Dentro de un grupo de varias tarjetas, la tarjeta NO continúa el turno por
   * su cuenta: avisa al grupo, que continúa una sola vez cuando todas se
   * resolvieron.
   */
  group?: { report: (outcome: GroupOutcome) => void };
  handleRef?: React.Ref<CardHandle>;
  /** Para las fixtures de /v/aprobaciones-showcase: los valores de antes, sin red. */
  previewPreset?: PreviewContext;
}

type Status = 'pending' | 'running' | 'allowed' | 'cancelled' | 'error';
type UndoState = 'idle' | 'running' | 'done' | 'error';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function ConfirmationPrompt({
  conversationId,
  toolId,
  input,
  toolCallId,
  onConfirmed,
  onSay,
  waiting = false,
  why,
  group,
  handleRef,
  previewPreset,
}: ConfirmationPromptProps) {
  const [status, setStatus] = useState<Status>('pending');
  const [errorMessage, setErrorMessage] = useState('');
  const [errorKind, setErrorKind] = useState<'rejected' | 'failed'>('rejected');
  const [showDetails, setShowDetails] = useState(false);
  const [executed, setExecuted] = useState<unknown>(undefined);
  const [undoEventId, setUndoEventId] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoState>('idle');
  const [undoMessage, setUndoMessage] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string | boolean>>({});
  const [editedInput, setEditedInput] = useState<unknown>(undefined);
  const [previewCtx, setPreviewCtx] = useState<PreviewContext>(previewPreset ?? {});
  const compose = useChatCompose();
  const uid = useId();

  const effective = editedInput ?? input;
  const fields = editableFields(input);
  const canEdit = fields.length > 0;

  // Los valores de ANTES (sólo lectura en el servidor): la fila que se edita o,
  // para trackers.define, la definición actual de la tabla.
  useEffect(() => {
    const row = toolId === 'trackers.upsert' && isRecord(input) && typeof input.rowId === 'string';
    const table = toolId === 'trackers.define' && isRecord(input) && typeof input.slug === 'string';
    if (!row && !table) return;
    if (waiting || previewPreset) return;
    let alive = true;
    fetch('/api/chat/confirm/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, toolId, input, toolCallId }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            before?: Record<string, unknown> | null;
            fieldLabels?: Record<string, string>;
            trackerName?: string;
            exists?: boolean;
            current?: { name?: string; description?: string; fields: unknown[] } | null;
          } | null,
        ) => {
          if (!alive || !data) return;
          if (table) {
            if (typeof data.exists !== 'boolean') return;
            setPreviewCtx({
              trackerExists: data.exists,
              trackerBefore: data.exists ? (data.current ?? null) : null,
            });
            return;
          }
          if (!data.before) return;
          setPreviewCtx({
            before: data.before,
            ...(data.fieldLabels ? { fieldLabels: data.fieldLabels } : {}),
            ...(data.trackerName ? { trackerName: data.trackerName } : {}),
          });
        },
      )
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [conversationId, toolId, input, toolCallId, waiting, previewPreset]);

  async function execute(): Promise<boolean> {
    setStatus('running');
    try {
      const res = await fetch('/api/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          toolId,
          input,
          toolCallId,
          ...(editedInput !== undefined ? { editedInput } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage((data as { error?: string }).error ?? 'Error desconocido.');
        // 500 = la herramienta corrió y falló: la propuesta ya no está pendiente.
        setErrorKind(res.status === 500 ? 'failed' : 'rejected');
        setStatus('error');
        return false;
      }
      // El resultado real de la ejecución, guardado para dibujarlo aquí mismo.
      // La ruta lo persiste sobre el centinela, pero eso vive en la BASE: el
      // mensaje que esta pantalla tiene en memoria sigue cargando el centinela,
      // y sin esto la primera vez que alguien vería la tarjeta de lo que acaba
      // de aprobar sería tras recargar la página. Se vio en producción con la
      // pestaña viva del navegador: la persona aprobaba, la pestaña se abría
      // de verdad, y el chat no enseñaba nada — así que la persona volvía a
      // pedir, y cada reintento abría otra pestaña hasta llenar el cupo.
      const data = (await res.json().catch(() => ({}))) as {
        result?: unknown;
        undoEventId?: string;
      };
      setExecuted(data.result);
      setUndoEventId(data.undoEventId ?? null);
      setStatus('allowed');
      // La continuación. `onSay` mete la aprobación como mensaje de la persona
      // con el desenlace en palabras — que es el ÚNICO canal por el que el
      // resultado alcanza al modelo, porque el historial entre turnos es texto
      // (ver confirmationFollowUp). `onConfirmed` (regenerar) queda solo de
      // respaldo para superficies sin compositor: regenerar borra el turno y
      // el modelo, sin el resultado a la vista, vuelve a pedir confirmación.
      if (group) group.report({ status: 'allowed', toolId, summary, result: data.result });
      else if (onSay) onSay(confirmationFollowUp(toolId, data.result));
      else onConfirmed?.();
      return true;
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'No se pudo enviar la solicitud.');
      setErrorKind('rejected');
      setStatus('error');
      return false;
    }
  }

  const summary =
    headlineFor(toolId, effective, previewCtx) ??
    confirmationSummary(toolId, isRecord(effective) ? effective : {});
  const risk = riskOfTool(toolId);
  const reversibility = reversibilityOf(toolId);
  const preview: ConfirmationPreview | null = buildPreview(toolId, effective, previewCtx);
  const say = onSay ?? compose?.ask;

  // El grupo aprueba por esta misma función; `ready` lo lee en el momento.
  const live = useRef({ execute, status, editing });
  live.current = { execute, status, editing };
  useImperativeHandle(
    handleRef,
    () => ({
      approve: () => live.current.execute(),
      ready: () => live.current.status === 'pending' && !live.current.editing,
    }),
    [],
  );

  function handleReject() {
    const why = reason.trim();
    setStatus('cancelled');
    if (group) {
      group.report({ status: 'cancelled', toolId, summary, ...(why ? { reason: why } : {}) });
      return;
    }
    if (why && say) say(`No apruebes esto: ${summary}. Motivo: ${why}`);
  }

  function startEdit() {
    const seed: Record<string, string | boolean> = {};
    const source = editableFields(effective);
    for (const f of source)
      seed[f.path.join('.')] = f.kind === 'boolean' ? Boolean(f.value) : String(f.value);
    setEdits(seed);
    setEditing(true);
  }

  function saveEdit() {
    const changes = editableFields(input).map((f) => ({
      path: f.path,
      value: edits[f.path.join('.')] ?? f.value,
    }));
    const next = applyEdits(input, changes);
    setEditedInput(describeEdits(input, next).length > 0 ? next : undefined);
    setEditing(false);
  }

  async function handleUndo() {
    if (!undoEventId) return;
    setUndo('running');
    try {
      const out = await undoActivity([undoEventId]);
      setUndoMessage(out.message);
      setUndo(out.ok ? 'done' : 'error');
    } catch {
      setUndoMessage('No se pudo deshacer.');
      setUndo('error');
    }
  }

  // ---- Resolved states ----
  if (status === 'allowed') {
    // Si lo ejecutado tiene vista propia (la pestaña viva del navegador, un
    // trámite que quedó esperando un captcha), se dibuja AQUÍ, debajo del
    // «Listo»: es la salida de lo que la persona acaba de aprobar y el sitio
    // donde la está mirando. En una recarga este prompt ya no existe — el
    // centinela fue reescrito — y la misma tarjeta sale por el camino normal
    // del registro, así que nunca hay dos.
    const resolved = executed === undefined ? null : resolveView(toolId, executed);
    const note =
      isRecord(executed) && typeof executed.markdown === 'string' ? executed.markdown : '';
    return (
      <div className="space-y-2">
        <div className="rounded-card border border-emerald/20 bg-emerald-soft px-3.5 py-2 text-sm shadow-card">
          <div className="flex flex-wrap items-center gap-2 font-medium text-emerald">
            <Check className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {undo === 'done' ? 'Deshecho' : 'Listo'} — {summary}
            </span>
            {editedInput !== undefined && (
              <span className={chipClass('neutral')}>Con tus cambios</span>
            )}
            {undoEventId && undo !== 'done' && (
              <button
                type="button"
                onClick={handleUndo}
                disabled={undo === 'running'}
                className="inline-flex items-center gap-1 rounded-pill border border-emerald/30 px-2.5 py-1 text-xs font-semibold text-emerald transition-colors hover:bg-surface disabled:opacity-60 motion-reduce:transition-none"
              >
                {undo === 'running' ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <Undo2 className="h-3 w-3" aria-hidden />
                )}
                Deshacer
              </button>
            )}
          </div>
          {note && !resolved && (
            <p className="mt-1 text-xs leading-snug text-ink-muted [overflow-wrap:anywhere]">
              {note}
            </p>
          )}
          {undoMessage && (
            <output
              className={clsx(
                'mt-1 block text-xs',
                undo === 'error' ? 'text-rose' : 'text-ink-muted',
              )}
            >
              {undoMessage}
            </output>
          )}
        </div>
        {resolved?.as === 'rich' ? (
          <resolved.View
            result={executed}
            toolCallId={toolCallId ?? `confirmed:${toolId}`}
            onSay={onSay}
          />
        ) : null}
      </div>
    );
  }
  if (status === 'cancelled') {
    return (
      <div className="flex items-center gap-2 rounded-card border border-border bg-surface-2 px-3.5 py-2 text-sm text-ink-faint">
        <X className="h-4 w-4" />
        Rechazada
      </div>
    );
  }

  // ---- Pending / running / error card ----
  // Amber, never red: this is an action waiting on a decision, not one that
  // was refused, and red is reserved for what cannot be undone.
  return (
    <div
      data-approval-card
      className="overflow-hidden rounded-card border border-amber/25 bg-surface shadow-card"
    >
      <div className="flex items-start gap-3 bg-amber-soft px-4 py-3.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-amber/15 text-amber">
          <ShieldAlert className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          {/* Names the state of the whole block, not a value beneath it, so
              it is deliberately not `.field-label`. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-micro font-semibold text-amber">Confirmación requerida</span>
            <span className={chipClass(risk.tone)}>{risk.label}</span>
            {reversibility !== 'unknown' && (
              <span className={chipClass(reversibility === 'reversible' ? 'emerald' : 'rose')}>
                {REVERSIBILITY_LABEL[reversibility]}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm font-semibold text-ink [overflow-wrap:anywhere]">{summary}</p>
          <p className="mt-1 text-xs leading-snug text-ink-muted [overflow-wrap:anywhere]">
            {confirmationReason(toolId)}
          </p>
          <p className="mt-1 text-xs font-medium leading-snug text-amber [overflow-wrap:anywhere]">
            Todavía no se hizo nada: queda pendiente hasta que la apruebes.
          </p>
        </div>
      </div>

      <div className="px-4 py-3">
        {why && (
          <div className="mb-2">
            <div className="text-micro font-semibold text-ink-faint">Por qué lo propongo</div>
            <p className="mt-0.5 text-xs leading-snug text-ink-muted [overflow-wrap:anywhere]">
              {why}
            </p>
          </div>
        )}

        {editing ? (
          <fieldset className="mb-2 space-y-2 rounded-sm bg-surface-2 px-3 py-2.5">
            <legend className="sr-only">Editar antes de aprobar</legend>
            <div className="text-micro font-semibold text-ink-faint">Editar antes de aprobar</div>
            {editableFields(effective).map((f) => {
              const key = f.path.join('.');
              const id = `${uid}-${key}`;
              const value = edits[key];
              return (
                <div key={key} className={f.kind === 'boolean' ? 'flex items-center gap-2' : ''}>
                  <label htmlFor={id} className="text-xs font-medium text-ink-muted">
                    {f.label}
                  </label>
                  {f.kind === 'longtext' ? (
                    <textarea
                      id={id}
                      rows={4}
                      value={String(value ?? '')}
                      onChange={(e) => setEdits((s) => ({ ...s, [key]: e.target.value }))}
                      className="mt-0.5 w-full resize-y rounded-sm border border-border bg-surface px-2.5 py-1.5 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    />
                  ) : f.kind === 'boolean' ? (
                    <input
                      id={id}
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(e) => setEdits((s) => ({ ...s, [key]: e.target.checked }))}
                    />
                  ) : (
                    <input
                      id={id}
                      type={f.kind === 'number' ? 'number' : 'text'}
                      inputMode={f.kind === 'number' ? 'decimal' : undefined}
                      step={f.kind === 'number' ? 'any' : undefined}
                      value={String(value ?? '')}
                      onChange={(e) => setEdits((s) => ({ ...s, [key]: e.target.value }))}
                      className="mt-0.5 w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    />
                  )}
                </div>
              );
            })}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={saveEdit}
                className="rounded-pill bg-primary px-3.5 py-1.5 text-xs font-semibold text-white"
              >
                Usar estos valores
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-pill bg-surface px-3.5 py-1.5 text-xs font-medium text-ink-muted"
              >
                Cancelar
              </button>
            </div>
          </fieldset>
        ) : (
          preview && <PreviewBlock preview={preview} edited={editedInput !== undefined} />
        )}

        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
          className="flex items-center gap-1 rounded-pill text-xs font-medium text-ink-faint transition-colors duration-150 hover:text-primary motion-reduce:transition-none"
        >
          <ChevronDown
            className={clsx(
              'h-3.5 w-3.5 transition-transform duration-150 motion-reduce:transition-none',
              showDetails && 'rotate-180',
            )}
          />
          {showDetails ? 'Ocultar' : 'Ver'} lo que se va a enviar
        </button>
        {showDetails && (
          // Exactly what leaves the building, in the face evidence is set in.
          <pre className="scroll-slim mt-2 max-h-48 overflow-auto rounded-sm border border-border bg-surface-2 p-2.5 font-mono text-micro leading-relaxed text-ink-muted">
            {JSON.stringify(effective, null, 2)}
          </pre>
        )}

        {status === 'error' && (
          <div
            role="alert"
            className="mt-2 rounded-sm border border-rose/20 bg-rose-soft px-2.5 py-1.5 text-xs text-rose"
          >
            <p className="font-semibold">
              {errorKind === 'failed' ? 'No se pudo hacer' : 'No se pudo aprobar'}
            </p>
            <p className="[overflow-wrap:anywhere]">{errorMessage}</p>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {status === 'error' && errorKind === 'failed' ? (
            <button
              type="button"
              disabled={!say}
              onClick={() =>
                say?.(
                  `Falló «${summary}»: ${errorMessage} Revisa qué pasó y, si tiene sentido, propónmelo de nuevo.`,
                )
              }
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card disabled:opacity-60"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Pedirle a Cortex que lo reintente
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void execute()}
              data-approve
              disabled={status === 'running' || waiting || editing}
              title={waiting ? 'Espera a que Cortex termine este paso' : undefined}
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition-all duration-150 hover:-translate-y-px hover:brightness-95 disabled:opacity-60 disabled:shadow-none motion-reduce:transform-none motion-reduce:transition-none"
            >
              {status === 'running' ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Aprobando…
                </>
              ) : (
                <>
                  {status === 'error' ? (
                    <RotateCcw className="h-3.5 w-3.5" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}{' '}
                  {waiting
                    ? 'Espera a que Cortex termine'
                    : status === 'error'
                      ? 'Reintentar'
                      : 'Aprobar'}
                </>
              )}
            </button>
          )}
          {canEdit && !editing && (
            <button
              type="button"
              disabled={status === 'running'}
              onClick={startEdit}
              className="inline-flex items-center gap-1.5 rounded-pill px-3 py-2 text-sm font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-60 motion-reduce:transition-none"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden /> Editar
            </button>
          )}
          <button
            type="button"
            disabled={status === 'running'}
            onClick={() => setRejecting((v) => !v)}
            aria-expanded={rejecting}
            className="inline-flex items-center gap-1.5 rounded-pill px-3 py-2 text-sm font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-60 motion-reduce:transition-none"
          >
            <MessageSquareX className="h-3.5 w-3.5" aria-hidden /> Rechazar…
          </button>
          <kbd className="ml-auto hidden rounded-sm border border-border px-1.5 py-0.5 font-mono text-micro text-ink-faint sm:inline">
            ⌘↵ aprobar
          </kbd>
        </div>
        {rejecting && (
          <div className="mt-2 flex flex-col gap-2">
            <label className="text-micro font-semibold text-ink-faint" htmlFor={`${uid}-why`}>
              ¿Por qué no? (opcional) Cortex lo tendrá en cuenta.
            </label>
            <textarea
              id={`${uid}-why`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-sm border border-border bg-surface px-2.5 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            <button
              type="button"
              onClick={handleReject}
              className="self-start rounded-pill bg-rose px-4 py-1.5 text-sm font-semibold text-white"
            >
              Rechazar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Los primeros N renglones de una lista; el resto, detrás de «y N más». */
const LIST_SHOWN = 8;

function RowList({ items, total }: { items: string[]; total: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, LIST_SHOWN);
  const more = Math.max(total, items.length) - LIST_SHOWN;
  return (
    <div>
      <ul className="space-y-0.5">
        {shown.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: líneas de sólo lectura, sin estado
          <li key={i} className="[overflow-wrap:anywhere]">
            {line}
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1 rounded-pill text-xs font-medium text-primary hover:underline"
        >
          {open ? 'Ver menos' : `y ${more} más`}
        </button>
      )}
    </div>
  );
}

function RowText({ text, full, long }: { text: string; full?: string; long?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={long ? 'block whitespace-pre-wrap rounded-sm bg-surface px-2 py-1.5' : undefined}
    >
      {open && full ? full : text}
      {full && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="ml-1.5 rounded-pill text-xs font-medium text-primary hover:underline"
        >
          {open ? 'Ver menos' : 'Ver más'}
        </button>
      )}
    </span>
  );
}

/** «Qué va a cambiar»: antes → después, el correo tal cual, o los campos. */
export function PreviewBlock({
  preview,
  edited = false,
}: {
  preview: ConfirmationPreview;
  edited?: boolean;
}) {
  return (
    <div className="mb-2 rounded-sm bg-surface-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-micro font-semibold text-ink-faint">Qué va a cambiar</span>
        {preview.heading && <span className="text-xs text-ink-muted">· {preview.heading}</span>}
        {edited && <span className={chipClass('primary')}>Editado</span>}
      </div>
      <dl className="mt-1.5 space-y-1.5">
        {preview.rows.map((r) => (
          <div
            key={r.key}
            className="grid grid-cols-[minmax(0,7rem)_1fr] gap-x-3 text-xs sm:grid-cols-[8rem_1fr]"
          >
            <dt className="font-medium text-ink-faint [overflow-wrap:anywhere]">{r.label}</dt>
            <dd className="min-w-0 leading-snug text-ink [overflow-wrap:anywhere]">
              {r.items ? (
                <RowList items={r.items} total={r.total ?? r.items.length} />
              ) : preview.kind === 'diff' && r.before !== undefined && r.changed ? (
                <span className="flex flex-wrap items-center gap-x-1.5">
                  <span className="text-ink-faint line-through decoration-ink-faint/50">
                    {r.before}
                  </span>
                  <ArrowRight className="h-3 w-3 shrink-0 text-ink-faint" aria-hidden />
                  <span className="font-semibold text-ink">{r.after}</span>
                </span>
              ) : preview.kind === 'diff' && !r.changed ? (
                <span className="text-ink-faint">{r.after} · sin cambio</span>
              ) : r.long || r.full ? (
                <RowText text={r.after} full={r.full} long={r.long} />
              ) : (
                r.after
              )}
              {r.secondary && (
                <span className="mt-0.5 block text-micro text-ink-faint">{r.secondary}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
