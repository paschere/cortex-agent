'use client';

import { useAppNav } from '@/components/apps/AppNav';
import { activeOutbox } from '@/lib/apps/app-outbox';
import { assignRowAction, assignablePeopleAction } from '@/lib/apps/location-actions';
import { undoRowChangeAction } from '@/lib/apps/history-actions';
import { editAppRowAction, runAppActionAction } from '@/lib/apps/write-actions';
import { editViewRowAction, runViewActionAction } from '@/lib/views/actions';
import { hasPending, resolvePending } from '@/lib/views/offline-files';
import type {
  AssignablePerson,
  ComputedAction,
  ComputedEditMeta,
  TrackerField,
} from '@cortex/agent-tools';
import { validateRowValues } from '@cortex/agent-tools/src/trackers/validation';
import { confirmDialog, promptDialog } from '@/lib/ui/dialog-queue';
import { formatDay, formatMoney, formatNumber } from '@cortex/agent-tools/src/format/display';
import { clsx } from 'clsx';
import { Check, Clock, Loader2, X } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { SubmitTarget } from './ViewCanvas';
import { AssignPicker } from './blocks/AssignPicker';
import { uploaderFor } from './blocks/form-transport';

/**
 * ESCRIBIR DESDE UNA VISTA (migración 0160): editar una celda, mover una
 * tarjeta, usar un botón.
 *
 * Adentro va por server action (con sesión); afuera por /api/views/public/rows
 * (con token y, si hace falta, la cookie de la contraseña). Qué se puede tocar
 * lo decide el servidor con el spec guardado — aquí sólo se pide. Después de
 * cada escritura se pide un refresco, para que todos los bloques (cifras,
 * gráficos) reflejen el cambio y no sólo la celda.
 */

/** `queued`: no había señal; quedó guardado en el teléfono y se envía solo, en orden. */
type Result = { ok: true; message: string; queued?: boolean } | { ok: false; error: string };

/** Lo que el que escribe sabe de la edición: lo que la persona VIO (para detectar un cambio ajeno) y cómo llamarla. */
export interface EditOptions {
  expect?: Record<string, string>;
  label?: string;
}

const QUEUED_MESSAGE = 'Guardado en el teléfono · se envía al volver la señal.';

export interface ViewWriter {
  edit(
    blockId: string,
    rowId: string,
    patch: Record<string, string>,
    opts?: EditOptions,
  ): Promise<Result>;
  act(blockId: string, action: ComputedAction, rowId: string, rowLabel: string): Promise<Result>;
  /**
   * «Deshacer este cambio» del historial de un registro (sólo dentro de una
   * aplicación): el servidor decide si este rol puede y si el campo no cambió después.
   */
  undo?(blockId: string, rowId: string, entryId: string): Promise<Result>;
  /**
   * «Asignar a…»: sólo dentro de una aplicación. Sin esto (vistas del equipo,
   * enlaces públicos) un botón de asignar no se pinta.
   */
  assign?: {
    people(
      blockId: string,
      actionId: string,
    ): Promise<{ ok: true; people: AssignablePerson[] } | { ok: false; error: string }>;
    pick(blockId: string, actionId: string, rowId: string, personRef: string): Promise<Result>;
  };
}

/** Rechazar pide un motivo opcional; `null` = la persona canceló. */
async function askReason(action: ComputedAction, rowLabel: string): Promise<string | null> {
  if (!action.askReason) return '';
  return promptDialog({
    title: `Motivo del rechazo de «${rowLabel}»`,
    label: 'Motivo (opcional)',
    confirmLabel: 'Rechazar',
    maxLength: 300,
  });
}

/** «¿Aprobar en «Fila»?»: un diálogo propio, no el del navegador. */
function askConfirm(action: ComputedAction, rowLabel: string): Promise<boolean> {
  return confirmDialog({
    title: `¿${action.label} en «${rowLabel}»?`,
    confirmLabel: action.label,
  });
}

