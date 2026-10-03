'use client';

import { Button } from '@/components/ui/button';
import { Panel, PanelHead } from '@/components/ui/panel';
import type {
  ActionResult,
  Client360View,
  OpenItemView,
  Piece,
  TeamMember,
  TimelineEntry,
  Tone,
} from '@/lib/clients/types';
import { CHIP_INTERACTIVE, DOT_TONE, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  Banknote,
  Briefcase,
  Building2,
  CalendarClock,
  CalendarPlus,
  ClipboardList,
  FileText,
  HandCoins,
  History,
  Loader2,
  Mail,
  MessageCircle,
  Mic,
  NotebookPen,
  Plus,
  Receipt,
  Send,
  Sparkles,
  Tag,
  Wallet,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useMemo, useState, useTransition } from 'react';

/**
 * LA FICHA 360 DEL CLIENTE.
 *
 * Arriba, quién es y cómo va, en palabras («Pagos atrasados: $4,2 M vencidos;
 * la más vieja hace 47 días»). Debajo, la plata en seis cifras, las preguntas
 * para Cortex, y en dos columnas: la línea de tiempo de todo lo que pasó (con
 * filtros por clase) y lo abierto (cartera, compromisos, casos, trabajo),
 * documentos, otros nombres y — en `aside` — contactos, dominios y propuestas.
 *
 * Cada sección se pinta sola: si su lectura falló dice «sin dato» y el resto
 * de la ficha sigue. Todo llega formateado del servidor (lib/clients/view360).
 */

export interface Client360Handlers {
  addNote: (clientId: string, body: string) => Promise<ActionResult>;
  createCommitment: (input: {
    clientId: string;
    title: string;
    dueOn: string;
    amountCop?: number | null;
    kind?: 'payment' | 'contract' | 'other';
  }) => Promise<ActionResult>;
  setTags: (clientId: string, tags: string[]) => Promise<ActionResult>;
  setOwner: (clientId: string, ownerId: string | null) => Promise<ActionResult>;
  addAlias: (clientId: string, alias: string) => Promise<ActionResult>;
  splitAlias: (clientId: string, aliasId: string) => Promise<ActionResult>;
}

const KIND_ICON: Record<string, typeof Mail> = {
  invoice: Receipt,
  payment: Banknote,
  email: Mail,
  action: Send,
  meeting: Mic,
  commitment: CalendarClock,
  case: Briefcase,
  document: FileText,
  whatsapp: MessageCircle,
  note: NotebookPen,
};

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink',
  primary: 'text-primary',
  emerald: 'text-emerald',
  amber: 'text-amber',
  rose: 'text-rose',
};

function NoData({ error }: { error: string }) {
  return (
    <p className="px-6 pb-5 pt-3 text-sm text-ink-muted">
      <span className="font-semibold text-ink">Sin dato.</span> {error}
    </p>
  );
}

function Feedback({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <p
      aria-live="polite"
      className={clsx(
        'mt-2 rounded-sm px-3 py-2 text-xs',
        result.ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
      )}
    >
      {result.ok ? (result.note ?? 'Listo.') : (result.error ?? 'No se pudo.')}
    </p>
  );
}

// ---------------------------------------------------------------------------
// La ficha
// ---------------------------------------------------------------------------

