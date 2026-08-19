'use client';

import { cop, plural, shortDate } from '@/app/(app)/clients/_components/format';
import { type ClientStatus, STATUS_TONE } from '@/lib/clients-shape';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { Building2, Star } from 'lucide-react';
import { PinSurface } from '../PinSurface';
import type { ResultViewProps } from './registry';

/**
 * «¿QUÉ TENEMOS DE COLTRANS?» — TODO LO GUARDADO, EN UNA TARJETA.
 *
 * ===========================================================================
 * LO QUE NO SE INVENTA
 * ===========================================================================
 * `clients.overview` sólo dice lo que está guardado, y esta tarjeta hereda esa
 * disciplina hasta el final: un cliente sin nada colgado sale VACÍO, con la
 * frase que explica por qué, en vez de descrito. Es la diferencia entre una
 * ficha y un resumen, y es la única versión que se puede llevar a una reunión.
 *
 * ===========================================================================
 * LAS PROPUESTAS SIN CONFIRMAR NO SON HECHOS, Y SE DIBUJAN COMO LO QUE SON
 * ===========================================================================
 * Cortex propone vínculos —«este correo parece de este cliente»— y nadie los ha
 * revisado. Meterlos en la misma lista que lo confirmado convertiría una
 * sospecha en un dato con sólo enseñarla. Van aparte, en ámbar, contadas y
 * dichas: ámbar significa en este producto «una persona tiene que mirar esto»,
 * que es exactamente lo que son.
 *
 * ===========================================================================
 * POR QUÉ NO SE PINTA EL `markdown`
 * ===========================================================================
 * La herramienta también devuelve la ficha ya escrita en prosa, y ésa es para el
 * modelo: es lo que le permite CONTAR el cliente en su respuesta. Repetirla
 * debajo sería decir dos veces lo mismo con dos tipografías. La tarjeta enseña
 * la estructura —estado, con quién se habla, qué se vence, qué está vinculado—
 * que es lo que la prosa no puede dar de un vistazo.
 */

const CONTACTS_SHOWN = 5;
const DUE_SHOWN = 5;

/**
 * `clients-shape.ts` habla el vocabulario de color del sistema de diseño, donde
 * un prospecto es `sky`; el chip de estado no tiene ese tono y llama `primary`
 * a «el sistema está afirmando algo». Una traducción aquí, y no una segunda
 * paleta que acabaría discrepando de la primera — es la misma junta que
 * `ProposedActionCard` hace con los tonos de desenlace.
 */
function statusTone(status: string): StatusTone {
  const tone = STATUS_TONE[status as ClientStatus];
  if (!tone) return 'neutral';
  return tone === 'sky' ? 'primary' : tone;
}

interface Client {
  id: string;
  name: string;
  nit: string | null;
  status: string;
  statusLabel: string;
  city: string | null;
  department: string | null;
  owner: string | null;
  paymentTermsDays: number | null;
}

interface Contact {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  isPrimary: boolean;
}

interface Due {
  title: string;
  kind: string;
  dueOn: string;
  state: string;
  amountCop: number | null;
}

interface Overview {
  client: Client;
  contacts: Contact[];
  domains: string[];
  commitments: Due[];
  linksByKind: Array<[string, number]>;
  linkCount: number;
  proposals: number;
}

