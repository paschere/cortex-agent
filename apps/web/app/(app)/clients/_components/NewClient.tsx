'use client';

import { Button } from '@/components/ui/button';
// Not from `@cortex/agent-tools`: the barrel reaches `node:dns/promises` and
// fails the browser bundle. See the header of lib/clients-shape.ts.
import {
  CLIENT_SERVICES,
  CLIENT_STATUSES,
  CUSTOMS_ROLES,
  CUSTOMS_ROLE_LABEL,
  PUBLIC_EMAIL_DOMAINS,
  SERVICE_LABEL,
  STATUS_LABEL,
  type ClientService,
  type ClientStatus,
  type CustomsRole,
} from '@/lib/clients-shape';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { Loader2, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type React from 'react';
import { createClient } from '../actions';

/**
 * Register a client.
 *
 * Two fields carry the weight and the form says so out loud.
 *
 * THE NIT is the identity, so it is asked for first and checked on the server
 * against its own verification digit. A mistyped NIT rejected here is a
 * duplicate client that never exists; accepted, it is a card split in half six
 * months later with neither half looking wrong.
 *
 * THE DOMAIN is what makes the rest of the module work by itself. Everything
 * that arrives from it is attributed to this client with no further review, so
 * the helper text states that in those words, and a free provider is called out
 * in the browser before the server refuses it — the same refusal, said earlier.
 */
export function NewClientButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [nit, setNit] = useState('');
  const [status, setStatus] = useState<ClientStatus>('active');
  const [city, setCity] = useState('');
  const [department, setDepartment] = useState('');
  const [phone, setPhone] = useState('');
  const [domains, setDomains] = useState('');
  const [services, setServices] = useState<ClientService[]>([]);
  const [customsRole, setCustomsRole] = useState<CustomsRole | ''>('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const domainList = domains
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  const publicDomain = domainList.find((d) => PUBLIC_EMAIL_DOMAINS.includes(d));

  function toggleService(service: ClientService) {
    setServices((prev) =>
      prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service],
    );
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await createClient({
        name,
        legalName: legalName || undefined,
        nit: nit || undefined,
        status,
        city: city || undefined,
        department: department || undefined,
        phone: phone || undefined,
        services,
        customsRole: customsRole || null,
        paymentTermsDays: paymentTerms ? Number(paymentTerms) : null,
        domains: domainList,
      });
      if (!result.ok) {
        setError(result.error ?? 'No se pudo registrar.');
        return;
      }
      setOpen(false);
      setName('');
      setLegalName('');
      setNit('');
      setCity('');
      setDepartment('');
      setPhone('');
      setDomains('');
      setServices([]);
      setCustomsRole('');
      setPaymentTerms('');
      if (result.clientId) router.push(`/clients/${result.clientId}`);
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button>
          <Plus className="h-4 w-4" aria-hidden />
          Registrar cliente
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[min(620px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card border border-border bg-surface p-6 shadow-pop outline-none">
          <Dialog.Title className="text-[17px] font-bold tracking-[-0.01em] text-ink">
            Registrar cliente
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[13px] leading-snug text-ink-muted">
            El NIT es la llave de verdad: el nombre se escribe de cinco maneras, el NIT no. Si
            además pones el dominio de su correo, todo lo que llegue de ahí se le cuelga solo.
          </Dialog.Description>

          <div className="mt-5 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nombre" htmlFor="cl-name">
                <input
                  id="cl-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Coltrans"
                  className={INPUT}
                />
              </Field>
              <Field label="NIT" htmlFor="cl-nit">
                <input
                  id="cl-nit"
                  value={nit}
                  onChange={(e) => setNit(e.target.value)}
                  placeholder="830.025.281-7"
                  className={`${INPUT} tabular`}
                />
              </Field>
            </div>

            <Field label="Razón social" htmlFor="cl-legal">
              <input
                id="cl-legal"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                placeholder="Como aparece en el RUT, si es distinta"
                className={INPUT}
              />
            </Field>

            <Field label="Dominios de su correo" htmlFor="cl-domains">
              <input
                id="cl-domains"
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
                placeholder="coltrans.com"
                className={INPUT}
              />
              <p
                className={clsx(
                  'mt-1.5 text-[12px] leading-snug',
                  publicDomain ? 'text-rose' : 'text-ink-faint',
                )}
              >
                {publicDomain
                  ? `${publicDomain} es un correo público, no el dominio de una empresa. Si lo registras, cualquier cuenta personal quedaría atribuida a este cliente.`
                  : 'Todo lo que llegue de estos dominios se le atribuye a este cliente sin revisión. Registra solo los que son suyos.'}
              </p>
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Estado" htmlFor="cl-status">
                <select
                  id="cl-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as ClientStatus)}
                  className={INPUT}
                >
                  {CLIENT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Ciudad" htmlFor="cl-city">
                <input
                  id="cl-city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Buenaventura"
                  className={INPUT}
                />
              </Field>
              <Field label="Departamento" htmlFor="cl-dept">
                <input
                  id="cl-dept"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  placeholder="Valle del Cauca"
                  className={INPUT}
                />
              </Field>
            </div>

            <div>
              <span className="field-label">¿Qué le hacemos?</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {CLIENT_SERVICES.map((service) => {
                  const on = services.includes(service);
                  return (
                    <button
                      key={service}
                      type="button"
                      onClick={() => toggleService(service)}
                      aria-pressed={on}
                      className={clsx(
                        'rounded-pill px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none',
                        on
                          ? 'bg-primary text-white'
                          : 'border border-border bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      {SERVICE_LABEL[service]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Comercio exterior" htmlFor="cl-customs">
                <select
                  id="cl-customs"
                  value={customsRole}
                  onChange={(e) => setCustomsRole(e.target.value as CustomsRole | '')}
                  className={INPUT}
                >
                  <option value="">Sin definir</option>
                  {CUSTOMS_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {CUSTOMS_ROLE_LABEL[role]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Paga a (días)" htmlFor="cl-terms">
                <input
                  id="cl-terms"
                  value={paymentTerms}
                  onChange={(e) => setPaymentTerms(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  placeholder="30"
                  className={`${INPUT} tabular`}
                />
              </Field>
              <Field label="Teléfono" htmlFor="cl-phone">
                <input
                  id="cl-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={INPUT}
                />
              </Field>
            </div>
          </div>

          {error && (
            <p className="mt-4 rounded-sm bg-rose-soft px-3 py-2 text-[12.5px] leading-snug text-rose">
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost" type="button">
                Cancelar
              </Button>
            </Dialog.Close>
            <Button type="button" onClick={submit} disabled={pending || !name.trim()}>
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
 * A labelled control, wired by id rather than by nesting. `htmlFor` is
 * required: half of these are `<select>`s, and a screen reader given an
 * unlabelled select reads the current option and nothing about what it means.
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
