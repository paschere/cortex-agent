'use client';

import {
  ActionNote,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from '@/components/finance/pieces';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  Gavel,
  Inbox,
  Link2,
  Plus,
  Scale,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ProgressRing } from '../charts/ProgressRing';
import type {
  ActionResult,
  AreaView,
  CaseView,
  ChecklistItemView,
  ComplianceActions,
  ComplianceScreen,
  PqrsView,
} from './types';

/**
 * /cumplimiento (0195). Cuatro pestañas:
 *   «Lista»     por área, con su avance, lo vencido y lo que hay que revisar con alguien.
 *   «PQRS»      la bandeja con el contador de días hábiles, radicar y responder.
 *   «Procesos»  los procesos judiciales, con la consulta a la Rama Judicial por trámite.
 *   «Perfil»    de donde sale todo, y si aplica SAGRILAFT/PTEE/RNBD, por confirmar.
 * Todo llega armado (lib/compliance/screen.ts) y se pinta igual en /v/cumplimiento-showcase.
 */

function useAct() {
  const router = useRouter();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      setNote(r.ok ? { ok: true, text: r.note ?? 'Listo.' } : { ok: false, text: r.error });
      if (r.ok) {
        after?.();
        router.refresh();
      }
    });
  return { note, pending, run };
}

const APPLIES: Record<string, { label: string; tone: 'emerald' | 'neutral' | 'amber' }> = {
  si: { label: 'Aplica', tone: 'emerald' },
  no: { label: 'No aplica', tone: 'neutral' },
  revisar: { label: 'Por confirmar', tone: 'amber' },
};

export function ComplianceHome({
  screen,
  tab,
  focusPqrs,
  actions,
  base = '/cumplimiento',
}: {
  screen: ComplianceScreen;
  tab: 'lista' | 'pqrs' | 'procesos' | 'perfil';
  focusPqrs: string | null;
  actions: ComplianceActions;
  base?: string;
}) {
  const openPqrs = screen.pqrs.filter((p) => p.open);
  const urgent = openPqrs.filter((p) => p.left <= 3).length;
  const tabs = [
    {
      id: 'lista',
      label: 'Lista de cumplimiento',
      count: screen.overall.overdue,
      tone: 'rose' as const,
    },
    { id: 'pqrs', label: 'PQRS', count: urgent, tone: 'amber' as const },
    {
      id: 'procesos',
      label: 'Procesos judiciales',
      count: screen.cases.filter((c) => c.status === 'activo').length,
      tone: 'neutral' as const,
    },
    { id: 'perfil', label: 'Perfil', count: 0, tone: 'neutral' as const },
  ];
  return (
    <>
      <PageHeader
        title="Cumplimiento"
        subtitle="Lo societario, los datos personales, las PQRS, la prevención de lavado de activos y los procesos judiciales de la empresa, con su fundamento y su fecha. No es asesoría legal: lo marcado «por confirmar» va con tu abogado o tu oficial de cumplimiento."
        icon={<Scale className="h-5 w-5" aria-hidden />}
      />
      {screen.configured && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label={`Avance ${screen.year}`}
            value={`${screen.overall.percent} %`}
            tone="text-ink"
          />
          <Stat
            label="Vencidas"
            value={String(screen.overall.overdue)}
            tone={screen.overall.overdue ? 'text-rose' : 'text-ink'}
          />
          <Stat
            label="Por confirmar con alguien"
            value={String(screen.overall.review)}
            tone={screen.overall.review ? 'text-amber' : 'text-ink'}
          />
          <Stat
            label="PQRS abiertas"
            value={String(openPqrs.length)}
            tone={urgent ? 'text-amber' : 'text-ink'}
          />
        </div>
      )}
      <nav
        className="mb-5 flex gap-1 overflow-x-auto border-b border-border"
        aria-label="Secciones de cumplimiento"
      >
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={`${base}?tab=${t.id}`}
            aria-current={tab === t.id ? 'page' : undefined}
            className={clsx(
              '-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold transition-colors',
              tab === t.id
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
            {t.count > 0 && <span className={statusPill(t.tone)}>{t.count}</span>}
          </Link>
        ))}
      </nav>
      {tab === 'lista' &&
        (screen.configured ? (
          <Checklist areas={screen.areas} actions={actions} />
        ) : (
          <Empty base={base} />
        ))}
      {tab === 'pqrs' && <PqrsTab screen={screen} actions={actions} focus={focusPqrs} />}
      {tab === 'procesos' && <CasesTab screen={screen} actions={actions} />}
      {tab === 'perfil' && <ProfileTab screen={screen} actions={actions} />}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3 shadow-card">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={clsx('mt-0.5 text-2xl font-extrabold tabular-nums', tone)}>{value}</p>
    </div>
  );
}