export function Client360({
  view,
  team,
  handlers,
  aside,
  today,
}: {
  view: Client360View;
  team: TeamMember[];
  handlers: Client360Handlers;
  /** Contactos, dominios y propuestas (ClientAside). */
  aside?: ReactNode;
  today: string;
}) {
  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 sm:py-8">
      <Link
        href="/clients"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Clientes
      </Link>

      <Header view={view} team={team} handlers={handlers} today={today} />
      <MoneyStrip view={view} />
      <AskCortex view={view} />

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Timeline view={view} />
        <div className="space-y-4">
          <OpenItems view={view} />
          <Documents view={view} />
          <Aliases view={view} handlers={handlers} />
          {aside}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Encabezado: quién es, cómo va, y las acciones rápidas
// ---------------------------------------------------------------------------

function Header({
  view,
  team,
  handlers,
  today,
}: {
  view: Client360View;
  team: TeamMember[];
  handlers: Client360Handlers;
  today: string;
}) {
  const [open, setOpen] = useState<'note' | 'commitment' | 'tags' | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const [owner, setOwner] = useState(view.ownerId ?? '');

  function changeOwner(next: string) {
    setOwner(next);
    start(async () => setResult(await handlers.setOwner(view.id, next || null)));
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-card bg-primary-soft text-primary ring-1 ring-inset ring-primary/10">
            <Building2 className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-extrabold tracking-[-0.02em] text-ink sm:text-2xl">
                {view.name}
              </h1>
              <span className={chipClass(view.statusTone)}>{view.statusLabel}</span>
              <span
                className={chipClass(view.health.tone === 'neutral' ? 'neutral' : view.health.tone)}
              >
                <span
                  className={clsx('h-1.5 w-1.5 rounded-full', DOT_TONE[view.health.tone])}
                  aria-hidden
                />
                {view.health.label}
              </span>
            </div>
            <p className="mt-1 text-sm text-ink-muted">{view.health.reason}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-muted">
              {view.nit ? (
                <span className="tabular font-semibold text-ink">NIT {view.nit}</span>
              ) : (
                <span className="text-amber">Sin NIT</span>
              )}
              {view.legalName && <span>{view.legalName}</span>}
              {view.place && <span>{view.place}</span>}
              {view.paymentTerms && <span>Plazo {view.paymentTerms}</span>}
              {view.lastContact && <span>Último contacto {view.lastContact}</span>}
              <span title={view.sourceDetail ?? undefined}>{view.sourceLabel}</span>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                Responsable
                <select
                  value={owner}
                  onChange={(e) => changeOwner(e.target.value)}
                  disabled={pending}
                  className="min-h-8 rounded-pill border border-border bg-surface px-2.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <option value="">Sin responsable</option>
                  {team.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              {view.tags.map((t) => (
                <span key={t} className={chipClass('neutral')}>
                  <Tag className="h-3 w-3" aria-hidden />
                  {t}
                </span>
              ))}
              <button
                type="button"
                onClick={() => setOpen(open === 'tags' ? null : 'tags')}
                className={clsx(chipClass('neutral'), CHIP_INTERACTIVE, 'border-dashed')}
              >
                <Plus className="h-3 w-3" aria-hidden />
                Etiquetas
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-9 px-4 text-xs"
            onClick={() => setOpen(open === 'note' ? null : 'note')}
          >
            <NotebookPen className="h-3.5 w-3.5" aria-hidden />
            Registrar nota
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-9 px-4 text-xs"
            onClick={() => setOpen(open === 'commitment' ? null : 'commitment')}
          >
            <CalendarPlus className="h-3.5 w-3.5" aria-hidden />
            Crear compromiso
          </Button>
          <Link
            href={view.collectHref}
            className="cortex-primary-button inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-4 text-xs font-bold text-white transition-colors duration-150 hover:bg-primary-strong motion-reduce:transition-none"
          >
            <HandCoins className="h-3.5 w-3.5" aria-hidden />
            Cobrar
          </Link>
        </div>
      </div>

      {open === 'note' && (
        <NoteForm
          onCancel={() => setOpen(null)}
          onSave={async (body) => {
            const r = await handlers.addNote(view.id, body);
            setResult(r);
            if (r.ok) setOpen(null);
          }}
        />
      )}
      {open === 'commitment' && (
        <CommitmentForm
          today={today}
          onCancel={() => setOpen(null)}
          onSave={async (input) => {
            const r = await handlers.createCommitment({ clientId: view.id, ...input });
            setResult(r);
            if (r.ok) setOpen(null);
          }}
        />
      )}
      {open === 'tags' && (
        <TagsForm
          initial={view.tags}
          onCancel={() => setOpen(null)}
          onSave={async (tags) => {
            const r = await handlers.setTags(view.id, tags);
            setResult(r);
            if (r.ok) setOpen(null);
          }}
        />
      )}
      <Feedback result={result} />
    </div>
  );
}

function FormCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel className="mt-3 px-5 py-4">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <div className="mt-3">{children}</div>
    </Panel>
  );
}

const FIELD =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

function NoteForm({
  onSave,
  onCancel,
}: { onSave: (body: string) => Promise<void>; onCancel: () => void }) {
  const [body, setBody] = useState('');
  const [pending, start] = useTransition();
  return (
    <FormCard title="Nota en la ficha">
      <textarea
        className={clsx(FIELD, 'min-h-[84px]')}
        placeholder="Llamé a Carlos: paga la FV-118 el viernes."
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Nota"
      />
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          className="min-h-9 px-4 text-xs"
          disabled={pending || !body.trim()}
          onClick={() => start(() => onSave(body))}
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Guardar nota
        </Button>
        <Button type="button" variant="ghost" className="min-h-9 px-3 text-xs" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </FormCard>
  );
}

