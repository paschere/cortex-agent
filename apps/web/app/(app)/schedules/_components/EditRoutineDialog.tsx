'use client';

import { SchedulePickerField } from '@/components/forms/SchedulePickerField';
import { type ScheduleDraft, draftFromSchedule, resolveDraft } from '@/lib/schedule-picker';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { Loader2, Mail, Plus, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RoutinePatch, ScheduledJob } from './types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
  const [schedule, setSchedule] = useState<ScheduleDraft>(() => draftFromSchedule({}));
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [recipientDraft, setRecipientDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jobId = job?.id ?? null;

  // Re-seed the form whenever a different routine is opened.
  useEffect(() => {
    if (!job) return;
    setName(job.name);
    setSchedule(draftFromSchedule(job));
    setNotifyEmail(job.notifyEmail);
    setRecipients(job.recipients);
    setRecipientDraft('');
    setError(null);
    setSaving(false);
  }, [job]);

  if (!job || !jobId) return null;

  // A finished one-off has nothing left to reschedule: the API refuses to
  // switch kinds on a routine that is not active or paused.
  const live = job.status === 'active' || job.status === 'paused';
  const canRetime = live || job.scheduleKind === 'cron';

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
    if (!job) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Ponle un nombre a la rutina.');
      return;
    }
    const resolved = canRetime ? resolveDraft(schedule) : null;
    if (resolved && !resolved.ok) {
      // A one-off whose moment already passed and was not touched is not an
      // error: only the other fields are being edited.
      const untouchedOnce =
        job.scheduleKind === 'once' &&
        schedule.picker.mode === 'once' &&
        !schedule.custom &&
        draftFromSchedule(job).picker.date === schedule.picker.date &&
        draftFromSchedule(job).picker.time === schedule.picker.time;
      if (!untouchedOnce) {
        setError(resolved.error);
        return;
      }
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
      timezone: schedule.timezone,
      notifyEmail,
      recipients: finalRecipients,
    };
    // Send the schedule only when it changed: re-sending an old one-off time
    // would be refused as "in the past".
    if (resolved?.ok && resolved.kind === 'cron') {
      if (job.scheduleKind !== 'cron' || resolved.cron !== job.cron) patch.cron = resolved.cron;
    } else if (resolved?.ok && resolved.kind === 'once') {
      const saved = job.runAt ? new Date(job.runAt).toISOString() : null;
      if (job.scheduleKind !== 'once' || resolved.runAt !== saved) patch.runAt = resolved.runAt;
    }

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
                <Dialog.Description className="text-micro text-ink-faint">
                  El nombre, la hora y a quién le llega. La instrucción se cambia desde el chat.
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              className="grid h-8 w-8 shrink-0 place-items-center rounded-card text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Cerrar"
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
                className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
                placeholder="Reporte de clientes del viernes"
              />
            </Field>

            {canRetime ? (
              <SchedulePickerField
                idPrefix="routine-schedule"
                value={schedule}
                onChange={setSchedule}
                allowOnce={live}
              />
            ) : (
              <div className="rounded-card border border-border bg-surface-2 px-3 py-2.5 text-xs text-ink-muted">
                Esta rutina ya corrió su única vez, así que no se le puede cambiar la hora aquí.
                Pídele a Cortex en el chat una nueva a la hora que quieras.
              </div>
            )}

            <div>
              <div className="field-label mb-2">Entrega</div>
              <button
                type="button"
                onClick={() => setNotifyEmail(!notifyEmail)}
                className="flex w-full items-center justify-between gap-3 rounded-card border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Mail className="h-4 w-4 text-ink-faint" /> Enviar el resultado por correo
                </span>
                <span
                  className={clsx(
                    'relative h-5 w-9 shrink-0 rounded-pill border transition-colors',
                    notifyEmail ? 'border-primary bg-primary' : 'border-border bg-surface-2',
                  )}
                >
                  <span
                    className={clsx(
                      'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-surface transition-all',
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
                        className="inline-flex items-center gap-1 rounded-pill border border-primary/30 bg-primary-soft py-0.5 pl-2 pr-1 font-mono text-micro font-semibold text-primary"
                      >
                        {r}
                        <button
                          type="button"
                          onClick={() => setRecipients(recipients.filter((x) => x !== r))}
                          className="grid h-4 w-4 place-items-center rounded-full transition-colors hover:bg-primary hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
                    className="min-w-0 flex-1 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
                  />
                  <button
                    type="button"
                    onClick={() => addRecipient()}
                    className="inline-flex shrink-0 items-center gap-1 rounded-pill border border-border-strong bg-surface px-2.5 text-xs font-semibold text-ink-muted shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transform-none motion-reduce:transition-none"
                  >
                    <Plus className="h-3.5 w-3.5" /> Agregar
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div className="rounded-card border border-rose/40 bg-rose-soft px-3 py-2 text-xs text-rose">
                {error}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Dialog.Close className="rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              Cancelar
            </Dialog.Close>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3.5 py-1.5 text-xs font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none"
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
      <label htmlFor={htmlFor} className="field-label mb-1.5 block">
        {label}
      </label>
      {children}
    </div>
  );
}
