'use client';

import { Button } from '@/components/ui/button';
import { COMMITMENT_KINDS, DEFAULT_NOTICE_DAYS, KIND_LABEL } from '@cortex/agent-tools';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, Plus } from 'lucide-react';
import { useState, useTransition } from 'react';
import { recordCommitment } from '../actions';

/**
 * Register a commitment by hand.
 *
 * There is no field here for "where did this come from", and that absence is
 * deliberate: whatever is typed on this form was stated by the person typing
 * it, so it is filed under their name and the chip on the resulting card says
 * so. A source picker would let somebody label their own guess as "RUNT", and
 * then the chip would mean nothing anywhere on the screen.
 *
 * The warning window fills itself from the kind — a month for a SOAT, three
 * days for a payment — and stays editable. Most people will never touch it,
 * which is the point of having a sensible default per type.
 */
export function NewCommitmentButton({ people }: { people: Array<{ id: string; name: string }> }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof COMMITMENT_KINDS)[number]>('other');
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [amount, setAmount] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [noticeDays, setNoticeDays] = useState<string>('');
  const [recurrence, setRecurrence] = useState<'none' | 'monthly' | 'quarterly' | 'yearly'>('none');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const effectiveNotice = noticeDays === '' ? DEFAULT_NOTICE_DAYS[kind] : Number(noticeDays);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await recordCommitment({
        title,
        dueOn,
        kind,
        counterparty: counterparty || undefined,
        amountCop: amount ? Number(amount.replace(/\D/g, '')) : null,
        noticeDays: noticeDays === '' ? null : Number(noticeDays),
        ownerUserId: ownerUserId || null,
        recurrence,
      });
      if (!result.ok) {
        setError(result.error ?? 'No se pudo registrar.');
        return;
      }
      setOpen(false);
      setTitle('');
      setDueOn('');
      setCounterparty('');
      setAmount('');
      setNoticeDays('');
      setRecurrence('none');
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button>
          <Plus className="h-4 w-4" aria-hidden />
          Registrar vencimiento
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[min(560px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card border border-border bg-surface p-6 shadow-pop outline-none">
          <Dialog.Title className="text-[17px] font-bold tracking-[-0.01em] text-ink">
            Registrar vencimiento
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[13px] leading-snug text-ink-muted">
            Queda a tu nombre: la fuente de esta fecha eres tú, y así se va a mostrar.
          </Dialog.Description>

          <div className="mt-5 space-y-4">
            <Field label="¿Qué es?" htmlFor="c-title">
              <input
                id="c-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Renovación contrato Servientrega"
                className={INPUT}
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Tipo" htmlFor="c-kind">
                <select
                  id="c-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as typeof kind)}
                  className={INPUT}
                >
                  {COMMITMENT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="¿Cuándo se vence?" htmlFor="c-due">
                <input
                  id="c-due"
                  type="date"
                  value={dueOn}
                  onChange={(e) => setDueOn(e.target.value)}
                  className={`${INPUT} tabular`}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="¿Con quién?" htmlFor="c-party">
                <input
                  id="c-party"
                  value={counterparty}
                  onChange={(e) => setCounterparty(e.target.value)}
                  placeholder="Cliente, proveedor o entidad"
                  className={INPUT}
                />
              </Field>
              <Field label="Valor (COP)" htmlFor="c-amount">
                <input
                  id="c-amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="numeric"
                  placeholder="Opcional"
                  className={`${INPUT} tabular`}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="¿Quién responde?" htmlFor="c-owner">
                <select
                  id="c-owner"
                  value={ownerUserId}
                  onChange={(e) => setOwnerUserId(e.target.value)}
                  className={INPUT}
                >
                  <option value="">Yo</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`Avisar con ${effectiveNotice} días`} htmlFor="c-notice">
                <input
                  id="c-notice"
                  type="number"
                  min={0}
                  max={365}
                  value={noticeDays}
                  onChange={(e) => setNoticeDays(e.target.value)}
                  placeholder={String(DEFAULT_NOTICE_DAYS[kind])}
                  className={`${INPUT} tabular`}
                />
              </Field>
            </div>

            <Field label="¿Se repite?" htmlFor="c-recurrence">
              <select
                id="c-recurrence"
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value as typeof recurrence)}
                className={INPUT}
              >
                <option value="none">No se repite</option>
                <option value="monthly">Cada mes</option>
                <option value="quarterly">Cada trimestre</option>
                <option value="yearly">Cada año</option>
              </select>
            </Field>
            <p className="text-[11.5px] leading-snug text-ink-faint">
              Sólo marca que se repite si tú sabes la periodicidad. Cuando lo marques como cumplido,
              el siguiente aparece solo con esa misma cadencia.
            </p>

            {error && (
              <div
                role="alert"
                className="rounded-sm border border-rose/25 bg-rose-soft px-3 py-2 text-[12.5px] text-rose"
              >
                {error}
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost" type="button">
                Cancelar
              </Button>
            </Dialog.Close>
            <Button type="button" onClick={submit} disabled={pending || !title.trim() || !dueOn}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Registrar
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const INPUT =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-[13.5px] text-ink shadow-sm outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/20 motion-reduce:transition-none';

/**
 * A labelled control, wired by id rather than by nesting.
 *
 * `htmlFor` is required, not optional: half of these controls are `<select>`s,
 * and a screen reader given an unlabelled select reads out the current option
 * and nothing about what it means.
 */
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
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