/** Lo que escribió la persona, como se verá en la celda (dinero y fechas con su formato). */
function shownText(type: string, value: string): string {
  const v = value.trim();
  if (!v) return '—';
  if (type === 'money' && Number.isFinite(Number(v))) return formatMoney(Number(v));
  if (type === 'number' && Number.isFinite(Number(v))) return formatNumber(Number(v), 6);
  if (type === 'date') return formatDay(v);
  if (type === 'checkbox') return v === '1' ? 'Sí' : 'No';
  return v;
}

const WriterContext = createContext<ViewWriter | null>(null);

export function useViewWriter(): ViewWriter | null {
  return useContext(WriterContext);
}

async function publicWrite(body: Record<string, unknown>): Promise<Result> {
  try {
    const res = await fetch('/api/views/public/rows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    return res.ok && data?.message
      ? { ok: true, message: data.message }
      : { ok: false, error: data?.error ?? 'No se pudo guardar.' };
  } catch {
    return { ok: false, error: 'Sin conexión. Inténtalo otra vez.' };
  }
}

export function ViewWriterProvider({
  target,
  onChanged,
  children,
}: {
  target: SubmitTarget;
  onChanged?: () => void;
  children: React.ReactNode;
}) {
  let writer: ViewWriter | null = null;
  if (target.kind === 'app') {
    writer = {
      async edit(blockId, rowId, patch) {
        const res = await editViewRowAction(target.viewId, blockId, rowId, patch);
        if (res.ok) onChanged?.();
        return res;
      },
      async act(blockId, action, rowId, rowLabel) {
        if (action.confirm && !(await askConfirm(action, rowLabel)))
          return { ok: false, error: 'Cancelado.' };
        const reason = await askReason(action, rowLabel);
        if (reason === null) return { ok: false, error: 'Cancelado.' };
        const res = await runViewActionAction(target.viewId, blockId, action.id, rowId, reason);
        if (res.ok) onChanged?.();
        return res;
      },
    };
  } else if (target.kind === 'custom_app') {
    writer = {
      async undo(blockId, rowId, entryId) {
        try {
          const res = await undoRowChangeAction(target.appId, target.screen, blockId, rowId, entryId);
          if (res.ok) onChanged?.();
          return res;
        } catch {
          return { ok: false, error: 'Sin conexión. Inténtalo otra vez.' };
        }
      },
      assign: {
        people: (blockId, actionId) =>
          assignablePeopleAction(target.appId, target.screen, blockId, actionId),
        async pick(blockId, actionId, rowId, personRef) {
          const res = await assignRowAction(
            target.appId,
            target.screen,
            blockId,
            actionId,
            rowId,
            personRef,
          );
          if (res.ok) onChanged?.();
          return res;
        },
      },
      async edit(blockId, rowId, patch, opts) {
        // Sin señal (o con fotos/firmas guardadas en el teléfono): a la cola de la app,
        // que lo envía en orden al volver la señal. Con señal, directo como siempre.
        const outbox = activeOutbox(target.appId);
        const label = opts?.label ?? `Cambio en «${rowId.slice(0, 8)}»`;
        const keep = async (): Promise<Result> => {
          if (!outbox) return { ok: false, error: 'Sin conexión. Inténtalo otra vez.' };
          await outbox.queueEdit({
            screen: target.screen,
            blockId,
            rowId,
            label,
            patch,
            expect: opts?.expect,
          });
          return { ok: true, message: QUEUED_MESSAGE, queued: true };
        };
        if (typeof navigator !== 'undefined' && !navigator.onLine) return keep();
        let outgoing = patch;
        if (hasPending(patch)) {
          try {
            outgoing = await resolvePending(patch, uploaderFor(target, blockId));
          } catch {
            return keep();
          }
        }
        try {
          const res = await editAppRowAction(target.appId, target.screen, blockId, rowId, outgoing);
          if (res.ok) onChanged?.();
          return res;
        } catch {
          // La server action no llegó: sin red.
          return keep();
        }
      },
      async act(blockId, action, rowId, rowLabel) {
        if (action.confirm && !(await askConfirm(action, rowLabel)))
          return { ok: false, error: 'Cancelado.' };
        const reason = await askReason(action, rowLabel);
        if (reason === null) return { ok: false, error: 'Cancelado.' };
        const outbox = activeOutbox(target.appId);
        const keep = async (): Promise<Result> => {
          if (!outbox) return { ok: false, error: 'Sin conexión. Inténtalo otra vez.' };
          await outbox.queueAct({
            screen: target.screen,
            blockId,
            rowId,
            actionId: action.id,
            reason: reason || undefined,
            label: `${action.label}: ${rowLabel}`,
          });
          return { ok: true, message: QUEUED_MESSAGE, queued: true };
        };
        if (typeof navigator !== 'undefined' && !navigator.onLine) return keep();
        try {
          const res = await runAppActionAction(
            target.appId,
            target.screen,
            blockId,
            action.id,
            rowId,
            reason,
          );
          if (res.ok) onChanged?.();
          return res;
        } catch {
          return keep();
        }
      },
    };
  } else if (target.kind === 'public') {
    writer = {
      async edit(blockId, rowId, patch) {
        const res = await publicWrite({ op: 'edit', token: target.token, blockId, rowId, patch });
        if (res.ok) onChanged?.();
        return res;
      },
      async act(blockId, action, rowId, rowLabel) {
        if (action.confirm && !(await askConfirm(action, rowLabel)))
          return { ok: false, error: 'Cancelado.' };
        const reason = await askReason(action, rowLabel);
        if (reason === null) return { ok: false, error: 'Cancelado.' };
        const res = await publicWrite({
          op: 'action',
          token: target.token,
          blockId,
          rowId,
          actionId: action.id,
          ...(reason ? { reason } : {}),
        });
        if (res.ok) onChanged?.();
        return res;
      },
    };
  } else if (target.kind === 'demo') {
    // El escaparate de desarrollo: todo «sale bien» sin tocar nada.
    const fake = async (): Promise<Result> => {
      await new Promise((r) => setTimeout(r, 400));
      return {
        ok: true,
        message: target.dryRun
          ? 'Modo prueba: no se guardó nada.'
          : 'Hecho (de mentira).',
      };
    };
    writer = { edit: fake, act: fake };
  }
  return <WriterContext.Provider value={writer}>{children}</WriterContext.Provider>;
}

// ---------------------------------------------------------------------------
// Una celda que se edita en el sitio
// ---------------------------------------------------------------------------

/**
 * Las reglas del campo antes de pedirle nada al servidor: el mismo
 * `validateRowValues` que corre allá, así el mensaje sale en la celda sin ir y
 * volver. Lo que sólo el servidor sabe (que un valor ya existe) lo dice él.
 */
function checkCell(edit: ComputedEditMeta, label: string, value: string): string | null {
  const field = { key: 'v', label, ...edit } as TrackerField;
  return validateRowValues([field], { v: value })[0]?.message ?? null;
}

const EDIT_INPUT =
  'w-full min-w-[7rem] rounded-sm border border-primary bg-surface px-2 py-1 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/30';

interface EditableProps {
  blockId: string;
  rowId: string;
  field: string;
  edit: ComputedEditMeta;
  raw: string | number | null;
  display: string;
  className?: string;
  /** Nombre del campo para el lector de pantalla («Editar Estado»). */
  label?: string;
}

/** Una celda de tabla que se edita en el sitio. */
export function EditableCell(props: EditableProps) {
  return <EditableValue {...props} as="td" />;
}

/**
 * Un valor que se edita en el sitio, dentro de lo que sea: una celda, un
 * renglón de la ficha. Sin quien escriba (vista previa, sólo lectura), es el
 * valor y nada más.
 */
export function EditableValue({
  blockId,
  rowId,
  field,
  edit,
  raw,
  display,
  className,
  label,
  as: Tag = 'div',
}: EditableProps & { as?: 'td' | 'div' }) {
  const writer = useViewWriter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(raw == null ? '' : String(raw));
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'queued'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Lo que se escribió sin señal: se muestra con un reloj hasta que el servidor lo confirme.
  const [queuedValue, setQueuedValue] = useState<string | null>(null);
  // Lo que acaba de escribir, ya en pantalla mientras el servidor contesta; si falla, se devuelve.
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const input = useRef<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setValue(raw == null ? '' : String(raw));
  }, [raw, editing]);
  // El servidor ya trae otro valor: lo pendiente se resolvió (o cambió).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo cuando cambia lo que dice el servidor
  useEffect(() => {
    setQueuedValue(null);
    setOptimistic(null);
    setState((s) => (s === 'queued' ? 'idle' : s));
  }, [raw]);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  if (!writer) return <Tag className={className}>{display}</Tag>;

  async function commit(next: string) {
    if (next === (raw == null ? '' : String(raw))) {
      setEditing(false);
      return;
    }
    const problem = checkCell(edit, label ?? field, next);
    if (problem) {
      // Se queda editando con el motivo a la vista; Esc descarta el cambio.
      setState('error');
      setError(problem);
      return;
    }
    setEditing(false);
    setState('saving');
    setOptimistic(shownText(edit.type, next));
    const res = await writer?.edit(
      blockId,
      rowId,
      { [field]: next },
      { expect: { [field]: raw == null ? '' : String(raw) }, label: `${label ?? field} → ${next}` },
    );
    if (res?.ok && res.queued) {
      setState('queued');
      setQueuedValue(next);
      setError(null);
    } else if (res?.ok) {
      setState('saved');
      setError(null);
      setTimeout(() => setState('idle'), 1500);
    } else {
      setOptimistic(null);
      setState('error');
      setError(res?.error ?? 'No se pudo guardar.');
    }
  }

  return (
    <Tag className={clsx(className, 'group/cell relative')}>
      {editing ? (
        edit.type === 'select' || edit.type === 'checkbox' ? (
          <select
            ref={input}
            aria-label={label ? `Editar ${label}` : undefined}
            value={value}
            onChange={(e) => void commit(e.target.value)}
            onBlur={() => setEditing(false)}
            className={EDIT_INPUT}
          >
            {!edit.required && <option value="">—</option>}
            {/* Una casilla se guarda como 1/0; el servidor la entiende así. */}
            {(edit.type === 'checkbox' ? ['1', '0'] : edit.options).map((o) => (
              <option key={o} value={o}>
                {edit.type === 'checkbox' ? (o === '1' ? 'Sí' : 'No') : o}
              </option>
            ))}
          </select>
        ) : edit.type === 'longtext' ? (
          <textarea
            ref={input}
            rows={3}
            aria-label={label ? `Editar ${label}` : undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => void commit(value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setValue(raw == null ? '' : String(raw));
                setState('idle');
                setError(null);
                setEditing(false);
              }
            }}
            className={EDIT_INPUT}
          />
        ) : (
          <input
            ref={input}
            type={
              edit.type === 'date'
                ? 'date'
                : edit.type === 'time'
                  ? 'time'
                  : edit.type === 'number' || edit.type === 'money'
                    ? 'number'
                    : 'text'
            }
            step="any"
            aria-label={label ? `Editar ${label}` : undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => void commit(value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit(value);
              if (e.key === 'Escape') {
                setValue(raw == null ? '' : String(raw));
                setState('idle');
                setError(null);
                setEditing(false);
              }
            }}
            className={EDIT_INPUT}
          />
        )
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Editar"
          aria-label={label ? `${label}: ${display}. Editar` : undefined}
          style={{ textAlign: 'inherit' }}
          className="-mx-1 w-[calc(100%+0.5rem)] rounded-sm px-1 underline decoration-border-strong decoration-dotted underline-offset-4 transition-colors hover:bg-primary-soft/40"
        >
          {state === 'saving' ? (
            <>
              {optimistic ?? display}
              <Loader2 className="ml-1 inline h-3 w-3 animate-spin motion-reduce:animate-none" />
            </>
          ) : state === 'queued' && queuedValue !== null ? (
            shownText(edit.type, queuedValue) || '—'
          ) : optimistic !== null ? (
            optimistic
          ) : (
            display
          )}
          {state === 'queued' && (
            <span
              role="img"
              className="ml-1 inline-flex align-middle text-amber"
              title="Guardado en el teléfono; se envía al volver la señal"
              aria-label="Pendiente de enviar"
            >
              <Clock className="h-3.5 w-3.5" aria-hidden />
            </span>
          )}
          {state === 'saved' && <Check className="ml-1 inline h-3.5 w-3.5 text-emerald" />}
          {state === 'error' && <X className="ml-1 inline h-3.5 w-3.5 text-rose" />}
        </button>
      )}
      {error && state === 'error' && (
        <span className="mt-0.5 block text-micro text-rose">{error}</span>
      )}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Los botones de una fila o tarjeta
