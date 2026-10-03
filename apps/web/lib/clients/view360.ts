import { type ClientStatus, STATUS_LABEL } from '@/lib/clients-shape';
import {
  CLIENT_SOURCE_LABEL,
  type Client360,
  type ClientMoney,
  TIMELINE_KIND_LABEL,
  type TimelineKind,
} from '@cortex/agent-tools';
import type { Client360View, MoneyView, Piece, TimelineEntry, Tone } from './types';

/**
 * LA FICHA, LISTA PARA PINTAR: de `Client360` (lo leído) a `Client360View`
 * (frases y cifras en español de Colombia). Puro; lo usan la página y el
 * escaparate. Las fechas de calendario se formatean desde el TEXTO, nunca con
 * un Date (un «2026-09-14» parseado se vuelve 13 al oeste de Bogotá).
 */

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

export function dayLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return iso;
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

function monthLabel(iso: string): string {
  const [y, m] = iso.slice(0, 10).split('-');
  return `${MONTHS_LONG[Number(m) - 1] ?? m} ${y}`;
}

/** «$ 12,4 M», «$ 850 mil»: corto, para tarjetas. */
export function shortMoney(value: number): string {
  const n = Math.abs(Math.round(value));
  const sign = value < 0 ? '−' : '';
  const one = (x: number) => x.toLocaleString('es-CO', { maximumFractionDigits: 1 });
  if (n >= 1e9) return `${sign}$ ${one(n / 1e9)} mil M`;
  if (n >= 1e6) return `${sign}$ ${one(n / 1e6)} M`;
  if (n >= 1e3) return `${sign}$ ${Math.round(n / 1e3).toLocaleString('es-CO')} mil`;
  return `${sign}$ ${n.toLocaleString('es-CO')}`;
}