function CommitmentForm({
  onSave,
  onCancel,
  today,
}: {
  onSave: (input: {
    title: string;
    dueOn: string;
    amountCop: number | null;
    kind: 'payment' | 'contract' | 'other';
  }) => Promise<void>;
  onCancel: () => void;
  today: string;
}) {
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState(today);
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState<'payment' | 'contract' | 'other'>('payment');
  const [pending, start] = useTransition();
  const amountCop = amount.replace(/\D/g, '') ? Number(amount.replace(/\D/g, '')) : null;
  return (
    <FormCard title="Compromiso con este cliente">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px_160px_150px]">
        <input
          className={FIELD}
          placeholder="Pagar la FV-118"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Qué se comprometió"
        />
        <input
          className={FIELD}
          type="date"
          value={dueOn}
          onChange={(e) => setDueOn(e.target.value)}
          aria-label="Fecha"
        />
        <input
          className={FIELD}
          inputMode="numeric"
          placeholder="Monto (opcional)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Monto en pesos"
        />
        <select
          className={FIELD}
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          aria-label="Clase"
        >
          <option value="payment">Pago</option>
          <option value="contract">Contrato</option>
          <option value="other">Otro</option>
        </select>
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          className="min-h-9 px-4 text-xs"
          disabled={pending || !title.trim() || !dueOn}
          onClick={() => start(() => onSave({ title, dueOn, amountCop, kind }))}
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Crear compromiso
        </Button>
        <Button type="button" variant="ghost" className="min-h-9 px-3 text-xs" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </FormCard>
  );
}

function TagsForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: string[];
  onSave: (tags: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [tags, setTags] = useState(initial);
  const [draft, setDraft] = useState('');
  const [pending, start] = useTransition();
  const add = () => {
    const t = draft.trim();
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) setTags([...tags, t]);
    setDraft('');
  };
  return (
    <FormCard title="Etiquetas">
      <div className="flex flex-wrap items-center gap-2">
        {tags.map((t) => (
          <span key={t} className={chipClass('neutral')}>
            {t}
            <button
              type="button"
              aria-label={`Quitar ${t}`}
              onClick={() => setTags(tags.filter((x) => x !== t))}
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          className={clsx(FIELD, 'w-48')}
          placeholder="Nueva etiqueta"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          aria-label="Nueva etiqueta"
        />
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          className="min-h-9 px-4 text-xs"
          disabled={pending}
          onClick={() => start(() => onSave(draft.trim() ? [...tags, draft.trim()] : tags))}
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Guardar
        </Button>
        <Button type="button" variant="ghost" className="min-h-9 px-3 text-xs" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </FormCard>
  );
}

// ---------------------------------------------------------------------------
// La plata
// ---------------------------------------------------------------------------

function Tile({
  label,
  icon,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  icon: ReactNode;
  value: string | null;
  note: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3.5 shadow-card">
      <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
        <span className="text-ink-faint">{icon}</span>
        {label}
      </div>
      <div
        className={clsx(
          'stat-num mt-2 text-lg leading-none',
          value ? TONE_TEXT[tone] : 'text-ink-faint',
        )}
      >
        {value ?? 'Sin dato'}
      </div>
      <div className="mt-1.5 text-xs leading-snug text-ink-faint">{note}</div>
    </div>
  );
}

function MoneyStrip({ view }: { view: Client360View }) {
  const m = view.money;
  const sinDato = m.ok ? null : m.error;
  const expected = view.expected;
  return (
    <div className="mt-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="Facturado 12 meses"
          icon={<Receipt className="h-3.5 w-3.5" />}
          value={m.ok ? m.data.invoiced12m : null}
          note={m.ok ? m.data.invoiced12mNote : (sinDato ?? '')}
        />
        <Tile
          label="Saldo por cobrar"
          icon={<Wallet className="h-3.5 w-3.5" />}
          value={m.ok ? m.data.outstanding : null}
          note={m.ok ? m.data.outstandingNote : (sinDato ?? '')}
        />
        <Tile
          label="Vencido"
          icon={<CalendarClock className="h-3.5 w-3.5" />}
          value={m.ok ? m.data.overdue : null}
          note={m.ok ? m.data.overdueNote : (sinDato ?? '')}
          tone={m.ok ? m.data.overdueTone : 'neutral'}
        />
        <Tile
          label="Días de pago"
          icon={<History className="h-3.5 w-3.5" />}
          value={m.ok ? m.data.paymentDays : null}
          note={m.ok ? m.data.paymentDaysNote : (sinDato ?? '')}
        />
        <Tile
          label="Recuperado con Cortex"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          value={view.recovered.ok ? (view.recovered.data?.total ?? '$ 0') : null}
          note={
            view.recovered.ok
              ? (view.recovered.data?.note ?? 'Nada atribuido todavía')
              : view.recovered.error
          }
          tone={view.recovered.ok && view.recovered.data ? 'emerald' : 'neutral'}
        />
        <Tile
          label="Próximos cobros"
          icon={<Banknote className="h-3.5 w-3.5" />}
          value={
            expected.ok
              ? expected.data.length
                ? (expected.data[0]?.amount ?? null)
                : 'Nada esperado'
              : null
          }
          note={
            expected.ok
              ? expected.data.length
                ? `${expected.data[0]?.date}${expected.data.length > 1 ? ` y ${expected.data.length - 1} más` : ''}, según la proyección de caja`
                : 'La proyección no espera cobros de este cliente'
              : expected.error
          }
          tone="primary"
        />
      </div>
      {m.ok && m.data.nextDue && (
        <p className="mt-2 text-xs text-ink-muted">
          Próximo vencimiento: <span className="font-semibold text-ink">{m.data.nextDue}</span> ·{' '}
          {m.data.nextDueNote}
        </p>
      )}
      {m.ok && m.data.otherCurrencies.length > 0 && (
        <p className="mt-1 text-xs text-ink-faint">
          También tiene facturas en {m.data.otherCurrencies.join(', ')}: se muestran aparte y no se
          suman a los pesos.
        </p>
      )}
    </div>
  );
}

function AskCortex({ view }: { view: Client360View }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
        Pídele a Cortex
      </span>
      {view.ask.map((a) => (
        <Link
          key={a.label}
          href={a.href}
          className={clsx(chipClass('primary'), CHIP_INTERACTIVE, 'min-h-8 px-3')}
        >
          {a.label}
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// La línea de tiempo
// ---------------------------------------------------------------------------

function Timeline({ view }: { view: Client360View }) {
  const [kind, setKind] = useState<string | null>(null);
  const [limit, setLimit] = useState(40);
  const items = useMemo(
    () => (view.timeline.ok ? view.timeline.data.filter((t) => !kind || t.kind === kind) : []),
    [view.timeline, kind],
  );
  const shown = items.slice(0, limit);
  let lastMonth = '';
  return (
    <Panel>
      <PanelHead
        icon={<History className="h-4 w-4" aria-hidden />}
        title="Lo que ha pasado"
        right={
          view.timeline.ok ? `${items.length} ${items.length === 1 ? 'cosa' : 'cosas'}` : undefined
        }
      />
      {!view.timeline.ok ? (
        <NoData error={view.timeline.error} />
      ) : view.timeline.data.length === 0 ? (
        <p className="px-6 pb-6 pt-3 text-sm leading-snug text-ink-muted">
          Todavía no hay nada de este cliente. Registrar su NIT y el dominio de su correo es lo que
          más rinde: desde ahí, facturas, pagos y correos llegan solos.
        </p>
      ) : (
        <>
          <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 px-6 pb-0 pt-3">
            <legend className="sr-only">Filtrar por clase</legend>
            <button
              type="button"
              aria-pressed={kind === null}
              onClick={() => setKind(null)}
              className={clsx(chipClass(kind === null ? 'primary' : 'neutral'), CHIP_INTERACTIVE)}
            >
              Todo
            </button>
            {view.timelineKinds.map((k) => (
              <button
                key={k.kind}
                type="button"
                aria-pressed={kind === k.kind}
                onClick={() => setKind(kind === k.kind ? null : k.kind)}
                className={clsx(
                  chipClass(kind === k.kind ? 'primary' : 'neutral'),
                  CHIP_INTERACTIVE,
                )}
              >
                {k.label} <span className="tabular opacity-70">{k.count}</span>
              </button>
            ))}
          </fieldset>
          <ol className="mt-3 px-6 pb-5">
            {shown.map((t) => {
              const header = t.monthLabel !== lastMonth ? t.monthLabel : null;
              lastMonth = t.monthLabel;
              return <TimelineRow key={t.id} item={t} header={header} />;
            })}
          </ol>
          {items.length > shown.length && (
            <div className="px-6 pb-5">
              <Button
                type="button"
                variant="ghost"
                className="min-h-9 px-3 text-xs"
                onClick={() => setLimit(limit + 60)}
              >
                Ver {Math.min(60, items.length - shown.length)} más
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function TimelineRow({ item, header }: { item: TimelineEntry; header: string | null }) {
  const Icon = KIND_ICON[item.kind] ?? FileText;
  const body = (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p
          className={clsx(
            'min-w-0 text-sm font-medium',
            item.tone === 'rose' ? 'text-rose' : 'text-ink',
          )}
        >
          {item.title}
        </p>
        <span className="tabular shrink-0 text-xs text-ink-faint">
          {item.upcoming ? 'próximo · ' : ''}
          {item.dateLabel}
        </span>
      </div>
      {(item.detail || item.by) && (
        <p className="mt-0.5 text-xs leading-snug text-ink-muted">
          {item.detail}
          {item.detail && item.by ? ' · ' : ''}
          {item.by && <span className="text-ink-faint">{item.by}</span>}
        </p>
      )}
    </div>
  );
  return (
    <>
      {header && (
        <li className="mb-1 mt-4 text-[11px] font-bold uppercase tracking-wide text-ink-faint first:mt-0">
          {header}
        </li>
      )}
      <li className="relative flex gap-3 border-l border-border py-2 pl-4">
        <span
          className={clsx(
            'absolute -left-[13px] top-2.5 grid h-6 w-6 place-items-center rounded-full border border-border bg-surface',
            TONE_TEXT[item.tone],
          )}
        >
          <Icon className="h-3 w-3" aria-hidden />
        </span>
        {item.href ? (
          <Link
            href={item.href}
            className="min-w-0 flex-1 rounded-sm hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {body}
          </Link>
        ) : (
          body
        )}
      </li>
    </>
  );
}

// ---------------------------------------------------------------------------
// Lo abierto, documentos, otros nombres
// ---------------------------------------------------------------------------

function OpenList({
  title,
  piece,
  empty,
}: { title: string; piece: Piece<OpenItemView[]>; empty: string }) {
  return (
    <div className="px-6 pt-3">
      <p className="text-xs font-bold text-ink-muted">{title}</p>
      {!piece.ok ? (
        <p className="mt-1 text-xs text-ink-faint">Sin dato. {piece.error}</p>
      ) : piece.data.length === 0 ? (
        <p className="mt-1 text-xs text-ink-faint">{empty}</p>
      ) : (
        <ul className="mt-1 divide-y divide-border">
          {piece.data.slice(0, 6).map((i) => (
            <li key={i.id} className="py-2">
              {i.href ? (
                <Link href={i.href} className="text-sm font-medium text-ink hover:text-primary">
                  {i.title}
                </Link>
              ) : (
                <span className="text-sm font-medium text-ink">{i.title}</span>
              )}
              {i.meta && (
                <p
                  className={clsx(
                    'text-xs',
                    i.tone === 'neutral' ? 'text-ink-faint' : TONE_TEXT[i.tone],
                  )}
                >
                  {i.meta}
                </p>
              )}
            </li>
          ))}
          {piece.data.length > 6 && (
            <li className="py-2 text-xs text-ink-faint">y {piece.data.length - 6} más</li>
          )}
        </ul>
      )}
    </div>
  );
}

function OpenItems({ view }: { view: Client360View }) {
  const inv = view.open.invoices;
  return (
    <Panel>
      <PanelHead icon={<ClipboardList className="h-4 w-4" aria-hidden />} title="Lo abierto" />
      <div className="px-6 pt-3">
        <p className="text-xs font-bold text-ink-muted">Cartera</p>
        {!inv.ok ? (
          <p className="mt-1 text-xs text-ink-faint">Sin dato. {inv.error}</p>
        ) : inv.data.length === 0 ? (
          <p className="mt-1 text-xs text-ink-faint">No debe nada.</p>
        ) : (
          <ul className="mt-1 divide-y divide-border">
            {inv.data.slice(0, 6).map((i) => (
              <li key={i.id} className="flex items-baseline justify-between gap-3 py-2">
                <div className="min-w-0">
                  {i.href ? (
                    <a
                      href={i.href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-ink hover:text-primary"
                    >
                      {i.label}
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-ink">{i.label}</span>
                  )}
                  <p className={clsx('text-xs', i.late ? TONE_TEXT[i.tone] : 'text-ink-faint')}>
                    {i.late ?? i.dueLabel}
                  </p>
                </div>
                <span className={clsx('tabular shrink-0 text-sm font-semibold', TONE_TEXT[i.tone])}>
                  {i.amount}
                </span>
              </li>
            ))}
            {inv.data.length > 6 && (
              <li className="py-2 text-xs text-ink-faint">y {inv.data.length - 6} más</li>
            )}
          </ul>
        )}
      </div>
      <OpenList
        title="Compromisos"
        piece={view.open.commitments}
        empty="Nada con fecha a su nombre."
      />
      <OpenList title="Casos" piece={view.open.cases} empty="Ningún caso abierto." />
      <OpenList
        title="Trabajo del equipo"
        piece={view.open.work}
        empty="Nadie tiene tareas abiertas de este cliente."
      />
      <div className="h-4" />
    </Panel>
  );
}

function Documents({ view }: { view: Client360View }) {
  const d = view.documents;
  return (
    <Panel>
      <PanelHead
        icon={<FileText className="h-4 w-4" aria-hidden />}
        title="Documentos"
        right={d.ok && d.data.length ? String(d.data.length) : undefined}
      />
      {!d.ok ? (
        <NoData error={d.error} />
      ) : d.data.length === 0 ? (
        <p className="px-6 pb-5 pt-3 text-sm text-ink-muted">Ningún documento vinculado todavía.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border pb-2">
          {d.data.slice(0, 8).map((doc) => (
            <li key={doc.id} className="flex items-baseline justify-between gap-3 px-6 py-2.5">
              {doc.href ? (
                <a
                  href={doc.href}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate text-sm text-ink hover:text-primary"
                >
                  {doc.title}
                </a>
              ) : (
                <span className="min-w-0 truncate text-sm text-ink">{doc.title}</span>
              )}
              <span className="shrink-0 text-xs text-ink-faint">
                {doc.kindLabel}
                {doc.dateLabel ? ` · ${doc.dateLabel}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Aliases({ view, handlers }: { view: Client360View; handlers: Client360Handlers }) {
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirmSplit, setConfirmSplit] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Panel>
      <PanelHead icon={<Tag className="h-4 w-4" aria-hidden />} title="Otros nombres" />
      <p className="px-6 pt-2 text-xs leading-snug text-ink-muted">
        Cómo aparece en extractos y facturas. Un nombre confirmado se vincula solo, como un dominio.
      </p>
      {view.aliases.length > 0 && (
        <ul className="mt-2 divide-y divide-border">
          {view.aliases.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-6 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{a.alias}</p>
                <p className="text-xs text-ink-faint">
                  {a.sourceLabel}
                  {a.verified ? '' : ' · sin confirmar'}
                </p>
              </div>
              {confirmSplit === a.id ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="danger"
                    className="min-h-8 px-3 text-xs"
                    disabled={pending}
                    onClick={() =>
                      start(async () => setResult(await handlers.splitAlias(view.id, a.id)))
                    }
                  >
                    Separar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-8 px-2 text-xs"
                    onClick={() => setConfirmSplit(null)}
                  >
                    No
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  className="shrink-0 text-xs font-semibold text-ink-muted hover:text-ink"
                  title="Es otra empresa: crearla aparte y llevarse lo que llegó sólo por este nombre"
                  onClick={() => setConfirmSplit(a.id)}
                >
                  No es este cliente
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2 px-6 pb-4 pt-3">
        <input
          className={clsx(FIELD, 'min-h-9 py-1.5')}
          placeholder="COLTRANS SAS BOGOTA"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Otro nombre del cliente"
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-9 shrink-0 px-3 text-xs"
          disabled={pending || draft.trim().length < 2}
          onClick={() =>
            start(async () => {
              const r = await handlers.addAlias(view.id, draft);
              setResult(r);
              if (r.ok) setDraft('');
            })
          }
        >
          Agregar
        </Button>
      </div>
      {result && (
        <div className="px-6 pb-4">
          <Feedback result={result} />
        </div>
      )}
    </Panel>
  );
}
