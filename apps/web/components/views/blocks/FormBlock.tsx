'use client';

import { forValidation, hasPending } from '@/lib/views/offline-files';
import { type SentRecord, canCorrect, minutesLeft, newClientId } from '@/lib/views/offline-queue';
import type { ComputedBlock, TrackerField } from '@cortex/agent-tools';
import { displayTrackerValue } from '@cortex/agent-tools/src/trackers/schema';
import {
  defaultValues,
  validateRowValues,
  violationsByKey,
  visibleKeys,
} from '@cortex/agent-tools/src/trackers/validation';
import { stepErrors, stepFields, visibleSteps } from '@cortex/agent-tools/src/views/form-extras';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CloudOff,
  Loader2,
  Pencil,
  RefreshCw,
  Send,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import { useEffect, useId, useState, useTransition } from 'react';
import { DictateRecord, type Dictated } from '../DictateRecord';
import type { SubmitTarget } from '../ViewCanvas';
import { VoiceFormAssistant } from '../VoiceFormAssistant';
import { FileInput, LocationInput, RelationInput, ScanInput } from './FieldInputs';
import { type SubmitFn, correctorFor, uploaderFor } from './form-transport';
import { type VoiceSendOutcome, useFormVoiceStore } from './form-voice-bridge';
import { Card, useViewTheme } from './theme';
import { queueKeyFor, useFormQueue, useOnline } from './useFormQueue';

/**
 * EL FORMULARIO DE UNA VISTA.
 *
 * Valida con las MISMAS reglas que el servidor (`validateRowValues`), llena con
 * dictado, y además:
 *   - SIN INTERNET: si el envío no sale por falta de señal, el registro se
 *     guarda en el teléfono (IndexedDB) y sale solo al volver (ver
 *     useFormQueue.ts y lib/views/offline-queue.ts). Las fotos que no subieron
 *     se guardan también y suben antes del envío. Sin señal no hay dictado.
 *   - CORREGIR: tras enviar, «Corregir» durante `editWindowMinutes`.
 *   - POR PASOS: con `steps`, barra de progreso, Siguiente/Atrás con validación
 *     por paso, y un resumen antes de enviar; en el celular, a pantalla completa.
 * Sin `steps` y con señal, se comporta como siempre: una pantalla y Enviar.
 */

const INPUT_OPERATOR =
  'h-14 w-full rounded-sm border-2 border-border-strong bg-surface px-4 text-lg text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-primary focus-visible:ring-4 focus-visible:ring-primary/20';
const INPUT_BASE =
  'h-11 w-full rounded-sm border border-border-strong bg-surface px-3.5 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint hover:border-ink-faint/50 focus:border-primary focus-visible:ring-4 focus-visible:ring-primary/15';

type Done = {
  message: string;
  duplicate: string | null;
  /** Se guardó en el teléfono; todavía no llegó. */
  offline: boolean;
  rowId: string | null;
};

/** Lo que se lee de un valor en el resumen y en «Mis últimos envíos». */
function readable(field: TrackerField, value: string): string {
  if (!value) return '';
  if (field.type === 'checkbox') return value === '1' || value === 'true' ? 'Sí' : 'No';
  return displayTrackerValue(field, value);
}

function ago(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}