function Empty({ base }: { base: string }) {
  return (
    <Panel className="p-7 text-center">
      <h2 className="text-lg font-extrabold text-ink">Primero, el perfil de la empresa</h2>
      <p className="mx-auto mt-1 max-w-xl text-sm text-ink-muted">
        Con el tipo de sociedad, el tamaño, las cifras del año anterior y si atiendes consumidores
        sale la lista de lo que te aplica.
      </p>
      <Link href={`${base}?tab=perfil`} className={clsx(pillPrimary, 'mt-4')}>
        Llenar el perfil
      </Link>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

function Ring({ percent }: { percent: number }) {
  return <ProgressRing percent={percent} />;
}

function Checklist({ areas, actions }: { areas: AreaView[]; actions: ComplianceActions }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {areas.map((a) => (
        <Panel key={a.area} className="p-5">
          <div className="flex items-center gap-3">
            <Ring percent={a.percent} />
            <div className="min-w-0">
              <h2 className="text-base font-bold text-ink">{a.label}</h2>
              <p className="text-xs text-ink-muted">
                {a.done} de {a.total} · {a.percent} %{a.overdue ? ` · ${a.overdue} vencida(s)` : ''}
                {a.review ? ` · ${a.review} por confirmar` : ''}
              </p>
            </div>
          </div>
          <ul className="mt-4 divide-y divide-border">
            {a.items.map((i) => (
              <Item key={i.id} item={i} actions={actions} />
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

function Item({ item, actions }: { item: ChecklistItemView; actions: ComplianceActions }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(item.evidenceUrl ?? '');
  const [noteText, setNoteText] = useState(item.evidenceNote ?? '');
  const { note, pending, run } = useAct();
  const done = item.status === 'cumplido';
  const off = item.status === 'no_aplica';
  return (
    <li className={clsx('py-3', off && 'opacity-60')}>
      <button
        type="button"
        className="flex w-full items-start gap-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {done ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald" aria-hidden />
        ) : item.overdue ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose" aria-hidden />
        ) : (
          <span
            className="mt-1 h-3 w-3 shrink-0 rounded-full border-2 border-border-strong"
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">{item.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            <span className={statusPill(APPLIES[item.applies]?.tone ?? 'neutral')}>
              {APPLIES[item.applies]?.label}
            </span>
            <span>{item.frequencyLabel}</span>
            {item.dueOn && (
              <span className={clsx(item.overdue && 'font-semibold text-rose')}>
                · {item.overdue ? 'venció' : 'vence'} {item.dueOn}
                {item.dueNeedsConfirmation ? ' (fecha por confirmar)' : ''}
              </span>
            )}
            <span>· {item.statusLabel}</span>
          </span>
        </span>
        <ChevronDown
          className={clsx(
            'mt-1 h-4 w-4 shrink-0 text-ink-faint transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      {open && (
        <div className="mt-3 space-y-2 pl-7 text-xs leading-relaxed text-ink-muted">
          {item.description && <p>{item.description}</p>}
          {item.legalBasis && (
            <p>
              <strong className="text-ink">Fundamento:</strong> {item.legalBasis}
            </p>
          )}
          {item.applicabilityNote && (
            <p className={clsx(item.applies === 'revisar' && 'text-amber')}>
              <strong className="text-ink">Por qué:</strong> {item.applicabilityNote}
            </p>
          )}
          {item.linkedHref && (
            <Link
              href={item.linkedHref}
              className="inline-flex items-center gap-1 font-semibold text-primary underline"
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden /> Ir a donde se lleva
            </Link>
          )}
          <div className="grid gap-2 pt-1 sm:grid-cols-2">
            <input
              className={fieldClass}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Enlace de la evidencia (https://…)"
            />
            <input
              className={fieldClass}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Qué se hizo / por qué no aplica"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={pillPrimary}
              disabled={pending}
              onClick={() =>
                run(() =>
                  actions.markItem({
                    id: item.id,
                    status: 'cumplido',
                    evidenceUrl: url || null,
                    evidenceNote: noteText || null,
                  }),
                )
              }
            >
              Cumplido
            </button>
            <button
              type="button"
              className={pillLink}
              disabled={pending}
              onClick={() => run(() => actions.markItem({ id: item.id, status: 'en_curso' }))}
            >
              En curso
            </button>
            <button
              type="button"
              className={pillLink}
              disabled={pending}
              onClick={() =>
                run(() =>
                  actions.markItem({
                    id: item.id,
                    status: 'no_aplica',
                    evidenceNote: noteText || null,
                  }),
                )
              }
            >
              No aplica
            </button>
            {(done || off) && (
              <button
                type="button"
                className={pillLink}
                disabled={pending}
                onClick={() => run(() => actions.markItem({ id: item.id, status: 'pendiente' }))}
              >
                Volver a pendiente
              </button>
            )}
            <ActionNote note={note} />
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// PQRS
// ---------------------------------------------------------------------------

function PqrsTab({
  screen,
  actions,
  focus,
}: { screen: ComplianceScreen; actions: ComplianceActions; focus: string | null }) {
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(
    focus ?? screen.pqrs.find((p) => p.open)?.id ?? null,
  );
  const [filter, setFilter] = useState<'abiertas' | 'todas'>('abiertas');
  const list = screen.pqrs
    .filter((p) => filter === 'todas' || p.open)
    .sort((a, b) => (a.open && b.open ? a.left - b.left : 0));
  const current = screen.pqrs.find((p) => p.id === selected) ?? null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-pill border border-border bg-surface-2 p-1 text-xs font-semibold">
          {(['abiertas', 'todas'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={clsx(
                'rounded-pill px-3 py-1.5',
                filter === f ? 'bg-surface text-ink shadow-card' : 'text-ink-muted',
              )}
            >
              {f === 'abiertas' ? 'Abiertas' : 'Todas'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {screen.publicForm.url && <CopyLink url={screen.publicForm.url} />}
          <button type="button" className={pillPrimary} onClick={() => setCreating((v) => !v)}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Radicar una
          </button>
        </div>
      </div>
      {creating && <NewPqrs screen={screen} actions={actions} onDone={() => setCreating(false)} />}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_1fr]">
        <Panel className="overflow-hidden">
          {list.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">
              <Inbox className="mb-2 h-5 w-5 text-ink-faint" aria-hidden />
              No hay PQRS {filter === 'abiertas' ? 'abiertas' : 'todavía'}.{' '}
              {!screen.publicForm.enabled &&
                'Prende el formulario público en «Perfil» para recibirlas con radicado.'}
            </p>
          ) : (
            <ul className="max-h-[70vh] divide-y divide-border overflow-y-auto">
              {list.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(p.id)}
                    className={clsx(
                      'w-full px-4 py-3 text-left transition-colors',
                      selected === p.id ? 'bg-primary-soft/60' : 'hover:bg-surface-2',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-ink-muted">
                        {p.radicado}
                      </span>
                      <span className={statusPill(p.deadlineTone)}>{p.deadlineText}</span>
                    </span>
                    <span className="mt-1 block truncate text-sm font-semibold text-ink">
                      {p.subject}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-muted">
                      {p.kindLabel} · {p.requester} · {p.channelLabel}
                      {p.assigned ? ` · ${p.assigned}` : ' · sin asignar'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {current ? (
          <PqrsDetail key={current.id} p={current} screen={screen} actions={actions} />
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={pillLink}
      onClick={async () => {
        await navigator.clipboard.writeText(url).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Copy className="h-3.5 w-3.5" aria-hidden />{' '}
      {copied ? 'Enlace copiado' : 'Copiar enlace del formulario'}
    </button>
  );
}

function NewPqrs({
  screen,
  actions,
  onDone,
}: { screen: ComplianceScreen; actions: ComplianceActions; onDone: () => void }) {
  const { note, pending, run } = useAct();
  const [f, setF] = useState<Record<string, string>>({
    kind: 'peticion',
    matter: 'general',
    channel: 'correo',
  });
  const set = (k: string) => (e: { target: { value: string } }) =>
    setF((v) => ({ ...v, [k]: e.target.value }));
  return (
    <Panel className="p-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <select className={fieldClass} value={f.kind} onChange={set('kind')} aria-label="Clase">
          {screen.options.pqrsKinds.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className={fieldClass}
          value={f.matter}
          onChange={set('matter')}
          aria-label="Materia"
        >
          {screen.options.pqrsMatters.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className={fieldClass}
          value={f.channel}
          onChange={set('channel')}
          aria-label="Canal"
        >
          {screen.options.pqrsChannels.map((o) => (
            <option key={o.value} value={o.value}>
              Llegó por {o.label.toLowerCase()}
            </option>
          ))}
        </select>
        <input
          className={fieldClass}
          placeholder="Quién la presenta"
          value={f.requesterName ?? ''}
          onChange={set('requesterName')}
        />
        <input
          className={fieldClass}
          placeholder="Correo"
          value={f.requesterEmail ?? ''}
          onChange={set('requesterEmail')}
        />
        <label className="text-xs text-ink-muted">
          Llegó el
          <input
            type="date"
            className={clsx(fieldClass, 'mt-1')}
            value={f.receivedOn ?? ''}
            onChange={set('receivedOn')}
          />
        </label>
        <input
          className={clsx(fieldClass, 'sm:col-span-2')}
          placeholder="Asunto"
          value={f.subject ?? ''}
          onChange={set('subject')}
        />
        <select
          className={fieldClass}
          value={f.assignedUserId ?? ''}
          onChange={set('assignedUserId')}
          aria-label="Responsable"
        >
          <option value="">Responsable del perfil</option>
          {screen.options.team.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <textarea
          className={clsx(fieldClass, 'sm:col-span-3')}
          rows={3}
          placeholder="Lo que pide, en sus palabras"
          value={f.body ?? ''}
          onChange={set('body')}
        />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className={pillPrimary}
          disabled={pending}
          onClick={() => run(() => actions.createPqrs(f), onDone)}
        >
          Radicar
        </button>
        <span className="text-xs text-ink-faint">
          El plazo se cuenta en días hábiles desde el día siguiente a la llegada.
        </span>
        <ActionNote note={note} />
      </div>
    </Panel>
  );
}

function PqrsDetail({
  p,
  screen,
  actions,
}: { p: PqrsView; screen: ComplianceScreen; actions: ComplianceActions }) {
  const { note, pending, run } = useAct();
  const [text, setText] = useState(p.responseText ?? '');
  const [extendTo, setExtendTo] = useState('');
  const [reason, setReason] = useState('');
  const fill = (tpl: string) =>
    tpl
      .replaceAll('{nombre}', p.requester)
      .replaceAll('{radicado}', p.radicado)
      .replaceAll('{fecha}', p.receivedOn)
      .replaceAll('{empresa}', screen.companyName)
      .replaceAll('{asunto}', p.subject)
      .replaceAll('{plazo}', p.due);
  return (
    <Panel className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs font-semibold text-ink-muted">{p.radicado}</p>
          <h2 className="mt-1 text-lg font-extrabold text-ink">{p.subject}</h2>
          <p className="mt-1 text-xs text-ink-muted">
            {p.kindLabel} · {p.matterLabel} · llegó el {p.receivedOn} por{' '}
            {p.channelLabel.toLowerCase()} · {p.requester}
            {p.requesterEmail ? ` (${p.requesterEmail})` : ''}
          </p>
        </div>
        <span className={statusPill(p.deadlineTone)}>{p.deadlineText}</span>
      </div>
      <p className="mt-3 whitespace-pre-wrap rounded-sm bg-surface-2 px-4 py-3 text-sm text-ink">
        {p.body}
      </p>
      <p className="mt-2 text-xs text-ink-faint">
        Plazo: {p.due}
        {p.extended ? ' (ampliado)' : ''}. {p.deadlineBasis}
      </p>
      {p.open && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className={clsx(fieldClass, 'w-56')}
            defaultValue={p.assignedId ?? ''}
            onChange={(e) =>
              run(() => actions.updatePqrs({ id: p.id, assignedUserId: e.target.value || null }))
            }
            aria-label="Asignar"
          >
            <option value="">Sin asignar</option>
            {screen.options.team.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {p.status === 'radicada' && (
            <button
              type="button"
              className={pillLink}
              disabled={pending}
              onClick={() => run(() => actions.updatePqrs({ id: p.id, status: 'en_tramite' }))}
            >
              Pasar a trámite
            </button>
          )}
        </div>
      )}
      <div className="mt-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold text-ink">Respuesta</h3>
          {p.open &&
            screen.responseTemplates.map((t) => (
              <button
                key={t.key}
                type="button"
                className="text-xs font-semibold text-primary underline"
                onClick={() => setText(fill(t.text))}
              >
                {t.label}
              </button>
            ))}
        </div>
        <textarea
          className={clsx(fieldClass, 'mt-2')}
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!p.open && p.status !== 'respondida'}
        />
        <p className="mt-1 text-xs text-ink-faint">
          Las plantillas son borradores: completa lo marcado [COMPLETAR] y revisa antes de guardar.
          Guardar no la envía.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={pillPrimary}
            disabled={pending}
            onClick={() => run(() => actions.respondPqrs({ id: p.id, text, close: false }))}
          >
            Guardar respuesta
          </button>
          <button
            type="button"
            className={pillLink}
            disabled={pending}
            onClick={() => run(() => actions.respondPqrs({ id: p.id, text, close: true }))}
          >
            Guardar y cerrar
          </button>
          <ActionNote note={note} />
        </div>
      </div>
      {p.open && !p.extended && p.left >= 0 && (
        <details className="mt-5 rounded-sm border border-border p-3 text-xs">
          <summary className="cursor-pointer font-semibold text-ink">Ampliar el plazo</summary>
          <p className="mt-2 text-ink-muted">
            Se avisa antes de que venza, con la razón y el nuevo plazo, que no puede pasar del doble
            del inicial (a más tardar el {p.maxExtension}).
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              type="date"
              className={clsx(fieldClass, 'w-44')}
              value={extendTo}
              max={p.maxExtension}
              onChange={(e) => setExtendTo(e.target.value)}
            />
            <input
              className={clsx(fieldClass, 'flex-1')}
              placeholder="Por qué"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className={pillLink}
              disabled={pending || !extendTo || !reason}
              onClick={() =>
                run(() => actions.updatePqrs({ id: p.id, extendTo, extensionReason: reason }))
              }
            >
              Ampliar
            </button>
          </div>
        </details>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Procesos judiciales
// ---------------------------------------------------------------------------

function CasesTab({ screen, actions }: { screen: ComplianceScreen; actions: ComplianceActions }) {
  const [editing, setEditing] = useState<CaseView | 'new' | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-muted">
          Consulta tus procesos con el trámite aprendido de la Consulta de Procesos de la Rama
          Judicial. Si el portal pide CAPTCHA, lo resuelves tú en la pestaña en vivo; Cortex nunca
          lo intenta.
        </p>
        <div className="flex gap-2">
          <a href={screen.ramaJudicialUrl} target="_blank" rel="noreferrer" className={pillLink}>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Rama Judicial
          </a>
          <button type="button" className={pillPrimary} onClick={() => setEditing('new')}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Registrar proceso
          </button>
        </div>
      </div>
      {editing && (
        <CaseForm
          screen={screen}
          actions={actions}
          current={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}
      {screen.cases.length === 0 ? (
        <Panel className="p-6 text-sm text-ink-muted">
          <Gavel className="mb-2 h-5 w-5 text-ink-faint" aria-hidden />
          No hay procesos registrados. Si la empresa no tiene ninguno, márcalo en la lista de
          cumplimiento.
        </Panel>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {screen.cases.map((c) => (
            <Panel key={c.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-bold text-ink">{c.title}</h3>
                  {c.radicadoPretty && (
                    <p className="mt-0.5 font-mono text-xs text-ink-muted">{c.radicadoPretty}</p>
                  )}
                </div>
                <span className={statusPill(c.status === 'activo' ? 'primary' : 'neutral')}>
                  {c.statusLabel}
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-ink-muted">Despacho</dt>
                <dd className="text-ink">
                  {c.court ?? '—'}
                  {c.city ? `, ${c.city}` : ''}
                </dd>
                <dt className="text-ink-muted">Somos</dt>
                <dd className="text-ink">
                  {c.roleLabel}
                  {c.counterparty ? ` · contra ${c.counterparty}` : ''}
                </dd>
                <dt className="text-ink-muted">Última actuación</dt>
                <dd className="text-ink">
                  {c.lastActionOn ? `${c.lastActionOn}: ${c.lastAction ?? ''}` : '—'}
                </dd>
                <dt className="text-ink-muted">Próxima diligencia</dt>
                <dd className={clsx(c.nextHearingOn ? 'font-semibold text-ink' : 'text-ink-muted')}>
                  {c.nextHearingOn
                    ? `${c.nextHearingOn}${c.nextHearing ? ` · ${c.nextHearing}` : ''}`
                    : '—'}
                </dd>
                <dt className="text-ink-muted">Apoderado</dt>
                <dd className="text-ink">{c.lawyer ?? '—'}</dd>
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  href={`/chat?prompt=${encodeURIComponent(c.checkPrompt)}`}
                  className={pillLink}
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden /> Consultar con Cortex
                </Link>
                <button type="button" className={pillLink} onClick={() => setEditing(c)}>
                  Actualizar
                </button>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

function CaseForm({
  screen,
  actions,
  current,
  onDone,
}: {
  screen: ComplianceScreen;
  actions: ComplianceActions;
  current: CaseView | null;
  onDone: () => void;
}) {
  const { note, pending, run } = useAct();
  const [f, setF] = useState<Record<string, string>>({
    id: current?.id ?? '',
    radicado: current?.radicado ?? '',
    title: current?.title ?? '',
    court: current?.court ?? '',
    city: current?.city ?? '',
    processType: current?.processType ?? '',
    role: current?.role ?? 'demandado',
    counterparty: current?.counterparty ?? '',
    status: current?.status ?? 'activo',
    lastActionOn: '',
    lastAction: '',
    nextHearingOn: current?.nextHearingOn ?? '',
    nextHearing: current?.nextHearing ?? '',
    lawyer: current?.lawyer ?? '',
  });
  const set = (k: string) => (e: { target: { value: string } }) =>
    setF((v) => ({ ...v, [k]: e.target.value }));
  const input = (k: string, placeholder: string, type = 'text') => (
    <label className="text-xs text-ink-muted">
      {placeholder}
      <input
        type={type}
        className={clsx(fieldClass, 'mt-1')}
        value={f[k] ?? ''}
        onChange={set(k)}
      />
    </label>
  );
  return (
    <Panel className="p-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {input('radicado', 'Radicado (23 dígitos)')}
        {input('title', 'Nombre del proceso')}
        {input('court', 'Despacho')}
        {input('city', 'Ciudad')}
        {input('processType', 'Clase de proceso')}
        {input('counterparty', 'Contraparte')}
        <label className="text-xs text-ink-muted">
          La empresa es
          <select className={clsx(fieldClass, 'mt-1')} value={f.role} onChange={set('role')}>
            {screen.options.caseRoles.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Estado
          <select className={clsx(fieldClass, 'mt-1')} value={f.status} onChange={set('status')}>
            {screen.options.caseStatuses.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {input('lawyer', 'Apoderado')}
        {input('lastActionOn', 'Fecha de la actuación nueva', 'date')}
        <label className="text-xs text-ink-muted sm:col-span-2">
          Actuación
          <input
            className={clsx(fieldClass, 'mt-1')}
            value={f.lastAction}
            onChange={set('lastAction')}
          />
        </label>
        {input('nextHearingOn', 'Próxima diligencia', 'date')}
        <label className="text-xs text-ink-muted sm:col-span-2">
          Qué diligencia
          <input
            className={clsx(fieldClass, 'mt-1')}
            value={f.nextHearing}
            onChange={set('nextHearing')}
          />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className={pillPrimary}
          disabled={pending}
          onClick={() => run(() => actions.saveCase(f), onDone)}
        >
          Guardar
        </button>
        <button type="button" className={pillLink} onClick={onDone}>
          Cancelar
        </button>
        <ActionNote note={note} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------------------

function ProfileTab({ screen, actions }: { screen: ComplianceScreen; actions: ComplianceActions }) {
  const { note, pending, run } = useAct();
  const form = useAct();
  const [p, setP] = useState(screen.profile);
  const set = (k: keyof typeof p) => (e: { target: { value: string } }) =>
    setP((v) => ({ ...v, [k]: e.target.value }));
  const disabled = !screen.canManage;
  const text = (k: keyof typeof p, label: string, hint?: string) => (
    <label className="text-xs font-semibold text-ink-muted">
      {label}
      <input
        className={clsx(fieldClass, 'mt-1')}
        value={String(p[k] ?? '')}
        onChange={set(k)}
        disabled={disabled}
        inputMode={hint ? 'numeric' : undefined}
      />
      {hint && <span className="mt-1 block font-normal text-ink-faint">{hint}</span>}
    </label>
  );
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <Panel className="p-5 sm:p-7">
        <h2 className="text-lg font-extrabold text-ink">Perfil de la empresa</h2>
        {disabled && (
          <p className="mt-1 text-xs text-amber">Lo edita quien administra la empresa.</p>
        )}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-xs font-semibold text-ink-muted">
            Tipo de sociedad
            <select
              className={clsx(fieldClass, 'mt-1')}
              value={p.entityType}
              onChange={set('entityType')}
              disabled={disabled}
            >
              {screen.options.entityTypes.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-ink-muted">
            La vigila
            <select
              className={clsx(fieldClass, 'mt-1')}
              value={p.supervisor}
              onChange={set('supervisor')}
              disabled={disabled}
            >
              {screen.options.supervisors.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {text('revenueCop', 'Ingresos totales del año anterior (COP)', 'Al 31 de diciembre')}
          {text('assetsCop', 'Activos totales (COP)', 'Al 31 de diciembre')}
          {text('figuresYear', 'Año de esas cifras')}
          {text('employees', 'Personas empleadas')}
          {text('internationalCop', 'Negocios internacionales del año (COP)', 'Para PTEE')}
          {text('stateContractsCop', 'Contratos con el Estado del año (COP)', 'Para PTEE')}
          {text('complianceOfficer', 'Oficial de cumplimiento')}
          {text('privacyPolicyUrl', 'Enlace de la política de datos')}
          <label className="text-xs font-semibold text-ink-muted">
            Responde por el cumplimiento
            <select
              className={clsx(fieldClass, 'mt-1')}
              value={p.ownerUserId}
              onChange={set('ownerUserId')}
              disabled={disabled}
            >
              <option value="">—</option>
              {screen.options.team.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-ink-muted">
            Recibe las PQRS
            <select
              className={clsx(fieldClass, 'mt-1')}
              value={p.pqrsOwnerUserId}
              onChange={set('pqrsOwnerUserId')}
              disabled={disabled}
            >
              <option value="">—</option>
              {screen.options.team.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-4 text-sm text-ink">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={p.handlesPersonalData}
              onChange={(e) => setP((v) => ({ ...v, handlesPersonalData: e.target.checked }))}
              disabled={disabled}
            />
            Trata datos personales (empleados, clientes, proveedores)
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={p.consumerFacing}
              onChange={(e) => setP((v) => ({ ...v, consumerFacing: e.target.checked }))}
              disabled={disabled}
            />
            Vende a consumidores finales
          </label>
        </div>
        <fieldset className="mt-4">
          <legend className="text-xs font-semibold text-ink-muted">Sectores</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {screen.options.sectors.map((o) => {
              const on = p.sectors.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    setP((v) => ({
                      ...v,
                      sectors: on
                        ? v.sectors.filter((s) => s !== o.value)
                        : [...v.sectors, o.value],
                    }))
                  }
                  className={clsx(
                    'rounded-pill border px-3 py-1 text-xs font-semibold',
                    on
                      ? 'border-primary bg-primary-soft text-primary-ink'
                      : 'border-border text-ink-muted',
                  )}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </fieldset>
        <div className="mt-6 flex items-center gap-2">
          <button
            type="button"
            className={pillPrimary}
            disabled={disabled || form.pending}
            onClick={() => form.run(() => actions.saveProfile({ ...p }))}
          >
            Guardar y armar la lista
          </button>
          <ActionNote note={form.note} />
        </div>
      </Panel>
      <aside className="space-y-4">
        {screen.applicability.map((a) => (
          <Panel key={a.label} className="p-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-ink">{a.label}</h3>
              <span className={statusPill(APPLIES[a.applies]?.tone ?? 'neutral')}>
                {APPLIES[a.applies]?.label}
              </span>
            </div>
            {a.regime && a.regime !== 'SAGRILAFT' && a.regime !== 'PTEE' && (
              <p className="mt-1 text-xs font-semibold text-ink">{a.regime}</p>
            )}
            <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-muted">
              {a.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs font-semibold text-amber">
              Confirma con tu oficial de cumplimiento o tu abogado.
            </p>
          </Panel>
        ))}
        <Panel className="p-5">
          <h3 className="text-sm font-bold text-ink">Formulario público de PQRS</h3>
          <p className="mt-1 text-xs text-ink-muted">
            Un enlace para tu web o tus facturas: quien escribe recibe su radicado y la fecha límite
            de respuesta.
          </p>
          {screen.publicForm.url && (
            <p className="mt-2 break-all rounded-sm bg-surface-2 px-3 py-2 font-mono text-micro text-ink">
              {screen.publicForm.url}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={screen.publicForm.enabled ? pillLink : pillPrimary}
              disabled={disabled || pending || !screen.configured}
              onClick={() =>
                run(() => actions.setPublicForm({ enabled: !screen.publicForm.enabled }))
              }
            >
              {screen.publicForm.enabled ? 'Apagarlo' : 'Prenderlo'}
            </button>
            {screen.publicForm.enabled && (
              <button
                type="button"
                className={pillLink}
                disabled={disabled || pending}
                onClick={() => run(() => actions.setPublicForm({ enabled: true, rotate: true }))}
              >
                Cambiar el enlace
              </button>
            )}
          </div>
          <ActionNote note={note} />
        </Panel>
      </aside>
    </div>
  );
}
