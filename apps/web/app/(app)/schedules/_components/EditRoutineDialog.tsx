'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { AlarmClock, Loader2, Mail, Plus, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DOW, humanizeCron } from './format';
import type { RoutinePatch, ScheduledJob } from './types';

type Frequency = 'daily' | 'weekly' | 'monthly';

const FREQUENCY_LABEL: Record<Frequency, string> = {
  daily: 'Diaria',
  weekly: 'Semanal',
  monthly: 'Mensual',
};

/** Short, deliberately opinionated list — the timezones this team actually uses. */
const TIMEZONES = [
  'America/Bogota',
  'America/Mexico_City',
  'America/New_York',
  'America/Los_Angeles',
  'America/Argentina/Buenos_Aires',
  'Europe/Madrid',
  'UTC',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface CronDraft {
  frequency: Frequency;
  time: string;
  weekday: string;
  monthDay: string;
}

const DEFAULT_DRAFT: CronDraft = {
  frequency: 'daily',
  time: '09:00',
  weekday: '1',
  monthDay: '1',
};

/** Read a 5-field cron back into the friendly picker. Null when it's too exotic. */
function parseCron(cron: string | null): CronDraft | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour) || month !== '*') return null;
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (dom === '*' && dow === '*') return { ...DEFAULT_DRAFT, frequency: 'daily', time };
  if (dom === '*' && /^[0-6]$/.test(dow))
    return { ...DEFAULT_DRAFT, frequency: 'weekly', time, weekday: dow };
  if (/^\d{1,2}$/.test(dom) && dow === '*')
    return {
      ...DEFAULT_DRAFT,
      frequency: 'monthly',
      time,
      monthDay: String(Number(dom)),
    };
  return null;
}

/** Compose the 5-field expression the picker can express. */
function buildCron(draft: CronDraft): string {
  const [hh = '9', mm = '0'] = draft.time.split(':');
  const hour = String(Number(hh));
  const min = String(Number(mm));
  if (draft.frequency === 'weekly') return `${min} ${hour} * * ${draft.weekday}`;
  if (draft.frequency === 'monthly') return `${min} ${hour} ${draft.monthDay} * *`;
  return `${min} ${hour} * * *`;
}

/**
 * Rename a routine, retime it, and fix who gets the email — without going back
 * to chat. Everything persists through PATCH /api/schedules/[id].
 */