export function FormBlock({
  block,
  target,
  submit,
}: {
  block: Extract<ComputedBlock, { type: 'form' }>;
  target: SubmitTarget;
  submit?: SubmitFn;
}) {
  const fields = block.fields as unknown as TrackerField[];
  const baseId = useId().replace(/:/g, '');
  const initialValues = () =>
    Object.fromEntries(Object.entries(defaultValues(fields)).map(([k, v]) => [k, String(v)]));
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heard, setHeard] = useState<Dictated | null>(null);
  const [pending, start] = useTransition();
  const [correcting, setCorrecting] = useState<{ rowId: string; token: string | null } | null>(
    null,
  );
  const [step, setStep] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [full, setFull] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const disabled = target.kind === 'preview' || !submit;
  const operator = useViewTheme().layout === 'operator';
  const INPUT = operator ? INPUT_OPERATOR : INPUT_BASE;
  const online = useOnline();
  const visible = visibleKeys(fields, values);
  const editWindow = block.editWindowMinutes ?? 10;
  const corrector = correctorFor(target);

  const summarize = (v: Record<string, string>) => {
    const parts = fields
      .map((f) => readable(f, v[f.key] ?? ''))
      .filter(Boolean)
      .slice(0, 2);
    return parts.join(' · ') || 'Registro';
  };
  const queue = useFormQueue({
    queueKey: queueKeyFor(target, block.id),
    blockId: block.id,
    submit,
    uploader: uploaderFor(target, block.id),
    summarize,
    editWindow,
  });

  // El reloj de «Corregir (N min)».
  useEffect(() => {
    if (!done && queue.sent.length === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(t);
  }, [done, queue.sent.length]);

  // Los pasos: lo que el formulario pide, agrupado; los ocultos por showIf se saltan.
  const allSteps = block.steps
    ? stepFields(
        block.steps,
        fields.map((f) => f.key),
      )
    : null;
  const steps = allSteps ? visibleSteps(allSteps, visible) : null;
  const stepIndex = steps ? Math.min(step, Math.max(steps.length - 1, 0)) : 0;
  const lastStep = steps ? stepIndex >= steps.length - 1 : true;
  const current = steps?.[stepIndex] ?? null;

  // «viewer» lo llena el servidor con el nombre de quien envía (en un enlace
  // público queda vacío): aquí no puede contar como «falta». Una foto guardada
  // en el teléfono (`pending:`) cuenta como puesta.
  const check = () =>
    violationsByKey(
      validateRowValues(
        fields.map((f) => (f.default === 'viewer' ? { ...f, required: false } : f)),
        Object.fromEntries(Object.entries(values).map(([k, v]) => [k, forValidation(v)])),
      ),
    );
  const setValue = (key: string, next: string) => {
    setValues((v) => ({ ...v, [key]: next }));
    setErrors((e) => {
      if (!(key in e)) return e;
      const { [key]: _gone, ...rest } = e;
      return rest;
    });
  };
  const blurField = (key: string) =>
    setErrors((e) => {
      const msg = check()[key];
      if (msg) return { ...e, [key]: msg };
      if (!(key in e)) return e;
      const { [key]: _gone, ...rest } = e;
      return rest;
    });
  const focusField = (key: string | undefined) => {
    if (key) document.getElementById(`${baseId}-${key}`)?.focus();
  };

  const reset = () => {
    setDone(null);
    setValues(initialValues());
    setErrors({});
    setHeard(null);
    setCorrecting(null);
    setStep(0);
    setReviewing(false);
    setError(null);
  };

  /** Sólo lo que se muestra y tiene algo: lo oculto por `showIf` no viaja. Al corregir viajan también los vacíos (para poder borrar). */
  const buildPayload = (all: boolean) => {
    const payload: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.key];
      if (all) payload[f.key] = visible.has(f.key) ? (v ?? '') : '';
      else if (visible.has(f.key) && v !== undefined && v !== '') payload[f.key] = v;
    }
    return payload;
  };

  const goToFirstError = (found: Record<string, string>) => {
    setErrors(found);
    const first = fields.find((f) => found[f.key]);
    if (!first) return;
    if (steps) {
      const at = steps.findIndex((s) => s.fields.includes(first.key));
      if (at >= 0) {
        setStep(at);
        setReviewing(false);
      }
    }
    setTimeout(() => focusField(first.key), 50);
  };

  const finish = (d: Done) => {
    setDone(d);
    setNow(Date.now());
    setFull(false);
  };

  const send = () => {
    if (disabled || !submit) return;
    setError(null);
    const found = check();
    if (Object.keys(found).length) return goToFirstError(found);

    if (correcting) {
      if (!corrector) return;
      const payload = buildPayload(true);
      start(async () => {
        const res = await corrector(block.id, correcting.rowId, payload, correcting.token);
        if (res.ok) {
          queue.update(correcting.rowId, payload);
          finish({
            message: res.message,
            duplicate: res.duplicate ?? null,
            offline: false,
            rowId: correcting.rowId,
          });
          setCorrecting(null);
        } else setError(res.error);
      });
      return;
    }

    start(async () => {
      await submitRecord(buildPayload(false), newClientId());
    });
  };

  /**
   * El envío de un registro nuevo, por el camino de siempre: a la cola del
   * teléfono si no hay señal, fotos pendientes primero, y el submitter de la
   * vista. Lo usan el botón Enviar y el asistente de voz.
   */
  const submitRecord = async (
    payload: Record<string, string>,
    clientId: string,
  ): Promise<VoiceSendOutcome> => {
    const keepLocal = async (): Promise<VoiceSendOutcome> => {
      await queue.add(payload, clientId);
      const message = 'Guardado en el teléfono — se enviará al volver la señal.';
      finish({ message, duplicate: null, offline: true, rowId: null });
      return { ok: true, offline: true, message, duplicate: null };
    };
    const canQueue = target.kind === 'app' || target.kind === 'public';
    // Sin señal (o con fotos sin subir y sin señal): directo a la cola.
    if (canQueue && !navigator.onLine) return keepLocal();
    let outgoing = payload;
    if (canQueue && hasPending(payload)) {
      try {
        const { resolvePending } = await import('@/lib/views/offline-files');
        outgoing = await resolvePending(payload, uploaderFor(target, block.id));
      } catch {
        return keepLocal();
      }
    }
    if (!submit) return { ok: false, error: 'Este formulario no puede enviar ahora.' };
    const res = await submit(block.id, outgoing, clientId);
    if (res.ok) {
      const rec = queue.recordSent(outgoing, res);
      finish({
        message: res.message,
        duplicate: res.duplicate ?? null,
        offline: false,
        rowId: rec?.rowId ?? null,
      });
      return { ok: true, offline: false, message: res.message, duplicate: res.duplicate ?? null };
    }
    if (res.offline && canQueue) return keepLocal();
    setError(res.error);
    return { ok: false, error: res.error };
  };

  const startCorrection = (rec: SentRecord) => {
    setValues({ ...initialValues(), ...rec.values });
    setCorrecting({ rowId: rec.rowId, token: rec.editToken });
    setDone(null);
    setErrors({});
    setStep(0);
    setReviewing(false);
    setError(null);
  };

  const lastSent = done?.rowId ? queue.sent.find((r) => r.rowId === done.rowId) : undefined;

  // El asistente de voz maneja ESTE formulario por el puente: mismos valores,
  // misma validación, mismo envío (con su cola sin internet).
  const voiceMode = block.voice ?? 'dictate';
  const voiceStore = useFormVoiceStore();
  useEffect(() => {
    voiceStore?.set(block.id, {
      blockId: block.id,
      title: block.title,
      target,
      fields,
      steps: block.steps ?? null,
      values,
      setValues: (patch) => {
        setValues((v) => ({ ...v, ...patch }));
        setErrors((e) => {
          const keys = Object.keys(patch).filter((k) => k in e);
          if (!keys.length) return e;
          const rest = { ...e };
          for (const k of keys) delete rest[k];
          return rest;
        });
      },
      disabled,
      online,
      done: Boolean(done),
      prepare: forValidation,
      submit: async () => {
        if (disabled || !submit)
          return { ok: false, error: 'Esta vista es sólo una vista previa.' };
        setError(null);
        const found = check();
        const first = Object.values(found)[0];
        if (first) {
          goToFirstError(found);
          return { ok: false, error: first };
        }
        if (correcting)
          return {
            ok: false,
            error: 'Estás corrigiendo un envío: termina esa corrección con el dedo.',
          };
        return submitRecord(buildPayload(false), newClientId());
      },
      reset,
    });
  });
  useEffect(() => () => voiceStore?.drop(block.id), [voiceStore, block.id]);

  // ------------------------------------------------------------------------
  // Pantalla de «listo»
  // ------------------------------------------------------------------------
  if (done) {
    return (
      <Card>
        <output className="flex flex-col items-center gap-3 py-8 text-center">
          <span
            className={clsx(
              'grid h-14 w-14 place-items-center rounded-pill ring-8',
              done.offline
                ? 'bg-amber-soft text-amber ring-amber-soft/40'
                : 'bg-emerald-soft text-emerald ring-emerald-soft/40',
            )}
          >
            {done.offline ? (
              <CloudOff className="h-7 w-7" strokeWidth={2.5} aria-hidden />
            ) : (
              <Check className="h-7 w-7" strokeWidth={2.5} aria-hidden />
            )}
          </span>
          <p className={clsx('font-bold text-ink', operator ? 'text-lg' : 'text-base')}>
            {done.message}
          </p>
          {done.duplicate && (
            <p
              role="alert"
              className="max-w-sm rounded-sm border border-rose/30 bg-rose-soft px-3 py-2 text-sm font-semibold text-rose"
            >
              {done.duplicate}
            </p>
          )}
          {!done.offline && (
            <p className="max-w-xs text-xs leading-relaxed text-ink-muted">
              Lo enviado ya está en «{block.title}».
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            {lastSent && canCorrect(lastSent, now) && corrector && (
              <button
                type="button"
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-pill border border-border-strong px-4 font-semibold text-ink transition-colors hover:bg-surface-2',
                  operator ? 'h-12 text-base' : 'py-1.5 text-xs',
                )}
                onClick={() => startCorrection(lastSent)}
              >
                <Pencil className="h-4 w-4" aria-hidden />
                Corregir ({minutesLeft(lastSent, now)} min)
              </button>
            )}
            <button
              type="button"
              className={clsx(
                'rounded-pill border border-border px-4 font-semibold text-ink transition-colors hover:bg-surface-2',
                operator ? 'h-12 text-base' : 'py-1.5 text-xs',
              )}
              onClick={reset}
            >
              Enviar otro
            </button>
          </div>
        </output>
        {operator && (
          <RecentSent
            queue={queue}
            now={now}
            onCorrect={startCorrection}
            canEdit={Boolean(corrector)}
          />
        )}
      </Card>
    );
  }

  // ------------------------------------------------------------------------
  // Un campo
  // ------------------------------------------------------------------------
  const renderField = (f: TrackerField) => {
    const id = `${baseId}-${f.key}`;
    const msg = errors[f.key];
    const describedBy =
      [f.help ? `${id}-help` : null, msg ? `${id}-err` : null].filter(Boolean).join(' ') ||
      undefined;
    const value = values[f.key] ?? '';
    const common = {
      id,
      'aria-invalid': msg ? (true as const) : undefined,
      'aria-describedby': describedBy,
      onBlur: () => blurField(f.key),
    };
    const inputClass = clsx(INPUT, msg && 'border-rose focus:border-rose');
    const placeholder =
      f.placeholder ?? (f.example ? `Ej. ${f.example}` : f.type === 'money' ? '$ 0' : undefined);
    const shared = {
      field: block.fields.find((x) => x.key === f.key) as (typeof block.fields)[number],
      id,
      value,
      onChange: (next: string) => setValue(f.key, next),
      onBlur: () => blurField(f.key),
      invalid: Boolean(msg),
      describedBy,
      className: inputClass,
      target,
      blockId: block.id,
    };
    return (
      <div
        key={f.key}
        className={clsx(
          'block',
          (f.type === 'text' ||
            f.type === 'longtext' ||
            f.type === 'location' ||
            f.type === 'relation' ||
            f.type === 'file') &&
            'sm:col-span-2',
        )}
      >
        <label
          htmlFor={id}
          className={clsx(
            'flex items-baseline justify-between gap-2 font-semibold text-ink',
            operator ? 'mb-2 text-base' : 'mb-1.5 text-xs',
          )}
        >
          <span>
            {f.label}
            {f.required && (
              <span className="text-rose" aria-hidden>
                {' '}
                *
              </span>
            )}
          </span>
          {!f.required && <span className="text-micro font-normal text-ink-faint">Opcional</span>}
        </label>
        {f.type === 'select' ? (
          <select
            {...common}
            value={value}
            onChange={(e) => setValue(f.key, e.target.value)}
            className={inputClass}
          >
            <option value="">Elige…</option>
            {f.options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : f.type === 'longtext' ? (
          <textarea
            {...common}
            rows={3}
            maxLength={f.maxLength ?? 4000}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(f.key, e.target.value)}
            className={clsx(inputClass, 'h-auto min-h-[5.5rem] py-2.5')}
          />
        ) : f.type === 'checkbox' ? (
          <span className={clsx('flex items-center gap-3', operator ? 'h-14' : 'h-11')}>
            <input
              {...common}
              type="checkbox"
              checked={value === '1' || value === 'true'}
              onChange={(e) => setValue(f.key, e.target.checked ? '1' : '0')}
              className={clsx(
                'rounded-sm border-border-strong accent-primary',
                operator ? 'h-7 w-7' : 'h-5 w-5',
              )}
            />
            <span className={clsx('text-ink-muted', operator ? 'text-lg' : 'text-sm')}>Sí</span>
          </span>
        ) : f.type === 'location' ? (
          <LocationInput {...shared} />
        ) : f.type === 'relation' ? (
          <RelationInput {...shared} />
        ) : f.type === 'file' ? (
          <FileInput {...shared} />
        ) : f.type === 'text' && f.scan ? (
          <ScanInput {...shared} />
        ) : (
          <input
            {...common}
            type={
              f.type === 'date'
                ? 'date'
                : f.type === 'time'
                  ? 'time'
                  : f.type === 'number' || f.type === 'money'
                    ? 'number'
                    : f.format === 'email'
                      ? 'email'
                      : 'text'
            }
            inputMode={
              f.type === 'number' || f.type === 'money'
                ? 'decimal'
                : f.format === 'phone'
                  ? 'tel'
                  : f.format === 'digits'
                    ? 'numeric'
                    : undefined
            }
            step="any"
            min={typeof f.min === 'number' ? f.min : undefined}
            max={typeof f.max === 'number' ? f.max : undefined}
            maxLength={f.maxLength ?? 400}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(f.key, e.target.value)}
            className={clsx(inputClass, f.type !== 'text' && 'tabular font-mono')}
          />
        )}
        {f.help && (
          <p
            id={`${id}-help`}
            className={clsx('mt-1 text-ink-muted', operator ? 'text-sm' : 'text-micro')}
          >
            {f.help}
          </p>
        )}
        {msg && (
          <p
            id={`${id}-err`}
            role="alert"
            className={clsx('mt-1 font-semibold text-rose', operator ? 'text-sm' : 'text-micro')}
          >
            {msg}
          </p>
        )}
      </div>
    );
  };

  const shownFields = (
    steps && current && !reviewing
      ? current.fields.map((k) => fields.find((f) => f.key === k)).filter(Boolean)
      : steps && reviewing
        ? []
        : fields
  ).filter((f): f is TrackerField => Boolean(f) && visible.has((f as TrackerField).key));

  const next = () => {
    if (!current) return;
    const found = stepErrors(current, visible, check());
    if (Object.keys(found).length) {
      setErrors((e) => ({ ...e, ...found }));
      setTimeout(() => focusField(Object.keys(found)[0]), 50);
      return;
    }
    setFull(true);
    if (lastStep) setReviewing(true);
    else setStep(stepIndex + 1);
    setError(null);
  };
  const back = () => {
    setFull(true);
    if (reviewing) setReviewing(false);
    else setStep(Math.max(0, stepIndex - 1));
  };

  const BIG = operator ? 'h-14 text-lg' : 'h-11 px-6 text-sm';
  const PRIMARY = clsx(
    BIG,
    'cortex-primary-button inline-flex items-center justify-center gap-2 rounded-pill bg-primary font-semibold text-white shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong hover:shadow-pop disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none',
  );
  const GHOST = clsx(
    BIG,
    'inline-flex items-center justify-center gap-2 rounded-pill border border-border-strong px-5 font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-45',
  );

  return (
    <div
      className={clsx(
        steps &&
          full &&
          'max-sm:fixed max-sm:inset-0 max-sm:z-40 max-sm:overflow-y-auto max-sm:bg-surface max-sm:p-3',
      )}
    >
      <Card title={block.title}>
        {steps && full && (
          <button
            type="button"
            onClick={() => setFull(false)}
            aria-label="Salir de pantalla completa"
            className="absolute right-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-pill bg-surface-2 text-ink sm:hidden"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        )}
        {queue.pending.length > 0 && (
          <output className="mb-4 flex flex-wrap items-center gap-2 rounded-sm border border-amber/40 bg-amber-soft px-3 py-2 text-sm font-semibold text-amber">
            <CloudOff className="h-4 w-4 shrink-0" aria-hidden />
            <span>
              {queue.pending.length} pendiente{queue.pending.length > 1 ? 's' : ''} de enviar
            </span>
            {online && (
              <button
                type="button"
                onClick={() => void queue.drain(true)}
                className="ml-auto inline-flex items-center gap-1 rounded-pill border border-amber/40 px-2.5 py-0.5 text-xs"
              >
                <RefreshCw className="h-3 w-3" aria-hidden />
                Reintentar ahora
              </button>
            )}
          </output>
        )}
        {queue.rejected.length > 0 && (
          <ul className="mb-4 space-y-1.5">
            {queue.rejected.map((q) => (
              <li
                key={q.clientId}
                className="flex items-start gap-2 rounded-sm border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose"
              >
                <span className="min-w-0 flex-1">
                  No se pudo enviar un registro guardado: {q.rejected}
                </span>
                <button
                  type="button"
                  onClick={() => void queue.discard(q.clientId)}
                  aria-label="Descartar este registro"
                  className="shrink-0"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {block.intro && !reviewing && (
          <p className="-mt-1 mb-5 text-sm leading-relaxed text-ink-muted">{block.intro}</p>
        )}
        {correcting && (
          <p className="mb-5 flex items-center gap-2 rounded-sm bg-primary-soft px-3 py-2 text-sm font-semibold text-primary">
            <Pencil className="h-4 w-4" aria-hidden />
            Corrigiendo lo que enviaste.
            <button
              type="button"
              className="ml-auto text-xs underline"
              onClick={() => {
                setCorrecting(null);
                reset();
              }}
            >
              Cancelar
            </button>
          </p>
        )}
        {!disabled && !correcting && online && voiceMode === 'conversation' && (
          <VoiceFormAssistant blockId={block.id} variant="button" className="mb-3" />
        )}
        {!disabled && !correcting && online && voiceMode !== 'off' && (
          <DictateRecord
            className="mb-5"
            target={target}
            blockId={block.id}
            onDictated={(d) => {
              setValues((v) => ({ ...v, ...d.values }));
              setHeard(d);
              setError(null);
            }}
          />
        )}
        {!disabled && !correcting && !online && voiceMode !== 'off' && (
          <p className="mb-5 flex items-center gap-2 rounded-sm bg-surface-2 px-3 py-2 text-xs text-ink-muted">
            <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
            Sin internet: el dictado no está disponible. Escribe el registro; se guarda en el
            teléfono y sale al volver la señal.
          </p>
        )}
        {heard && (
          <p className="-mt-2 mb-5 rounded-sm bg-surface-2 px-3 py-2 text-xs leading-relaxed text-ink-muted">
            Oí: «{heard.heard}». Revisa antes de enviar
            {heard.missing.length
              ? `; falta: ${heard.missing
                  .map((k) => block.fields.find((f) => f.key === k)?.label ?? k)
                  .join(', ')}.`
              : '.'}
          </p>
        )}
        {steps && current && (
          <div className="mb-5" aria-live="polite">
            <p className="mb-2 flex items-baseline justify-between gap-2 text-xs font-semibold text-ink-muted">
              <span>
                {reviewing
                  ? 'Revisa antes de enviar'
                  : `Paso ${stepIndex + 1} de ${steps.length} — ${current.title}`}
              </span>
              <span className="tabular font-mono text-micro text-ink-faint">
                {reviewing ? steps.length : stepIndex + 1}/{steps.length}
              </span>
            </p>
            <progress
              className="sr-only"
              max={steps.length}
              value={reviewing ? steps.length : stepIndex + 1}
            />
            <div aria-hidden className="h-2 overflow-hidden rounded-pill bg-surface-2">
              <div
                className="h-full rounded-pill bg-primary transition-all duration-300"
                style={{
                  width: `${((reviewing ? steps.length : stepIndex + 1) / steps.length) * 100}%`,
                }}
              />
            </div>
          </div>
        )}
        <form
          noValidate
          className={clsx('grid', operator ? 'gap-5' : 'gap-4 sm:grid-cols-2')}
          onSubmit={(e) => {
            e.preventDefault();
            if (steps && !reviewing) return next();
            send();
          }}
        >
          {reviewing && steps ? (
            <dl className="space-y-3 sm:col-span-2">
              {steps.map((s, i) => (
                <div key={s.title} className="rounded-sm border border-border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <dt className="text-xs font-bold uppercase tracking-field text-ink-faint">
                      {s.title}
                    </dt>
                    <button
                      type="button"
                      onClick={() => {
                        setStep(i);
                        setReviewing(false);
                      }}
                      className="text-xs font-semibold text-primary hover:underline"
                    >
                      Cambiar
                    </button>
                  </div>
                  <dd className="space-y-1.5">
                    {s.fields
                      .filter((k) => visible.has(k))
                      .map((k) => {
                        const f = fields.find((x) => x.key === k);
                        if (!f) return null;
                        const text = readable(f, values[k] ?? '');
                        return (
                          <div
                            key={k}
                            className={clsx(
                              'flex justify-between gap-3',
                              operator ? 'text-base' : 'text-sm',
                            )}
                          >
                            <span className="shrink-0 text-ink-muted">{f.label}</span>
                            <span className="min-w-0 break-words text-right font-semibold text-ink">
                              {text || '—'}
                            </span>
                          </div>
                        );
                      })}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            shownFields.map(renderField)
          )}
          {error && (
            <p
              role="alert"
              className={clsx(
                'rounded-sm border border-rose/30 bg-rose-soft px-3 py-2 text-rose sm:col-span-2',
                operator ? 'text-base font-semibold' : 'text-xs',
              )}
            >
              {error}
            </p>
          )}
          <div
            className={clsx(
              'flex gap-3 pt-1 sm:col-span-2',
              steps ? 'max-sm:sticky max-sm:bottom-0 max-sm:bg-surface max-sm:pb-2' : '',
              operator || steps ? 'flex-col sm:flex-row' : 'flex-col sm:flex-row sm:items-center',
            )}
          >
            {steps && (stepIndex > 0 || reviewing) && (
              <button
                type="button"
                onClick={back}
                className={clsx(GHOST, operator && 'w-full sm:w-auto')}
              >
                <ArrowLeft className="h-5 w-5" aria-hidden />
                Atrás
              </button>
            )}
            {steps && !reviewing ? (
              <button
                type="submit"
                disabled={disabled}
                className={clsx(PRIMARY, (operator || steps) && 'w-full sm:w-auto sm:flex-1')}
              >
                {lastStep ? 'Revisar' : 'Siguiente'}
                <ArrowRight className="h-5 w-5" aria-hidden />
              </button>
            ) : (
              <button
                type="submit"
                disabled={disabled || pending}
                className={clsx(
                  PRIMARY,
                  operator && 'w-full',
                  steps && 'w-full sm:w-auto sm:flex-1',
                )}
              >
                {pending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Send className="h-5 w-5" />
                )}
                {correcting ? 'Guardar corrección' : block.submitLabel}
              </button>
            )}
            {target.kind === 'preview' && (
              <span className="text-micro text-ink-faint">
                Vista previa: guarda para recibir envíos.
              </span>
            )}
          </div>
        </form>
        {operator && (
          <RecentSent
            queue={queue}
            now={now}
            onCorrect={startCorrection}
            canEdit={Boolean(corrector)}
          />
        )}
      </Card>
    </div>
  );
}

/** «Mis últimos envíos» (local al teléfono) + los que esperan señal. Modo operario. */
function RecentSent({
  queue,
  now,
  onCorrect,
  canEdit,
}: {
  queue: ReturnType<typeof useFormQueue>;
  now: number;
  onCorrect: (rec: SentRecord) => void;
  canEdit: boolean;
}) {
  if (!queue.sent.length && !queue.pending.length) return null;
  return (
    <section className="mt-6 border-t border-border pt-4" aria-label="Mis últimos envíos">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-field text-ink-faint">
        Mis últimos envíos
      </h3>
      <ul className="space-y-2">
        {queue.pending.map((q) => (
          <li
            key={q.clientId}
            className="flex items-center gap-2 rounded-sm bg-amber-soft px-3 py-2 text-sm text-amber"
          >
            <CloudOff className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Pendiente de enviar</span>
            <span className="text-micro">{ago(q.createdAt, now)}</span>
          </li>
        ))}
        {queue.sent.map((r) => (
          <li
            key={r.rowId}
            className="flex items-center gap-2 rounded-sm border border-border px-3 py-2 text-sm"
          >
            <Check className="h-4 w-4 shrink-0 text-emerald" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-ink">{r.summary}</span>
            <span className="shrink-0 text-micro text-ink-faint">{ago(r.at, now)}</span>
            {canEdit && canCorrect(r, now) && (
              <button
                type="button"
                onClick={() => onCorrect(r)}
                className="shrink-0 rounded-pill border border-border-strong px-3 py-1 text-xs font-semibold text-ink hover:bg-surface-2"
              >
                Corregir ({minutesLeft(r, now)} min)
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