export function ClientOverview({ result, toolCallId }: ResultViewProps) {
  const view = overviewOf(result);
  if (!view) return null;

  const { client } = view;
  const tone = statusTone(client.status);
  const place = [client.city, client.department].filter(Boolean).join(', ');
  const bare = view.contacts.length === 0 && view.commitments.length === 0 && view.linkCount === 0;

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-primary-soft px-4 py-3">
        <Building2 className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="text-sm font-semibold text-ink">{client.name}</span>
        <span className={chipClass(tone)}>{client.statusLabel}</span>
        {client.nit && <span className="tabular text-xs text-ink-muted">NIT {client.nit}</span>}
        {place && <span className="text-xs text-ink-muted">{place}</span>}
        <span className="ml-auto">
          <PinSurface
            surface="client"
            surfaceKey={client.id}
            hidden={toolCallId.startsWith('panel:')}
          />
        </span>
      </div>

      {(client.owner || client.paymentTermsDays != null || view.domains.length > 0) && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-xs text-ink-muted">
          {client.owner && <span>Responde acá {client.owner}</span>}
          {client.paymentTermsDays != null && (
            <span>Paga a {plural(client.paymentTermsDays, 'día')}</span>
          )}
          {view.domains.length > 0 && (
            <span className="tabular text-ink-faint">{view.domains.join(' · ')}</span>
          )}
        </p>
      )}

      {view.contacts.length > 0 && (
        <section className="border-b border-border px-4 py-2.5">
          <h4 className="field-label">Con quién se habla ahí</h4>
          <ul className="mt-1 space-y-0.5">
            {view.contacts.slice(0, CONTACTS_SHOWN).map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-2 text-xs text-ink">
                {c.isPrimary && <Star className="h-3 w-3 shrink-0 text-amber" aria-hidden />}
                <span className="font-medium">{c.name}</span>
                {c.role && <span className="text-ink-muted">{c.role}</span>}
                {c.email && <span className="tabular text-ink-faint">{c.email}</span>}
              </li>
            ))}
          </ul>
          {view.contacts.length > CONTACTS_SHOWN && (
            <p className="mt-1 text-micro text-ink-faint">
              y {plural(view.contacts.length - CONTACTS_SHOWN, 'contacto')} más
            </p>
          )}
        </section>
      )}

      {view.commitments.length > 0 && (
        <section className="border-b border-border px-4 py-2.5">
          <h4 className="field-label">Vencimientos</h4>
          <ul className="mt-1 space-y-0.5">
            {view.commitments.slice(0, DUE_SHOWN).map((d) => (
              <li
                key={`${d.title}:${d.dueOn}`}
                className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink"
              >
                <span className="font-medium">{d.title}</span>
                <span className="text-ink-muted">{d.kind}</span>
                <span className="tabular ml-auto">{shortDate(d.dueOn)}</span>
                {d.amountCop != null && (
                  <span className="tabular text-ink-muted">{cop(d.amountCop)}</span>
                )}
                <span className="text-micro text-ink-faint">{d.state}</span>
              </li>
            ))}
          </ul>
          {view.commitments.length > DUE_SHOWN && (
            <p className="mt-1 text-micro text-ink-faint">
              y {plural(view.commitments.length - DUE_SHOWN, 'vencimiento')} más
            </p>
          )}
        </section>
      )}

      {view.linkCount > 0 && (
        <section className="border-b border-border px-4 py-2.5">
          <h4 className="field-label">Lo que está vinculado</h4>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {view.linksByKind.map(([kind, count]) => (
              <li key={kind} className={chipClass('neutral')}>
                {kind}
                <span className="tabular font-semibold">{count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.proposals > 0 && (
        <p className="border-b border-border bg-amber-soft px-4 py-2 text-xs leading-relaxed text-amber">
          {plural(view.proposals, 'propuesta sin confirmar', 'propuestas sin confirmar')}: Cortex
          cree que son de este cliente y nadie lo ha revisado, así que todavía no cuentan.
        </p>
      )}

      {bare && (
        <p className="px-4 py-3 text-xs leading-relaxed text-ink-muted">
          Todavía no hay nada colgado de este cliente. Registrar el dominio de su correo es lo que
          hace que empiece a llenarse solo.
        </p>
      )}
    </div>
  );
}

/**
 * Lo que llega cruzó un stream y, en una conversación reabierta, una fila de la
 * base. Sin nombre de cliente no hay ficha: una tarjeta encabezada por nada es
 * una ficha de un cliente que no se sabe cuál es.
 */
function overviewOf(result: unknown): Overview | null {
  if (!result || typeof result !== 'object' || '__error' in result) return null;
  const r = result as Record<string, unknown>;
  const raw = r.client;
  if (!raw || typeof raw !== 'object' || typeof (raw as Client).name !== 'string') return null;
  const c = raw as Record<string, unknown>;

  const contacts = (Array.isArray(r.contacts) ? r.contacts : []).flatMap((row): Contact[] => {
    if (!row || typeof row !== 'object') return [];
    const v = row as Record<string, unknown>;
    if (typeof v.id !== 'string' || typeof v.name !== 'string') return [];
    return [
      {
        id: v.id,
        name: v.name,
        email: typeof v.email === 'string' ? v.email : null,
        role: typeof v.role === 'string' ? v.role : null,
        isPrimary: v.isPrimary === true,
      },
    ];
  });

  const commitments = (Array.isArray(r.commitments) ? r.commitments : []).flatMap((row): Due[] => {
    if (!row || typeof row !== 'object') return [];
    const v = row as Record<string, unknown>;
    if (typeof v.title !== 'string' || typeof v.dueOn !== 'string') return [];
    return [
      {
        title: v.title,
        kind: typeof v.kind === 'string' ? v.kind : '',
        dueOn: v.dueOn,
        state: typeof v.state === 'string' ? v.state : '',
        amountCop: typeof v.amountCop === 'number' ? v.amountCop : null,
      },
    ];
  });

  // Cuántos de cada cosa, que es lo que se puede leer de un vistazo. La lista
  // entera de vínculos es material de pantalla, no de conversación.
  const byKind = new Map<string, number>();
  const links = Array.isArray(r.links) ? r.links : [];
  for (const row of links) {
    if (!row || typeof row !== 'object') continue;
    const label = (row as { kindLabel?: unknown }).kindLabel;
    if (typeof label !== 'string') continue;
    byKind.set(label, (byKind.get(label) ?? 0) + 1);
  }

  return {
    client: {
      id: typeof c.id === 'string' ? c.id : '',
      name: c.name as string,
      nit: typeof c.nit === 'string' ? c.nit : null,
      status: typeof c.status === 'string' ? c.status : '',
      statusLabel: typeof c.statusLabel === 'string' ? c.statusLabel : '',
      city: typeof c.city === 'string' ? c.city : null,
      department: typeof c.department === 'string' ? c.department : null,
      owner: typeof c.owner === 'string' ? c.owner : null,
      paymentTermsDays: typeof c.paymentTermsDays === 'number' ? c.paymentTermsDays : null,
    },
    contacts,
    domains: (Array.isArray(r.domains) ? r.domains : []).filter(
      (d): d is string => typeof d === 'string',
    ),
    commitments,
    linksByKind: [...byKind.entries()],
    linkCount: links.length,
    proposals: Array.isArray(r.proposals) ? r.proposals.length : 0,
  };
}