export function EditRoutineDialog({
  job,
  onClose,
  onSaved,
}: {
  job: ScheduledJob | null;
  onClose: () => void;
  onSaved: (patch: RoutinePatch) => void;
}) {
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<CronDraft>(DEFAULT_DRAFT);
  const [advanced, setAdvanced] = useState(false);
  const [rawCron, setRawCron] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [recipientDraft, setRecipientDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jobId = job?.id ?? null;

  // Re-seed the form whenever a different routine is opened.
  useEffect(() => {
    if (!job) return;
    const parsed = parseCron(job.cron);
    setName(job.name);
    setDraft(parsed ?? DEFAULT_DRAFT);
    setAdvanced(job.scheduleKind === 'cron' && !parsed);
    setRawCron(job.cron ?? '');
    setTimezone(job.timezone);
    setNotifyEmail(job.notifyEmail);
    setRecipients(job.recipients);
    setRecipientDraft('');
    setError(null);
    setSaving(false);
  }, [job]);

  if (!job || !jobId) return null;

  const isCron = job.scheduleKind === 'cron';
  const composedCron = advanced ? rawCron.trim() : buildCron(draft);
  const tzOptions = TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES];

  function addRecipient(raw?: string) {
    const value = (raw ?? recipientDraft).trim().toLowerCase().replace(/,$/, '');
    if (!value) return;
    if (!EMAIL_RE.test(value)) {
      setError(`“${value}” no parece un correo electrónico.`);
      return;
    }
    setRecipients((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setRecipientDraft('');
    setError(null);
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Ponle un nombre a la rutina.');
      return;
    }
    if (isCron && composedCron.trim().split(/\s+/).length !== 5) {
      setError('La expresión cron necesita exactamente 5 campos, por ejemplo “0 9 * * 1-5”.');
      return;
    }
    // A half-typed recipient in the box is almost always meant to be included.
    let finalRecipients = recipients;
    const pending = recipientDraft.trim().toLowerCase();
    if (pending) {
      if (!EMAIL_RE.test(pending)) {
        setError(`“${pending}” no parece un correo electrónico.`);
        return;
      }
      finalRecipients = recipients.includes(pending) ? recipients : [...recipients, pending];
    }

    const patch: RoutinePatch = {
      name: trimmed,
      timezone,
      notifyEmail,
      recipients: finalRecipients,
    };
    if (isCron) patch.cron = composedCron;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/schedules/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `La solicitud falló (${res.status}).`);
      }
      onSaved(patch);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(560px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-card border border-primary/30 bg-primary-soft text-primary">
                <SlidersHorizontal className="h-4 w-4" />
              </span>
              <div>
                <Dialog.Title className="text-sm font-bold text-ink">Editar la rutina</Dialog.Title>
                <Dialog.Description className="text-[11.5px] text-ink-faint">
                  El nombre, la hora y a quién le llega. La instrucción se cambia desde el chat.
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              className="grid h-8 w-8 shrink-0 place-items-center rounded-card text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="scroll-slim min-h-0 flex-1 space-y-5 overflow-auto px-5 py-4">
            <Field label="Nombre" htmlFor="routine-name">
              <input
                id="routine-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                className="w-full rounded-card border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-border-strong"
                placeholder="Reporte de clientes del viernes"
              />
            </Field>

            {isCron ? (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="field-label">Programación</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (!advanced) setRawCron(composedCron);
                      else setDraft(parseCron(rawCron) ?? draft);
                      setAdvanced(!advanced);
                    }}
                    className="rounded-card px-2 py-0.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {advanced ? 'Usar el selector' : 'Avanzado'}
                  </button>
                </div>

                {advanced ? (
                  <input
                    value={rawCron}
                    onChange={(e) => setRawCron(e.target.value)}
                    spellCheck={false}
                    placeholder="0 9 * * 1-5"
                    className="w-full rounded-card border border-border bg-surface px-3 py-2 font-mono text-[13px] text-ink outline-none transition-colors focus:border-border-strong"
                  />
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-1 rounded-card border border-border bg-surface-2 p-1">
                      {(['daily', 'weekly', 'monthly'] as const).map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setDraft({ ...draft, frequency: f })}
                          className={clsx(
                            'rounded-sm px-2 py-1.5 text-[12px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                            draft.frequency === f
                              ? 'border border-border-strong bg-surface text-ink'
                              : 'border border-transparent text-ink-muted hover:text-ink',
                          )}
                        >
                          {FREQUENCY_LABEL[f]}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <label className="flex min-w-[120px] flex-1 flex-col gap-1">
                        <span className="field-label">Hora</span>
                        <input
                          type="time"
                          value={draft.time}
                          onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                          className="tabular rounded-card border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-border-strong"
                        />
                      </label>
                      {draft.frequency === 'weekly' && (
                        <label className="flex min-w-[140px] flex-1 flex-col gap-1">
                          <span className="field-label">Día de la semana</span>
                          <select
                            value={draft.weekday}
                            onChange={(e) => setDraft({ ...draft, weekday: e.target.value })}
                            className="rounded-card border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-border-strong"
                          >
                            {DOW.map((d, i) => (
                              <option key={d} value={String(i)}>
                                {d}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {draft.frequency === 'monthly' && (
                        <label className="flex min-w-[140px] flex-1 flex-col gap-1">
                          <span className="field-label">Día del mes</span>
                          <select
                            value={draft.monthDay}
                            onChange={(e) => setDraft({ ...draft, monthDay: e.target.value })}
                            className="tabular rounded-card border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-border-strong"
                          >
                            {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                  </div>
                )}

                <p className="tabular mt-2 inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint">
                  <AlarmClock className="h-3.5 w-3.5 text-primary" />
                  {humanizeCron(composedCron || null, timezone)} · {timezone}
                </p>
              </div>
            ) : (
              <div className="rounded-card border border-border bg-surface-2 px-3 py-2.5 text-[12px] text-ink-muted">
                Esta rutina corre una sola vez, así que no se le puede cambiar la hora aquí. Pídele
                a Cortex en el chat una nueva a la hora que quieras.
              </div>
            )}

            <Field label="Zona horaria" htmlFor="routine-timezone">
              <select
                id="routine-timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full rounded-card border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-border-strong"
              >
                {tzOptions.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </Field>

            <div>
              <div className="field-label mb-2">Entrega</div>
              <button
                type="button"
                onClick={() => setNotifyEmail(!notifyEmail)}
                className="flex w-full items-center justify-between gap-3 rounded-card border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                  <Mail className="h-4 w-4 text-ink-faint" /> Enviar el resultado por correo
                </span>
                <span
                  className={clsx(
                    'relative h-5 w-9 shrink-0 rounded-sm border transition-colors',
                    notifyEmail ? 'border-primary bg-primary' : 'border-border bg-surface-2',
                  )}
                >
                  <span
                    className={clsx(
                      'absolute top-0.5 h-3.5 w-3.5 rounded-sm bg-surface transition-all',
                      notifyEmail ? 'left-[1.125rem]' : 'left-0.5',
                    )}
                  />
                </span>
              </button>

              <div className="mt-2">
                <div className="field-label mb-1.5">
                  Destinatarios {recipients.length === 0 && '— vacío significa solo el dueño'}
                </div>
                {recipients.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {recipients.map((r) => (
                      <span
                        key={r}
                        className="inline-flex items-center gap-1 rounded-sm border border-primary/30 bg-primary-soft py-0.5 pl-2 pr-1 font-mono text-[11px] font-semibold text-primary"
                      >
                        {r}
                        <button
                          type="button"
                          onClick={() => setRecipients(recipients.filter((x) => x !== r))}
                          className="grid h-4 w-4 place-items-center rounded-sm transition-colors hover:bg-primary hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          aria-label={`Quitar ${r}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex gap-1.5">
                  <input
                    value={recipientDraft}
                    onChange={(e) => setRecipientDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        addRecipient();
                      }
                    }}
                    onBlur={() => recipientDraft.trim() && addRecipient()}
                    type="email"
                    placeholder="companero@empresa.com"
                    className="min-w-0 flex-1 rounded-card border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-border-strong"
                  />
                  <button
                    type="button"
                    onClick={() => addRecipient()}
                    className="inline-flex shrink-0 items-center gap-1 rounded-card border border-border-strong bg-surface px-2.5 text-[12px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <Plus className="h-3.5 w-3.5" /> Agregar
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div className="rounded-card border border-rose/40 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
                {error}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Dialog.Close className="rounded-card px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              Cancelar
            </Dialog.Close>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-card bg-primary px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saving ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
      <label
        htmlFor={htmlFor}
        className="field-label mb-1.5 block"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