/** «$4.250.000»: entero, para cuando el número exacto importa. */
export function fullMoney(value: number): string {
  return `$${Math.round(value).toLocaleString('es-CO')}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function daysFrom(today: string, iso: string): number {
  return Math.round(
    (Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}

function moneyView(m: ClientMoney, today: string): MoneyView {
  const nextDays = m.nextDue ? daysFrom(today, m.nextDue.on) : null;
  return {
    invoiced12m: shortMoney(m.invoiced12m),
    invoiced12mNote:
      m.invoiced12mCount > 0
        ? `${plural(m.invoiced12mCount, 'factura')} en el último año`
        : 'Sin facturas en el último año',
    outstanding: shortMoney(m.outstanding),
    outstandingNote:
      m.openCount > 0
        ? `${plural(m.openCount, 'factura abierta', 'facturas abiertas')}`
        : 'No debe nada',
    overdue: shortMoney(m.overdue),
    overdueNote:
      m.overdueCount > 0
        ? `${plural(m.overdueCount, 'factura')}; la más vieja hace ${m.maxDaysOverdue} días`
        : 'Nada vencido',
    overdueTone: m.overdue <= 0 ? 'emerald' : (m.maxDaysOverdue ?? 0) > 60 ? 'rose' : 'amber',
    paymentDays: m.paymentDays ? `${m.paymentDays.average} días` : null,
    paymentDaysNote: m.paymentDays
      ? `Promedio de ${plural(m.paymentDays.sample, 'factura pagada', 'facturas pagadas')}`
      : 'Sin facturas pagadas con fecha de pago',
    nextDue: m.nextDue ? fullMoney(m.nextDue.amount) : null,
    nextDueNote: m.nextDue
      ? `${m.nextDue.docNumber ? `Factura ${m.nextDue.docNumber}, ` : ''}vence ${dayLabel(m.nextDue.on)}${nextDays === 0 ? ' (hoy)' : nextDays === 1 ? ' (mañana)' : nextDays != null ? ` (en ${nextDays} días)` : ''}`
      : null,
    otherCurrencies: m.otherCurrencies,
  };
}

function piece<T, U>(
  s: { ok: true; data: T } | { ok: false; error: string },
  map: (t: T) => U,
): Piece<U> {
  return s.ok ? { ok: true, data: map(s.data) } : { ok: false, error: s.error };
}

const KIND_TONE: Partial<Record<TimelineKind, Tone>> = {
  payment: 'emerald',
  action: 'primary',
};

/** Preguntas a Cortex con el contexto del cliente. */
function askLinks(name: string): Array<{ label: string; href: string }> {
  const ask = (label: string, prompt: string) => ({
    label,
    href: `/chat?prompt=${encodeURIComponent(prompt)}`,
  });
  return [
    ask(
      `Resume cómo va ${name}`,
      `Resume cómo va ${name}: plata, lo abierto y lo último que pasó.`,
    ),
    ask(
      'Redacta un recordatorio de pago',
      `Redacta un recordatorio de pago amable para ${name} por sus facturas vencidas.`,
    ),
    ask('¿Qué le prometimos?', `¿Qué compromisos tenemos abiertos con ${name} y cuándo vencen?`),
    ask(
      'Prepárame la próxima reunión',
      `Prepárame la próxima reunión con ${name}: qué nos debe, qué está pendiente y qué se habló la última vez.`,
    ),
  ];
}

export function client360View(hub: Client360, today: string): Client360View {
  const c = hub.client;
  const status = c.status as ClientStatus;
  const timeline: Piece<TimelineEntry[]> = piece(hub.timeline, (items) =>
    items.map((t) => ({
      id: t.id,
      kind: t.kind,
      kindLabel: TIMELINE_KIND_LABEL[t.kind] ?? t.kind,
      at: t.at,
      dateLabel: dayLabel(t.at),
      monthLabel: monthLabel(t.at),
      title: t.title,
      detail: t.detail ?? null,
      by: t.by ?? null,
      href: t.href ?? null,
      tone: t.tone ?? KIND_TONE[t.kind] ?? 'neutral',
      upcoming: t.at.slice(0, 10) > today,
    })),
  );
  const counts = new Map<string, number>();
  if (timeline.ok) for (const t of timeline.data) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);

  const lastDays = hub.lastContactAt ? -daysFrom(today, hub.lastContactAt) : null;

  return {
    id: c.id,
    name: c.name,
    legalName: c.legal_name,
    nit: hub.nit,
    statusLabel: STATUS_LABEL[status] ?? c.status,
    statusTone:
      status === 'active'
        ? 'emerald'
        : status === 'blocked'
          ? 'rose'
          : status === 'prospect'
            ? 'primary'
            : 'amber',
    owner: c.owner_name ?? null,
    ownerId: c.owner_user_id,
    tags: c.tags ?? [],
    sourceLabel:
      CLIENT_SOURCE_LABEL[(c.source ?? 'manual') as keyof typeof CLIENT_SOURCE_LABEL] ??
      'Registrado a mano',
    sourceDetail: c.source_detail ?? null,
    place: c.city ? `${c.city}${c.department ? `, ${c.department}` : ''}` : null,
    phone: c.phone,
    website: c.website,
    paymentTerms: c.payment_terms_days != null ? `${c.payment_terms_days} días` : null,
    health: hub.health,
    lastContact:
      lastDays == null
        ? null
        : lastDays <= 0
          ? 'hoy'
          : lastDays === 1
            ? 'ayer'
            : `hace ${lastDays} días`,
    contacts: hub.contacts.map((k) => ({
      id: k.id,
      name: k.full_name,
      email: k.email,
      phone: k.phone,
      role: k.role_title,
      isPrimary: k.is_primary,
    })),
    domains: hub.domains.map((d) => d.domain),
    aliases: hub.aliases.map((a) => ({
      id: a.id,
      alias: a.alias,
      verified: Boolean(a.verified_by),
      sourceLabel:
        a.source === 'merge'
          ? 'De una unión'
          : a.source === 'confirmation'
            ? 'Aprendido al confirmar'
            : a.source === 'accounting'
              ? 'Del programa contable'
              : 'Escrito a mano',
    })),
    money: piece(hub.money, (m) => moneyView(m, today)),
    recovered: piece(hub.recovered, (r) =>
      r.total > 0
        ? {
            total: shortMoney(r.total),
            note: `${plural(r.invoices, 'factura')} cobrada${r.invoices === 1 ? '' : 's'} después de un aviso de Cortex`,
          }
        : null,
    ),
    expected: piece(hub.expected, (items) =>
      items.map((e) => ({
        date: dayLabel(e.expectedDate),
        amount: shortMoney(e.expectedAmount),
        reason: e.reason,
      })),
    ),
    timeline,
    timelineKinds: [...counts.entries()]
      .map(([kind, count]) => ({
        kind,
        count,
        label: TIMELINE_KIND_LABEL[kind as TimelineKind] ?? kind,
      }))
      .sort((a, b) => b.count - a.count),
    open: {
      invoices: piece(hub.open.invoices, (list) =>
        list.map((i) => ({
          id: i.id,
          label: `Factura ${i.docNumber ?? 'sin número'}`,
          amount:
            i.currency === 'COP'
              ? fullMoney(i.balance)
              : `${Math.round(i.balance).toLocaleString('es-CO')} ${i.currency}`,
          dueLabel: i.dueOn ? `vence ${dayLabel(i.dueOn)}` : 'sin fecha de vencimiento',
          late: i.daysOverdue ? `${i.daysOverdue} días vencida` : null,
          tone: i.daysOverdue
            ? ((i.daysOverdue > 60 ? 'rose' : 'amber') as Tone)
            : ('neutral' as Tone),
          href: i.href,
        })),
      ),
      commitments: piece(hub.open.commitments, (list) =>
        list.map((k) => ({
          id: k.id,
          title: k.title,
          meta: `${dayLabel(k.dueOn)} · ${k.daysLeft < 0 ? `venció hace ${-k.daysLeft} días` : k.daysLeft === 0 ? 'vence hoy' : `en ${k.daysLeft} días`}${k.amountCop ? ` · ${fullMoney(k.amountCop)}` : ''}`,
          tone: (k.state === 'overdue'
            ? 'rose'
            : k.state === 'due_soon'
              ? 'amber'
              : 'neutral') as Tone,
          href: '/commitments',
        })),
      ),
      cases: piece(hub.open.cases, (list) =>
        list.map((k) => ({
          id: k.id,
          title: k.title,
          meta: [k.why, k.nextAction ? `Sigue: ${k.nextAction}` : null].filter(Boolean).join(' · '),
          tone: (k.state === 'blocked' ? 'rose' : 'neutral') as Tone,
          href: '/management',
        })),
      ),
      work: piece(hub.open.work, (list) =>
        list.map((w) => ({
          id: w.id,
          title: w.title,
          meta:
            [w.assignee, w.dueOn ? `para el ${dayLabel(w.dueOn)}` : null]
              .filter(Boolean)
              .join(' · ') || w.workType,
          tone: 'neutral' as Tone,
          href: '/work',
        })),
      ),
    },
    documents: piece(hub.documents, (list) =>
      list.map((d) => ({
        id: d.id,
        title: d.title,
        dateLabel: dayLabel(d.at),
        kindLabel: d.kind === 'invoice' ? 'Factura' : d.kind === 'email' ? 'Correo' : 'Documento',
        href: d.href,
      })),
    ),
    proposals: hub.proposals,
    ask: askLinks(c.name),
    collectHref: `/chat?prompt=${encodeURIComponent(`Cobra a ${c.name}: redacta el correo de cobro de sus facturas vencidas y propónmelo para aprobar.`)}`,
  };
}
