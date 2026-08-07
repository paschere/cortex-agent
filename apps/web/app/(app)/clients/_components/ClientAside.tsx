'use client';

import { Button } from '@/components/ui/button';
import { Panel, PanelHead } from '@/components/ui/panel';
import { Provenance } from '@/components/ui/provenance';
// Not from `@cortex/agent-tools`: the barrel reaches `node:dns/promises` and
// fails the browser bundle. See the header of lib/clients-shape.ts.
import {
  CLIENT_STATUSES,
  PUBLIC_EMAIL_DOMAINS,
  STATUS_LABEL,
  type ClientStatus,
} from '@/lib/clients-shape';
import { clsx } from 'clsx';
import { AtSign, Check, Loader2, Plus, Users, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import {
  acceptProposal,
  discardProposal,
  registerDomain,
  saveClient,
  saveContact,
  unregisterDomain,
} from '../actions';
import type { ContactView, DomainView, LinkView } from './types';

/**
 * The right-hand column of the client card: who is spoken to there, which
 * domains are theirs, and what is waiting on somebody.
 *
 * These three sit together because they are the same job seen from three
 * angles — deciding what belongs to this client. Contacts and domains are the
 * statements a person makes UP FRONT, which is what lets Cortex attach things
 * without asking again. Proposals are the leftovers: what Cortex suspects and
 * has not been told.
 */
export function ClientAside({
  clientId,
  clientName,
  status,
  contacts,
  domains,
  proposals,
}: {
  clientId: string;
  clientName: string;
  status: ClientStatus;
  contacts: ContactView[];
  domains: DomainView[];
  proposals: LinkView[];
}) {
  return (
    <div className="space-y-4">
      {proposals.length > 0 && (
        <Proposals clientId={clientId} clientName={clientName} proposals={proposals} />
      )}
      <Contacts clientId={clientId} contacts={contacts} />
      <Domains clientId={clientId} domains={domains} />
      <StatusPicker clientId={clientId} status={status} />
    </div>
  );
}

/**
 * What Cortex suspects, and has not been told.
 *
 * These are NOT on the card above, and the wording has to keep saying so: a
 * proposal that reads like a fact is worse than no proposal, because the whole
 * value of the card is that everything on it is true. Two buttons, both cheap,
 * and the evidence is right there so the decision takes a glance rather than an
 * investigation.
 */
function Proposals({
  clientId,
  clientName,
  proposals,
}: {
  clientId: string;
  clientName: string;
  proposals: LinkView[];
}) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(id);
    setError(null);
    startTransition(async () => {
      const result = await fn();
      setBusy(null);
      if (!result.ok) setError(result.error ?? 'No se pudo.');
    });
  }

  return (
    <Panel className="border-amber/30">
      <PanelHead title="Por revisar" right={`${proposals.length}`} />
      <p className="px-5 pt-1 text-[12.5px] leading-snug text-ink-muted">
        Cortex cree que esto es de {clientName}, pero nadie lo ha confirmado, así que no aparece en
        la ficha ni cuenta en ningún número.
      </p>
      {error && (
        <p className="mx-5 mt-3 rounded-sm bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          {error}
        </p>
      )}
      <ul className="mt-3 divide-y divide-border">
        {proposals.map((p) => (
          <li key={p.id} className="px-5 py-3">
            <p className="truncate text-[13px] font-medium text-ink">{p.label}</p>
            <p className="mt-0.5 text-[11.5px] text-ink-faint">
              {p.kindLabel} · {p.why}
            </p>
            {p.evidence && (
              <p className="tabular mt-1 truncate text-[11.5px] text-ink-muted">{p.evidence}</p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="outline"
                type="button"
                disabled={pending}
                onClick={() => run(p.id, () => acceptProposal(clientId, p.id))}
              >
                {busy === p.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Check className="h-3.5 w-3.5" aria-hidden />
                )}
                Sí es
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={pending}
                onClick={() => run(p.id, () => discardProposal(clientId, p.id))}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                No es
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="h-2" />
    </Panel>
  );
}

function Contacts({ clientId, contacts }: { clientId: string; contacts: ContactView[] }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveContact({
        clientId,
        fullName: name,
        email: email || undefined,
        roleTitle: role || undefined,
        isPrimary: contacts.length === 0,
      });
      if (!result.ok) {
        setError(result.error ?? 'No se pudo guardar.');
        return;
      }
      setName('');
      setEmail('');
      setRole('');
      setAdding(false);
    });
  }

  return (
    <Panel>
      <PanelHead
        icon={<Users className="h-4 w-4" aria-hidden />}
        title="Con quién se habla ahí"
        right={contacts.length > 0 ? `${contacts.length}` : undefined}
      />
      {contacts.length === 0 && !adding && (
        <p className="px-5 pb-1 pt-2 text-[12.5px] leading-snug text-ink-muted">
          Nadie registrado todavía. Con el correo de una persona, lo que ella escriba se le atribuye
          a este cliente aunque no tengas el dominio completo.
        </p>
      )}
      <ul className="mt-2 divide-y divide-border">
        {contacts.map((c) => (
          <li key={c.id} className="px-5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium text-ink">{c.name}</span>
              {c.isPrimary && (
                <span className="shrink-0 rounded-pill bg-primary-soft px-2 py-0.5 text-[10px] font-bold text-primary">
                  principal
                </span>
              )}
            </div>
            {c.role && <p className="text-[11.5px] text-ink-faint">{c.role}</p>}
            {c.email && <p className="tabular truncate text-[12px] text-ink-muted">{c.email}</p>}
          </li>
        ))}
      </ul>

      <div className="px-5 pb-4 pt-3">
        {adding ? (
          <div className="space-y-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nombre y apellido"
              aria-label="Nombre del contacto"
              className={INPUT}
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="correo@cliente.com"
              aria-label="Correo del contacto"
              className={`${INPUT} tabular`}
            />
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="Cargo (opcional)"
              aria-label="Cargo del contacto"
              className={INPUT}
            />
            {error && <p className="text-[12px] text-rose">{error}</p>}
            <div className="flex items-center gap-2">
              <Button type="button" onClick={submit} disabled={pending || !name.trim()}>
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                Guardar
              </Button>
              <Button variant="ghost" type="button" onClick={() => setAdding(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" type="button" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Agregar contacto
          </Button>
        )}
      </div>
    </Panel>
  );
}

/**
 * The domains, and the sentence that makes them consequential.
 *
 * Registering one is the strongest thing a person can do on this screen: from
 * then on, every mail from that domain is attributed to this client with no
 * further review. The copy says that in those words rather than calling it
 * "vincular correo", and a free provider is called out before the server
 * refuses it.
 */
function Domains({ clientId, domains }: { clientId: string; domains: DomainView[] }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const candidate = value.trim().toLowerCase().replace(/^@/, '');
  const isPublic = PUBLIC_EMAIL_DOMAINS.includes(candidate);

  function add() {
    setError(null);
    startTransition(async () => {
      const result = await registerDomain(clientId, candidate);
      if (!result.ok) {
        setError(result.error ?? 'No se pudo registrar.');
        return;
      }
      setValue('');
    });
  }

  return (
    <Panel>
      <PanelHead icon={<AtSign className="h-4 w-4" aria-hidden />} title="Dominios de su correo" />
      <p className="px-5 pt-1 text-[12.5px] leading-snug text-ink-muted">
        Todo lo que llegue de estos dominios se le atribuye a este cliente sin que nadie lo revise.
        Por eso queda a nombre de quien lo registró.
      </p>

      <ul className="mt-3 divide-y divide-border">
        {domains.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 px-5 py-2.5">
            <div className="min-w-0">
              <p className="tabular truncate text-[13px] font-medium text-ink">@{d.domain}</p>
              {d.verifiedBy && (
                <Provenance
                  source={d.verifiedBy}
                  readAt={d.verifiedLabel ?? undefined}
                  detail="lo registró"
                  className="mt-1"
                />
              )}
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await unregisterDomain(clientId, d.id);
                })
              }
              aria-label={`Quitar ${d.domain}`}
              className="shrink-0 rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-rose-soft hover:text-rose focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose/40 motion-reduce:transition-none"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>

      <div className="space-y-2 px-5 pb-4 pt-3">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="coltrans.com"
          aria-label="Dominio del cliente"
          className={`${INPUT} tabular`}
        />
        {(isPublic || error) && (
          <p className={clsx('text-[12px] leading-snug', 'text-rose')}>
            {isPublic
              ? `${candidate} es un correo público. Si lo registras, cualquier cuenta personal quedaría atribuida a este cliente.`
              : error}
          </p>
        )}
        <Button
          variant="outline"
          type="button"
          onClick={add}
          disabled={pending || !candidate.includes('.') || isPublic}
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Registrar dominio
        </Button>
      </div>
    </Panel>
  );
}

function StatusPicker({ clientId, status }: { clientId: string; status: ClientStatus }) {
  const [pending, startTransition] = useTransition();
  return (
    <Panel>
      <PanelHead title="Estado" />
      <div className="px-5 pb-4 pt-2">
        <select
          value={status}
          aria-label="Estado del cliente"
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value as ClientStatus;
            startTransition(async () => {
              await saveClient(clientId, { status: next });
            });
          }}
          className={INPUT}
        >
          {CLIENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <p className="mt-2 text-[11.5px] leading-snug text-ink-faint">
          &ldquo;Bloqueado&rdquo; es una decisión, no una descripción: significa que no se le
          despacha.
        </p>
      </div>
    </Panel>
  );
}

const INPUT =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-[13px] text-ink shadow-sm outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/20 motion-reduce:transition-none';
