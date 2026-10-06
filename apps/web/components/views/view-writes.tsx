'use client';

import { editViewRowAction, runViewActionAction } from '@/lib/views/actions';
import type { ComputedAction, ComputedEditMeta, TrackerField } from '@cortex/agent-tools';
import { validateRowValues } from '@cortex/agent-tools/src/trackers/validation';
import { clsx } from 'clsx';
import { Check, Loader2, X } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { SubmitTarget } from './ViewCanvas';

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

type Result = { ok: true; message: string } | { ok: false; error: string };

export interface ViewWriter {
  edit(blockId: string, rowId: string, patch: Record<string, string>): Promise<Result>;
  act(blockId: string, action: ComputedAction, rowId: string, rowLabel: string): Promise<Result>;
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
        if (action.confirm && !window.confirm(`¿${action.label} en «${rowLabel}»?`))
          return { ok: false, error: 'Cancelado.' };
        const res = await runViewActionAction(target.viewId, blockId, action.id, rowId);
        if (res.ok) onChanged?.();
        return res;
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
        if (action.confirm && !window.confirm(`¿${action.label} en «${rowLabel}»?`))
          return { ok: false, error: 'Cancelado.' };
        const res = await publicWrite({
          op: 'action',
          token: target.token,
          blockId,
          rowId,
          actionId: action.id,
        });
        if (res.ok) onChanged?.();
        return res;
      },
    };
  } else if (target.kind === 'demo') {
    // El escaparate de desarrollo: todo «sale bien» sin tocar nada.
    const fake = async (): Promise<Result> => {
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, message: 'Hecho (de mentira).' };
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
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setValue(raw == null ? '' : String(raw));
  }, [raw, editing]);
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
    const res = await writer?.edit(blockId, rowId, { [field]: next });
    if (res?.ok) {
      setState('saved');
      setError(null);
      setTimeout(() => setState('idle'), 1500);
    } else {
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
          {state === 'saving' ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : display}
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
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  if (!writer || !actions.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={busy !== null}
          onClick={async () => {
            setBusy(a.id);
            const res = await writer.act(blockId, a, rowId, rowLabel);
            setBusy(null);
            if (res.ok || res.error !== 'Cancelado.')
              setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error });
            setTimeout(() => setNote(null), 3000);
          }}
          className={clsx(
            'inline-flex items-center gap-1 rounded-pill border border-border px-2 py-0.5 text-micro font-semibold transition-colors disabled:opacity-45',
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