// ---------------------------------------------------------------------------

const TONE_BTN: Record<ComputedAction['tone'], string> = {
  primary: 'text-primary hover:bg-primary-soft',
  emerald: 'text-emerald hover:bg-emerald-soft',
  amber: 'text-amber hover:bg-amber-soft',
  sky: 'text-sky hover:bg-sky-soft',
  rose: 'text-rose hover:bg-rose-soft',
};

export function RowActions({
  blockId,
  actions,
  rowId,
  rowLabel,
}: {
  blockId: string;
  actions: ComputedAction[];
  rowId: string;
  rowLabel: string;
}) {
  const writer = useViewWriter();
  const appNav = useAppNav();
  const [busy, setBusy] = useState<string | null>(null);
  // Un botón a la vez, también entre dos toques del mismo instante (antes de que `busy` pinte).
  const busyRef = useRef(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [picking, setPicking] = useState<ComputedAction | null>(null);
  // Aprobar / Rechazar sólo salen en las filas que esperan revisión (`rowIds`);
  // «Asignar a…» sólo donde hay a quién asignar (dentro de una aplicación).
  const shown = actions.filter(
    (a) => (!a.rowIds || a.rowIds.includes(rowId)) && (a.kind !== 'assign' || writer?.assign),
  );
  if (!writer || !shown.length) return null;
  const say = (res: Result) => {
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error });
    setTimeout(() => setNote(null), 4000);
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {writer.assign && picking && (
        <AssignPicker
          open
          title={`${picking.label}: ${rowLabel}`}
          load={() =>
            (writer.assign as NonNullable<ViewWriter['assign']>).people(blockId, picking.id)
          }
          onClose={() => setPicking(null)}
          onPick={async (ref) => {
            const res = await (writer.assign as NonNullable<ViewWriter['assign']>).pick(
              blockId,
              picking.id,
              rowId,
              ref,
            );
            if (res.ok) setPicking(null);
            say(res);
          }}
        />
      )}
      {shown.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={busy !== null}
          onClick={async () => {
            if (a.kind === 'assign') {
              setPicking(a);
              return;
            }
            if (busyRef.current) return;
            busyRef.current = true;
            setBusy(a.id);
            let res: Result;
            try {
              res = await writer.act(blockId, a, rowId, rowLabel);
            } finally {
              busyRef.current = false;
              setBusy(null);
            }
            if (res.ok || res.error !== 'Cancelado.')
              setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error });
            setTimeout(() => setNote(null), 3000);
            // Encadenar: tras el cambio, abre otra pantalla con ESTA fila prellenada.
            if (res.ok && a.next) appNav?.goThen(a.next, { row: { id: rowId, label: rowLabel } });
          }}
          className={clsx(
            'view-press inline-flex items-center gap-1 rounded-pill border border-border px-2 py-0.5 text-micro font-semibold transition-colors disabled:opacity-45 max-sm:min-h-11 max-sm:px-4 max-sm:text-xs',
            TONE_BTN[a.tone],
          )}
        >
          {busy === a.id && <Loader2 className="h-3 w-3 animate-spin" />}
          {a.label}
        </button>
      ))}
      {note && (
        <span className={clsx('text-micro', note.ok ? 'text-emerald' : 'text-rose')}>
          {note.text}
        </span>
      )}
    </span>
  );
}
