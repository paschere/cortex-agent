'use client';

import { Button } from '@/components/ui/button';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type React from 'react';
import type { ActionResult, Option, TrackInput } from './types';

/**
 * Registrar a mano un papel que vence. Nace confirmado por quien lo escribe:
 * la fecha es la que esa persona afirma, y queda a su nombre.
 */

export const INPUT =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink shadow-sm outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/20 motion-reduce:transition-none';

const VEHICLE_KINDS = new Set(['soat', 'tecnomecanica']);

export function NewExpirationButton({
  kinds,
  subjectKinds,
  team,
  leadDays,
  onTrack,
}: {
  kinds: Option[];
  subjectKinds: Option[];
  team: Option[];
  /** Anticipación por defecto de cada tipo, para mostrarla en el campo. */
  leadDays: Record<string, number>;
  onTrack: (input: TrackInput) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(kinds[0]?.value ?? 'poliza');
  const [subjectKind, setSubjectKind] = useState('empresa');
  const [subject, setSubject] = useState('');
  const [label, setLabel] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [issuer, setIssuer] = useState('');
  const [number, setNumber] = useState('');
  const [owner, setOwner] = useState('');
  const [lead, setLead] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function pickKind(value: string) {
    setKind(value);
    if (VEHICLE_KINDS.has(value)) setSubjectKind('vehiculo');
    else if (value === 'contrato') setSubjectKind('cliente');
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!expiresOn) {
      setError('Falta la fecha de vencimiento.');
      return;
    }
    if (VEHICLE_KINDS.has(kind) && !subject.trim()) {
      setError('Escribe la placa del vehículo.');
      return;
    }
    start(async () => {
      const result = await onTrack({
        kind,
        expiresOn,
        subject: subject.trim() || undefined,
        subjectKind,
        label: label.trim() || undefined,
        issuer: issuer.trim() || undefined,
        number: number.trim() || undefined,
        ownerUserId: owner || undefined,
        renewalLeadDays: lead ? Number(lead) : undefined,
      });
      if (!result.ok) {
        setError(result.error ?? 'No se pudo registrar.');
        return;
      }
      setOpen(false);
      setSubject('');
      setLabel('');
      setExpiresOn('');
      setIssuer('');
      setNumber('');
      setLead('');
      router.refresh();
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button>
          <Plus className="h-4 w-4" aria-hidden />
          Registrar documento
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[min(560px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card border border-border bg-surface p-6 shadow-pop outline-none">
          <Dialog.Title className="text-lg font-bold tracking-[-0.01em] text-ink">
            Registrar un documento que vence
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-snug text-ink-muted">
            Queda vigilado desde ya y a tu nombre como fuente. Si ya tenías uno anterior del mismo
            tipo y del mismo vehículo o cliente, queda como renovado.
          </Dialog.Description>
          <form onSubmit={submit} className="mt-5 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tipo" htmlFor="ne-kind">
                <select
                  id="ne-kind"
                  value={kind}
                  onChange={(e) => pickKind(e.target.value)}
                  className={INPUT}
                >
                  {kinds.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Vence el" htmlFor="ne-expires">
                <input
                  id="ne-expires"
                  type="date"
                  required
                  value={expiresOn}
                  onChange={(e) => setExpiresOn(e.target.value)}
                  className={`${INPUT} tabular`}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Es de" htmlFor="ne-subject-kind">
                <select
                  id="ne-subject-kind"
                  value={subjectKind}
                  onChange={(e) => setSubjectKind(e.target.value)}
                  className={INPUT}
                >
                  {subjectKinds.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={subjectKind === 'vehiculo' ? 'Placa' : 'Nombre'} htmlFor="ne-subject">
                <input
                  id="ne-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={subjectKind === 'vehiculo' ? 'WGY482' : 'Opcional'}
                  className={INPUT}
                />
              </Field>
            </div>
            <Field label="Nombre del documento" htmlFor="ne-label">
              <input
                id="ne-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Póliza de responsabilidad civil (opcional)"
                className={INPUT}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Expedido por" htmlFor="ne-issuer">
                <input
                  id="ne-issuer"
                  value={issuer}
                  onChange={(e) => setIssuer(e.target.value)}
                  placeholder="Aseguradora, entidad…"
                  className={INPUT}
                />
              </Field>
              <Field label="Número" htmlFor="ne-number">
                <input
                  id="ne-number"
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  className={INPUT}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Responsable" htmlFor="ne-owner">
                <select
                  id="ne-owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  className={INPUT}
                >
                  <option value="">Yo</option>
                  {team.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Avisar con (días)" htmlFor="ne-lead">
                <input
                  id="ne-lead"
                  type="number"
                  min={0}
                  max={365}
                  value={lead}
                  onChange={(e) => setLead(e.target.value)}
                  placeholder={String(leadDays[kind] ?? 30)}
                  className={`${INPUT} tabular`}
                />
              </Field>
            </div>
            {error && (
              <p role="alert" className="rounded-sm bg-rose-soft px-3 py-2 text-xs text-rose">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" variant="ghost">
                  Cancelar
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Registrar
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Field({
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
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}
